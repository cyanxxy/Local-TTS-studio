mod neucodec_encoder;
mod qwen3;
mod reference_audio;

use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use clap::{Parser, ValueEnum};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tungstenite::handshake::machine::TryParse;
use tungstenite::handshake::server::{Request, Response, create_response, write_response};
use tungstenite::http::StatusCode;
use tungstenite::protocol::{Role, WebSocketConfig};
use tungstenite::{Message, WebSocket};

#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
))]
use qwen3::{
    AudioSink, CustomVoiceRequest, GenerationSummary, Qwen3Runtime, VoiceCloneReference,
    VoiceCloneRequest, resolved_runtime_target,
};
use qwen3::{ExpectedModelType, GenerationControls};
use reference_audio::decode_bounded_mono_wav;

const RESULT_PREFIX: &str = "__RESULT__";
const PORT_PREFIX: &str = "__PORT__";
// Electron accepts reference-audio base64 strings up to 60,000,000 bytes. Keep
// the transport ceiling above that payload plus its bounded JSON envelope.
const MAX_WEBSOCKET_TEXT_FRAME_BYTES: usize = 64 * 1024 * 1024;
const MAX_WEBSOCKET_HANDSHAKE_BYTES: usize = 64 * 1024;
const MAX_AUDIO_CHUNK_SAMPLES: usize = 262_144;
const WEBSOCKET_READ_TIMEOUT_SEC: u64 = 10;
const WEBSOCKET_HANDSHAKE_DEADLINE_SEC: u64 = 10;
const WEBSOCKET_IDLE_READ_TIMEOUT_SEC: u64 = 30 * 60;
const WEBSOCKET_WRITE_TIMEOUT_SEC: u64 = 30;
const MAX_WEBSOCKET_WRITE_BUFFER_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOCAL_TTS_TEXT_CHARS: usize = 6_000;
const MAX_REFERENCE_TEXT_CHARS: usize = 2_000;
const MAX_REFERENCE_CACHE_KEY_CHARS: usize = 120;
const MAX_REFERENCE_AUDIO_BASE64_CHARS: usize = 60_000_000;
const NEUTTS_REFERENCE_MAX_DURATION_SECONDS: u32 = 20;
const MAX_NEUTTS_REFERENCE_CODES: usize = 1_000;
const MAX_NEUTTS_REFERENCE_CODE_VALUE: i32 = 65_535;
const MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES: usize = 64 * 1_024;
const MAX_NEUTTS_REFERENCE_CODES_BASE64_CHARS: usize =
    ((MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES + 2) / 3) * 4;
const NEUTTS_DEFAULT_MODEL: &str = "neuphonic/neutts-nano-q4-gguf";
const QWEN3_MLX_CUSTOMVOICE_06B_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
const QWEN3_MLX_BASE_06B_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
const QWEN3_LIBTORCH_CUSTOMVOICE_06B_MODEL: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice";
const QWEN3_LIBTORCH_BASE_06B_MODEL: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";

#[derive(Debug, Parser)]
#[command(about = "Open TTS local runtime bridge")]
struct Cli {
    #[arg(long, value_enum)]
    action: Action,
    #[arg(long, value_enum)]
    model: LocalModel,
    #[arg(long)]
    cache_dir: PathBuf,
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 0)]
    port: u16,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
#[value(rename_all = "kebab-case")]
enum Action {
    Probe,
    ServeWs,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
#[value(rename_all = "kebab-case")]
enum LocalModel {
    Neutts,
    Qwen3,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WebSocketRequest {
    request_id: Option<String>,
    payload: Option<Value>,
    command: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Qwen3Payload {
    text: String,
    mode: Option<String>,
    model_repo: String,
    model_path: String,
    reference_audio_base64: Option<String>,
    reference_text: Option<String>,
    reference_cache_key: Option<String>,
    speaker: Option<String>,
    language: Option<String>,
    instruct: Option<String>,
    temperature: Option<f64>,
    top_k: Option<i64>,
    max_new_tokens: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Qwen3WarmPayload {
    mode: String,
    model_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NeuttsPayload {
    text: String,
    reference_text: String,
    reference_codes_base64: Option<String>,
    reference_audio_base64: Option<String>,
    model_repo: Option<String>,
}

struct NeuttsHost {
    model_repo: String,
    model: neutts::NeuTTS,
}

struct RuntimeState {
    model: LocalModel,
    cache_dir: PathBuf,
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    qwen3: Qwen3Runtime,
    neutts: Option<NeuttsHost>,
    neutts_encoder: Option<neucodec_encoder::NeuCodecRtenEncoder>,
}

struct GenerationOutput {
    samples: Vec<f32>,
    sample_rate: usize,
    model_repo: String,
    device: Option<String>,
    warnings: Vec<String>,
    streamed_audio: Option<StreamedAudioSummary>,
    phase_timings: serde_json::Map<String, Value>,
}

struct StreamedAudioSummary {
    sample_count: usize,
    audio_chunk_count: usize,
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.action {
        Action::Probe => run_probe(&cli),
        Action::ServeWs => run_websocket_server(&cli),
    };

    if let Err(err) = result {
        let _ = emit_result(&json!({
            "ok": false,
            "error": err.to_string(),
            "details": format!("{err:#}"),
        }));
        std::process::exit(1);
    }
}

fn emit_result(payload: &Value) -> Result<()> {
    println!("{RESULT_PREFIX}{}", serde_json::to_string(payload)?);
    Ok(())
}

fn run_probe(cli: &Cli) -> Result<()> {
    std::fs::create_dir_all(&cli.cache_dir).with_context(|| {
        format!(
            "Failed to create cache directory {}",
            cli.cache_dir.display()
        )
    })?;

    let result = match cli.model {
        LocalModel::Qwen3 => qwen3_probe_result(),
        LocalModel::Neutts => json!({
            "ready": true,
            "message": "Rust NeuTTS runtime is ready. Upload a WAV reference clip or pre-encoded NeuCodec .npy codes before generating.",
            "runtime": "rust",
            "package": "neutts",
            "packageVersion": "0.1.1",
            "recommendedModelRepo": NEUTTS_DEFAULT_MODEL,
            "warnings": [
                "The first WAV reference triggers a one-time NeuCodec encoder download (~1.8 GB)."
            ],
        }),
    };

    emit_result(&json!({ "ok": true, "result": result }))
}

#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
))]
fn qwen3_probe_result() -> Value {
    let target = resolved_runtime_target();
    let (recommended_model, recommended_base_model) = if cfg!(target_os = "macos") {
        (QWEN3_MLX_CUSTOMVOICE_06B_MODEL, QWEN3_MLX_BASE_06B_MODEL)
    } else {
        (
            QWEN3_LIBTORCH_CUSTOMVOICE_06B_MODEL,
            QWEN3_LIBTORCH_BASE_06B_MODEL,
        )
    };
    let warnings: Vec<&str> = if target.accelerated {
        Vec::new()
    } else {
        vec!["No supported GPU accelerator was detected; Qwen3 will use its local CPU fallback."]
    };
    json!({
        "ready": true,
        "message": "Native Qwen3-TTS runtime is ready. Download or select a validated model directory before generation.",
        "runtime": "rust",
        "package": "qwen3-tts-rs",
        "packageVersion": "0.2.2",
        "upstreamRevision": qwen3::UPSTREAM_REVISION,
        "provider": target.provider,
        "device": target.device,
        "accelerated": target.accelerated,
        "recommendedModelRepo": recommended_model,
        "recommendedBaseModelRepo": recommended_base_model,
        "warnings": warnings,
    })
}

#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
)))]
fn qwen3_probe_result() -> Value {
    json!({
        "ready": false,
        "message": "Qwen3-TTS is supported only on Apple Silicon macOS and Windows.",
        "runtime": "rust",
        "package": "qwen3-tts-rs",
        "packageVersion": "0.2.2",
        "upstreamRevision": qwen3::UPSTREAM_REVISION,
        "provider": "unsupported",
        "device": "unavailable",
        "accelerated": false,
        "warnings": ["This platform has no packaged Qwen3 tensor provider."],
    })
}

fn run_websocket_server(cli: &Cli) -> Result<()> {
    let auth_token = std::env::var("OPEN_TTS_WS_AUTH_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
        .context("WebSocket bridge requires a non-empty authentication token.")?;
    std::fs::create_dir_all(&cli.cache_dir).with_context(|| {
        format!(
            "Failed to create cache directory {}",
            cli.cache_dir.display()
        )
    })?;

    let bind_addresses = resolve_loopback_bind_addresses(&cli.host, cli.port)?;
    let listener = TcpListener::bind(bind_addresses.as_slice()).with_context(|| {
        format!(
            "Failed to bind WebSocket bridge on {}:{}",
            cli.host, cli.port
        )
    })?;
    let local_address = listener
        .local_addr()
        .context("Failed reading WebSocket bridge listener address")?;
    ensure!(
        local_address.ip().is_loopback(),
        "WebSocket bridge must bind to a loopback address."
    );
    let port = local_address.port();
    println!("{PORT_PREFIX}{port}");
    std::io::stdout()
        .flush()
        .context("Failed announcing WebSocket bridge port")?;
    exit_when_parent_pipe_closes();

    let mut state = RuntimeState {
        model: cli.model,
        cache_dir: cli.cache_dir.clone(),
        #[cfg(any(
            all(target_os = "macos", target_arch = "aarch64"),
            all(target_os = "windows", target_arch = "x86_64")
        ))]
        qwen3: Qwen3Runtime::new(),
        neutts: None,
        neutts_encoder: None,
    };

    loop {
        let (stream, _) = listener
            .accept()
            .context("Failed accepting WebSocket client")?;
        let _ = stream.set_nodelay(true);
        let mut websocket = match WebSocketConnection::accept(stream, &auth_token) {
            Ok(connection) => connection,
            Err(err) => {
                eprintln!("WebSocket bridge rejected connection: {err}");
                continue;
            }
        };
        match serve_websocket_connection(&mut websocket, &mut state) {
            Ok(_) => {}
            Err(err) if is_client_disconnect(&err) => {
                eprintln!("WebSocket bridge client disconnected: {err:#}");
            }
            Err(err) => return Err(err),
        }
        let _ = websocket.close();
        // One authenticated connection owns this process. Electron never
        // reconnects to an existing child, so exit when that owner disconnects
        // instead of leaving an unreachable loopback listener orphaned.
        return Ok(());
    }
}

fn resolve_loopback_bind_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    let addresses = (host, port)
        .to_socket_addrs()
        .with_context(|| format!("Failed to resolve WebSocket bridge host '{host}'"))?
        .collect::<Vec<_>>();
    ensure!(
        !addresses.is_empty(),
        "WebSocket bridge host '{host}' resolved to no addresses."
    );
    ensure!(
        addresses.iter().all(|address| address.ip().is_loopback()),
        "WebSocket bridge host must resolve only to loopback addresses."
    );
    Ok(addresses)
}

fn exit_when_parent_pipe_closes() {
    thread::spawn(|| {
        let mut input = std::io::stdin().lock();
        let mut byte = [0_u8; 1];
        loop {
            match input.read(&mut byte) {
                Ok(0) => std::process::exit(0),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => std::process::exit(0),
            }
        }
    });
}

fn serve_websocket_connection(
    websocket: &mut WebSocketConnection,
    state: &mut RuntimeState,
) -> Result<bool> {
    loop {
        let raw_message = match websocket.recv_text() {
            Ok(Some(message)) => message,
            Ok(None) => return Ok(false),
            Err(err) if is_client_disconnect(&err) => return Ok(false),
            Err(err) => return Err(err).context("Failed reading WebSocket request"),
        };
        let request: WebSocketRequest = match serde_json::from_str(&raw_message) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("WebSocket bridge rejected invalid request JSON: {err}");
                send_request_error(
                    websocket,
                    "",
                    &anyhow::anyhow!("Invalid WebSocket request JSON."),
                )?;
                continue;
            }
        };
        if request.command.as_deref() == Some("shutdown") {
            return Ok(true);
        }

        let request_id = request.request_id.unwrap_or_default();
        if request_id.trim().is_empty() {
            send_request_error(
                websocket,
                &request_id,
                &anyhow::anyhow!("WebSocket requests require a non-empty requestId."),
            )?;
            continue;
        }
        let payload = request.payload.unwrap_or(Value::Null);
        if request.command.as_deref() == Some("warm") {
            let outcome = {
                let _heartbeat = Heartbeat::start();
                state.warm(payload)
            };
            send_request_outcome(websocket, &request_id, outcome)?;
            continue;
        }
        if request.command.is_some() {
            send_request_error(
                websocket,
                &request_id,
                &anyhow::anyhow!("Unsupported WebSocket command."),
            )?;
            continue;
        }

        let outcome = {
            let _heartbeat = Heartbeat::start();
            state.generate(&request_id, payload, websocket)
        };
        match outcome {
            Ok(output) => send_generation_result(websocket, &request_id, output)?,
            Err(err) => {
                if is_client_disconnect(&err) {
                    return Ok(false);
                }
                send_request_error(websocket, &request_id, &err)?;
            }
        }
    }
}

fn send_request_outcome(
    websocket: &mut WebSocketConnection,
    request_id: &str,
    outcome: Result<Value>,
) -> Result<()> {
    match outcome {
        Ok(result) => websocket.send_json(&json!({
            "type": "result",
            "requestId": request_id,
            "ok": true,
            "result": result,
        })),
        Err(err) => send_request_error(websocket, request_id, &err),
    }
}

fn send_request_error(
    websocket: &mut WebSocketConnection,
    request_id: &str,
    error: &anyhow::Error,
) -> Result<()> {
    websocket.send_json(&json!({
        "type": "result",
        "requestId": request_id,
        "ok": false,
        "error": error.to_string(),
        "details": format!("{error:#}"),
    }))
}

impl RuntimeState {
    fn ensure_neutts_encoder(
        &mut self,
        progress: &mut dyn FnMut(String),
    ) -> Result<&neucodec_encoder::NeuCodecRtenEncoder> {
        if self.neutts_encoder.is_none() {
            self.neutts_encoder = Some(neucodec_encoder::NeuCodecRtenEncoder::ensure(
                &self.cache_dir,
                progress,
            )?);
        }
        Ok(self.neutts_encoder.as_ref().expect("encoder just set"))
    }

    fn warm(&mut self, payload: Value) -> Result<Value> {
        match self.model {
            LocalModel::Qwen3 => self.warm_qwen3(payload),
            LocalModel::Neutts => Ok(json!({
                "warmed": false,
                "message": "NeuTTS has no resident engine warm-up.",
            })),
        }
    }

    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn warm_qwen3(&mut self, payload: Value) -> Result<Value> {
        let target = resolved_runtime_target();
        let payload: Qwen3WarmPayload =
            serde_json::from_value(payload).context("Invalid Qwen3 warm payload")?;
        let model_type = parse_model_type(&payload.mode)?;
        self.qwen3
            .warm(Path::new(&payload.model_path), model_type)?;
        Ok(json!({
            "warmed": true,
            "message": "Qwen3 model is loaded in the resident Rust bridge.",
            "provider": target.provider,
            "device": target.device,
            "accelerated": target.accelerated,
        }))
    }

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    fn warm_qwen3(&mut self, _payload: Value) -> Result<Value> {
        bail!("Qwen3 is unavailable on this platform.")
    }

    fn generate(
        &mut self,
        request_id: &str,
        payload: Value,
        websocket: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        match self.model {
            LocalModel::Qwen3 => self.generate_qwen3(request_id, payload, websocket),
            LocalModel::Neutts => self.generate_neutts(request_id, payload, websocket),
        }
    }

    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn generate_qwen3(
        &mut self,
        request_id: &str,
        payload: Value,
        websocket: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        let mut payload: Qwen3Payload =
            serde_json::from_value(payload).context("Invalid Qwen3 payload")?;
        ensure!(
            payload.temperature.is_none_or(f64::is_finite),
            "Qwen3 temperature must be finite."
        );
        let trimmed_text = payload.text.trim();
        ensure!(
            !trimmed_text.is_empty() && trimmed_text.chars().count() <= MAX_LOCAL_TTS_TEXT_CHARS,
            "Qwen3 text must contain between 1 and {MAX_LOCAL_TTS_TEXT_CHARS} characters."
        );
        payload.text = trimmed_text.to_owned();
        let model_type = parse_model_type(payload.mode.as_deref().unwrap_or("customVoice"))?;
        let repo_is_base = payload.model_repo.contains("-Base");
        ensure!(
            repo_is_base == (model_type == ExpectedModelType::Base),
            "Qwen3 model repository does not match the requested mode."
        );
        match model_type {
            ExpectedModelType::Base => ensure!(
                payload.speaker.is_none() && payload.instruct.is_none(),
                "Qwen3 voice cloning does not accept speaker or instruct."
            ),
            ExpectedModelType::CustomVoice => ensure!(
                payload.reference_text.is_none()
                    && payload.reference_audio_base64.is_none()
                    && payload.reference_cache_key.is_none(),
                "Qwen3 CustomVoice does not accept voice-clone reference fields."
            ),
        }
        let controls = GenerationControls::new(
            payload.temperature.unwrap_or(0.9),
            payload.top_k.unwrap_or(50),
            payload.max_new_tokens.unwrap_or(1_536),
        );
        let started = Instant::now();
        let inference_started = Instant::now();
        let mut sink = WebSocketQwenSink {
            request_id,
            websocket,
            started,
            audio_chunk_count: 0,
        };
        let mut summary = match model_type {
            ExpectedModelType::CustomVoice => self.qwen3.generate_custom_voice(
                Path::new(&payload.model_path),
                &CustomVoiceRequest {
                    text: &payload.text,
                    speaker: payload.speaker.as_deref().unwrap_or("Ryan"),
                    language: payload.language.as_deref().unwrap_or("English"),
                    instruct: payload.instruct.as_deref().unwrap_or(""),
                    controls,
                },
                &mut sink,
            )?,
            ExpectedModelType::Base => {
                let reference_text = payload.reference_text.take();
                let reference_cache_key = payload.reference_cache_key.take();
                if let Some(cache_key) = reference_cache_key.as_deref() {
                    validate_qwen_reference_cache_key(cache_key)?;
                }
                let reference = if let Some(encoded) = payload.reference_audio_base64.take() {
                    let reference_text = reference_text.as_deref().context(
                        "Qwen3 voice cloning requires referenceText with a reference WAV.",
                    )?;
                    validate_qwen_reference_fields(reference_text, &encoded)?;
                    let reference_wav = BASE64
                        .decode(encoded.trim())
                        .context("Failed to decode Qwen3 reference WAV.")?;
                    drop(encoded);
                    VoiceCloneReference::Audio {
                        reference_wav,
                        reference_text,
                        session_key: reference_cache_key.as_deref(),
                    }
                } else {
                    ensure!(
                        reference_text.is_none(),
                        "Qwen3 cached voice references do not accept referenceText without referenceAudioBase64."
                    );
                    VoiceCloneReference::Cached {
                        session_key: reference_cache_key
                            .as_deref()
                            .context("Qwen3 voice cloning requires referenceAudioBase64 or referenceCacheKey.")?,
                    }
                };
                self.qwen3.generate_voice_clone(
                    Path::new(&payload.model_path),
                    VoiceCloneRequest {
                        text: &payload.text,
                        language: payload.language.as_deref().unwrap_or("Auto"),
                        reference,
                        controls,
                    },
                    &mut sink,
                )?
            }
        };
        summary.audio_chunk_count = sink.audio_chunk_count;
        qwen_generation_output(summary, payload.model_repo, inference_started.elapsed())
    }

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    fn generate_qwen3(
        &mut self,
        _request_id: &str,
        _payload: Value,
        _websocket: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        bail!("Qwen3 is unavailable on this platform.")
    }

    fn generate_neutts(
        &mut self,
        request_id: &str,
        payload: Value,
        websocket: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        let mut payload: NeuttsPayload =
            serde_json::from_value(payload).context("Invalid NeuTTS payload")?;
        ensure!(
            !payload.text.trim().is_empty(),
            "Text to synthesize is empty."
        );
        ensure!(
            payload.text.chars().count() <= MAX_LOCAL_TTS_TEXT_CHARS,
            "NeuTTS text exceeds {MAX_LOCAL_TTS_TEXT_CHARS} characters."
        );
        ensure!(
            !payload.reference_text.trim().is_empty()
                && payload.reference_text.chars().count() <= MAX_REFERENCE_TEXT_CHARS,
            "NeuTTS reference text must contain between 1 and {MAX_REFERENCE_TEXT_CHARS} characters."
        );
        let started = Instant::now();
        let mut phase_timings = serde_json::Map::new();
        let model_repo = normalize_neutts_model(payload.model_repo.as_deref())?;

        enum PreparedReference {
            Codes(Vec<i32>),
            Audio { samples: Vec<f32>, truncated: bool },
        }

        let reference_started = Instant::now();
        let reference_codes = payload
            .reference_codes_base64
            .take()
            .filter(|encoded| !encoded.trim().is_empty());
        let reference_audio = payload
            .reference_audio_base64
            .take()
            .filter(|encoded| !encoded.trim().is_empty());
        let prepared_reference = match (reference_codes, reference_audio) {
            (Some(_), Some(_)) => {
                bail!("Provide either NeuTTS reference codes or reference audio, not both.")
            }
            (Some(encoded), None) => {
                PreparedReference::Codes(decode_neutts_reference_codes(&encoded)?)
            }
            (None, Some(audio)) => {
                let (samples, truncated) = prepare_neutts_reference_samples(&audio)?;
                PreparedReference::Audio { samples, truncated }
            }
            (None, None) => bail!(
                "Provide a reference: either pre-encoded .npy codes (referenceCodesBase64) or a WAV clip (referenceAudioBase64)."
            ),
        };
        let reference_validation_elapsed = reference_started.elapsed();

        websocket.send_progress(
            request_id,
            "model_load",
            format!("Loading Rust NeuTTS model: {model_repo}"),
            started,
        )?;
        let load_started = Instant::now();
        self.ensure_neutts_model(&model_repo)?;
        phase_timings.insert(
            "modelLoadSec".to_string(),
            json!(round_secs(load_started.elapsed().as_secs_f64())),
        );

        let reference_encoding_started = Instant::now();
        let mut warnings = Vec::new();
        let reference_codes = match prepared_reference {
            PreparedReference::Codes(codes) => codes,
            PreparedReference::Audio { samples, truncated } => {
                let mut progress = |message: String| {
                    let _ =
                        websocket.send_progress(request_id, "reference_encoding", message, started);
                };
                progress("Encoding WAV reference with NeuCodec...".to_string());
                if truncated {
                    warnings.push(
                        "Reference audio is longer than 20 seconds; only the first 20 seconds were used."
                            .to_string(),
                    );
                }
                self.ensure_neutts_encoder(&mut progress)?
                    .encode(&samples)?
            }
        };
        let reference_elapsed = reference_validation_elapsed + reference_encoding_started.elapsed();
        phase_timings.insert(
            "referenceEncodingSec".to_string(),
            json!(round_secs(reference_elapsed.as_secs_f64())),
        );

        websocket.send_progress(
            request_id,
            "inference",
            "Running Rust NeuTTS inference...",
            started,
        )?;
        let inference_started = Instant::now();
        let host = self
            .neutts
            .as_ref()
            .context("NeuTTS model was not loaded")?;
        let samples = host
            .model
            .infer(
                payload.text.trim(),
                &reference_codes,
                payload.reference_text.trim(),
            )
            .with_context(|| format!("NeuTTS inference failed for {}", host.model_repo))?;
        phase_timings.insert(
            "inferenceSec".to_string(),
            json!(round_secs(inference_started.elapsed().as_secs_f64())),
        );

        Ok(GenerationOutput {
            samples,
            sample_rate: neutts::SAMPLE_RATE as usize,
            model_repo,
            device: None,
            warnings,
            streamed_audio: None,
            phase_timings,
        })
    }

    fn ensure_neutts_model(&mut self, model_repo: &str) -> Result<()> {
        if self
            .neutts
            .as_ref()
            .is_some_and(|host| host.model_repo == model_repo)
        {
            return Ok(());
        }
        let model = neutts::download::load_from_hub(model_repo)
            .with_context(|| format!("Failed to load Rust NeuTTS model {model_repo}"))?;
        self.neutts = Some(NeuttsHost {
            model_repo: model_repo.to_string(),
            model,
        });
        Ok(())
    }
}

#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
))]
fn qwen_generation_output(
    summary: GenerationSummary,
    model_repo: String,
    inference_elapsed: Duration,
) -> Result<GenerationOutput> {
    let target = resolved_runtime_target();
    ensure!(
        summary.sample_rate > 0,
        "Qwen3 returned an invalid sample rate."
    );
    let mut phase_timings = serde_json::Map::new();
    phase_timings.insert(
        "inferenceSec".to_string(),
        json!(round_secs(inference_elapsed.as_secs_f64())),
    );
    Ok(GenerationOutput {
        samples: Vec::new(),
        sample_rate: usize::try_from(summary.sample_rate).context("Invalid Qwen3 sample rate")?,
        model_repo,
        device: Some(target.device.to_string()),
        warnings: if summary.reference_truncated {
            vec!["Qwen3 used only the first 20 seconds of the reference WAV.".to_string()]
        } else {
            Vec::new()
        },
        streamed_audio: Some(StreamedAudioSummary {
            sample_count: summary.sample_count,
            audio_chunk_count: summary.audio_chunk_count,
        }),
        phase_timings,
    })
}

fn parse_model_type(mode: &str) -> Result<ExpectedModelType> {
    match mode {
        "customVoice" => Ok(ExpectedModelType::CustomVoice),
        "voiceClone" => Ok(ExpectedModelType::Base),
        _ => bail!("Unsupported Qwen3 mode: {mode}"),
    }
}

#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
))]
struct WebSocketQwenSink<'a> {
    request_id: &'a str,
    websocket: &'a mut WebSocketConnection,
    started: Instant,
    audio_chunk_count: usize,
}

#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
))]
impl AudioSink for WebSocketQwenSink<'_> {
    fn progress(&mut self, phase: &str, message: &str) -> Result<()> {
        self.websocket
            .send_progress(self.request_id, phase, message, self.started)
    }

    fn audio_chunk(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        index: usize,
        total: usize,
        silence_after_samples: usize,
    ) -> Result<()> {
        for (part_index, chunk) in samples.chunks(MAX_AUDIO_CHUNK_SAMPLES).enumerate() {
            let is_last_part = (part_index + 1) * MAX_AUDIO_CHUNK_SAMPLES >= samples.len();
            let mut metadata = json!({
                "type": "audio_chunk",
                "requestId": self.request_id,
                "index": self.audio_chunk_count,
                // The final transport chunk count is not known while Qwen is
                // streaming. The result envelope supplies the authoritative
                // count after generation completes.
                "total": 0,
                "sampleRate": sample_rate,
                "sampleCount": chunk.len(),
                "silenceAfterSamples": if is_last_part { silence_after_samples } else { 0 },
            });
            if total > 0 {
                metadata["textUnitIndex"] = json!(index);
                metadata["textUnitTotal"] = json!(total);
            }
            self.websocket.send_json(&metadata)?;
            self.websocket.send_binary(float32_to_le_bytes(chunk))?;
            self.audio_chunk_count = self.audio_chunk_count.saturating_add(1);
        }
        Ok(())
    }
}

fn validate_generation_output(output: &GenerationOutput) -> Result<()> {
    let streamed_audio = output.streamed_audio.as_ref();
    if output.samples.is_empty() && streamed_audio.is_none() {
        bail!("Generation produced no audio samples.");
    }
    if output.sample_rate == 0 {
        bail!("Generation returned an invalid sample rate.");
    }
    let sample_count = streamed_audio
        .map(|summary| summary.sample_count)
        .unwrap_or(output.samples.len());
    let chunk_count = streamed_audio
        .map(|summary| summary.audio_chunk_count)
        .unwrap_or_else(|| sample_count.div_ceil(MAX_AUDIO_CHUNK_SAMPLES));
    ensure!(
        sample_count > 0 && chunk_count > 0,
        "Generation produced no audio samples."
    );
    Ok(())
}

fn send_generation_result(
    websocket: &mut WebSocketConnection,
    request_id: &str,
    mut output: GenerationOutput,
) -> Result<()> {
    if let Err(err) = validate_generation_output(&output) {
        return send_request_error(websocket, request_id, &err);
    }

    let streamed_audio = output.streamed_audio.as_ref();
    let sample_count = streamed_audio
        .map(|summary| summary.sample_count)
        .unwrap_or(output.samples.len());
    let chunk_count = streamed_audio
        .map(|summary| summary.audio_chunk_count)
        .unwrap_or_else(|| sample_count.div_ceil(MAX_AUDIO_CHUNK_SAMPLES));
    if streamed_audio.is_none() {
        let transport_started = Instant::now();
        for (index, chunk) in output.samples.chunks(MAX_AUDIO_CHUNK_SAMPLES).enumerate() {
            websocket.send_json(&json!({
                "type": "audio_chunk",
                "requestId": request_id,
                "index": index,
                "total": chunk_count,
                "sampleRate": output.sample_rate,
                "sampleCount": chunk.len(),
                "silenceAfterSamples": 0,
            }))?;
            websocket.send_binary(float32_to_le_bytes(chunk))?;
        }
        output.phase_timings.insert(
            "transportEncodingSec".to_string(),
            json!(round_secs(transport_started.elapsed().as_secs_f64())),
        );
    }

    let duration_sec = sample_count as f64 / output.sample_rate as f64;
    let elapsed_sec = output
        .phase_timings
        .iter()
        .filter(|(key, _)| is_elapsed_phase_timing(key))
        .filter_map(|(_, value)| Value::as_f64(value))
        .sum::<f64>();
    let mut result = json!({
        "sampleRate": output.sample_rate,
        "modelRepo": output.model_repo,
        "durationSec": round_secs(duration_sec),
        "elapsedSec": round_secs(elapsed_sec),
        "audioTransport": "websocket-binary",
        "audioChunkCount": chunk_count,
        "phaseTimingsSec": output.phase_timings,
    });
    if let Some(device) = output.device {
        result["device"] = json!(device);
    }
    if !output.warnings.is_empty() {
        result["warnings"] = json!(output.warnings);
    }
    websocket.send_json(&json!({
        "type": "result",
        "requestId": request_id,
        "ok": true,
        "result": result,
    }))
}

fn is_elapsed_phase_timing(key: &str) -> bool {
    matches!(
        key,
        "modelLoadSec"
            | "referenceEncodingSec"
            | "inferenceSec"
            | "outputEncodingSec"
            | "transportEncodingSec"
    )
}

fn float32_to_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(samples));
    for sample in samples {
        let clean = if sample.is_finite() { *sample } else { 0.0 };
        bytes.extend_from_slice(&clean.to_le_bytes());
    }
    bytes
}

fn decode_neutts_reference_codes(encoded: &str) -> Result<Vec<i32>> {
    let encoded = encoded.trim();
    ensure!(
        encoded.len() <= MAX_NEUTTS_REFERENCE_CODES_BASE64_CHARS,
        "NeuTTS reference-code payload exceeds the {MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES}-byte .npy limit."
    );
    let bytes = BASE64
        .decode(encoded)
        .context("Failed to decode NeuTTS reference codes")?;
    prevalidate_neutts_npy(&bytes)?;

    let parsed = neutts::npy::parse_npy(&bytes).context("Failed to parse NeuTTS reference .npy")?;
    let codes = match parsed {
        neutts::npy::NpyData::Int32 { data, .. } => data,
        neutts::npy::NpyData::Float32 { data, .. } => {
            let mut codes = Vec::with_capacity(data.len());
            for code in data {
                ensure!(
                    code.is_finite() && code.fract() == 0.0,
                    "NeuTTS reference .npy float codes must be finite whole numbers."
                );
                ensure!(
                    (0.0..=MAX_NEUTTS_REFERENCE_CODE_VALUE as f32).contains(&code),
                    "NeuTTS reference codes must be between 0 and {MAX_NEUTTS_REFERENCE_CODE_VALUE}."
                );
                codes.push(code as i32);
            }
            codes
        }
    };
    ensure!(
        (1..=MAX_NEUTTS_REFERENCE_CODES).contains(&codes.len()),
        "NeuTTS reference .npy must contain between 1 and {MAX_NEUTTS_REFERENCE_CODES} codes."
    );
    ensure!(
        codes
            .iter()
            .all(|code| (0..=MAX_NEUTTS_REFERENCE_CODE_VALUE).contains(code)),
        "NeuTTS reference codes must be between 0 and {MAX_NEUTTS_REFERENCE_CODE_VALUE}."
    );
    Ok(codes)
}

fn prevalidate_neutts_npy(raw: &[u8]) -> Result<()> {
    ensure!(
        raw.len() <= MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES,
        "NeuTTS reference .npy exceeds the {MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES}-byte limit."
    );
    ensure!(
        raw.len() >= 10 && &raw[..6] == b"\x93NUMPY",
        "NeuTTS reference is not a valid .npy file."
    );

    let (header_len, header_start) = match raw[6] {
        1 => (u16::from_le_bytes([raw[8], raw[9]]) as usize, 10usize),
        2 => {
            ensure!(
                raw.len() >= 12,
                "NeuTTS reference .npy v2 header is truncated."
            );
            (
                u32::from_le_bytes([raw[8], raw[9], raw[10], raw[11]]) as usize,
                12usize,
            )
        }
        major => bail!("Unsupported NeuTTS reference .npy version {major}."),
    };
    let header_end = header_start
        .checked_add(header_len)
        .context("NeuTTS reference .npy header length overflowed")?;
    ensure!(
        header_end <= raw.len(),
        "NeuTTS reference .npy header is truncated."
    );
    let header = std::str::from_utf8(&raw[header_start..header_end])
        .context("NeuTTS reference .npy header is not valid UTF-8")?;
    let shape = extract_npy_header_field(header, "shape")
        .context("NeuTTS reference .npy header is missing 'shape'")?;
    let shape = shape
        .strip_prefix('(')
        .and_then(|value| value.strip_suffix(')'))
        .context("NeuTTS reference .npy shape must be a tuple")?;

    let mut element_count = 1usize;
    for dimension in shape
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let dimension = dimension.parse::<usize>().with_context(|| {
            format!("Invalid NeuTTS reference .npy shape dimension '{dimension}'")
        })?;
        element_count = element_count
            .checked_mul(dimension)
            .context("NeuTTS reference .npy shape dimensions overflowed")?;
    }
    ensure!(
        (1..=MAX_NEUTTS_REFERENCE_CODES).contains(&element_count),
        "NeuTTS reference .npy must contain between 1 and {MAX_NEUTTS_REFERENCE_CODES} codes."
    );

    // The only dtypes accepted by neutts::npy are four bytes wide. Checking
    // this before calling its parser guarantees its internal shape products
    // and byte-size arithmetic cannot overflow, even for hostile headers.
    let data_bytes = element_count
        .checked_mul(4)
        .context("NeuTTS reference .npy data size overflowed")?;
    let required_len = header_end
        .checked_add(data_bytes)
        .context("NeuTTS reference .npy total size overflowed")?;
    ensure!(
        required_len <= raw.len(),
        "NeuTTS reference .npy data section is truncated."
    );
    Ok(())
}

fn extract_npy_header_field<'a>(header: &'a str, field: &str) -> Option<&'a str> {
    let single_quoted_key = format!("'{field}':");
    let double_quoted_key = format!("\"{field}\":");
    let start = header
        .find(&single_quoted_key)
        .map(|position| position + single_quoted_key.len())
        .or_else(|| {
            header
                .find(&double_quoted_key)
                .map(|position| position + double_quoted_key.len())
        })?;
    let value = header[start..].trim_start();
    if value.starts_with('(') {
        let end = value.find(')')?;
        Some(&value[..=end])
    } else {
        None
    }
}

fn prepare_neutts_reference_samples(encoded: &str) -> Result<(Vec<f32>, bool)> {
    ensure_reference_audio_base64_len(encoded.trim().len())?;
    let bytes = BASE64
        .decode(encoded.trim())
        .context("Failed to decode NeuTTS reference WAV")?;
    let reader = hound::WavReader::new(std::io::Cursor::new(bytes))
        .context("NeuTTS reference must be a valid WAV file")?;
    let decoded = decode_bounded_mono_wav(
        reader,
        "NeuTTS reference WAV",
        NEUTTS_REFERENCE_MAX_DURATION_SECONDS,
    )?;
    ensure!(
        !decoded.samples.is_empty(),
        "NeuTTS reference WAV contains no audio."
    );
    let mut samples = neutts::codec::resample(
        &decoded.samples,
        decoded.sample_rate,
        neutts::ENCODER_SAMPLE_RATE,
    );
    for sample in &mut samples {
        *sample = if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        };
    }
    let truncated = decoded.truncated || samples.len() > neucodec_encoder::ENCODER_WINDOW_SAMPLES;
    samples.truncate(neucodec_encoder::ENCODER_WINDOW_SAMPLES);
    ensure!(
        samples.len() >= neucodec_encoder::MIN_REFERENCE_SAMPLES,
        "Reference audio is too short; provide at least half a second of speech."
    );
    Ok((samples, truncated))
}

fn validate_qwen_reference_fields(reference_text: &str, encoded_audio: &str) -> Result<()> {
    let reference_text = reference_text.trim();
    ensure!(
        !reference_text.is_empty() && reference_text.chars().count() <= MAX_REFERENCE_TEXT_CHARS,
        "Qwen3 reference text must contain between 1 and {MAX_REFERENCE_TEXT_CHARS} characters."
    );
    let encoded_audio = encoded_audio.trim();
    ensure!(
        !encoded_audio.is_empty(),
        "Qwen3 voice cloning requires non-empty referenceAudioBase64."
    );
    ensure_reference_audio_base64_len(encoded_audio.len())
}

fn validate_qwen_reference_cache_key(cache_key: &str) -> Result<()> {
    ensure!(
        !cache_key.is_empty()
            && cache_key.len() <= MAX_REFERENCE_CACHE_KEY_CHARS
            && cache_key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            && !cache_key.contains(".."),
        "Qwen3 referenceCacheKey has an invalid format."
    );
    Ok(())
}

fn ensure_reference_audio_base64_len(encoded_len: usize) -> Result<()> {
    ensure!(
        encoded_len <= MAX_REFERENCE_AUDIO_BASE64_CHARS,
        "Reference audio payload exceeds the {MAX_REFERENCE_AUDIO_BASE64_CHARS}-character base64 limit."
    );
    Ok(())
}

fn normalize_neutts_model(input: Option<&str>) -> Result<String> {
    let model = input.unwrap_or(NEUTTS_DEFAULT_MODEL);
    let allowed = [
        "neuphonic/neutts-nano-q4-gguf",
        "neuphonic/neutts-nano-q8-gguf",
        "neuphonic/neutts-nano-german-q4-gguf",
        "neuphonic/neutts-nano-german-q8-gguf",
        "neuphonic/neutts-nano-french-q4-gguf",
        "neuphonic/neutts-nano-french-q8-gguf",
        "neuphonic/neutts-nano-spanish-q4-gguf",
        "neuphonic/neutts-nano-spanish-q8-gguf",
    ];
    if allowed.contains(&model) {
        Ok(model.to_string())
    } else {
        bail!("Unsupported Rust NeuTTS model repository: {model}")
    }
}

fn round_secs(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);

struct Heartbeat {
    stop: Option<mpsc::Sender<()>>,
    handle: Option<JoinHandle<()>>,
}

impl Heartbeat {
    fn start() -> Self {
        let (stop, signal) = mpsc::channel::<()>();
        let handle = thread::spawn(move || {
            loop {
                match signal.recv_timeout(HEARTBEAT_INTERVAL) {
                    Err(RecvTimeoutError::Timeout) => {
                        let mut stderr = std::io::stderr();
                        if stderr.write_all(b" ").is_err() || stderr.flush().is_err() {
                            return;
                        }
                    }
                    _ => return,
                }
            }
        });
        Self {
            stop: Some(stop),
            handle: Some(handle),
        }
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.stop.take();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn is_client_disconnect(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<tungstenite::Error>()
            .is_some_and(|error| {
                matches!(
                    error,
                    tungstenite::Error::ConnectionClosed
                        | tungstenite::Error::AlreadyClosed
                        | tungstenite::Error::Io(_)
                )
            })
    })
}

struct WebSocketConnection {
    socket: WebSocket<TcpStream>,
}

impl WebSocketConnection {
    fn accept(mut stream: TcpStream, auth_token: &str) -> Result<Self> {
        stream
            .set_read_timeout(Some(Duration::from_secs(WEBSOCKET_READ_TIMEOUT_SEC)))
            .context("Failed to set WebSocket read timeout")?;
        enable_tcp_keepalive(&stream);
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_WEBSOCKET_TEXT_FRAME_BYTES))
            .max_frame_size(Some(MAX_WEBSOCKET_TEXT_FRAME_BYTES))
            .max_write_buffer_size(MAX_WEBSOCKET_WRITE_BUFFER_BYTES)
            .accept_unmasked_frames(false);
        let (request, tail) = read_websocket_upgrade(&mut stream)?;
        if !websocket_request_path_is_authorized(&request, auth_token) {
            let _ = write_websocket_error_response(&mut stream, StatusCode::UNAUTHORIZED);
            bail!("Unauthorized WebSocket path.");
        }
        let response = create_response(&request).context("Invalid WebSocket upgrade request")?;
        write_response(&mut stream, &response)
            .context("Failed writing WebSocket upgrade response")?;
        stream
            .flush()
            .context("Failed flushing WebSocket upgrade response")?;
        stream
            .set_read_timeout(Some(Duration::from_secs(WEBSOCKET_IDLE_READ_TIMEOUT_SEC)))
            .context("Failed to set WebSocket idle read timeout")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(WEBSOCKET_WRITE_TIMEOUT_SEC)))
            .context("Failed to set WebSocket write timeout")?;
        let socket = WebSocket::from_partially_read(stream, tail, Role::Server, Some(config));
        Ok(Self { socket })
    }

    fn recv_text(&mut self) -> Result<Option<String>> {
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => return Ok(Some(text.to_string())),
                Ok(Message::Binary(_)) => bail!("Binary WebSocket requests are not supported."),
                Ok(Message::Close(_)) => return Ok(None),
                Ok(Message::Ping(payload)) => self.socket.send(Message::Pong(payload))?,
                Ok(Message::Pong(_) | Message::Frame(_)) => {}
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return Ok(None);
                }
                Err(tungstenite::Error::Io(err))
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    self.socket
                        .send(Message::Ping(Vec::new().into()))
                        .context("Failed pinging idle WebSocket peer")?;
                }
                Err(err) => return Err(err).context("Failed reading WebSocket request"),
            }
        }
    }

    fn send_progress(
        &mut self,
        request_id: &str,
        phase: &str,
        message: impl Into<String>,
        started: Instant,
    ) -> Result<()> {
        self.send_json(&json!({
            "type": "progress",
            "requestId": request_id,
            "phase": phase,
            "message": message.into(),
            "elapsedSec": round_secs(started.elapsed().as_secs_f64()),
        }))
    }

    fn send_json(&mut self, payload: &Value) -> Result<()> {
        let body = serde_json::to_vec(payload)?;
        let text = String::from_utf8(body).context("WebSocket JSON payload was not UTF-8")?;
        self.socket.send(Message::Text(text.into()))?;
        Ok(())
    }

    fn send_binary(&mut self, payload: Vec<u8>) -> Result<()> {
        self.socket.send(Message::Binary(payload.into()))?;
        Ok(())
    }

    fn close(&mut self) -> Result<()> {
        self.socket.close(None)?;
        Ok(())
    }
}

fn websocket_request_path_is_authorized(request: &Request, auth_token: &str) -> bool {
    let uri = request.uri();
    let Some(path_token) = uri.path().strip_prefix('/') else {
        return false;
    };
    constant_time_eq(path_token.as_bytes(), auth_token.as_bytes()) && uri.query().is_none()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in a.iter().zip(b) {
        difference |= left ^ right;
    }
    difference == 0
}

fn enable_tcp_keepalive(stream: &TcpStream) {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let enabled: libc::c_int = 1;
        let result = unsafe {
            libc::setsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_KEEPALIVE,
                std::ptr::from_ref(&enabled).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            )
        };
        if result != 0 {
            eprintln!(
                "Failed to enable SO_KEEPALIVE on WebSocket connection: {}",
                std::io::Error::last_os_error()
            );
        }
    }
    #[cfg(not(unix))]
    let _ = stream;
}

fn read_websocket_upgrade(stream: &mut TcpStream) -> Result<(Request, Vec<u8>)> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1_024];
    let deadline = Instant::now() + Duration::from_secs(WEBSOCKET_HANDSHAKE_DEADLINE_SEC);
    loop {
        if Instant::now() > deadline {
            let _ = write_websocket_error_response(stream, StatusCode::REQUEST_TIMEOUT);
            bail!("WebSocket handshake exceeded the total handshake deadline.");
        }
        let read = stream.read(&mut buffer)?;
        ensure!(read > 0, "WebSocket client disconnected during handshake.");
        request.extend_from_slice(&buffer[..read]);
        if request.len() > MAX_WEBSOCKET_HANDSHAKE_BYTES {
            let _ = write_websocket_error_response(stream, StatusCode::PAYLOAD_TOO_LARGE);
            bail!("WebSocket handshake exceeded the maximum header size.");
        }
        if let Some((header_len, parsed)) =
            Request::try_parse(&request).context("Invalid WebSocket handshake request")?
        {
            let tail = request.split_off(header_len);
            return Ok((parsed, tail));
        }
    }
}

fn write_websocket_error_response(stream: &mut TcpStream, status: StatusCode) -> Result<()> {
    let response = Response::builder()
        .status(status)
        .header("Connection", "close")
        .body(())?;
    write_response(&mut *stream, &response)?;
    stream.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_base64_with_channels(channels: u16, sample_rate: u32, samples: &[i16]) -> String {
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            for sample in samples {
                writer.write_sample(*sample).unwrap();
            }
            writer.finalize().unwrap();
        }
        BASE64.encode(cursor.into_inner())
    }

    fn wav_base64(sample_rate: u32, samples: &[i16]) -> String {
        wav_base64_with_channels(1, sample_rate, samples)
    }

    fn npy_base64_with_header(header: &str, data: &[u8]) -> String {
        let header_len = u16::try_from(header.len()).unwrap();
        let mut bytes = Vec::with_capacity(10 + header.len() + data.len());
        bytes.extend_from_slice(b"\x93NUMPY");
        bytes.extend_from_slice(&[1, 0]);
        bytes.extend_from_slice(&header_len.to_le_bytes());
        bytes.extend_from_slice(header.as_bytes());
        bytes.extend_from_slice(data);
        BASE64.encode(bytes)
    }

    fn npy_base64_i32(codes: &[i32]) -> String {
        let header = format!(
            "{{'descr': '<i4', 'fortran_order': False, 'shape': ({},), }}\n",
            codes.len()
        );
        let data = codes
            .iter()
            .flat_map(|code| code.to_le_bytes())
            .collect::<Vec<_>>();
        npy_base64_with_header(&header, &data)
    }

    fn output_with(
        samples: Vec<f32>,
        sample_rate: usize,
        streamed_audio: Option<StreamedAudioSummary>,
    ) -> GenerationOutput {
        GenerationOutput {
            samples,
            sample_rate,
            model_repo: "test/repo".to_string(),
            device: None,
            warnings: Vec::new(),
            streamed_audio,
            phase_timings: serde_json::Map::new(),
        }
    }

    #[test]
    fn qwen_payload_rejects_removed_controls() {
        let payload = json!({
            "text": "Hello",
            "modelRepo": QWEN3_MLX_CUSTOMVOICE_06B_MODEL,
            "modelPath": "/model",
            "deviceMap": "auto",
        });
        assert!(serde_json::from_value::<Qwen3Payload>(payload).is_err());
    }

    #[test]
    fn qwen_reference_fields_enforce_rust_transport_limits() {
        assert!(validate_qwen_reference_fields("matching words", "AQID").is_ok());
        assert!(
            validate_qwen_reference_fields(&"x".repeat(MAX_REFERENCE_TEXT_CHARS + 1), "AQID")
                .unwrap_err()
                .to_string()
                .contains("between 1 and 2000 characters")
        );
        assert!(
            ensure_reference_audio_base64_len(MAX_REFERENCE_AUDIO_BASE64_CHARS + 1)
                .unwrap_err()
                .to_string()
                .contains("60000000-character")
        );
        assert!(validate_qwen_reference_cache_key("reader-job-1").is_ok());
        assert!(validate_qwen_reference_cache_key("bad/key").is_err());
        assert!(validate_qwen_reference_cache_key(&"x".repeat(121)).is_err());
    }

    #[test]
    fn prepare_neutts_reference_samples_resamples_to_encoder_rate() {
        let encoded = wav_base64(48_000, &vec![1_000_i16; 48_000]);
        let (samples, truncated) = prepare_neutts_reference_samples(&encoded).unwrap();
        assert!(!truncated);
        assert!(samples.len().abs_diff(neutts::ENCODER_SAMPLE_RATE as usize) <= 2);
    }

    #[test]
    fn prepare_neutts_reference_samples_truncates_to_encoder_window() {
        let encoded = wav_base64(16_000, &vec![1_000_i16; 16_000 * 25]);
        let (samples, truncated) = prepare_neutts_reference_samples(&encoded).unwrap();
        assert!(truncated);
        assert_eq!(samples.len(), neucodec_encoder::ENCODER_WINDOW_SAMPLES);
    }

    #[test]
    fn prepare_neutts_reference_samples_rejects_invalid_input() {
        assert!(prepare_neutts_reference_samples("not base64!").is_err());
        assert!(prepare_neutts_reference_samples(&BASE64.encode(b"not a wav file")).is_err());
        let too_slow = wav_base64(1, &[0]);
        assert!(
            prepare_neutts_reference_samples(&too_slow)
                .unwrap_err()
                .to_string()
                .contains("between 8000 and 192000")
        );
        let too_fast = wav_base64(192_001, &[0]);
        assert!(prepare_neutts_reference_samples(&too_fast).is_err());
        let three_channels = wav_base64_with_channels(3, 24_000, &[0, 0, 0]);
        assert!(prepare_neutts_reference_samples(&three_channels).is_err());
        let too_short = wav_base64(16_000, &vec![0; 7_999]);
        assert!(
            prepare_neutts_reference_samples(&too_short)
                .unwrap_err()
                .to_string()
                .contains("at least half a second")
        );
    }

    #[test]
    fn decode_neutts_reference_codes_accepts_bounded_integer_codes() {
        let encoded = npy_base64_i32(&[0, 42, MAX_NEUTTS_REFERENCE_CODE_VALUE]);
        assert_eq!(
            decode_neutts_reference_codes(&encoded).unwrap(),
            vec![0, 42, MAX_NEUTTS_REFERENCE_CODE_VALUE]
        );
    }

    #[test]
    fn decode_neutts_reference_codes_rejects_shape_overflow() {
        let header = format!(
            "{{'descr': '<i4', 'fortran_order': False, 'shape': ({}, 2), }}\n",
            usize::MAX
        );
        let encoded = npy_base64_with_header(&header, &[]);
        assert!(
            decode_neutts_reference_codes(&encoded)
                .unwrap_err()
                .to_string()
                .contains("shape dimensions overflowed")
        );
    }

    #[test]
    fn decode_neutts_reference_codes_rejects_oversized_valid_array() {
        let encoded = npy_base64_i32(&vec![0; MAX_NEUTTS_REFERENCE_CODES + 1]);
        assert!(
            decode_neutts_reference_codes(&encoded)
                .unwrap_err()
                .to_string()
                .contains("between 1 and 1000 codes")
        );
    }

    #[test]
    fn decode_neutts_reference_codes_rejects_out_of_range_values() {
        let encoded = npy_base64_i32(&[-1, MAX_NEUTTS_REFERENCE_CODE_VALUE + 1]);
        assert!(
            decode_neutts_reference_codes(&encoded)
                .unwrap_err()
                .to_string()
                .contains("between 0 and 65535")
        );
    }

    #[test]
    fn normalize_neutts_model_enforces_allowlist() {
        assert_eq!(normalize_neutts_model(None).unwrap(), NEUTTS_DEFAULT_MODEL);
        assert!(normalize_neutts_model(Some("neuphonic/neutts-nano-q8-gguf")).is_ok());
        assert!(normalize_neutts_model(Some("evil/model")).is_err());
    }

    #[test]
    fn validate_generation_output_accepts_buffered_and_streamed_audio() {
        assert!(validate_generation_output(&output_with(vec![0.0; 4], 24_000, None)).is_ok());
        assert!(
            validate_generation_output(&output_with(
                Vec::new(),
                24_000,
                Some(StreamedAudioSummary {
                    sample_count: 4,
                    audio_chunk_count: 1,
                }),
            ))
            .is_ok()
        );
    }

    #[test]
    fn validate_generation_output_rejects_empty_audio_and_zero_rate() {
        assert!(validate_generation_output(&output_with(Vec::new(), 24_000, None)).is_err());
        assert!(validate_generation_output(&output_with(vec![0.0; 4], 0, None)).is_err());
    }

    #[test]
    fn elapsed_phase_timing_excludes_milestones() {
        assert!(is_elapsed_phase_timing("modelLoadSec"));
        assert!(is_elapsed_phase_timing("inferenceSec"));
        assert!(!is_elapsed_phase_timing("firstAudioSec"));
    }

    #[test]
    fn float32_transport_cleans_non_finite_samples_without_normalizing() {
        let bytes = float32_to_le_bytes(&[f32::NAN, f32::INFINITY, -1.5]);
        let samples = bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(samples, vec![0.0, 0.0, -1.5]);
    }

    #[test]
    fn websocket_request_path_requires_auth_token() {
        let allowed = Request::builder().uri("/secret").body(()).unwrap();
        let wrong_path = Request::builder().uri("/wrong").body(()).unwrap();
        let query = Request::builder().uri("/secret?x=1").body(()).unwrap();
        assert!(websocket_request_path_is_authorized(&allowed, "secret"));
        assert!(!websocket_request_path_is_authorized(&wrong_path, "secret"));
        assert!(!websocket_request_path_is_authorized(&query, "secret"));
    }

    #[test]
    fn websocket_bind_host_must_resolve_only_to_loopback() {
        let ipv4 = resolve_loopback_bind_addresses("127.0.0.1", 0).unwrap();
        assert!(ipv4.iter().all(|address| address.ip().is_loopback()));
        let ipv6 = resolve_loopback_bind_addresses("::1", 0).unwrap();
        assert!(ipv6.iter().all(|address| address.ip().is_loopback()));

        for host in ["0.0.0.0", "::", "192.0.2.1"] {
            assert!(
                resolve_loopback_bind_addresses(host, 0)
                    .unwrap_err()
                    .to_string()
                    .contains("loopback")
            );
        }
    }

    #[test]
    fn constant_time_eq_compares_bytes() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secre"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn websocket_frame_limit_covers_electron_reference_audio_payload() {
        assert!(MAX_WEBSOCKET_TEXT_FRAME_BYTES > 60_000_000);
    }

    #[test]
    fn qwen_transport_chunks_fit_the_websocket_write_buffer() {
        assert!(
            MAX_AUDIO_CHUNK_SAMPLES * std::mem::size_of::<f32>() < MAX_WEBSOCKET_WRITE_BUFFER_BYTES
        );
    }
}

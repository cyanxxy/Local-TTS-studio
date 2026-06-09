use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use candle_core::{DType, Device};
use clap::{Parser, ValueEnum};
use qwen_tts::io::ModelArgs;
use qwen_tts::model::loader::{LoaderConfig, ModelLoader};
use qwen_tts::model::options::CustomVoiceOptions;
use qwen_tts::synthesis::detect_mode::DetectedMode;
use serde::Deserialize;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RESULT_PREFIX: &str = "__RESULT__";
const PORT_PREFIX: &str = "__PORT__";
const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WEBSOCKET_TEXT_FRAME_BYTES: usize = 32 * 1024 * 1024;
const MAX_AUDIO_CHUNK_SAMPLES: usize = 262_144;
const QWEN3_AUTO_MODEL: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice";
const QWEN3_MLX_CUSTOMVOICE_06B_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
const QWEN3_MLX_CUSTOMVOICE_17B_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit";
const QWEN3_MLX_BASE_06B_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
const QWEN3_MLX_BASE_17B_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-6bit";
// The model's `talker_config.spk_id` keys are lowercase (ryan, vivian, serena,
// uncle_fu, aiden, ono_anna, sohee, eric, dylan) and `validate_speaker_value`
// is case-sensitive. The UI/IPC keep capitalized display names; the bridge
// lowercases before generation (see `qwen3_speaker_id`). Keep this default
// lowercase so the no-speaker fallback also matches a real spk_id key.
const QWEN3_DEFAULT_SPEAKER: &str = "ryan";
const QWEN3_DEFAULT_LANGUAGE: &str = "English";
const QWEN3_DEFAULT_MAX_NEW_TOKENS: usize = 1536;
const QWEN3_CUSTOM_VOICE_MAX_UNIT_CHARS: usize = 420;
const QWEN3_MLX_API_SERVER_START_TIMEOUT_SEC: u64 = 180;
const QWEN3_MLX_API_SERVER_HEALTH_REQUEST_TIMEOUT_SEC: u64 = 3;
// Generous inactivity deadline for child-process output: first-run model
// downloads and slow CPU inference legitimately go quiet for a long time, but a
// wedged child must eventually surface an error instead of hanging forever
// (the stderr heartbeat would otherwise re-arm the host watchdog indefinitely).
const CHILD_OUTPUT_INACTIVITY_TIMEOUT_SEC: u64 = 600;
const WEBSOCKET_HANDSHAKE_READ_TIMEOUT_SEC: u64 = 10;
const QWEN3_CUSTOM_VOICE_MIN_SENTENCE_CHARS: usize = 40;
const NEUTTS_DEFAULT_MODEL: &str = "neuphonic/neutts-nano-q4-gguf";
const WORKER_FRAME_HEADER_BYTES: usize = 9;
const WORKER_INPUT_SPEAK: u8 = 1;
const WORKER_INPUT_SHUTDOWN: u8 = 3;
const WORKER_OUTPUT_READY: u8 = 1;
const WORKER_OUTPUT_AUDIO_START: u8 = 2;
const WORKER_OUTPUT_AUDIO_CHUNK: u8 = 3;
const WORKER_OUTPUT_AUDIO_DONE: u8 = 4;
const WORKER_OUTPUT_ERROR: u8 = 5;

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
    #[arg(long)]
    auth_token: Option<String>,
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
#[serde(rename_all = "camelCase")]
struct WebSocketRequest {
    request_id: Option<String>,
    payload: Option<Value>,
    command: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Qwen3Payload {
    text: String,
    mode: Option<String>,
    model_repo: Option<String>,
    base_model_path: Option<String>,
    reference_audio_base64: Option<String>,
    reference_text: Option<String>,
    speaker: Option<String>,
    language: Option<String>,
    instruct: Option<String>,
    device_map: Option<String>,
    dtype: Option<String>,
    attn_implementation: Option<String>,
    temperature: Option<f64>,
    top_k: Option<usize>,
    top_p: Option<f64>,
    max_new_tokens: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NeuttsPayload {
    text: String,
    reference_text: String,
    reference_codes_base64: String,
    model_repo: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct Qwen3Key {
    model_repo: String,
    dtype: String,
    device: String,
    attention: String,
}

struct Qwen3Host {
    key: Qwen3Key,
    model: qwen_tts::model::Model,
}

#[derive(Debug, Clone, PartialEq)]
struct Qwen3MlxKey {
    worker_path: PathBuf,
    model_path: PathBuf,
    reference_audio_digest: String,
    reference_text: String,
    language: String,
    output_sample_rate: u32,
    block_size: usize,
    streaming_chunk_size: usize,
    top_k: usize,
    max_new_tokens: usize,
    temperature: String,
}

struct Qwen3MlxWorkerHost {
    key: Qwen3MlxKey,
    child: Child,
    stdin: ChildStdin,
    /// Frames parsed from the worker's stdout on a dedicated reader thread, so
    /// receives can carry an inactivity deadline (`recv_worker_frame`). The
    /// channel disconnects on stdout EOF; the thread exits with it.
    frames: mpsc::Receiver<Result<WorkerFrame>>,
    next_request_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Qwen3MlxApiServerKey {
    api_server_path: PathBuf,
    model_path: PathBuf,
}

struct Qwen3MlxApiServerHost {
    key: Qwen3MlxApiServerKey,
    child: Child,
    host: String,
    port: u16,
}

struct NeuttsHost {
    model_repo: String,
    model: neutts::NeuTTS,
}

struct RuntimeState {
    model: LocalModel,
    cache_dir: PathBuf,
    qwen3: Option<Qwen3Host>,
    qwen3_mlx: Option<Qwen3MlxWorkerHost>,
    qwen3_mlx_api: Option<Qwen3MlxApiServerHost>,
    neutts: Option<NeuttsHost>,
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

struct SelectedQwen3Device {
    resolved: String,
    device: Device,
    warnings: Vec<String>,
}

struct StreamedAudioSummary {
    sample_count: usize,
    audio_chunk_count: usize,
}

struct WorkerFrame {
    frame_type: u8,
    request_id: u32,
    payload: Vec<u8>,
}

struct Qwen3ReferenceAudio {
    path: PathBuf,
    digest: String,
}

struct Qwen3MlxWorkerConfig<'a> {
    worker_path: &'a PathBuf,
    model_path: &'a PathBuf,
    reference_audio_path: &'a PathBuf,
    reference_text: &'a str,
    language: &'a str,
    output_sample_rate: u32,
    block_size: usize,
    streaming_chunk_size: usize,
    top_k: usize,
    max_new_tokens: usize,
    temperature: f64,
}

struct Qwen3MlxStreamResult {
    sample_rate: usize,
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
        let details = format!("{err:#}");
        let _ = emit_result(&json!({
            "ok": false,
            "error": err.to_string(),
            "details": details,
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
        LocalModel::Qwen3 => json!({
            "ready": true,
            "message": "Rust Qwen3-TTS runtime is ready. Model files download on first generation.",
            "runtime": "rust",
            "package": "qwen_tts",
            "packageVersion": "0.1.1",
            "recommendedModelRepo": QWEN3_MLX_CUSTOMVOICE_06B_MODEL,
            "recommendedBaseModelRepo": QWEN3_MLX_BASE_06B_MODEL,
            "recommendedDeviceMap": "auto",
            "recommendedDtype": "auto",
            "recommendedAttention": "eager",
            "warnings": [
                "Qwen3 defaults to the upstream MLX CustomVoice 6-bit profile on Apple Silicon when OPEN_TTS_QWEN3_MLX_API_SERVER (or OPEN_TTS_QWEN3_MLX_TTS) and a local MLX model directory are configured.",
                "Candle CustomVoice remains available as a fallback, and Base voice cloning uses pibot-tts-worker when explicitly selected."
            ],
        }),
        LocalModel::Neutts => json!({
            "ready": true,
            "message": "Rust NeuTTS runtime is ready. Upload pre-encoded NeuCodec .npy reference codes before generating.",
            "runtime": "rust",
            "package": "neutts",
            "packageVersion": "0.1.1",
            "recommendedModelRepo": NEUTTS_DEFAULT_MODEL,
            "warnings": [
                "WAV reference encoding is not available in the Rust NeuTTS crate; use pre-encoded .npy reference codes."
            ],
        }),
    };

    emit_result(&json!({ "ok": true, "result": result }))?;
    Ok(())
}

fn run_websocket_server(cli: &Cli) -> Result<()> {
    let auth_token = cli
        .auth_token
        .as_deref()
        .filter(|token| !token.is_empty())
        .context("WebSocket bridge requires a non-empty --auth-token.")?;

    std::fs::create_dir_all(&cli.cache_dir).with_context(|| {
        format!(
            "Failed to create cache directory {}",
            cli.cache_dir.display()
        )
    })?;

    let listener = TcpListener::bind((cli.host.as_str(), cli.port)).with_context(|| {
        format!(
            "Failed to bind WebSocket bridge on {}:{}",
            cli.host, cli.port
        )
    })?;
    let port = listener
        .local_addr()
        .context("Failed reading WebSocket bridge listener address")?
        .port();
    println!("{PORT_PREFIX}{port}");
    std::io::stdout()
        .flush()
        .context("Failed announcing WebSocket bridge port")?;

    let mut state = RuntimeState {
        model: cli.model,
        cache_dir: cli.cache_dir.clone(),
        qwen3: None,
        qwen3_mlx: None,
        qwen3_mlx_api: None,
        neutts: None,
    };

    loop {
        let (stream, _) = listener
            .accept()
            .context("Failed accepting WebSocket client")?;
        let _ = stream.set_nodelay(true);
        let mut websocket = WebSocketConnection::new(stream);
        let should_shutdown = match websocket.handshake(auth_token) {
            Ok(()) => serve_websocket_connection(&mut websocket, &mut state)?,
            Err(err) => {
                let _ = websocket.send_json(&json!({
                    "type": "error",
                    "ok": false,
                    "error": "WebSocket bridge failed.",
                    "details": err.to_string(),
                }));
                false
            }
        };
        let _ = websocket.close();
        if should_shutdown {
            break;
        }
    }

    Ok(())
}

fn serve_websocket_connection(
    websocket: &mut WebSocketConnection,
    state: &mut RuntimeState,
) -> Result<bool> {
    while let Some(raw_message) = websocket.recv_text()? {
        let request: WebSocketRequest = match serde_json::from_str(&raw_message) {
            Ok(value) => value,
            Err(_) => {
                websocket.send_json(&json!({
                    "type": "error",
                    "ok": false,
                    "error": "Invalid WebSocket request JSON.",
                }))?;
                continue;
            }
        };

        if request.command.as_deref() == Some("shutdown") {
            return Ok(true);
        }

        let request_id = request.request_id.unwrap_or_default();
        let payload = request.payload.unwrap_or(Value::Null);
        // Model download and CPU inference are single blocking calls that emit no
        // intermediate frames. The host re-arms its inactivity watchdog on any
        // stdout/stderr from the child, so emit a lightweight stderr heartbeat for
        // the duration of the blocking work to keep legitimate long-running
        // generations (multi-GB first-run download, slow CPU inference) alive.
        // The heartbeat stops before any result/audio frame is written, so it
        // never interleaves with the WebSocket stream.
        let outcome = {
            let _heartbeat = Heartbeat::start();
            state.generate(&request_id, payload, websocket)
        };
        match outcome {
            Ok(output) => send_generation_result(websocket, &request_id, output)?,
            Err(err) => {
                websocket.send_json(&json!({
                    "type": "result",
                    "requestId": request_id,
                    "ok": false,
                    "error": err.to_string(),
                    "details": format!("{err:#}"),
                }))?;
            }
        }
    }

    Ok(false)
}

impl RuntimeState {
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

    fn generate_qwen3(
        &mut self,
        request_id: &str,
        payload: Value,
        websocket: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        let payload: Qwen3Payload =
            serde_json::from_value(payload).context("Invalid Qwen3 payload")?;
        if payload.text.trim().is_empty() {
            bail!("Text to synthesize is empty.");
        }
        let model_repo = normalize_qwen3_model(payload.model_repo.as_deref())?;
        if payload.mode.as_deref() == Some("voiceClone") {
            return self.generate_qwen3_voice_clone(request_id, payload, websocket);
        }
        if is_qwen3_mlx_custom_voice_model(&model_repo) {
            return self
                .generate_qwen3_mlx_custom_voice(request_id, payload, model_repo, websocket);
        }
        let started = Instant::now();
        let mut phase_timings = serde_json::Map::new();
        // Display speaker names are capitalized in the UI; the model's spk_id keys
        // are lowercase and validation is case-sensitive, so normalize here.
        let speaker = qwen3_speaker_id(payload.speaker.as_deref().unwrap_or(QWEN3_DEFAULT_SPEAKER));
        let language = normalize_qwen3_language(
            payload
                .language
                .as_deref()
                .unwrap_or(QWEN3_DEFAULT_LANGUAGE),
        )?;
        let selected_device = select_qwen3_device(payload.device_map.as_deref())?;
        let dtype = normalize_qwen3_dtype(payload.dtype.as_deref(), &selected_device.resolved)?;
        let attention = normalize_qwen3_attention(payload.attn_implementation.as_deref())?;
        let key = Qwen3Key {
            model_repo: model_repo.clone(),
            dtype: dtype.clone(),
            device: selected_device.resolved.clone(),
            attention,
        };

        websocket.send_progress(
            request_id,
            "model_load",
            format!(
                "Loading Rust Qwen3 model on {}: {model_repo}",
                selected_device.resolved
            ),
            started,
        )?;
        let load_started = Instant::now();
        self.ensure_qwen3_model(&key, &selected_device.device)?;
        phase_timings.insert(
            "modelLoadSec".to_string(),
            json!(round_secs(load_started.elapsed().as_secs_f64())),
        );

        let host = self.qwen3.as_ref().context("Qwen3 model was not loaded")?;
        let options = CustomVoiceOptions {
            max_new_tokens: Some(
                payload
                    .max_new_tokens
                    .unwrap_or(QWEN3_DEFAULT_MAX_NEW_TOKENS),
            ),
            temperature: payload.temperature,
            top_k: payload.top_k,
            top_p: payload.top_p,
            non_streaming_mode: Some(true),
            ..Default::default()
        };

        let units = qwen3_custom_voice_units(payload.text.trim());
        let mut sample_rate = 0_usize;
        let mut sample_count = 0_usize;
        let mut audio_chunk_count = 0_usize;
        let mut inference_sec = 0_f64;
        let mut output_encoding_sec = 0_f64;
        for (index, unit) in units.iter().enumerate() {
            websocket.send_progress(
                request_id,
                "inference",
                format!(
                    "Running Rust Qwen3 inference chunk {}/{}...",
                    index + 1,
                    units.len()
                ),
                started,
            )?;
            let inference_started = Instant::now();
            let result = host
                .model
                .generate_custom_voice_from_text(
                    unit,
                    &speaker,
                    &language,
                    payload.instruct.as_deref(),
                    Some(options.clone()),
                )
                .map_err(|err| anyhow::anyhow!("Qwen3 generation failed: {err}"))?;
            inference_sec += inference_started.elapsed().as_secs_f64();

            if sample_rate == 0 {
                sample_rate = result.sample_rate;
            } else if sample_rate != result.sample_rate {
                bail!(
                    "Qwen3 generation returned inconsistent sample rates: {} then {}.",
                    sample_rate,
                    result.sample_rate
                );
            }

            let output_started = Instant::now();
            let samples = result
                .audio
                .flatten_all()
                .and_then(|audio| audio.to_dtype(DType::F32))
                .and_then(|audio| audio.to_vec1::<f32>())
                .map_err(|err| anyhow::anyhow!("Failed to read Qwen3 audio tensor: {err}"))?;
            output_encoding_sec += output_started.elapsed().as_secs_f64();
            if samples.is_empty() {
                bail!("Qwen3 generation produced an empty audio chunk.");
            }

            let silence_after_samples = if index + 1 < units.len() {
                (sample_rate as f64 * 0.2).round() as usize
            } else {
                0
            };
            websocket.send_json(&json!({
                "type": "audio_chunk",
                "requestId": request_id,
                "index": index,
                "total": units.len(),
                "sampleRate": sample_rate,
                "sampleCount": samples.len(),
                "silenceAfterSamples": silence_after_samples,
            }))?;
            websocket.send_binary(&float32_to_le_bytes(&samples))?;
            if index == 0 {
                phase_timings.insert(
                    "firstAudioSec".to_string(),
                    json!(round_secs(started.elapsed().as_secs_f64())),
                );
            }
            sample_count += samples.len() + silence_after_samples;
            audio_chunk_count += 1;
        }
        phase_timings.insert("inferenceSec".to_string(), json!(round_secs(inference_sec)));
        phase_timings.insert(
            "outputEncodingSec".to_string(),
            json!(round_secs(output_encoding_sec)),
        );

        Ok(GenerationOutput {
            samples: Vec::new(),
            sample_rate,
            model_repo,
            device: Some(selected_device.resolved),
            warnings: selected_device.warnings,
            streamed_audio: Some(StreamedAudioSummary {
                sample_count,
                audio_chunk_count,
            }),
            phase_timings,
        })
    }

    fn generate_qwen3_mlx_custom_voice(
        &mut self,
        request_id: &str,
        payload: Qwen3Payload,
        model_repo: String,
        websocket: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        let started = Instant::now();
        let mut phase_timings = serde_json::Map::new();
        let model_path = resolve_qwen3_mlx_model_path(
            payload.base_model_path.as_deref(),
            "Qwen3 MLX CustomVoice",
        )?;
        let speaker = qwen3_speaker_id(payload.speaker.as_deref().unwrap_or(QWEN3_DEFAULT_SPEAKER));
        let language = normalize_qwen3_language(
            payload
                .language
                .as_deref()
                .unwrap_or(QWEN3_DEFAULT_LANGUAGE),
        )?;
        let instruct = payload
            .instruct
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if let Ok(api_server_path) = resolve_qwen3_mlx_api_server_path() {
            let key = Qwen3MlxApiServerKey {
                api_server_path,
                model_path: stable_path(&model_path),
            };
            websocket.send_progress(
                request_id,
                "model_load",
                format!(
                    "Loading Qwen3 MLX CustomVoice model: {}",
                    model_path.display()
                ),
                started,
            )?;
            let model_load_started = Instant::now();
            self.ensure_qwen3_mlx_api_server(key)?;
            phase_timings.insert(
                "modelLoadSec".to_string(),
                json!(round_secs(model_load_started.elapsed().as_secs_f64())),
            );

            websocket.send_progress(
                request_id,
                "inference",
                "Running Qwen3 MLX CustomVoice inference…",
                started,
            )?;
            let inference_started = Instant::now();
            let (host, port) = {
                let host = self
                    .qwen3_mlx_api
                    .as_ref()
                    .context("Qwen3 MLX api_server host missing after startup.")?;
                (host.host.clone(), host.port)
            };
            let stream_result = stream_qwen3_mlx_api_speech(
                &host,
                port,
                payload.text.trim(),
                &speaker,
                &language,
                instruct,
                websocket,
                request_id,
                started,
                &mut phase_timings,
            );
            if stream_result.is_err() {
                // A failed request can leave the resident api_server dead or in
                // a bad state; evict it (Drop kills the child) so the next
                // request respawns a fresh server.
                self.qwen3_mlx_api.take();
            }
            let stream_result = stream_result?;
            phase_timings.insert(
                "inferenceSec".to_string(),
                json!(round_secs(inference_started.elapsed().as_secs_f64())),
            );

            return Ok(GenerationOutput {
                samples: Vec::new(),
                sample_rate: stream_result.sample_rate,
                model_repo,
                device: Some("mlx".to_string()),
                warnings: Vec::new(),
                streamed_audio: Some(StreamedAudioSummary {
                    sample_count: stream_result.sample_count,
                    audio_chunk_count: stream_result.audio_chunk_count,
                }),
                phase_timings,
            });
        }

        self.generate_qwen3_mlx_custom_voice_via_tts(
            request_id,
            payload.text.trim(),
            model_repo,
            model_path,
            speaker,
            language,
            instruct,
            websocket,
            started,
            phase_timings,
        )
    }

    fn generate_qwen3_mlx_custom_voice_via_tts(
        &mut self,
        request_id: &str,
        text: &str,
        model_repo: String,
        model_path: PathBuf,
        speaker: String,
        language: String,
        instruct: Option<&str>,
        websocket: &mut WebSocketConnection,
        started: Instant,
        mut phase_timings: serde_json::Map<String, Value>,
    ) -> Result<GenerationOutput> {
        let tts_path = resolve_qwen3_mlx_tts_path()?;
        let units = qwen3_custom_voice_units(text);
        if units.is_empty() {
            bail!("Qwen3 MLX CustomVoice received empty text.");
        }

        websocket.send_progress(
            request_id,
            "inference",
            format!(
                "Running upstream Qwen3 MLX CustomVoice tts ({} units): {}",
                units.len(),
                model_path.display()
            ),
            started,
        )?;
        let inference_started = Instant::now();
        let mut sample_rate = 0_usize;
        let mut sample_count = 0_usize;
        let mut audio_chunk_count = 0_usize;

        for (index, unit) in units.iter().enumerate() {
            let run_dir = create_qwen3_mlx_run_dir(&self.cache_dir, request_id)?;
            let mut command = Command::new(&tts_path);
            command
                .arg(&model_path)
                .arg(unit)
                .arg(&speaker)
                .arg(&language)
                .current_dir(&run_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(instruct) = instruct {
                command.arg(instruct);
            }

            let output = command.output().with_context(|| {
                format!(
                    "Failed to run Qwen3 MLX CustomVoice tts binary {}",
                    tts_path.display()
                )
            })?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                let _ = std::fs::remove_dir_all(&run_dir);
                bail!(
                    "Qwen3 MLX CustomVoice tts failed with status {}. {}{}",
                    output.status,
                    stderr.trim(),
                    if stdout.trim().is_empty() {
                        String::new()
                    } else {
                        format!(" stdout: {}", stdout.trim())
                    }
                );
            }

            let output_wav = run_dir.join("output.wav");
            let read_result = read_wav_as_f32(&output_wav);
            let _ = std::fs::remove_dir_all(&run_dir);
            let (samples, unit_sample_rate) = read_result?;
            if samples.is_empty() {
                bail!("Qwen3 MLX CustomVoice tts produced empty audio.");
            }
            if sample_rate == 0 {
                sample_rate = unit_sample_rate;
            } else if unit_sample_rate != sample_rate {
                bail!("Qwen3 MLX CustomVoice tts returned inconsistent sample rates.");
            }

            let silence_after_samples = if index + 1 < units.len() {
                sample_rate / 2
            } else {
                0
            };
            websocket.send_json(&json!({
                "type": "audio_chunk",
                "requestId": request_id,
                "index": index,
                "total": units.len(),
                "sampleRate": sample_rate,
                "sampleCount": samples.len(),
                "silenceAfterSamples": silence_after_samples,
            }))?;
            websocket.send_binary(&float32_to_le_bytes(&samples))?;
            if index == 0 {
                phase_timings.insert(
                    "firstAudioSec".to_string(),
                    json!(round_secs(started.elapsed().as_secs_f64())),
                );
            }
            sample_count += samples.len() + silence_after_samples;
            audio_chunk_count += 1;
        }

        phase_timings.insert(
            "inferenceSec".to_string(),
            json!(round_secs(inference_started.elapsed().as_secs_f64())),
        );
        phase_timings.insert("outputEncodingSec".to_string(), json!(0.0));

        Ok(GenerationOutput {
            samples: Vec::new(),
            sample_rate,
            model_repo,
            device: Some("mlx".to_string()),
            warnings: vec![
                "Qwen3 MLX CustomVoice fell back to one-shot tts because OPEN_TTS_QWEN3_MLX_API_SERVER is unavailable.".to_string(),
            ],
            streamed_audio: Some(StreamedAudioSummary {
                sample_count,
                audio_chunk_count,
            }),
            phase_timings,
        })
    }

    fn generate_qwen3_voice_clone(
        &mut self,
        request_id: &str,
        payload: Qwen3Payload,
        websocket: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        let started = Instant::now();
        let mut phase_timings = serde_json::Map::new();
        let model_repo = normalize_qwen3_model(payload.model_repo.as_deref())?;
        if !model_repo.contains("-Base-") {
            bail!("Qwen3 voice cloning requires a Base model repository.");
        }
        let model_path = if let Some(path) = payload
            .base_model_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            PathBuf::from(path)
        } else {
            std::env::var("OPEN_TTS_QWEN3_MLX_MODEL_DIR")
                .map(PathBuf::from)
                .context("Qwen3 Base voice cloning requires `baseModelPath` or OPEN_TTS_QWEN3_MLX_MODEL_DIR.")?
        };
        if !model_path.exists() {
            bail!(
                "Qwen3 Base voice clone model directory does not exist: {}",
                model_path.display()
            );
        }
        let worker_path = std::env::var("OPEN_TTS_QWEN3_MLX_WORKER")
            .map(PathBuf::from)
            .context("Qwen3 Base voice cloning requires OPEN_TTS_QWEN3_MLX_WORKER pointing to pibot-tts-worker.")?;
        if !worker_path.exists() {
            bail!(
                "Qwen3 MLX worker binary does not exist: {}",
                worker_path.display()
            );
        }
        let reference_text = payload
            .reference_text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .context("Qwen3 Base voice cloning requires referenceText.")?;
        let reference_audio = payload
            .reference_audio_base64
            .as_deref()
            .context("Qwen3 Base voice cloning requires referenceAudioBase64.")?;
        let reference_audio = self.write_qwen3_reference_audio(reference_audio)?;
        let language = normalize_qwen3_language(
            payload
                .language
                .as_deref()
                .unwrap_or(QWEN3_DEFAULT_LANGUAGE),
        )?;
        let output_sample_rate = 24_000_u32;
        let block_size = 512_usize;
        let streaming_chunk_size = 4_usize;
        let top_k = payload.top_k.unwrap_or(50);
        let max_new_tokens = payload
            .max_new_tokens
            .unwrap_or(QWEN3_DEFAULT_MAX_NEW_TOKENS);
        let temperature = payload.temperature.unwrap_or(0.9);
        let worker_path = stable_path(&worker_path);
        let model_path = stable_path(&model_path);
        let key = Qwen3MlxKey {
            worker_path: worker_path.clone(),
            model_path: model_path.clone(),
            reference_audio_digest: reference_audio.digest.clone(),
            reference_text: reference_text.to_string(),
            language: language.clone(),
            output_sample_rate,
            block_size,
            streaming_chunk_size,
            top_k,
            max_new_tokens,
            temperature: temperature.to_string(),
        };
        let is_reuse = self.qwen3_mlx.as_ref().is_some_and(|host| host.key == key);

        websocket.send_progress(
            request_id,
            "model_load",
            if is_reuse {
                format!(
                    "Reusing upstream Qwen3 MLX worker: {}",
                    model_path.display()
                )
            } else {
                format!(
                    "Starting upstream Qwen3 MLX worker: {}",
                    model_path.display()
                )
            },
            started,
        )?;
        let load_started = Instant::now();
        self.ensure_qwen3_mlx_worker(
            key,
            Qwen3MlxWorkerConfig {
                worker_path: &worker_path,
                model_path: &model_path,
                reference_audio_path: &reference_audio.path,
                reference_text,
                language: &language,
                output_sample_rate,
                block_size,
                streaming_chunk_size,
                top_k,
                max_new_tokens,
                temperature,
            },
        )?;
        phase_timings.insert(
            "modelLoadSec".to_string(),
            json!(round_secs(load_started.elapsed().as_secs_f64())),
        );

        websocket.send_progress(
            request_id,
            "inference",
            "Running upstream Qwen3 Base voice clone inference...",
            started,
        )?;
        let inference_started = Instant::now();
        let stream_result = {
            let host = self
                .qwen3_mlx
                .as_mut()
                .context("Qwen3 MLX worker was not started")?;
            stream_qwen3_mlx_request(
                host,
                request_id,
                payload.text.trim(),
                output_sample_rate as usize,
                websocket,
            )
        };
        if stream_result.is_err() {
            self.qwen3_mlx.take();
        }
        let stream_result = stream_result?;
        phase_timings.insert(
            "inferenceSec".to_string(),
            json!(round_secs(inference_started.elapsed().as_secs_f64())),
        );

        Ok(GenerationOutput {
            samples: Vec::new(),
            sample_rate: stream_result.sample_rate,
            model_repo,
            device: Some("mlx".to_string()),
            warnings: Vec::new(),
            streamed_audio: Some(StreamedAudioSummary {
                sample_count: stream_result.sample_count,
                audio_chunk_count: stream_result.audio_chunk_count,
            }),
            phase_timings,
        })
    }

    fn write_qwen3_reference_audio(&self, encoded: &str) -> Result<Qwen3ReferenceAudio> {
        let encoded = encoded.trim();
        let refs_dir = self.cache_dir.join("qwen3-voice-clone-refs");
        std::fs::create_dir_all(&refs_dir)
            .with_context(|| format!("Failed to create {}", refs_dir.display()))?;
        // Hash the base64 payload (not the decoded bytes) so repeat requests
        // with an already-cached reference skip the decode entirely.
        let mut hasher = Sha1::new();
        hasher.update(encoded.as_bytes());
        let digest = hasher.finalize();
        let digest = format!("{:x}", digest);
        let filename = format!("ref-{digest}.wav");
        let path = refs_dir.join(filename);
        if !path.exists() {
            let bytes = BASE64
                .decode(encoded)
                .context("Failed to decode Qwen3 reference WAV")?;
            // Write-then-rename so a crash mid-write can never leave a
            // truncated reference WAV that the exists() guard would reuse.
            let temp_path = refs_dir.join(format!("ref-{digest}.wav.tmp-{}", std::process::id()));
            std::fs::write(&temp_path, bytes).with_context(|| {
                format!(
                    "Failed to write Qwen3 reference WAV {}",
                    temp_path.display()
                )
            })?;
            std::fs::rename(&temp_path, &path).with_context(|| {
                format!("Failed to finalize Qwen3 reference WAV {}", path.display())
            })?;
        }
        Ok(Qwen3ReferenceAudio { path, digest })
    }

    fn ensure_qwen3_mlx_worker(
        &mut self,
        key: Qwen3MlxKey,
        config: Qwen3MlxWorkerConfig<'_>,
    ) -> Result<()> {
        if self.qwen3_mlx.as_ref().is_some_and(|host| host.key == key) {
            return Ok(());
        }

        self.qwen3_mlx.take();
        let mut child = Command::new(config.worker_path)
            .arg("--serve")
            .arg("--model-name")
            .arg(config.model_path)
            .arg("--ref-audio")
            .arg(config.reference_audio_path)
            .arg("--ref-text")
            .arg(config.reference_text)
            .arg("--language")
            .arg(config.language)
            .arg("--output-sample-rate")
            .arg(config.output_sample_rate.to_string())
            .arg("--temperature")
            .arg(config.temperature.to_string())
            .arg("--top-k")
            .arg(config.top_k.to_string())
            .arg("--max-new-tokens")
            .arg(config.max_new_tokens.to_string())
            .arg("--blocksize")
            .arg(config.block_size.to_string())
            .arg("--streaming-chunk-size")
            .arg(config.streaming_chunk_size.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| {
                format!(
                    "Failed to start Qwen3 MLX worker {}",
                    config.worker_path.display()
                )
            })?;

        if let Some(mut stderr) = child.stderr.take() {
            thread::spawn(move || {
                let _ = std::io::copy(&mut stderr, &mut std::io::stderr());
            });
        }

        let stdin = child
            .stdin
            .take()
            .context("Qwen3 MLX worker stdin was unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("Qwen3 MLX worker stdout was unavailable")?;
        let frames = spawn_worker_frame_reader(stdout);
        let startup = recv_worker_frame(&frames)
            .and_then(|frame| frame.context("Qwen3 MLX worker exited before ready."))
            .and_then(|frame| match frame.frame_type {
                WORKER_OUTPUT_READY => Ok(()),
                WORKER_OUTPUT_ERROR => bail!(
                    "Qwen3 MLX worker failed during startup: {}",
                    String::from_utf8_lossy(&frame.payload)
                ),
                other => bail!("Qwen3 MLX worker returned unexpected startup frame {other}."),
            });
        if let Err(err) = startup {
            // Don't leak the spawned worker when startup fails.
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }

        self.qwen3_mlx = Some(Qwen3MlxWorkerHost {
            key,
            child,
            stdin,
            frames,
            next_request_id: 1,
        });
        Ok(())
    }

    fn ensure_qwen3_mlx_api_server(&mut self, key: Qwen3MlxApiServerKey) -> Result<()> {
        // Reuse the resident server only if its child is still alive; a dead or
        // unknown-state child falls through and is replaced.
        if let Some(host) = self.qwen3_mlx_api.as_mut()
            && host.key == key
            && matches!(host.child.try_wait(), Ok(None))
        {
            return Ok(());
        }

        // Dropping the previous host kills and reaps its child.
        self.qwen3_mlx_api.take();

        let (child, port) = start_qwen3_mlx_api_server(&key)?;
        self.qwen3_mlx_api = Some(Qwen3MlxApiServerHost {
            key,
            child,
            host: "127.0.0.1".to_string(),
            port,
        });
        Ok(())
    }

    fn ensure_qwen3_model(&mut self, key: &Qwen3Key, device: &Device) -> Result<()> {
        if self.qwen3.as_ref().is_some_and(|host| host.key == *key) {
            return Ok(());
        }

        let mode = DetectedMode::CustomVoice {
            speaker: QWEN3_DEFAULT_SPEAKER.to_string(),
            instruct: None,
        };
        let model_args = ModelArgs {
            model: Some(key.model_repo.clone()),
            model_path: None,
            device: key.device.clone(),
            dtype: key.dtype.clone(),
        };
        let model_dir =
            qwen_tts::io::model_path::get_model_path(&model_args, &mode).with_context(|| {
                format!("Failed to resolve Qwen3 model files for {}", key.model_repo)
            })?;
        let loader = ModelLoader::from_local_dir(&model_dir).with_context(|| {
            format!(
                "Failed to inspect Qwen3 model directory {}",
                model_dir.display()
            )
        })?;
        let model = loader
            .load_tts_model(
                device,
                &LoaderConfig {
                    dtype: qwen3_candle_dtype(&key.dtype),
                    load_tokenizer: true,
                    load_text_tokenizer: true,
                    load_generate_config: true,
                    use_flash_attn: qwen3_attention_uses_flash(&key.attention),
                },
            )
            .with_context(|| format!("Failed to load Qwen3 model from {}", model_dir.display()))?;
        self.qwen3 = Some(Qwen3Host {
            key: key.clone(),
            model,
        });
        Ok(())
    }

    fn generate_neutts(
        &mut self,
        request_id: &str,
        payload: Value,
        websocket: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        let payload: NeuttsPayload =
            serde_json::from_value(payload).context("Invalid NeuTTS payload")?;
        if payload.text.trim().is_empty() {
            bail!("Text to synthesize is empty.");
        }
        let started = Instant::now();
        let mut phase_timings = serde_json::Map::new();
        let model_repo = normalize_neutts_model(payload.model_repo.as_deref())?;

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

        let reference_started = Instant::now();
        let reference_codes = decode_neutts_reference_codes(&payload.reference_codes_base64)?;
        phase_timings.insert(
            "referenceEncodingSec".to_string(),
            json!(round_secs(reference_started.elapsed().as_secs_f64())),
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
            warnings: Vec::new(),
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
    if sample_count == 0 || chunk_count == 0 {
        bail!("Generation produced no audio samples.");
    }
    Ok(())
}

fn send_generation_result(
    websocket: &mut WebSocketConnection,
    request_id: &str,
    mut output: GenerationOutput,
) -> Result<()> {
    // An invalid output is a per-request failure, not a server-fatal one:
    // report it as an ok:false result frame instead of propagating (which
    // would tear down the whole WebSocket server loop).
    if let Err(err) = validate_generation_output(&output) {
        websocket.send_json(&json!({
            "type": "result",
            "requestId": request_id,
            "ok": false,
            "error": err.to_string(),
            "details": format!("{err:#}"),
        }))?;
        return Ok(());
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
            websocket.send_binary(&float32_to_le_bytes(chunk))?;
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
    }))?;
    Ok(())
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
    let mut bytes = Vec::with_capacity(samples.len() * std::mem::size_of::<f32>());
    for sample in samples {
        let cleaned = if sample.is_finite() { *sample } else { 0.0 };
        bytes.extend_from_slice(&cleaned.to_le_bytes());
    }
    bytes
}

fn read_worker_frame(stdout: &mut ChildStdout) -> Result<Option<WorkerFrame>> {
    let mut header = [0_u8; WORKER_FRAME_HEADER_BYTES];
    if !read_exact_or_eof(stdout, &mut header)? {
        return Ok(None);
    }
    let frame_type = header[0];
    let request_id = u32::from_le_bytes(header[1..5].try_into()?);
    let payload_len = u32::from_le_bytes(header[5..9].try_into()?) as usize;
    let mut payload = vec![0_u8; payload_len];
    if payload_len > 0 {
        stdout
            .read_exact(&mut payload)
            .context("Qwen3 MLX worker frame ended early")?;
    }
    Ok(Some(WorkerFrame {
        frame_type,
        request_id,
        payload,
    }))
}

/// Parse worker frames from stdout on a dedicated thread so the consumer can
/// receive with an inactivity deadline. On EOF the sender is dropped (channel
/// disconnect); a read/parse error is forwarded once before the thread exits.
fn spawn_worker_frame_reader(mut stdout: ChildStdout) -> mpsc::Receiver<Result<WorkerFrame>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        loop {
            match read_worker_frame(&mut stdout) {
                Ok(Some(frame)) => {
                    if sender.send(Ok(frame)).is_err() {
                        return;
                    }
                }
                Ok(None) => return,
                Err(err) => {
                    let _ = sender.send(Err(err));
                    return;
                }
            }
        }
    });
    receiver
}

fn recv_worker_frame(frames: &mpsc::Receiver<Result<WorkerFrame>>) -> Result<Option<WorkerFrame>> {
    match frames.recv_timeout(Duration::from_secs(CHILD_OUTPUT_INACTIVITY_TIMEOUT_SEC)) {
        Ok(Ok(frame)) => Ok(Some(frame)),
        Ok(Err(err)) => Err(err),
        // Reader thread exited on stdout EOF: the worker is gone.
        Err(RecvTimeoutError::Disconnected) => Ok(None),
        Err(RecvTimeoutError::Timeout) => bail!(
            "Qwen3 MLX worker produced no output for {CHILD_OUTPUT_INACTIVITY_TIMEOUT_SEC}s; treating it as wedged."
        ),
    }
}

fn write_worker_frame<W: Write>(
    writer: &mut W,
    frame_type: u8,
    request_id: u32,
    payload: &[u8],
) -> Result<()> {
    let payload_len = u32::try_from(payload.len()).context("Qwen3 MLX worker payload too large")?;
    writer.write_all(&[frame_type])?;
    writer.write_all(&request_id.to_le_bytes())?;
    writer.write_all(&payload_len.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

fn pcm_i16_le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
        .collect()
}

fn stream_qwen3_mlx_request(
    host: &mut Qwen3MlxWorkerHost,
    request_id: &str,
    text: &str,
    fallback_sample_rate: usize,
    websocket: &mut WebSocketConnection,
) -> Result<Qwen3MlxStreamResult> {
    let worker_request_id = host.next_request_id;
    host.next_request_id = host.next_request_id.checked_add(1).unwrap_or(1).max(1);
    write_worker_frame(
        &mut host.stdin,
        WORKER_INPUT_SPEAK,
        worker_request_id,
        text.as_bytes(),
    )?;

    let mut sample_rate = fallback_sample_rate;
    let mut chunk_index = 0_usize;
    let mut sample_count = 0_usize;
    loop {
        let frame = recv_worker_frame(&host.frames)?
            .context("Qwen3 MLX worker exited before audio was complete.")?;
        if frame.request_id != worker_request_id {
            bail!(
                "Qwen3 MLX worker returned frame for unexpected request {}.",
                frame.request_id
            );
        }
        match frame.frame_type {
            WORKER_OUTPUT_AUDIO_START => {
                if frame.payload.len() == 4 {
                    sample_rate = u32::from_le_bytes(frame.payload[..4].try_into()?) as usize;
                }
            }
            WORKER_OUTPUT_AUDIO_CHUNK => {
                if frame.payload.len() % 2 != 0 {
                    bail!("Qwen3 MLX worker returned malformed PCM chunk.");
                }
                let samples = pcm_i16_le_to_f32(&frame.payload);
                sample_count += samples.len();
                websocket.send_json(&json!({
                    "type": "audio_chunk",
                    "requestId": request_id,
                    "index": chunk_index,
                    "total": 0,
                    "sampleRate": sample_rate,
                    "sampleCount": samples.len(),
                    "silenceAfterSamples": 0,
                }))?;
                websocket.send_binary(&float32_to_le_bytes(&samples))?;
                chunk_index += 1;
            }
            WORKER_OUTPUT_AUDIO_DONE => break,
            WORKER_OUTPUT_ERROR => bail!(
                "Qwen3 MLX worker failed: {}",
                String::from_utf8_lossy(&frame.payload)
            ),
            other => bail!("Qwen3 MLX worker returned unexpected frame {other}."),
        }
    }
    Ok(Qwen3MlxStreamResult {
        sample_rate,
        sample_count,
        audio_chunk_count: chunk_index,
    })
}

fn resolve_qwen3_mlx_model_path(input: Option<&str>, label: &str) -> Result<PathBuf> {
    let model_path = if let Some(path) = input.map(str::trim).filter(|path| !path.is_empty()) {
        PathBuf::from(path)
    } else {
        std::env::var("OPEN_TTS_QWEN3_MLX_MODEL_DIR")
            .map(PathBuf::from)
            .with_context(|| {
                format!("{label} requires `baseModelPath` or OPEN_TTS_QWEN3_MLX_MODEL_DIR.")
            })?
    };
    if !model_path.exists() {
        bail!(
            "{label} model directory does not exist: {}",
            model_path.display()
        );
    }
    Ok(stable_path(&model_path))
}

fn resolve_qwen3_mlx_tts_path() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("OPEN_TTS_QWEN3_MLX_TTS") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(stable_path(&path));
        }
        bail!(
            "OPEN_TTS_QWEN3_MLX_TTS points to a missing tts binary: {}",
            path.display()
        );
    }

    if let Ok(worker_path) = std::env::var("OPEN_TTS_QWEN3_MLX_WORKER") {
        let worker_path = PathBuf::from(worker_path);
        if let Some(parent) = worker_path.parent() {
            let sibling = parent.join(format!("tts{}", std::env::consts::EXE_SUFFIX));
            if sibling.exists() {
                return Ok(stable_path(&sibling));
            }
        }
    }

    bail!(
        "Qwen3 MLX CustomVoice requires OPEN_TTS_QWEN3_MLX_TTS pointing to the upstream `tts` binary."
    )
}

fn resolve_qwen3_mlx_api_server_path() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("OPEN_TTS_QWEN3_MLX_API_SERVER") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(stable_path(&path));
        }
        bail!(
            "OPEN_TTS_QWEN3_MLX_API_SERVER points to a missing api_server binary: {}",
            path.display()
        );
    }

    if let Ok(worker_path) = std::env::var("OPEN_TTS_QWEN3_MLX_WORKER") {
        let worker_path = PathBuf::from(worker_path);
        if let Some(parent) = worker_path.parent() {
            let sibling = parent.join(format!("api_server{}", std::env::consts::EXE_SUFFIX));
            if sibling.exists() {
                return Ok(stable_path(&sibling));
            }
        }
    }

    bail!(
        "Qwen3 MLX CustomVoice requires OPEN_TTS_QWEN3_MLX_API_SERVER pointing to the upstream `api_server` binary."
    )
}

fn pick_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .context("Failed to bind ephemeral loopback port for Qwen3 MLX api_server")?;
    let port = listener
        .local_addr()
        .context("Failed to read ephemeral loopback port for Qwen3 MLX api_server")?
        .port();
    drop(listener);
    Ok(port)
}

enum ApiServerHealth {
    Ready,
    ChildExited(std::process::ExitStatus),
}

fn spawn_qwen3_mlx_api_server(key: &Qwen3MlxApiServerKey, port: u16) -> Result<Child> {
    let mut child = Command::new(&key.api_server_path)
        .arg(&key.model_path)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "Failed to start Qwen3 MLX api_server {}",
                key.api_server_path.display()
            )
        })?;

    if let Some(mut stderr) = child.stderr.take() {
        thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::stderr());
        });
    }
    if let Some(mut stdout) = child.stdout.take() {
        thread::spawn(move || {
            let _ = std::io::copy(&mut stdout, &mut std::io::stderr());
        });
    }
    Ok(child)
}

fn start_qwen3_mlx_api_server(key: &Qwen3MlxApiServerKey) -> Result<(Child, u16)> {
    // `pick_loopback_port` releases its probe socket before the api_server binds
    // the port (an unavoidable TOCTOU), so an early child exit can be a bind
    // race with another process. Retry once with a fresh port in that case.
    for attempt in 0..2 {
        let port = pick_loopback_port()?;
        let mut child = spawn_qwen3_mlx_api_server(key, port)?;
        match wait_for_http_health(
            "127.0.0.1",
            port,
            Duration::from_secs(QWEN3_MLX_API_SERVER_START_TIMEOUT_SEC),
            &mut child,
        ) {
            Ok(ApiServerHealth::Ready) => return Ok((child, port)),
            Ok(ApiServerHealth::ChildExited(status)) => {
                // try_wait already reaped the child; nothing to kill.
                if attempt == 0 {
                    eprintln!(
                        "Qwen3 MLX api_server exited during startup with status {status}; retrying once with a fresh port."
                    );
                    continue;
                }
                bail!("Qwen3 MLX api_server exited during startup with status {status}.");
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err.context(format!(
                    "Qwen3 MLX api_server did not become ready on 127.0.0.1:{port}"
                )));
            }
        }
    }
    unreachable!("Qwen3 MLX api_server startup loop always returns")
}

fn wait_for_http_health(
    host: &str,
    port: u16,
    timeout: Duration,
    child: &mut Child,
) -> Result<ApiServerHealth> {
    let url = format!("http://{host}:{port}/health");
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .context("Failed checking Qwen3 MLX api_server liveness")?
        {
            return Ok(ApiServerHealth::ChildExited(status));
        }
        if started.elapsed() > timeout {
            bail!("Timed out waiting for Qwen3 MLX api_server health check at {url}");
        }
        // A per-request timeout keeps a stuck socket from blocking an iteration
        // (and the child liveness check above) indefinitely.
        match ureq::get(&url)
            .timeout(Duration::from_secs(
                QWEN3_MLX_API_SERVER_HEALTH_REQUEST_TIMEOUT_SEC,
            ))
            .call()
        {
            Ok(response) if response.status() == 200 => return Ok(ApiServerHealth::Ready),
            _ => thread::sleep(Duration::from_millis(250)),
        }
    }
}

fn stream_qwen3_mlx_api_speech(
    host: &str,
    port: u16,
    text: &str,
    voice: &str,
    language: &str,
    instruct: Option<&str>,
    websocket: &mut WebSocketConnection,
    request_id: &str,
    started: Instant,
    phase_timings: &mut serde_json::Map<String, Value>,
) -> Result<Qwen3MlxStreamResult> {
    let mut body = json!({
        "input": text,
        "voice": voice,
        "language": language,
        "response_format": "pcm",
        "stream": true,
    });
    if let Some(instruct) = instruct {
        body["instructions"] = json!(instruct);
    }

    let url = format!("http://{host}:{port}/v1/audio/speech");
    // Per-read inactivity deadline: SSE reads block between deltas, so a wedged
    // api_server that stops emitting (without exiting) must eventually error
    // out instead of hanging this request forever.
    let agent = ureq::AgentBuilder::new()
        .timeout_read(Duration::from_secs(CHILD_OUTPUT_INACTIVITY_TIMEOUT_SEC))
        .build();
    let response = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .with_context(|| format!("Failed to call Qwen3 MLX api_server at {url}"))?;
    if response.status() != 200 {
        let status = response.status();
        let details = response.into_string().unwrap_or_default();
        bail!(
            "Qwen3 MLX api_server returned HTTP {status}: {}",
            details.trim()
        );
    }

    // The upstream api_server streams raw PCM deltas without a guaranteed rate
    // field; Qwen3's 12Hz codec emits 24 kHz audio, so that is the documented
    // fallback. Prefer a rate the server reports — response header first, then
    // any `sample_rate` field carried by an SSE frame.
    let mut sample_rate = response
        .header("x-sample-rate")
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|rate| *rate > 0)
        .unwrap_or(24_000_usize);
    let mut chunk_index = 0_usize;
    let mut sample_count = 0_usize;
    let mut recorded_first_audio = false;
    let mut reader = BufReader::new(response.into_reader());
    let mut line = String::new();

    while reader.read_line(&mut line)? != 0 {
        let trimmed = line.trim();
        if let Some(data) = trimmed.strip_prefix("data: ") {
            if data.is_empty() {
                line.clear();
                continue;
            }
            let parsed: Value = serde_json::from_str(data)
                .with_context(|| format!("Failed to parse Qwen3 MLX api_server SSE payload: {data}"))?;
            if let Some(rate) = parsed
                .get("sample_rate")
                .and_then(Value::as_u64)
                .filter(|rate| *rate > 0)
            {
                sample_rate = rate as usize;
            }
            match parsed.get("type").and_then(Value::as_str) {
                Some("speech.audio.delta") => {
                    let delta = parsed
                        .get("delta")
                        .and_then(Value::as_str)
                        .context("Qwen3 MLX api_server SSE delta missing audio payload")?;
                    let pcm = BASE64
                        .decode(delta)
                        .context("Failed to decode Qwen3 MLX api_server PCM delta")?;
                    let samples = pcm_i16_le_to_f32(&pcm);
                    if samples.is_empty() {
                        line.clear();
                        continue;
                    }
                    if !recorded_first_audio {
                        phase_timings.insert(
                            "firstAudioSec".to_string(),
                            json!(round_secs(started.elapsed().as_secs_f64())),
                        );
                        recorded_first_audio = true;
                    }
                    sample_count += samples.len();
                    websocket.send_json(&json!({
                        "type": "audio_chunk",
                        "requestId": request_id,
                        "index": chunk_index,
                        "total": 0,
                        "sampleRate": sample_rate,
                        "sampleCount": samples.len(),
                        "silenceAfterSamples": 0,
                    }))?;
                    websocket.send_binary(&float32_to_le_bytes(&samples))?;
                    chunk_index += 1;
                }
                Some("error") => {
                    let message = parsed
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Qwen3 MLX api_server reported an unknown streaming error.");
                    bail!("{message}");
                }
                Some("speech.audio.done") => break,
                _ => {}
            }
        }
        line.clear();
    }

    if chunk_index == 0 {
        bail!("Qwen3 MLX api_server returned no audio chunks.");
    }

    Ok(Qwen3MlxStreamResult {
        sample_rate,
        sample_count,
        audio_chunk_count: chunk_index,
    })
}

fn create_qwen3_mlx_run_dir(cache_dir: &Path, request_id: &str) -> Result<PathBuf> {
    let safe_request_id = sanitize_request_id_for_path(request_id);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis();
    let run_dir = cache_dir
        .join("qwen3-mlx-customvoice-runs")
        .join(format!("{millis}-{safe_request_id}"));
    std::fs::create_dir_all(&run_dir)
        .with_context(|| format!("Failed to create Qwen3 MLX run dir {}", run_dir.display()))?;
    Ok(run_dir)
}

fn sanitize_request_id_for_path(request_id: &str) -> String {
    let sanitized: String = request_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(80)
        .collect();
    if sanitized.is_empty() {
        "request".to_string()
    } else {
        sanitized
    }
}

fn read_wav_as_f32(path: &Path) -> Result<(Vec<f32>, usize)> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("Failed to open Qwen3 MLX output WAV {}", path.display()))?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels);
    if channels == 0 {
        bail!("Qwen3 MLX output WAV has zero channels.");
    }
    let sample_rate = usize::try_from(spec.sample_rate).context("Invalid WAV sample rate")?;
    let samples = match spec.sample_format {
        hound::SampleFormat::Float => {
            let raw = reader
                .samples::<f32>()
                .collect::<std::result::Result<Vec<_>, _>>()
                .context("Failed reading float Qwen3 MLX output WAV samples")?;
            downmix_interleaved(raw, channels)
        }
        hound::SampleFormat::Int => {
            if spec.bits_per_sample <= 16 {
                let raw = reader
                    .samples::<i16>()
                    .map(|sample| sample.map(|value| value as f32 / 32768.0))
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .context("Failed reading int16 Qwen3 MLX output WAV samples")?;
                downmix_interleaved(raw, channels)
            } else {
                let denom = 2_f32.powi(i32::from(spec.bits_per_sample.saturating_sub(1)));
                let raw = reader
                    .samples::<i32>()
                    .map(|sample| sample.map(|value| value as f32 / denom))
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .context("Failed reading int32 Qwen3 MLX output WAV samples")?;
                downmix_interleaved(raw, channels)
            }
        }
    };
    Ok((samples, sample_rate))
}

fn downmix_interleaved(samples: Vec<f32>, channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples;
    }
    samples
        .chunks_exact(channels)
        .map(|frame| {
            frame
                .iter()
                .map(|value| if value.is_finite() { *value } else { 0.0 })
                .sum::<f32>()
                / channels as f32
        })
        .collect()
}

fn stable_path(path: &std::path::Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

impl Drop for Qwen3MlxWorkerHost {
    fn drop(&mut self) {
        let _ = write_worker_frame(&mut self.stdin, WORKER_INPUT_SHUTDOWN, 0, &[]);
        for _ in 0..20 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(_) => return,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Qwen3MlxApiServerHost {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn decode_neutts_reference_codes(encoded: &str) -> Result<Vec<i32>> {
    let bytes = BASE64
        .decode(encoded.trim())
        .context("Failed to decode NeuTTS reference codes")?;
    neutts::npy::parse_npy(&bytes)
        .context("Failed to parse NeuTTS reference .npy")?
        .into_i32()
        .context("NeuTTS reference .npy must contain integer NeuCodec codes")
}

/// Map a UI/IPC speaker display name (capitalized, e.g. "Ryan", "Uncle_Fu") to
/// the model's lowercase `spk_id` key. Validation in qwen_tts is case-sensitive
/// and every key is ASCII, so a plain ASCII lowercasing is exact.
fn qwen3_speaker_id(display: &str) -> String {
    display.to_ascii_lowercase()
}

fn is_qwen3_mlx_custom_voice_model(model_repo: &str) -> bool {
    model_repo.starts_with("mlx-community/") && model_repo.contains("-CustomVoice-")
}

fn qwen3_custom_voice_units(text: &str) -> Vec<String> {
    let mut units = Vec::new();
    let mut current = String::new();
    let mut current_chars = 0_usize;

    for word in text.split_whitespace() {
        let word_chars = word.chars().count();
        let pending_chars = current_chars + if current.is_empty() { 0 } else { 1 } + word_chars;
        if !current.is_empty() && pending_chars > QWEN3_CUSTOM_VOICE_MAX_UNIT_CHARS {
            units.push(std::mem::take(&mut current));
            current_chars = 0;
        }

        if !current.is_empty() {
            current.push(' ');
            current_chars += 1;
        }
        current.push_str(word);
        current_chars += word_chars;

        if current_chars >= QWEN3_CUSTOM_VOICE_MIN_SENTENCE_CHARS
            && word.chars().last().is_some_and(is_qwen3_sentence_boundary)
        {
            units.push(std::mem::take(&mut current));
            current_chars = 0;
        }
    }

    if !current.trim().is_empty() {
        units.push(current);
    }
    units
}

fn is_qwen3_sentence_boundary(ch: char) -> bool {
    matches!(
        ch,
        '.' | '!' | '?' | ';' | ':' | '。' | '！' | '？' | '；' | '：'
    )
}

fn normalize_qwen3_model(input: Option<&str>) -> Result<String> {
    match input.unwrap_or("auto") {
        "auto" => Ok(QWEN3_AUTO_MODEL.to_string()),
        "base-auto" => Ok(QWEN3_MLX_BASE_06B_MODEL.to_string()),
        "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
        | "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
        | QWEN3_MLX_CUSTOMVOICE_06B_MODEL
        | QWEN3_MLX_CUSTOMVOICE_17B_MODEL
        | QWEN3_MLX_BASE_06B_MODEL
        | QWEN3_MLX_BASE_17B_MODEL => Ok(input.unwrap().to_string()),
        other => bail!("Unsupported Qwen3-TTS model repository: {other}"),
    }
}

fn normalize_qwen3_language(input: &str) -> Result<String> {
    match input.to_ascii_lowercase().as_str() {
        "auto" => Ok("auto".to_string()),
        "chinese" => Ok("chinese".to_string()),
        "english" => Ok("english".to_string()),
        "japanese" => Ok("japanese".to_string()),
        "korean" => Ok("korean".to_string()),
        "german" => Ok("german".to_string()),
        "french" => Ok("french".to_string()),
        "spanish" => Ok("spanish".to_string()),
        other => bail!("Unsupported Rust Qwen3 language: {other}"),
    }
}

fn normalize_qwen3_dtype(input: Option<&str>, resolved_device: &str) -> Result<String> {
    match input.unwrap_or("auto").to_ascii_lowercase().as_str() {
        // BF16 halves weight memory traffic on Apple Silicon (~1.5-2x faster
        // inference); precision-sensitive steps (logits, sampling) run in F32
        // inside qwen_tts, and the audio output path converts to F32.
        "auto" => Ok(if resolved_device == "metal" {
            "bfloat16".to_string()
        } else {
            "float32".to_string()
        }),
        "float32" | "f32" => Ok("float32".to_string()),
        "bfloat16" | "bf16" => {
            if resolved_device == "metal" {
                Ok("bfloat16".to_string())
            } else {
                bail!("Rust Qwen3 bfloat16 requires the Metal device; use float32 on CPU.")
            }
        }
        other => bail!("Unsupported Rust Qwen3 dtype: {other}."),
    }
}

fn qwen3_candle_dtype(dtype: &str) -> DType {
    if dtype == "bfloat16" {
        DType::BF16
    } else {
        DType::F32
    }
}

fn try_new_metal_device() -> std::result::Result<Device, String> {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    match catch_unwind(AssertUnwindSafe(|| Device::new_metal(0))) {
        Ok(Ok(device)) => Ok(device),
        Ok(Err(err)) => Err(err.to_string()),
        Err(_) => Err("Candle Metal initialization panicked.".to_string()),
    }
}

fn select_qwen3_device(input: Option<&str>) -> Result<SelectedQwen3Device> {
    match input.unwrap_or("auto").to_ascii_lowercase().as_str() {
        "cpu" => Ok(SelectedQwen3Device {
            resolved: "cpu".to_string(),
            device: Device::Cpu,
            warnings: Vec::new(),
        }),
        "auto" => match try_new_metal_device() {
            Ok(device) => Ok(SelectedQwen3Device {
                resolved: "metal".to_string(),
                device,
                warnings: Vec::new(),
            }),
            Err(err) => Ok(SelectedQwen3Device {
                resolved: "cpu".to_string(),
                device: Device::Cpu,
                warnings: vec![format!(
                    "Candle Metal was unavailable for Qwen3 auto device; using CPU fallback ({err})."
                )],
            }),
        },
        "metal" => try_new_metal_device()
            .map(|device| SelectedQwen3Device {
                resolved: "metal".to_string(),
                device,
                warnings: Vec::new(),
            })
            .map_err(|err| {
                anyhow::anyhow!(
                    "Rust Qwen3 Metal device was requested but Candle Metal is unavailable: {err}"
                )
            }),
        other => {
            bail!("Rust Qwen3 build supports auto, metal, or cpu device maps only, got {other}.")
        }
    }
}

fn normalize_qwen3_attention(input: Option<&str>) -> Result<String> {
    match input.unwrap_or("auto").to_ascii_lowercase().as_str() {
        "auto" | "eager" => Ok("eager".to_string()),
        other => bail!("Rust Qwen3 build currently supports eager attention only, got {other}."),
    }
}

fn qwen3_attention_uses_flash(attention: &str) -> bool {
    attention == "flash"
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
    (value * 1000.0).round() / 1000.0
}

/// Background keepalive that writes a single byte to stderr every
/// [`HEARTBEAT_INTERVAL`] while alive. The Electron host re-arms its per-request
/// inactivity watchdog on any child stdout/stderr, so this keeps a legitimately
/// long blocking operation (model download / CPU inference) from being treated
/// as a stuck worker. Dropping the guard signals the thread and joins it, so the
/// heartbeat is always stopped before any further WebSocket frame is written.
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
                    // Sender dropped (stop requested) or channel closed.
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
        // Dropping the sender disconnects the channel, waking the thread immediately.
        self.stop.take();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn validate_websocket_request_path(first_line: &str, auth_token: &str) -> Result<()> {
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();
    if method != "GET" || !version.starts_with("HTTP/") || parts.next().is_some() {
        bail!("WebSocket handshake was not a valid HTTP GET request.");
    }
    if path != format!("/{auth_token}") {
        bail!("WebSocket handshake used an unauthorized path.");
    }
    Ok(())
}

struct WebSocketConnection {
    stream: TcpStream,
}

impl WebSocketConnection {
    fn new(stream: TcpStream) -> Self {
        Self { stream }
    }

    fn handshake(&mut self, auth_token: &str) -> Result<()> {
        // Bound the pre-upgrade read so a client that connects and sends
        // nothing cannot park the single-threaded accept loop. Cleared after a
        // successful upgrade so long-idle WebSocket connections keep their
        // blocking read semantics.
        self.stream
            .set_read_timeout(Some(Duration::from_secs(
                WEBSOCKET_HANDSHAKE_READ_TIMEOUT_SEC,
            )))
            .context("Failed to set WebSocket handshake read timeout")?;
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = self.stream.read(&mut buffer)?;
            if read == 0 {
                bail!("WebSocket client disconnected during handshake.");
            }
            request.extend_from_slice(&buffer[..read]);
            if request.len() > 64_000 {
                bail!("WebSocket handshake exceeded the maximum header size.");
            }
        }

        let header_text = String::from_utf8_lossy(&request);
        let mut lines = header_text.split("\r\n");
        let first = lines.next().unwrap_or_default();
        validate_websocket_request_path(first, auth_token)?;

        let mut upgrade = String::new();
        let mut connection = String::new();
        let mut websocket_key = String::new();
        for line in lines {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            match key.trim().to_ascii_lowercase().as_str() {
                "upgrade" => upgrade = value.trim().to_string(),
                "connection" => connection = value.trim().to_string(),
                "sec-websocket-key" => websocket_key = value.trim().to_string(),
                _ => {}
            }
        }

        if !upgrade.eq_ignore_ascii_case("websocket") {
            bail!("WebSocket handshake missing Upgrade: websocket.");
        }
        if !connection.to_ascii_lowercase().contains("upgrade") {
            bail!("WebSocket handshake missing Connection: Upgrade.");
        }
        if websocket_key.is_empty() {
            bail!("WebSocket handshake missing Sec-WebSocket-Key.");
        }

        let mut sha1 = Sha1::new();
        sha1.update(format!("{websocket_key}{WEBSOCKET_GUID}").as_bytes());
        let accept = BASE64.encode(sha1.finalize());
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Accept: {accept}\r\n\
             \r\n"
        );
        self.stream.write_all(response.as_bytes())?;
        self.stream.flush()?;
        self.stream
            .set_read_timeout(None)
            .context("Failed to clear WebSocket handshake read timeout")?;
        Ok(())
    }

    fn recv_text(&mut self) -> Result<Option<String>> {
        let mut fragments: Vec<u8> = Vec::new();
        let mut fragment_opcode: Option<u8> = None;

        loop {
            let mut header = [0_u8; 2];
            if !read_exact_or_eof(&mut self.stream, &mut header)? {
                return Ok(None);
            }
            let fin = (header[0] & 0x80) != 0;
            let opcode = header[0] & 0x0f;
            let masked = (header[1] & 0x80) != 0;
            let mut length = u64::from(header[1] & 0x7f);
            if !masked {
                bail!("Client WebSocket frames must be masked.");
            }

            if length == 126 {
                let mut extended = [0_u8; 2];
                self.stream.read_exact(&mut extended)?;
                length = u64::from(u16::from_be_bytes(extended));
            } else if length == 127 {
                let mut extended = [0_u8; 8];
                self.stream.read_exact(&mut extended)?;
                length = u64::from_be_bytes(extended);
            }
            let length = usize::try_from(length).context("WebSocket frame too large")?;
            if length > MAX_WEBSOCKET_TEXT_FRAME_BYTES {
                bail!("WebSocket request frame exceeded the maximum supported size.");
            }

            let mut mask = [0_u8; 4];
            self.stream.read_exact(&mut mask)?;
            let mut payload = vec![0_u8; length];
            self.stream.read_exact(&mut payload)?;
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }

            match opcode {
                0x8 => return Ok(None),
                0x9 => {
                    if !fin || payload.len() > 125 {
                        bail!("Invalid WebSocket ping frame.");
                    }
                    self.send_frame(0xA, &payload)?;
                    continue;
                }
                0xA => {
                    if !fin || payload.len() > 125 {
                        bail!("Invalid WebSocket pong frame.");
                    }
                    continue;
                }
                0x1 | 0x2 => {
                    if fragment_opcode.is_some() {
                        bail!(
                            "Received a new WebSocket message before the fragmented message completed."
                        );
                    }
                    if opcode == 0x2 {
                        bail!("Binary WebSocket requests are not supported.");
                    }
                    if fin {
                        return Ok(Some(
                            String::from_utf8(payload).context("WebSocket text was not UTF-8")?,
                        ));
                    }
                    fragment_opcode = Some(opcode);
                    fragments = payload;
                }
                0x0 => {
                    let Some(start_opcode) = fragment_opcode else {
                        bail!("Unexpected WebSocket continuation frame.");
                    };
                    if start_opcode != 0x1 {
                        bail!("Binary WebSocket requests are not supported.");
                    }
                    let new_len = fragments
                        .len()
                        .checked_add(payload.len())
                        .context("WebSocket request frame exceeded the maximum supported size.")?;
                    if new_len > MAX_WEBSOCKET_TEXT_FRAME_BYTES {
                        bail!("WebSocket request frame exceeded the maximum supported size.");
                    }
                    fragments.extend_from_slice(&payload);
                    if fin {
                        let text = String::from_utf8(std::mem::take(&mut fragments))
                            .context("WebSocket text was not UTF-8")?;
                        return Ok(Some(text));
                    }
                }
                other => bail!("Unsupported WebSocket opcode: {other}"),
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
        self.send_frame(0x1, &body)
    }

    fn send_binary(&mut self, payload: &[u8]) -> Result<()> {
        self.send_frame(0x2, payload)
    }

    fn close(&mut self) -> Result<()> {
        self.send_frame(0x8, &[])
    }

    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<()> {
        let mut header = vec![0x80 | opcode];
        match payload.len() {
            0..=125 => header.push(payload.len() as u8),
            126..=65_535 => {
                header.push(126);
                header.extend_from_slice(&(payload.len() as u16).to_be_bytes());
            }
            _ => {
                header.push(127);
                header.extend_from_slice(&(payload.len() as u64).to_be_bytes());
            }
        }
        self.stream.write_all(&header)?;
        self.stream.write_all(payload)?;
        self.stream.flush()?;
        Ok(())
    }
}

fn read_exact_or_eof<R: Read>(reader: &mut R, buffer: &mut [u8]) -> Result<bool> {
    let mut read_total = 0;
    while read_total < buffer.len() {
        let read = reader.read(&mut buffer[read_total..])?;
        if read == 0 {
            return Ok(read_total == 0);
        }
        read_total += read;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaker_id_lowercases_every_display_name() {
        // The model's spk_id keys are lowercase; case-sensitive validation means
        // the capitalized UI names must map exactly to these keys.
        let cases = [
            ("Ryan", "ryan"),
            ("Aiden", "aiden"),
            ("Vivian", "vivian"),
            ("Serena", "serena"),
            ("Uncle_Fu", "uncle_fu"),
            ("Dylan", "dylan"),
            ("Eric", "eric"),
            ("Ono_Anna", "ono_anna"),
            ("Sohee", "sohee"),
        ];
        for (display, expected) in cases {
            assert_eq!(qwen3_speaker_id(display), expected, "speaker {display}");
        }
    }

    #[test]
    fn default_speaker_is_a_canonical_lowercase_key() {
        assert_eq!(
            QWEN3_DEFAULT_SPEAKER,
            qwen3_speaker_id(QWEN3_DEFAULT_SPEAKER)
        );
    }

    #[test]
    fn qwen3_custom_voice_units_split_sentences_and_cap_long_text() {
        let units = qwen3_custom_voice_units(
            "This is a first sentence with enough words to cross the minimum split size. \
             This is a second sentence with enough words to become another unit!",
        );
        assert_eq!(units.len(), 2);
        assert!(units[0].ends_with("size."));
        assert!(units[1].ends_with("unit!"));

        let long = "word ".repeat(120);
        let long_units = qwen3_custom_voice_units(&long);
        assert!(long_units.len() > 1);
        assert!(
            long_units
                .iter()
                .all(|unit| unit.chars().count() <= QWEN3_CUSTOM_VOICE_MAX_UNIT_CHARS)
        );
    }

    #[test]
    fn normalize_qwen3_model_resolves_auto_and_allows_known_repos() {
        assert_eq!(normalize_qwen3_model(None).unwrap(), QWEN3_AUTO_MODEL);
        assert_eq!(
            normalize_qwen3_model(Some("auto")).unwrap(),
            QWEN3_AUTO_MODEL
        );
        assert_eq!(
            normalize_qwen3_model(Some("Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")).unwrap(),
            "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
        );
        assert_eq!(
            normalize_qwen3_model(Some(QWEN3_MLX_CUSTOMVOICE_06B_MODEL)).unwrap(),
            QWEN3_MLX_CUSTOMVOICE_06B_MODEL
        );
        assert_eq!(
            normalize_qwen3_model(Some(QWEN3_MLX_CUSTOMVOICE_17B_MODEL)).unwrap(),
            QWEN3_MLX_CUSTOMVOICE_17B_MODEL
        );
        assert!(is_qwen3_mlx_custom_voice_model(
            QWEN3_MLX_CUSTOMVOICE_06B_MODEL
        ));
        assert!(!is_qwen3_mlx_custom_voice_model(QWEN3_MLX_BASE_06B_MODEL));
        assert_eq!(
            normalize_qwen3_model(Some("mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit")).unwrap(),
            "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit"
        );
        assert!(normalize_qwen3_model(Some("Qwen/other")).is_err());
    }

    #[test]
    fn normalize_qwen3_language_lowercases_and_rejects_unknown() {
        assert_eq!(normalize_qwen3_language("English").unwrap(), "english");
        assert_eq!(normalize_qwen3_language("Auto").unwrap(), "auto");
        assert!(normalize_qwen3_language("Klingon").is_err());
    }

    #[test]
    fn normalize_qwen3_dtype_and_device_accept_only_supported() {
        assert_eq!(normalize_qwen3_dtype(None, "cpu").unwrap(), "float32");
        assert_eq!(normalize_qwen3_dtype(None, "metal").unwrap(), "bfloat16");
        assert_eq!(
            normalize_qwen3_dtype(Some("float32"), "metal").unwrap(),
            "float32"
        );
        assert_eq!(
            normalize_qwen3_dtype(Some("bf16"), "metal").unwrap(),
            "bfloat16"
        );
        assert!(normalize_qwen3_dtype(Some("bf16"), "cpu").is_err());
        assert!(normalize_qwen3_dtype(Some("float16"), "metal").is_err());
        assert_eq!(qwen3_candle_dtype("bfloat16"), DType::BF16);
        assert_eq!(qwen3_candle_dtype("float32"), DType::F32);
        assert_eq!(select_qwen3_device(Some("cpu")).unwrap().resolved, "cpu");
        let auto_device = select_qwen3_device(Some("auto")).unwrap().resolved;
        assert!(matches!(auto_device.as_str(), "cpu" | "metal"));
        assert!(select_qwen3_device(Some("cuda")).is_err());
    }

    #[test]
    fn normalize_qwen3_attention_accepts_auto_and_eager_only() {
        assert_eq!(normalize_qwen3_attention(Some("eager")).unwrap(), "eager");
        assert_eq!(normalize_qwen3_attention(None).unwrap(), "eager");
        assert!(normalize_qwen3_attention(Some("flash")).is_err());
    }

    #[test]
    fn normalize_neutts_model_enforces_allowlist() {
        assert_eq!(normalize_neutts_model(None).unwrap(), NEUTTS_DEFAULT_MODEL);
        assert!(normalize_neutts_model(Some("neuphonic/neutts-nano-q8-gguf")).is_ok());
        assert!(normalize_neutts_model(Some("evil/model")).is_err());
    }

    #[test]
    fn pcm_i16_le_to_f32_converts_worker_audio() {
        let bytes = [0_u8, 0, 0xff, 0x7f, 0x00, 0x80];
        let samples = pcm_i16_le_to_f32(&bytes);
        assert_eq!(samples[0], 0.0);
        assert!((samples[1] - 0.9999695).abs() < 0.00001);
        assert_eq!(samples[2], -1.0);
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
        assert!(
            validate_generation_output(&output_with(
                Vec::new(),
                24_000,
                Some(StreamedAudioSummary {
                    sample_count: 0,
                    audio_chunk_count: 0,
                }),
            ))
            .is_err()
        );
    }

    #[test]
    fn elapsed_phase_timing_excludes_milestones() {
        assert!(is_elapsed_phase_timing("modelLoadSec"));
        assert!(is_elapsed_phase_timing("inferenceSec"));
        assert!(!is_elapsed_phase_timing("firstAudioSec"));
    }

    #[test]
    fn websocket_request_path_requires_auth_token() {
        assert!(validate_websocket_request_path("GET /secret HTTP/1.1", "secret").is_ok());
        assert!(validate_websocket_request_path("POST /secret HTTP/1.1", "secret").is_err());
        assert!(validate_websocket_request_path("GET /wrong HTTP/1.1", "secret").is_err());
        assert!(validate_websocket_request_path("GET /secret?x=1 HTTP/1.1", "secret").is_err());
    }
}

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
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const RESULT_PREFIX: &str = "__RESULT__";
const PORT_PREFIX: &str = "__PORT__";
const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WEBSOCKET_TEXT_FRAME_BYTES: usize = 32 * 1024 * 1024;
const QWEN3_AUTO_MODEL: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice";
// The model's `talker_config.spk_id` keys are lowercase (ryan, vivian, serena,
// uncle_fu, aiden, ono_anna, sohee, eric, dylan) and `validate_speaker_value`
// is case-sensitive. The UI/IPC keep capitalized display names; the bridge
// lowercases before generation (see `qwen3_speaker_id`). Keep this default
// lowercase so the no-speaker fallback also matches a real spk_id key.
const QWEN3_DEFAULT_SPEAKER: &str = "ryan";
const QWEN3_DEFAULT_LANGUAGE: &str = "English";
const NEUTTS_DEFAULT_MODEL: &str = "neuphonic/neutts-nano-q4-gguf";

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
    model_repo: Option<String>,
    speaker: Option<String>,
    language: Option<String>,
    instruct: Option<String>,
    device_map: Option<String>,
    dtype: Option<String>,
    attn_implementation: Option<String>,
    temperature: Option<f64>,
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
}

struct Qwen3Host {
    key: Qwen3Key,
    model: qwen_tts::model::Model,
}

struct NeuttsHost {
    model_repo: String,
    model: neutts::NeuTTS,
}

struct RuntimeState {
    model: LocalModel,
    qwen3: Option<Qwen3Host>,
    neutts: Option<NeuttsHost>,
}

struct GenerationOutput {
    samples: Vec<f32>,
    sample_rate: usize,
    model_repo: String,
    phase_timings: serde_json::Map<String, Value>,
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
            "recommendedModelRepo": QWEN3_AUTO_MODEL,
            "recommendedDeviceMap": "cpu",
            "recommendedDtype": "float32",
            "recommendedAttention": "eager",
            "warnings": [
                "Rust migration currently runs Qwen3 on CPU-only Candle defaults in this build."
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
        qwen3: None,
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
        let started = Instant::now();
        let mut phase_timings = serde_json::Map::new();
        let model_repo = normalize_qwen3_model(payload.model_repo.as_deref())?;
        // Display speaker names are capitalized in the UI; the model's spk_id keys
        // are lowercase and validation is case-sensitive, so normalize here.
        let speaker = qwen3_speaker_id(payload.speaker.as_deref().unwrap_or(QWEN3_DEFAULT_SPEAKER));
        let language = normalize_qwen3_language(payload.language.as_deref().unwrap_or(QWEN3_DEFAULT_LANGUAGE))?;
        let dtype = normalize_qwen3_dtype(payload.dtype.as_deref())?;
        let device_name = normalize_qwen3_device(payload.device_map.as_deref())?;
        validate_qwen3_attention(payload.attn_implementation.as_deref())?;
        let key = Qwen3Key {
            model_repo: model_repo.clone(),
            dtype: dtype.clone(),
            device: device_name.clone(),
        };

        websocket.send_progress(
            request_id,
            "model_load",
            format!("Loading Rust Qwen3 model: {model_repo}"),
            started,
        )?;
        let load_started = Instant::now();
        self.ensure_qwen3_model(&key)?;
        phase_timings.insert(
            "modelLoadSec".to_string(),
            json!(round_secs(load_started.elapsed().as_secs_f64())),
        );

        let host = self.qwen3.as_ref().context("Qwen3 model was not loaded")?;
        let options = CustomVoiceOptions {
            max_new_tokens: payload.max_new_tokens,
            temperature: payload.temperature,
            top_p: payload.top_p,
            ..Default::default()
        };

        websocket.send_progress(
            request_id,
            "inference",
            "Running Rust Qwen3 inference...",
            started,
        )?;
        let inference_started = Instant::now();
        let result = host
            .model
            .generate_custom_voice_from_text(
                payload.text.trim(),
                &speaker,
                &language,
                payload.instruct.as_deref(),
                Some(options),
            )
            .map_err(|err| anyhow::anyhow!("Qwen3 generation failed: {err}"))?;
        phase_timings.insert(
            "inferenceSec".to_string(),
            json!(round_secs(inference_started.elapsed().as_secs_f64())),
        );

        let output_started = Instant::now();
        let samples = result
            .audio
            .flatten_all()
            .and_then(|audio| audio.to_dtype(DType::F32))
            .and_then(|audio| audio.to_vec1::<f32>())
            .map_err(|err| anyhow::anyhow!("Failed to read Qwen3 audio tensor: {err}"))?;
        phase_timings.insert(
            "outputEncodingSec".to_string(),
            json!(round_secs(output_started.elapsed().as_secs_f64())),
        );

        Ok(GenerationOutput {
            samples,
            sample_rate: result.sample_rate,
            model_repo,
            phase_timings,
        })
    }

    fn ensure_qwen3_model(&mut self, key: &Qwen3Key) -> Result<()> {
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
        let model_dir = qwen_tts::io::model_path::get_model_path(&model_args, &mode)
            .with_context(|| format!("Failed to resolve Qwen3 model files for {}", key.model_repo))?;
        // The validators constrain device/dtype to cpu/float32 only, so the
        // runtime device and loader dtype below are the single source of truth;
        // key.device/key.dtype exist for the reuse cache key and future wiring.
        let device = Device::Cpu;
        let loader = ModelLoader::from_local_dir(&model_dir)
            .with_context(|| format!("Failed to inspect Qwen3 model directory {}", model_dir.display()))?;
        let model = loader
            .load_tts_model(
                &device,
                &LoaderConfig {
                    dtype: DType::F32,
                    load_tokenizer: true,
                    load_text_tokenizer: true,
                    load_generate_config: true,
                    use_flash_attn: false,
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
        let host = self.neutts.as_ref().context("NeuTTS model was not loaded")?;
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

fn send_generation_result(
    websocket: &mut WebSocketConnection,
    request_id: &str,
    output: GenerationOutput,
) -> Result<()> {
    if output.samples.is_empty() {
        bail!("Generation produced no audio samples.");
    }

    let sample_count = output.samples.len();
    websocket.send_json(&json!({
        "type": "audio_chunk",
        "requestId": request_id,
        "index": 0,
        "total": 1,
        "sampleRate": output.sample_rate,
        "sampleCount": sample_count,
        "silenceAfterSamples": 0,
    }))?;
    websocket.send_binary(&float32_to_le_bytes(&output.samples))?;

    let duration_sec = sample_count as f64 / output.sample_rate as f64;
    let elapsed_sec = output
        .phase_timings
        .values()
        .filter_map(Value::as_f64)
        .sum::<f64>();
    websocket.send_json(&json!({
        "type": "result",
        "requestId": request_id,
        "ok": true,
        "result": {
            "sampleRate": output.sample_rate,
            "modelRepo": output.model_repo,
            "durationSec": round_secs(duration_sec),
            "elapsedSec": round_secs(elapsed_sec),
            "audioTransport": "websocket-binary",
            "audioChunkCount": 1,
            "phaseTimingsSec": output.phase_timings,
        },
    }))?;
    Ok(())
}

fn float32_to_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * std::mem::size_of::<f32>());
    for sample in samples {
        let cleaned = if sample.is_finite() { *sample } else { 0.0 };
        bytes.extend_from_slice(&cleaned.to_le_bytes());
    }
    bytes
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

fn normalize_qwen3_model(input: Option<&str>) -> Result<String> {
    match input.unwrap_or("auto") {
        "auto" => Ok(QWEN3_AUTO_MODEL.to_string()),
        "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" | "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" => {
            Ok(input.unwrap().to_string())
        }
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

fn normalize_qwen3_dtype(input: Option<&str>) -> Result<String> {
    match input.unwrap_or("auto").to_ascii_lowercase().as_str() {
        "auto" | "float32" | "f32" => Ok("float32".to_string()),
        other => bail!("Rust Qwen3 build currently supports float32 only, got {other}."),
    }
}

fn normalize_qwen3_device(input: Option<&str>) -> Result<String> {
    match input.unwrap_or("auto").to_ascii_lowercase().as_str() {
        "auto" | "cpu" => Ok("cpu".to_string()),
        other => bail!("Rust Qwen3 build currently supports CPU only, got {other}."),
    }
}

fn validate_qwen3_attention(input: Option<&str>) -> Result<()> {
    match input.unwrap_or("auto").to_ascii_lowercase().as_str() {
        "auto" | "eager" => Ok(()),
        other => bail!("Rust Qwen3 build currently supports eager attention only, got {other}."),
    }
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
                        bail!("Received a new WebSocket message before the fragmented message completed.");
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
        assert_eq!(QWEN3_DEFAULT_SPEAKER, qwen3_speaker_id(QWEN3_DEFAULT_SPEAKER));
    }

    #[test]
    fn normalize_qwen3_model_resolves_auto_and_allows_known_repos() {
        assert_eq!(normalize_qwen3_model(None).unwrap(), QWEN3_AUTO_MODEL);
        assert_eq!(normalize_qwen3_model(Some("auto")).unwrap(), QWEN3_AUTO_MODEL);
        assert_eq!(
            normalize_qwen3_model(Some("Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")).unwrap(),
            "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
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
        assert_eq!(normalize_qwen3_dtype(None).unwrap(), "float32");
        assert_eq!(normalize_qwen3_dtype(Some("float32")).unwrap(), "float32");
        assert!(normalize_qwen3_dtype(Some("bf16")).is_err());
        assert_eq!(normalize_qwen3_device(Some("cpu")).unwrap(), "cpu");
        assert_eq!(normalize_qwen3_device(Some("auto")).unwrap(), "cpu");
        assert!(normalize_qwen3_device(Some("cuda")).is_err());
    }

    #[test]
    fn validate_qwen3_attention_accepts_auto_and_eager_only() {
        assert!(validate_qwen3_attention(Some("eager")).is_ok());
        assert!(validate_qwen3_attention(None).is_ok());
        assert!(validate_qwen3_attention(Some("flash")).is_err());
    }

    #[test]
    fn normalize_neutts_model_enforces_allowlist() {
        assert_eq!(
            normalize_neutts_model(None).unwrap(),
            NEUTTS_DEFAULT_MODEL
        );
        assert!(normalize_neutts_model(Some("neuphonic/neutts-nano-q8-gguf")).is_ok());
        assert!(normalize_neutts_model(Some("evil/model")).is_err());
    }

    #[test]
    fn websocket_request_path_requires_auth_token() {
        assert!(validate_websocket_request_path("GET /secret HTTP/1.1", "secret").is_ok());
        assert!(validate_websocket_request_path("POST /secret HTTP/1.1", "secret").is_err());
        assert!(validate_websocket_request_path("GET /wrong HTTP/1.1", "secret").is_err());
        assert!(validate_websocket_request_path("GET /secret?x=1 HTTP/1.1", "secret").is_err());
    }
}

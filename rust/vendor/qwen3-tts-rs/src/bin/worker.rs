// Copyright 2026 Michael Yuan.
// SPDX-License-Identifier: Apache-2.0

//! Persistent binary-framed worker for Qwen3 TTS voice cloning.
//!
//! This mirrors the pibot Python worker protocol:
//! frame header: uint8 type, uint32 request_id, uint32 payload_len, little-endian.

use clap::Parser;
use qwen3_tts_rs::audio::{load_wav_file, resample, write_wav_file};
use qwen3_tts_rs::audio_encoder::AudioEncoder;
use qwen3_tts_rs::inference::TTSInference;
use qwen3_tts_rs::speaker_encoder::SpeakerEncoder;
use qwen3_tts_rs::tensor::{Device, Tensor};
use serde_json::json;
use std::collections::HashSet;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

const DEFAULT_MODEL_PATH: &str = "/tmp/qwen3-tts.cpp/models/Qwen3-TTS-12Hz-0.6B-Base";
const DEFAULT_REF_TEXT: &str = "I'm confused why some people have super short timelines, yet at the same time are bullish on scaling up reinforcement learning atop LLMs. If we're actually close to a human-like learner, then this whole approach of training on verifiable outcomes.";
const DEFAULT_MAX_NEW_TOKENS: i64 = 1536;
const DEFAULT_BLOCKSIZE: usize = 512;
const FRAME_HEADER_BYTES: usize = 9;
const STDOUT_FILENO: i32 = 1;
const STDERR_FILENO: i32 = 2;

const WORKER_INPUT_SPEAK: u8 = 1;
const WORKER_INPUT_CANCEL: u8 = 2;
const WORKER_INPUT_SHUTDOWN: u8 = 3;
const WORKER_OUTPUT_READY: u8 = 1;
const WORKER_OUTPUT_AUDIO_START: u8 = 2;
const WORKER_OUTPUT_AUDIO_CHUNK: u8 = 3;
const WORKER_OUTPUT_AUDIO_DONE: u8 = 4;
const WORKER_OUTPUT_ERROR: u8 = 5;

extern "C" {
    fn dup(fd: i32) -> i32;
    fn dup2(oldfd: i32, newfd: i32) -> i32;
}

#[derive(Parser, Debug)]
#[command(
    name = "pibot-tts-worker",
    about = "Persistent Qwen3 TTS binary-framed worker"
)]
struct Args {
    /// Run as a persistent binary-framed worker on stdin/stdout.
    #[arg(long)]
    serve: bool,

    /// Path to the model directory. `--model-name` is accepted as the Python-compatible alias.
    #[arg(long, alias = "model-name", default_value = DEFAULT_MODEL_PATH)]
    model_path: PathBuf,

    /// Target text for one-shot generation.
    #[arg(long)]
    text: Option<String>,

    /// File containing target text for one-shot generation.
    #[arg(long)]
    text_file: Option<PathBuf>,

    /// One-shot output WAV path.
    #[arg(long, default_value = "data/voices/qwen3-rust-worker-test.wav")]
    output: PathBuf,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long, default_value = "")]
    output_dir: String,

    /// Reference WAV for ICL voice cloning.
    #[arg(long)]
    ref_audio: PathBuf,

    /// Reference transcript.
    #[arg(long)]
    ref_text: Option<String>,

    /// File containing the reference transcript.
    #[arg(long)]
    ref_text_file: Option<PathBuf>,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long, default_value = "Aiden")]
    speaker: String,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long)]
    instruct: Option<String>,

    /// Target language, e.g. german, english, de.
    #[arg(long, default_value = "german")]
    language: String,

    /// Accepted for Python worker CLI compatibility. Rust worker currently uses local full weights.
    #[arg(long, default_value = "6bit")]
    mlx_quantization: String,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long)]
    streaming_chunk_size: Option<i64>,

    /// Maximum generated codec frames.
    #[arg(long, default_value_t = DEFAULT_MAX_NEW_TOKENS)]
    max_new_tokens: i64,

    /// Output chunk size in samples.
    #[arg(long, default_value_t = DEFAULT_BLOCKSIZE)]
    blocksize: usize,

    /// PCM output sample rate.
    #[arg(long, default_value_t = 16000)]
    output_sample_rate: u32,

    /// Accepted for Python worker CLI compatibility. Rust worker does not currently seed MLX RNG.
    #[arg(long)]
    seed: Option<u64>,

    /// Sampling temperature.
    #[arg(long, default_value_t = 0.9)]
    temperature: f64,

    /// Top-k sampling.
    #[arg(long, default_value_t = 50)]
    top_k: i64,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long, default_value_t = 1.0)]
    top_p: f64,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long, default_value_t = 1.05)]
    repetition_penalty: f64,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long, default_value_t = 1.0)]
    speed: f64,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long, default_value = "cuda")]
    device: String,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long, default_value = "auto")]
    dtype: String,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long, default_value = "eager")]
    attn_implementation: String,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long)]
    xvec_only: bool,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long)]
    parity_mode: bool,

    /// Accepted for Python worker CLI compatibility.
    #[arg(long, default_value_t = true)]
    non_streaming_mode: bool,
}

struct Frame {
    frame_type: u8,
    request_id: u32,
    payload: Vec<u8>,
}

struct BinaryWriter {
    inner: File,
}

impl BinaryWriter {
    fn new(fd: RawFd) -> Self {
        let inner = unsafe { File::from_raw_fd(fd) };
        Self { inner }
    }

    fn write_frame(
        &mut self,
        frame_type: u8,
        request_id: u32,
        payload: &[u8],
    ) -> anyhow::Result<()> {
        let payload_len = u32::try_from(payload.len())?;
        let mut header = [0u8; FRAME_HEADER_BYTES];
        header[0] = frame_type;
        header[1..5].copy_from_slice(&request_id.to_le_bytes());
        header[5..9].copy_from_slice(&payload_len.to_le_bytes());
        self.inner.write_all(&header)?;
        self.inner.write_all(payload)?;
        self.inner.flush()?;
        Ok(())
    }
}

struct Worker {
    model_name: String,
    inference: TTSInference,
    speaker_embedding: Tensor,
    ref_codes: Vec<Vec<i64>>,
    ref_text: String,
    language: String,
    temperature: f64,
    top_k: i64,
    max_new_tokens: i64,
    output_sample_rate: u32,
    blocksize: usize,
    streaming_chunk_size: usize,
}

impl Worker {
    fn load(args: &Args) -> anyhow::Result<Self> {
        #[cfg(feature = "mlx")]
        {
            qwen3_tts_rs::backend::mlx::stream::init_mlx(true);
            eprintln!("MLX backend initialized (Metal GPU)");
        }

        let model_path = args.model_path.expanduser();
        if !model_path.exists() {
            anyhow::bail!(
                "Rust worker requires a local model directory for --model-name/--model-path, got {}",
                model_path.display()
            );
        }

        let device = Device::Cpu;
        let inference = TTSInference::new(&model_path, device)?;
        let speaker_encoder = SpeakerEncoder::load(
            inference.weights(),
            &inference.config().speaker_encoder_config,
            device,
        )?;
        let tokenizer_path = model_path
            .join("speech_tokenizer")
            .join("model.safetensors");
        let audio_encoder = AudioEncoder::load(&tokenizer_path, device)?;
        let ref_text = load_ref_text(args)?;
        let se_sr = inference.config().speaker_encoder_config.sample_rate;
        let (samples, sample_rate) = load_wav_file(path_str(&args.ref_audio.expanduser())?)?;
        let samples = if sample_rate == se_sr {
            samples
        } else {
            resample(&samples, sample_rate, se_sr)?
        };
        let speaker_embedding = speaker_encoder.extract_embedding(&samples)?;
        let ref_codes = audio_encoder.encode(&samples)?;

        Ok(Self {
            model_name: model_path.display().to_string(),
            inference,
            speaker_embedding,
            ref_codes,
            ref_text,
            language: normalize_language(&args.language),
            temperature: args.temperature,
            top_k: args.top_k,
            max_new_tokens: args.max_new_tokens,
            output_sample_rate: args.output_sample_rate,
            blocksize: args.blocksize.max(1),
            streaming_chunk_size: args.streaming_chunk_size.unwrap_or(4).max(1) as usize,
        })
    }

    fn synthesize(&self, text: &str) -> anyhow::Result<Vec<f32>> {
        let (samples, sample_rate) = self.inference.generate_with_icl(
            text,
            &self.ref_text,
            &self.ref_codes,
            &self.speaker_embedding,
            &self.language,
            self.temperature,
            self.top_k,
            self.max_new_tokens,
        )?;
        if sample_rate == self.output_sample_rate {
            Ok(samples)
        } else {
            Ok(resample(&samples, sample_rate, self.output_sample_rate)?)
        }
    }

    fn handle_speak(
        &self,
        request_id: u32,
        payload: &[u8],
        writer: &mut BinaryWriter,
        cancelled: &Arc<Mutex<HashSet<u32>>>,
    ) -> anyhow::Result<()> {
        if take_cancelled(cancelled, request_id) {
            writer.write_frame(WORKER_OUTPUT_AUDIO_DONE, request_id, &[])?;
            return Ok(());
        }

        let text = std::str::from_utf8(payload)?.trim();
        if text.is_empty() {
            anyhow::bail!("empty text");
        }

        writer.write_frame(
            WORKER_OUTPUT_AUDIO_START,
            request_id,
            &self.output_sample_rate.to_le_bytes(),
        )?;

        log_json(json!({
            "type": "ready",
            "backend": "rust_mlx",
            "model": self.model_name,
            "modelType": "base",
            "chunkSize": self.streaming_chunk_size,
            "maxNewTokens": self.max_new_tokens,
            "temperature": self.temperature,
            "topK": self.top_k,
            "topP": 1.0,
            "repetitionPenalty": 1.05,
            "seed": null
        }));

        let started = Instant::now();
        let mut streamer = PcmStreamer::new(self.output_sample_rate, self.blocksize);
        let mut ttfa_logged = false;
        let mut stream_error: Option<anyhow::Error> = None;
        let mut cancelled_during_stream = false;

        self.inference.generate_with_icl_streaming(
            text,
            &self.ref_text,
            &self.ref_codes,
            &self.speaker_embedding,
            &self.language,
            self.temperature,
            self.top_k,
            self.max_new_tokens,
            self.streaming_chunk_size,
            |samples, sample_rate| {
                if take_cancelled(cancelled, request_id) {
                    cancelled_during_stream = true;
                    return false;
                }
                if !ttfa_logged {
                    log_json(json!({
                        "type": "ttfa",
                        "seconds": round3(started.elapsed().as_secs_f64()),
                        "label": "voice_clone_rust"
                    }));
                    ttfa_logged = true;
                }
                if let Err(error) = streamer.push(samples, sample_rate, request_id, writer) {
                    stream_error = Some(error);
                    return false;
                }
                true
            },
        )?;
        if let Some(error) = stream_error {
            return Err(error);
        }
        if cancelled_during_stream {
            log_json(json!({ "type": "request_cancelled", "id": request_id }));
            writer.write_frame(WORKER_OUTPUT_AUDIO_DONE, request_id, &[])?;
            clear_mlx_cache();
            return Ok(());
        }
        streamer.finish(request_id, writer)?;

        let elapsed = started.elapsed().as_secs_f64();
        let audio_seconds = streamer.audio_samples as f64 / self.output_sample_rate as f64;
        log_json(json!({
            "type": "generated",
            "seconds": round3(elapsed),
            "audioSeconds": round3(audio_seconds),
            "rtf": round3(audio_seconds / elapsed),
            "label": "voice_clone_rust"
        }));
        writer.write_frame(WORKER_OUTPUT_AUDIO_DONE, request_id, &[])?;
        clear_cancelled(cancelled, request_id);
        clear_mlx_cache();
        Ok(())
    }
}

struct PcmStreamer {
    output_sample_rate: u32,
    blocksize: usize,
    found_speech: bool,
    leftover: Vec<i16>,
    audio_samples: usize,
}

impl PcmStreamer {
    fn new(output_sample_rate: u32, blocksize: usize) -> Self {
        Self {
            output_sample_rate,
            blocksize,
            found_speech: false,
            leftover: Vec::new(),
            audio_samples: 0,
        }
    }

    fn push(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        request_id: u32,
        writer: &mut BinaryWriter,
    ) -> anyhow::Result<()> {
        let samples = if sample_rate == self.output_sample_rate {
            samples.to_vec()
        } else {
            resample(samples, sample_rate, self.output_sample_rate)?
        };
        let mut pcm = samples_to_i16(&samples);
        if !self.found_speech {
            let threshold = (32768.0 * 0.01) as i16;
            if let Some(first_speech) = pcm.iter().position(|sample| sample.abs() > threshold) {
                let preroll = (self.output_sample_rate as f64 * 0.040) as usize;
                let start = first_speech.saturating_sub(preroll);
                pcm.drain(0..start);
                self.found_speech = true;
            } else {
                return Ok(());
            }
        }

        if !self.leftover.is_empty() {
            let mut combined = Vec::with_capacity(self.leftover.len() + pcm.len());
            combined.append(&mut self.leftover);
            combined.append(&mut pcm);
            pcm = combined;
        }

        let complete = (pcm.len() / self.blocksize) * self.blocksize;
        for chunk in pcm[..complete].chunks(self.blocksize) {
            self.audio_samples += chunk.len();
            writer.write_frame(WORKER_OUTPUT_AUDIO_CHUNK, request_id, &i16_bytes(chunk))?;
        }
        self.leftover = pcm[complete..].to_vec();
        Ok(())
    }

    fn finish(&mut self, request_id: u32, writer: &mut BinaryWriter) -> anyhow::Result<()> {
        if self.leftover.is_empty() {
            return Ok(());
        }
        self.audio_samples += self.leftover.len();
        let mut chunk = std::mem::take(&mut self.leftover);
        chunk.resize(self.blocksize, 0);
        writer.write_frame(WORKER_OUTPUT_AUDIO_CHUNK, request_id, &i16_bytes(&chunk))?;
        Ok(())
    }
}

trait ExpandUser {
    fn expanduser(&self) -> PathBuf;
}

impl ExpandUser for Path {
    fn expanduser(&self) -> PathBuf {
        let text = self.to_string_lossy();
        if let Some(rest) = text.strip_prefix("~/") {
            if let Some(home) = std::env::var_os("HOME") {
                return PathBuf::from(home).join(rest);
            }
        }
        self.to_path_buf()
    }
}

fn main() -> anyhow::Result<()> {
    let stdout_fd = unsafe { dup(STDOUT_FILENO) };
    if stdout_fd < 0 {
        anyhow::bail!("failed to duplicate stdout");
    }
    if unsafe { dup2(STDERR_FILENO, STDOUT_FILENO) } < 0 {
        anyhow::bail!("failed to redirect stdout to stderr");
    }
    let mut writer = BinaryWriter::new(stdout_fd);
    let args = Args::parse();

    match Worker::load(&args) {
        Ok(worker) => {
            if args.serve {
                serve(worker, &mut writer)
            } else {
                generate_once(worker, &args)
            }
        }
        Err(error) => {
            let message = error.to_string();
            let _ = writer.write_frame(WORKER_OUTPUT_ERROR, 0, message.as_bytes());
            Err(error)
        }
    }
}

fn serve(worker: Worker, writer: &mut BinaryWriter) -> anyhow::Result<()> {
    let (sender, receiver) = mpsc::channel::<Frame>();
    let cancelled = Arc::new(Mutex::new(HashSet::<u32>::new()));
    let reader_cancelled = Arc::clone(&cancelled);

    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        loop {
            let frame = match read_frame(&mut stdin) {
                Ok(Some(frame)) => frame,
                Ok(None) => Frame {
                    frame_type: WORKER_INPUT_SHUTDOWN,
                    request_id: 0,
                    payload: Vec::new(),
                },
                Err(error) => {
                    eprintln!("worker frame read error: {error}");
                    Frame {
                        frame_type: WORKER_INPUT_SHUTDOWN,
                        request_id: 0,
                        payload: Vec::new(),
                    }
                }
            };
            if frame.frame_type == WORKER_INPUT_CANCEL {
                if let Ok(mut set) = reader_cancelled.lock() {
                    set.insert(frame.request_id);
                }
                continue;
            }
            let shutdown = frame.frame_type == WORKER_INPUT_SHUTDOWN;
            if sender.send(frame).is_err() || shutdown {
                break;
            }
        }
    });

    writer.write_frame(WORKER_OUTPUT_READY, 0, &[])?;
    log_json(json!({
        "type": "server_ready",
        "backend": "rust_mlx",
        "model": worker.model_name
    }));

    while let Ok(frame) = receiver.recv() {
        match frame.frame_type {
            WORKER_INPUT_SHUTDOWN => break,
            WORKER_INPUT_SPEAK => {
                if let Err(error) =
                    worker.handle_speak(frame.request_id, &frame.payload, writer, &cancelled)
                {
                    writer.write_frame(
                        WORKER_OUTPUT_ERROR,
                        frame.request_id,
                        error.to_string().as_bytes(),
                    )?;
                    clear_cancelled(&cancelled, frame.request_id);
                }
            }
            other => {
                writer.write_frame(
                    WORKER_OUTPUT_ERROR,
                    frame.request_id,
                    format!("unknown frame type {other}").as_bytes(),
                )?;
            }
        }
    }
    Ok(())
}

fn generate_once(worker: Worker, args: &Args) -> anyhow::Result<()> {
    let text = load_text(args.text.as_deref(), args.text_file.as_ref(), None)?;
    if text.is_empty() {
        anyhow::bail!("provide --text or --text-file");
    }
    let started = Instant::now();
    let samples = worker.synthesize(&text)?;
    let elapsed = started.elapsed().as_secs_f64();
    let audio_seconds = samples.len() as f64 / worker.output_sample_rate as f64;
    let output = args.output.expanduser();
    write_wav_file(path_str(&output)?, &samples, worker.output_sample_rate)?;
    log_json(json!({
        "type": "generated",
        "seconds": round3(elapsed),
        "audioSeconds": round3(audio_seconds),
        "rtf": round3(audio_seconds / elapsed),
        "label": "voice_clone_rust"
    }));
    log_json(json!({ "type": "output", "path": output.display().to_string() }));
    Ok(())
}

fn read_frame<R: Read>(reader: &mut R) -> anyhow::Result<Option<Frame>> {
    let mut header = [0u8; FRAME_HEADER_BYTES];
    if !read_exact(reader, &mut header)? {
        return Ok(None);
    }
    let frame_type = header[0];
    let request_id = u32::from_le_bytes(header[1..5].try_into()?);
    let payload_len = u32::from_le_bytes(header[5..9].try_into()?) as usize;
    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 && !read_exact(reader, &mut payload)? {
        return Ok(None);
    }
    Ok(Some(Frame {
        frame_type,
        request_id,
        payload,
    }))
}

fn read_exact<R: Read>(reader: &mut R, buffer: &mut [u8]) -> anyhow::Result<bool> {
    let mut offset = 0;
    while offset < buffer.len() {
        let read = reader.read(&mut buffer[offset..])?;
        if read == 0 {
            return Ok(false);
        }
        offset += read;
    }
    Ok(true)
}

fn load_ref_text(args: &Args) -> anyhow::Result<String> {
    if let Some(path) = &args.ref_text_file {
        return Ok(std::fs::read_to_string(path.expanduser())?
            .trim()
            .to_string());
    }
    if let Some(text) = &args.ref_text {
        return Ok(text.trim().to_string());
    }
    Ok(DEFAULT_REF_TEXT.to_string())
}

fn load_text(
    value: Option<&str>,
    file: Option<&PathBuf>,
    fallback: Option<&str>,
) -> anyhow::Result<String> {
    if let Some(path) = file {
        return Ok(std::fs::read_to_string(path.expanduser())?
            .trim()
            .to_string());
    }
    if let Some(value) = value {
        return Ok(value.trim().to_string());
    }
    Ok(fallback.unwrap_or("").trim().to_string())
}

fn path_str(path: &Path) -> anyhow::Result<&str> {
    path.to_str()
        .ok_or_else(|| anyhow::anyhow!("path is not valid UTF-8: {}", path.display()))
}

fn samples_to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * 32768.0).clamp(-32768.0, 32767.0) as i16)
        .collect()
}

fn i16_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

fn take_cancelled(cancelled: &Arc<Mutex<HashSet<u32>>>, request_id: u32) -> bool {
    if let Ok(mut set) = cancelled.lock() {
        return set.remove(&request_id);
    }
    false
}

fn clear_cancelled(cancelled: &Arc<Mutex<HashSet<u32>>>, request_id: u32) {
    if let Ok(mut set) = cancelled.lock() {
        set.remove(&request_id);
    }
}

fn normalize_language(language: &str) -> String {
    match language.trim().to_lowercase().replace('_', "-").as_str() {
        "" | "auto" => "auto".to_string(),
        "de" | "de-de" => "german".to_string(),
        "en" | "en-us" | "en-gb" => "english".to_string(),
        "fr" | "fr-fr" => "french".to_string(),
        "es" | "es-es" => "spanish".to_string(),
        "it" | "it-it" => "italian".to_string(),
        "pt" | "pt-br" | "pt-pt" => "portuguese".to_string(),
        "ja" | "ja-jp" => "japanese".to_string(),
        "ko" | "ko-kr" => "korean".to_string(),
        "zh" | "zh-cn" | "zh-tw" => "chinese".to_string(),
        "ru" | "ru-ru" => "russian".to_string(),
        normalized => normalized.to_string(),
    }
}

fn log_json(value: serde_json::Value) {
    eprintln!("{}", value);
}

fn clear_mlx_cache() {
    #[cfg(feature = "mlx")]
    unsafe {
        qwen3_tts_rs::backend::mlx::ffi::mlx_clear_cache();
    }
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

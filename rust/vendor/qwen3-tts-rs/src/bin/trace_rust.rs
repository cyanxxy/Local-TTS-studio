// Copyright 2026 Michael Yuan.
// SPDX-License-Identifier: Apache-2.0

//! Generate a Rust-side parity trace for Qwen3-TTS ICL voice cloning.

use clap::Parser;
use qwen3_tts_rs::audio::{load_wav_file, resample};
use qwen3_tts_rs::audio_encoder::AudioEncoder;
use qwen3_tts_rs::inference::TTSInference;
use qwen3_tts_rs::speaker_encoder::SpeakerEncoder;
use qwen3_tts_rs::tensor::{Device, Tensor};
use qwen3_tts_rs::trace::TraceWriter;
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
#[command(
    name = "trace_rust",
    about = "Trace Rust Qwen3-TTS for Python MLX parity"
)]
struct Args {
    /// Path to the local model directory.
    #[arg(
        long,
        alias = "model-name",
        default_value = "~/models/qwen3-tts-12hz-1.7b-base"
    )]
    model_path: PathBuf,

    /// Text to synthesize.
    #[arg(long, default_value = "Hallo Dino.")]
    text: String,

    /// Reference WAV for ICL voice cloning.
    #[arg(
        long,
        default_value = "../../data/voices/elevenlabs-pibot-reference-de.wav"
    )]
    ref_audio: PathBuf,

    /// Reference transcript.
    #[arg(long)]
    ref_text: Option<String>,

    /// File containing the reference transcript.
    #[arg(
        long,
        default_value = "../../data/voices/elevenlabs-pibot-reference-de.txt"
    )]
    ref_text_file: PathBuf,

    /// Target language. Use the same value as Python, e.g. `de` for Pibot parity.
    #[arg(long, default_value = "de")]
    language: String,

    /// Trace output directory.
    #[arg(long)]
    trace_dir: PathBuf,

    /// Maximum generation steps to trace.
    #[arg(long, default_value_t = 4)]
    max_steps: i64,

    /// Sampling temperature. Use zero for deterministic greedy tracing.
    #[arg(long, default_value_t = 0.0)]
    temperature: f64,

    /// Top-k sampling. Ignored when temperature is zero.
    #[arg(long, default_value_t = 0)]
    top_k: i64,

    /// Number of top logits to record.
    #[arg(long, default_value_t = 8)]
    trace_topk: usize,

    /// Number of first/last tensor values to record.
    #[arg(long, default_value_t = 8)]
    sample_count: usize,

    /// Optional Python-generated ref_codes.json to isolate talker/code-predictor parity.
    #[arg(long)]
    ref_codes_json: Option<PathBuf>,

    /// Optional Python-generated generated_codes.json for teacher-forced parity traces.
    #[arg(long)]
    forced_codes_json: Option<PathBuf>,

    /// Optional path for dumping full speaker embedding values as JSON.
    #[arg(long)]
    dump_speaker_embed_json: Option<PathBuf>,
}

fn main() -> anyhow::Result<()> {
    #[cfg(feature = "mlx")]
    {
        qwen3_tts_rs::backend::mlx::stream::init_mlx(true);
    }

    let args = Args::parse();
    let model_path = args.model_path.expanduser();
    let ref_audio_path = args.ref_audio.expanduser();
    let ref_text = match args.ref_text {
        Some(text) => text.trim().to_string(),
        None => std::fs::read_to_string(args.ref_text_file.expanduser())?
            .trim()
            .to_string(),
    };

    let device = Device::Cpu;
    let inference = TTSInference::new(&model_path, device)?;
    let speaker_encoder = SpeakerEncoder::load(
        inference.weights(),
        &inference.config().speaker_encoder_config,
        device,
    )?;
    let audio_encoder = if args.ref_codes_json.is_none() {
        Some(AudioEncoder::load(
            &model_path
                .join("speech_tokenizer")
                .join("model.safetensors"),
            device,
        )?)
    } else {
        None
    };

    let sample_rate = inference.config().speaker_encoder_config.sample_rate;
    let (samples, source_sample_rate) = load_wav_file(path_str(&ref_audio_path)?)?;
    let samples = if source_sample_rate == sample_rate {
        samples
    } else {
        resample(&samples, source_sample_rate, sample_rate)?
    };

    let mut trace = TraceWriter::create(args.trace_dir.expanduser(), args.sample_count)?;
    let speaker_embedding = speaker_encoder.extract_embedding_with_trace(&samples, &mut trace)?;
    if let Some(path) = args.dump_speaker_embed_json.as_ref() {
        let path = path.expanduser();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let values = speaker_embedding.contiguous().to_vec_f32();
        std::fs::write(path, serde_json::to_vec(&values)?)?;
    }
    let ref_codes = if let Some(path) = args.ref_codes_json.as_ref() {
        let values: Vec<Vec<Vec<i64>>> =
            serde_json::from_str(&std::fs::read_to_string(path.expanduser())?)?;
        let quantizer_major = values.first().ok_or_else(|| {
            anyhow::anyhow!("ref_codes_json must have shape [1, quantizers, frames]")
        })?;
        let num_quantizers = quantizer_major.len();
        let num_frames = quantizer_major
            .first()
            .map(|codes| codes.len())
            .ok_or_else(|| anyhow::anyhow!("ref_codes_json contains no quantizers"))?;
        let quantizer_flat = quantizer_major
            .iter()
            .flat_map(|codes| codes.iter().copied())
            .collect::<Vec<_>>();
        let ref_codes_tensor = Tensor::from_slice_i64(&quantizer_flat).view(&[
            1,
            num_quantizers as i64,
            num_frames as i64,
        ]);
        trace.tensor("prepare/ref_codes", &ref_codes_tensor)?;
        let mut frames = Vec::with_capacity(num_frames);
        for frame_index in 0..num_frames {
            let mut frame = Vec::with_capacity(num_quantizers);
            for codes in quantizer_major {
                frame.push(*codes.get(frame_index).ok_or_else(|| {
                    anyhow::anyhow!("ref_codes_json quantizer has inconsistent frame count")
                })?);
            }
            frames.push(frame);
        }
        let flat = frames
            .iter()
            .flat_map(|frame| frame.iter().copied())
            .collect::<Vec<_>>();
        trace.ids("prepare/ref_codes_flat_frame_major", &flat)?;
        frames
    } else {
        audio_encoder
            .as_ref()
            .expect("audio encoder is loaded when ref_codes_json is absent")
            .encode_with_trace(&samples, &mut trace)?
    };

    trace.metadata(
        "input/ref_audio_loaded",
        serde_json::json!({
            "sample_rate": sample_rate,
            "samples": samples.len(),
            "source_sample_rate": source_sample_rate,
            "path": ref_audio_path.display().to_string(),
        }),
    )?;
    let forced_codes = if let Some(path) = args.forced_codes_json.as_ref() {
        Some(serde_json::from_str::<Vec<Vec<i64>>>(
            &std::fs::read_to_string(path.expanduser())?,
        )?)
    } else {
        None
    };
    inference.trace_with_icl(
        &mut trace,
        &args.text,
        &ref_text,
        &ref_codes,
        &speaker_embedding,
        &normalize_language(&args.language),
        args.temperature,
        args.top_k,
        args.max_steps,
        args.trace_topk,
        forced_codes.as_deref(),
    )?;
    Ok(())
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

fn path_str(path: &Path) -> anyhow::Result<&str> {
    path.to_str()
        .ok_or_else(|| anyhow::anyhow!("path is not valid UTF-8: {}", path.display()))
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

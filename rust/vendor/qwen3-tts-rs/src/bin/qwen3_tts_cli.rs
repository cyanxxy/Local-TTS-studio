// Copyright 2026 Michael Yuan.
// SPDX-License-Identifier: Apache-2.0

//! Standalone MLX-backed Qwen3-TTS CLI with timings comparable to qwen3-tts.cpp.

use clap::Parser;
use qwen3_tts_rs::audio::{load_wav_file, resample, write_wav_file};
use qwen3_tts_rs::audio_encoder::AudioEncoder;
use qwen3_tts_rs::inference::TTSInference;
use qwen3_tts_rs::speaker_encoder::SpeakerEncoder;
use qwen3_tts_rs::tensor::Device;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const DEFAULT_MODEL_PATH: &str = "~/models/qwen3-tts-12hz-0.6b-base-6bit";
const DEFAULT_REF_TEXT: &str = "I'm confused why some people have super short timelines, yet at the same time are bullish on scaling up reinforcement learning atop LLMs. If we're actually close to a human-like learner, then this whole approach of training on verifiable outcomes.";

#[derive(Parser, Debug)]
#[command(name = "qwen3-tts", about = "MLX-backed Qwen3-TTS CLI")]
struct Args {
    /// Path to the local MLX/HuggingFace model directory.
    #[arg(short = 'm', long, alias = "model-name", default_value = DEFAULT_MODEL_PATH)]
    model: PathBuf,

    /// Text to synthesize.
    #[arg(short = 't', long)]
    text: Option<String>,

    /// File containing text to synthesize.
    #[arg(long)]
    text_file: Option<PathBuf>,

    /// Output WAV path.
    #[arg(short = 'o', long, default_value = "out.wav")]
    output: PathBuf,

    /// Reference WAV for ICL voice cloning.
    #[arg(short = 'r', long)]
    ref_audio: PathBuf,

    /// Reference transcript.
    #[arg(long)]
    ref_text: Option<String>,

    /// File containing the reference transcript.
    #[arg(long)]
    ref_text_file: Option<PathBuf>,

    /// Target language, e.g. de, german, en, english.
    #[arg(short = 'l', long, default_value = "de")]
    language: String,

    /// Sampling temperature. Use 0 for greedy generation.
    #[arg(long, default_value_t = 0.9)]
    temperature: f64,

    /// Top-k sampling.
    #[arg(long, default_value_t = 50)]
    top_k: i64,

    /// Maximum generated codec frames.
    #[arg(long, alias = "max-new-tokens", default_value_t = 1536)]
    max_tokens: i64,

    /// Output sample rate.
    #[arg(long, default_value_t = 24000)]
    output_sample_rate: u32,

    /// Accepted for CLI parity with qwen3-tts.cpp. Currently ignored by MLX.
    #[arg(short = 'j', long, default_value_t = 0)]
    jobs: usize,

    /// Accepted for CLI parity. Currently ignored by this sampler.
    #[arg(long, default_value_t = 1.0)]
    top_p: f64,

    /// Accepted for CLI parity. Currently ignored by this sampler.
    #[arg(long, default_value_t = 1.0)]
    repetition_penalty: f64,

    /// Accepted for worker parity. Currently ignored by MLX backend.
    #[arg(long)]
    seed: Option<u64>,
}

struct ReferenceData {
    speaker_embedding: qwen3_tts_rs::tensor::Tensor,
    ref_codes: Vec<Vec<i64>>,
    seconds: f64,
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
    let args = Args::parse();
    let model_path = args.model.expanduser();
    let output_path = args.output.expanduser();
    let text = load_text(args.text.as_deref(), args.text_file.as_ref(), None)?;
    if text.is_empty() {
        anyhow::bail!("provide --text or --text-file");
    }
    let ref_text = load_text(
        args.ref_text.as_deref(),
        args.ref_text_file.as_ref(),
        Some(DEFAULT_REF_TEXT),
    )?;
    let language = normalize_language(&args.language);

    if args.jobs > 0 {
        eprintln!("warning: -j/--jobs is accepted for CLI parity but ignored by MLX");
    }
    if (args.top_p - 1.0).abs() > f64::EPSILON {
        eprintln!("warning: --top-p is accepted for CLI parity but ignored by this sampler");
    }
    if (args.repetition_penalty - 1.0).abs() > f64::EPSILON {
        eprintln!(
            "warning: --repetition-penalty is accepted for CLI parity but ignored by this sampler"
        );
    }
    if args.seed.is_some() {
        eprintln!("warning: --seed is accepted for CLI parity but ignored by MLX backend");
    }

    println!("Loading models from: {}", model_path.display());
    let load_start = Instant::now();
    init_backend();
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
    let load = load_start.elapsed();
    println!("All models loaded in {} ms", millis(load));

    println!("Synthesizing with voice cloning: \"{}\"", text);
    println!("Reference audio: {}", args.ref_audio.display());
    let ref_start = Instant::now();
    let reference = prepare_reference(
        &args.ref_audio.expanduser(),
        &inference,
        &speaker_encoder,
        &audio_encoder,
    )?;
    let speaker_encode = ref_start.elapsed();

    let generation = inference.generate_with_icl_timed(
        &text,
        &ref_text,
        &reference.ref_codes,
        &reference.speaker_embedding,
        &language,
        args.temperature,
        args.top_k,
        args.max_tokens,
    )?;

    let output_samples = if generation.sample_rate == args.output_sample_rate {
        generation.waveform
    } else {
        resample(
            &generation.waveform,
            generation.sample_rate,
            args.output_sample_rate,
        )?
    };
    write_wav_file(
        path_str(&output_path)?,
        &output_samples,
        args.output_sample_rate,
    )?;

    let audio_seconds = output_samples.len() as f64 / args.output_sample_rate as f64;
    let total_seconds = generation.timings.total.as_secs_f64();
    let throughput = if total_seconds > 0.0 {
        audio_seconds / total_seconds
    } else {
        0.0
    };

    println!();
    println!("Timing:");
    println!("  Load:           {} ms", millis(load));
    println!("  Reference prep: {} ms", millis(speaker_encode));
    println!(
        "  Tokenize:       {} ms",
        millis(generation.timings.tokenization)
    );
    println!(
        "  Embeddings:     {} ms",
        millis(generation.timings.embeddings)
    );
    println!(
        "  Generate:       {} ms",
        millis(generation.timings.code_generation)
    );
    println!(
        "  Decode:         {} ms",
        millis(generation.timings.vocoder_decode)
    );
    println!("  Total:          {} ms", millis(generation.timings.total));
    println!("  Audio duration: {:.2} s", audio_seconds);
    println!("  Throughput:     {:.2}x realtime", throughput);
    println!("  Code frames:    {}", generation.code_frames);
    println!("  Ref seconds:    {:.2} s", reference.seconds);

    let detail = &generation.timings.detailed_generation;
    let frames = detail.n_frames.max(1) as f64;
    println!();
    println!(
        "=== Detailed Generation Timing ({} frames) ===",
        detail.n_frames
    );
    println!();
    println!("  Prefill:");
    println!(
        "    Forward total:    {:8.1} ms",
        duration_ms(detail.prefill_forward)
    );
    println!(
        "      Compute:        {:8.1} ms",
        duration_ms(detail.prefill_forward)
    );
    println!();
    println!("  Talker forward_step (total / per-frame):");
    println!(
        "    Total:            {:8.1} ms   ({:.1} ms/frame)",
        duration_ms(detail.talker_forward),
        duration_ms(detail.talker_forward) / frames
    );
    println!(
        "      Compute:        {:8.1} ms   ({:.1} ms/frame)",
        duration_ms(detail.talker_forward),
        duration_ms(detail.talker_forward) / frames
    );
    println!();
    println!("  Code predictor (total / per-frame):");
    println!("    Backend:          MLX");
    println!(
        "    Total:            {:8.1} ms   ({:.1} ms/frame)",
        duration_ms(detail.code_pred),
        duration_ms(detail.code_pred) / frames
    );
    println!(
        "      Init/KV/embed:  {:8.1} ms   ({:.1} ms/frame)",
        duration_ms(detail.code_pred_init),
        duration_ms(detail.code_pred_init) / frames
    );
    println!(
        "      Prefill (2tok): {:8.1} ms   ({:.1} ms/frame)",
        duration_ms(detail.code_pred_prefill),
        duration_ms(detail.code_pred_prefill) / frames
    );
    println!(
        "      Steps (14):     {:8.1} ms   ({:.1} ms/frame)",
        duration_ms(detail.code_pred_steps),
        duration_ms(detail.code_pred_steps) / frames
    );
    println!();
    println!(
        "  Embed lookups:      {:8.1} ms   ({:.1} ms/frame)",
        duration_ms(detail.embed_lookup),
        duration_ms(detail.embed_lookup) / frames
    );
    let accounted =
        detail.prefill_forward + detail.talker_forward + detail.code_pred + detail.embed_lookup;
    println!(
        "  Other/overhead:     {:8.1} ms",
        duration_ms(detail.total_generate.saturating_sub(accounted))
    );
    println!("  ─────────────────────────────────────────");
    println!(
        "  Total generate:     {:8.1} ms",
        duration_ms(detail.total_generate)
    );
    if detail.n_frames > 0 {
        println!(
            "  Throughput:         {:8.1} ms/frame ({:.1} frames/s)",
            duration_ms(detail.total_generate) / detail.n_frames as f64,
            1000.0 * detail.n_frames as f64 / duration_ms(detail.total_generate)
        );
    }
    println!();
    println!("Output saved to: {}", output_path.display());

    eprintln!(
        "{}",
        json!({
            "type": "timing",
            "backend": "rust_mlx_cli",
            "model": model_path.display().to_string(),
            "output": output_path.display().to_string(),
            "loadMs": millis(load),
            "referencePrepMs": millis(speaker_encode),
            "tokenizeMs": millis(generation.timings.tokenization),
            "embeddingsMs": millis(generation.timings.embeddings),
            "generateMs": millis(generation.timings.code_generation),
            "decodeMs": millis(generation.timings.vocoder_decode),
            "totalMs": millis(generation.timings.total),
            "audioSeconds": round3(audio_seconds),
            "throughput": round3(throughput),
            "codeFrames": generation.code_frames,
            "sampleRate": args.output_sample_rate,
            "detail": {
                "frames": detail.n_frames,
                "prefillForwardMs": round3(duration_ms(detail.prefill_forward)),
                "talkerForwardMs": round3(duration_ms(detail.talker_forward)),
                "talkerForwardMsPerFrame": round3(duration_ms(detail.talker_forward) / frames),
                "codePredictorMs": round3(duration_ms(detail.code_pred)),
                "codePredictorMsPerFrame": round3(duration_ms(detail.code_pred) / frames),
                "codePredictorInitMs": round3(duration_ms(detail.code_pred_init)),
                "codePredictorPrefillMs": round3(duration_ms(detail.code_pred_prefill)),
                "codePredictorStepsMs": round3(duration_ms(detail.code_pred_steps)),
                "embedLookupMs": round3(duration_ms(detail.embed_lookup)),
                "generateTotalMs": round3(duration_ms(detail.total_generate)),
                "generateMsPerFrame": round3(duration_ms(detail.total_generate) / frames),
            },
        })
    );

    clear_mlx_cache();
    Ok(())
}

fn prepare_reference(
    ref_audio: &Path,
    inference: &TTSInference,
    speaker_encoder: &SpeakerEncoder,
    audio_encoder: &AudioEncoder,
) -> anyhow::Result<ReferenceData> {
    let se_sr = inference.config().speaker_encoder_config.sample_rate;
    let (samples, sample_rate) = load_wav_file(path_str(ref_audio)?)?;
    let samples = if sample_rate == se_sr {
        samples
    } else {
        resample(&samples, sample_rate, se_sr)?
    };
    let seconds = samples.len() as f64 / se_sr as f64;
    let speaker_embedding = speaker_encoder.extract_embedding(&samples)?;
    let ref_codes = audio_encoder.encode(&samples)?;
    Ok(ReferenceData {
        speaker_embedding,
        ref_codes,
        seconds,
    })
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

fn millis(duration: Duration) -> u128 {
    duration.as_millis()
}

fn duration_ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn init_backend() {
    #[cfg(feature = "mlx")]
    {
        qwen3_tts_rs::backend::mlx::stream::init_mlx(true);
        println!("MLX backend initialized (Metal GPU)");
    }
}

fn clear_mlx_cache() {
    #[cfg(feature = "mlx")]
    unsafe {
        qwen3_tts_rs::backend::mlx::ffi::mlx_clear_cache();
    }
}

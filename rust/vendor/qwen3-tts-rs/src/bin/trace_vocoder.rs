// Copyright 2026 Michael Yuan.
// SPDX-License-Identifier: Apache-2.0

//! Trace the Rust/MLX Qwen3-TTS vocoder for GGUF parity checks.

use clap::Parser;
use qwen3_tts_rs::audio::write_wav_file;
use qwen3_tts_rs::tensor::{Device, Tensor};
use qwen3_tts_rs::trace::TraceWriter;
use qwen3_tts_rs::vocoder::{load_vocoder_weights, Vocoder, VocoderConfig};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
#[command(name = "trace_vocoder", about = "Trace Rust Qwen3-TTS vocoder output")]
struct Args {
    /// Path to the local Qwen3-TTS model directory.
    #[arg(long, default_value = "~/models/qwen3-tts-12hz-0.6b-base")]
    model_path: PathBuf,

    /// Quantizer-major codes JSON with shape [1, 16, frames].
    #[arg(long)]
    codes_json: Option<PathBuf>,

    /// Frame-major codes JSON with shape [frames, 16].
    #[arg(long)]
    frame_codes_json: Option<PathBuf>,

    /// Optional trace output directory.
    #[arg(long)]
    trace_dir: Option<PathBuf>,

    /// Optional raw waveform sample JSON output.
    #[arg(long)]
    waveform_out: Option<PathBuf>,

    /// Optional 24 kHz PCM WAV output.
    #[arg(long)]
    wav_out: Option<PathBuf>,

    /// Optional raw 24 kHz signed 16-bit little-endian PCM output.
    #[arg(long)]
    pcm_s16le_out: Option<PathBuf>,

    /// Number of first/last tensor values to record.
    #[arg(long, default_value_t = 8)]
    sample_count: usize,
}

fn main() -> anyhow::Result<()> {
    #[cfg(feature = "mlx")]
    {
        qwen3_tts_rs::backend::mlx::stream::init_mlx(true);
    }

    let args = Args::parse();
    if args.codes_json.is_none() == args.frame_codes_json.is_none() {
        anyhow::bail!("exactly one of --codes-json or --frame-codes-json is required");
    }
    if args.trace_dir.is_none()
        && args.waveform_out.is_none()
        && args.wav_out.is_none()
        && args.pcm_s16le_out.is_none()
    {
        anyhow::bail!("at least one of --trace-dir, --waveform-out, --wav-out, or --pcm-s16le-out is required");
    }

    let model_path = args.model_path.expanduser();
    let weights = load_vocoder_weights(
        model_path
            .join("speech_tokenizer")
            .join("model.safetensors"),
        Device::Cpu,
    )?;
    let vocoder = Vocoder::load(&weights, VocoderConfig::default(), Device::Cpu)?;
    let codes = if let Some(path) = args.codes_json.as_ref() {
        load_quantizer_major_codes(&path.expanduser())?
    } else {
        load_frame_major_codes(
            &args
                .frame_codes_json
                .as_ref()
                .expect("validated")
                .expanduser(),
        )?
    };
    let waveform = if let Some(trace_dir) = args.trace_dir.as_ref() {
        let mut trace = TraceWriter::create(trace_dir.expanduser(), args.sample_count)?;
        vocoder.decode_with_trace(&codes, &mut trace)?
    } else {
        vocoder.decode(&codes)
    };

    let waveform_values = waveform.contiguous().to_vec_f32();
    if let Some(path) = args.waveform_out.as_ref() {
        write_waveform_json(&path.expanduser(), &waveform_values)?;
    }
    if let Some(path) = args.wav_out.as_ref() {
        let path = path.expanduser();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        write_wav_file(path_str(&path)?, &waveform_values, 24_000)?;
    }
    if let Some(path) = args.pcm_s16le_out.as_ref() {
        write_pcm_s16le(&path.expanduser(), &waveform_values)?;
    }

    Ok(())
}

fn load_quantizer_major_codes(path: &Path) -> anyhow::Result<Tensor> {
    let values: Vec<Vec<Vec<i64>>> = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let batch = values.len();
    if batch != 1 {
        anyhow::bail!("codes JSON must have batch size 1, got {batch}");
    }
    let quantizers = values[0].len();
    if quantizers != 16 {
        anyhow::bail!("codes JSON must have 16 quantizers, got {quantizers}");
    }
    let frames = values[0]
        .first()
        .map(Vec::len)
        .ok_or_else(|| anyhow::anyhow!("codes JSON contains no quantizers"))?;
    let mut flat = Vec::with_capacity(batch * quantizers * frames);
    for quantizer in &values[0] {
        if quantizer.len() != frames {
            anyhow::bail!("codes JSON quantizers have inconsistent frame counts");
        }
        flat.extend(quantizer.iter().copied());
    }
    Ok(Tensor::from_slice_i64(&flat).view(&[1, quantizers as i64, frames as i64]))
}

fn load_frame_major_codes(path: &Path) -> anyhow::Result<Tensor> {
    let frames: Vec<Vec<i64>> = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    if frames.is_empty() {
        anyhow::bail!("frame-major codes JSON is empty");
    }
    let mut flat = Vec::with_capacity(frames.len() * 16);
    for codebook in 0..16 {
        for (frame_index, frame) in frames.iter().enumerate() {
            if frame.len() != 16 {
                anyhow::bail!("frame {frame_index} has {} codes, expected 16", frame.len());
            }
            flat.push(frame[codebook]);
        }
    }
    Ok(Tensor::from_slice_i64(&flat).view(&[1, 16, frames.len() as i64]))
}

fn path_str(path: &Path) -> anyhow::Result<&str> {
    path.to_str()
        .ok_or_else(|| anyhow::anyhow!("path is not valid UTF-8: {}", path.display()))
}

fn write_waveform_json(path: &Path, values: &[f32]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = std::fs::File::create(path)?;
    serde_json::to_writer(&mut out, values)?;
    out.write_all(b"\n")?;
    Ok(())
}

fn write_pcm_s16le(path: &Path, values: &[f32]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = std::fs::File::create(path)?;
    for value in values {
        let sample = (value.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.write_all(&sample.to_le_bytes())?;
    }
    Ok(())
}

trait ExpandUser {
    fn expanduser(&self) -> PathBuf;
}

impl ExpandUser for PathBuf {
    fn expanduser(&self) -> PathBuf {
        let text = self.to_string_lossy();
        if let Some(rest) = text.strip_prefix("~/") {
            if let Some(home) = std::env::var_os("HOME") {
                return PathBuf::from(home).join(rest);
            }
        }
        self.clone()
    }
}

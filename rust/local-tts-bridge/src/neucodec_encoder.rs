//! WAV reference encoding for NeuTTS voice cloning.
//!
//! The upstream `neutts` crate ships only the NeuCodec *decoder*; its encoder
//! is an unimplemented stub that tells users to pre-encode references with the
//! Python `neucodec` package. This module fills that gap with a pure-Rust
//! (rten) port of the NeuCodec encoder published at
//! `ragtag-ai/neucodec-encoder-rten`, which has verified numerical parity with
//! the PyTorch original. It lets the bridge accept raw WAV references and
//! encode them to NeuCodec codes locally, with no Python dependency.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use rten::Model;
use rten_tensor::NdTensor;
use rten_tensor::prelude::*;

const ENCODER_MODEL_URL: &str =
    "https://huggingface.co/ragtag-ai/neucodec-encoder-rten/resolve/main/neucodec_encoder_v2.rten";
const ENCODER_MODEL_FILENAME: &str = "neucodec_encoder_v2.rten";
/// The exported graph takes a fixed 20-second window at 16 kHz; shorter
/// references are zero-padded and the resulting code tail is trimmed.
pub const ENCODER_WINDOW_SAMPLES: usize = neutts::ENCODER_SAMPLE_RATE as usize * 20;
/// Below ~0.5 s there is not enough voice signal to clone from.
pub const MIN_REFERENCE_SAMPLES: usize = neutts::ENCODER_SAMPLE_RATE as usize / 2;
/// The published fp32 export is ~1.77 GB; anything far below that is a
/// truncated download left over from an interrupted run.
const MIN_VALID_MODEL_BYTES: u64 = 1_500_000_000;

pub struct NeuCodecRtenEncoder {
    model: Model,
}

impl NeuCodecRtenEncoder {
    /// Load the encoder, downloading the model file into `cache_dir` first if
    /// needed. `progress` receives human-readable status lines for the UI.
    pub fn ensure(cache_dir: &Path, progress: &mut dyn FnMut(String)) -> Result<Self> {
        let path = ensure_model_file(cache_dir, progress)?;
        progress("Loading NeuCodec encoder...".to_string());
        let model = Model::load_file(&path).with_context(|| {
            format!(
                "Failed to load NeuCodec encoder model {} (delete the file to re-download)",
                path.display()
            )
        })?;
        Ok(Self { model })
    }

    /// Encode 16 kHz mono samples to NeuCodec codes (50 per second).
    /// Input longer than the 20-second window must be truncated by the caller.
    pub fn encode(&self, samples_16k: &[f32]) -> Result<Vec<i32>> {
        if samples_16k.len() < MIN_REFERENCE_SAMPLES {
            bail!("Reference audio is too short; provide at least half a second of speech.");
        }
        if samples_16k.len() > ENCODER_WINDOW_SAMPLES {
            bail!("Reference audio exceeds the 20-second encoder window.");
        }
        let mut window = vec![0.0f32; ENCODER_WINDOW_SAMPLES];
        window[..samples_16k.len()].copy_from_slice(samples_16k);

        let input = NdTensor::from_data([1usize, 1, ENCODER_WINDOW_SAMPLES], window);
        let output = self
            .model
            .run_one(input.into(), None)
            .context("NeuCodec encoder inference failed")?;
        let rten::Value::Int32Tensor(codes) = output else {
            bail!("NeuCodec encoder returned an unexpected output type.");
        };
        let mut codes = codes.to_vec();
        // The window is zero-padded, so codes past the real audio are padding
        // artifacts; the codec emits one code per 320 input samples.
        let expected = samples_16k
            .len()
            .div_ceil(neutts::codec::ENCODER_SAMPLES_PER_TOKEN);
        codes.truncate(expected.max(1));
        if codes.is_empty() {
            bail!("NeuCodec encoder produced no codes.");
        }
        Ok(codes)
    }
}

fn ensure_model_file(cache_dir: &Path, progress: &mut dyn FnMut(String)) -> Result<PathBuf> {
    if let Ok(override_path) = std::env::var("OPEN_TTS_NEUCODEC_ENCODER") {
        let path = PathBuf::from(override_path);
        if !path.exists() {
            bail!(
                "OPEN_TTS_NEUCODEC_ENCODER points to a missing file: {}",
                path.display()
            );
        }
        return Ok(path);
    }

    let dir = cache_dir.join("neucodec-encoder");
    fs::create_dir_all(&dir)
        .with_context(|| format!("Failed to create encoder cache dir {}", dir.display()))?;
    let path = dir.join(ENCODER_MODEL_FILENAME);
    if let Ok(metadata) = fs::metadata(&path)
        && metadata.len() >= MIN_VALID_MODEL_BYTES
    {
        return Ok(path);
    }

    progress("Downloading NeuCodec encoder (~1.8 GB, one-time)...".to_string());
    let response = ureq::get(ENCODER_MODEL_URL)
        .call()
        .context("Failed to download the NeuCodec encoder model")?;
    let total_bytes = response
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok());

    let temp_path = dir.join(format!(
        "{ENCODER_MODEL_FILENAME}.tmp-{}",
        std::process::id()
    ));
    let result = stream_to_file(response.into_reader(), &temp_path, total_bytes, progress);
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result?;
    fs::rename(&temp_path, &path).with_context(|| {
        format!(
            "Failed to move downloaded encoder model into place at {}",
            path.display()
        )
    })?;
    Ok(path)
}

fn stream_to_file(
    mut reader: impl Read,
    path: &Path,
    total_bytes: Option<u64>,
    progress: &mut dyn FnMut(String),
) -> Result<()> {
    let mut file = fs::File::create(path)
        .with_context(|| format!("Failed to create {}", path.display()))?;
    let mut buffer = vec![0u8; 1 << 20];
    let mut written: u64 = 0;
    let mut next_report: u64 = 0;
    loop {
        let read = reader
            .read(&mut buffer)
            .context("NeuCodec encoder download was interrupted")?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .with_context(|| format!("Failed writing {}", path.display()))?;
        written += read as u64;
        if written >= next_report {
            let progress_text = match total_bytes {
                Some(total) if total > 0 => format!(
                    "Downloading NeuCodec encoder: {} / {} MB",
                    written / 1_000_000,
                    total / 1_000_000
                ),
                _ => format!(
                    "Downloading NeuCodec encoder: {} MB",
                    written / 1_000_000
                ),
            };
            progress(progress_text);
            next_report = written + 100_000_000;
        }
    }
    if let Some(total) = total_bytes
        && written != total
    {
        bail!("NeuCodec encoder download is incomplete ({written} of {total} bytes).");
    }
    file.flush()
        .with_context(|| format!("Failed flushing {}", path.display()))?;
    Ok(())
}

use std::io::Cursor;

use anyhow::{Context, Result, bail, ensure};
use sha1::{Digest, Sha1};

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedReferenceWav {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub digest: String,
    pub truncated: bool,
}

pub fn prepare_reference_wav(
    bytes: &[u8],
    target_sample_rate: u32,
    max_duration_seconds: u32,
) -> Result<PreparedReferenceWav> {
    ensure!(target_sample_rate > 0, "Qwen3 reference target sample rate must be positive.");
    ensure!(max_duration_seconds > 0, "Qwen3 reference duration limit must be positive.");

    let mut reader = hound::WavReader::new(Cursor::new(bytes))
        .context("Qwen3 reference must be a valid WAV file.")?;
    let spec = reader.spec();
    ensure!(spec.sample_rate > 0, "Qwen3 reference WAV has an invalid sample rate.");
    ensure!(
        matches!(spec.channels, 1 | 2),
        "Qwen3 reference WAV must be mono or stereo."
    );

    let interleaved = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("Failed reading float Qwen3 reference samples.")?,
        hound::SampleFormat::Int if spec.bits_per_sample <= 16 => reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| f32::from(value) / 32_768.0))
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("Failed reading int16 Qwen3 reference samples.")?,
        hound::SampleFormat::Int => {
            let denominator = 2_f32.powi(i32::from(spec.bits_per_sample.saturating_sub(1)));
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / denominator))
                .collect::<std::result::Result<Vec<_>, _>>()
                .context("Failed reading int32 Qwen3 reference samples.")?
        }
    };

    let channels = usize::from(spec.channels);
    let mono = if channels == 1 {
        interleaved
    } else {
        interleaved
            .chunks_exact(channels)
            .map(|frame| {
                frame
                    .iter()
                    .map(|sample| if sample.is_finite() { *sample } else { 0.0 })
                    .sum::<f32>()
                    / channels as f32
            })
            .collect()
    };
    ensure!(!mono.is_empty(), "Qwen3 reference WAV contains no audio.");

    let mut samples = if spec.sample_rate == target_sample_rate {
        mono
    } else {
        let expected_len = ((mono.len() as u128 * u128::from(target_sample_rate))
            .div_ceil(u128::from(spec.sample_rate))) as usize;
        let mut resampled = qwen3_tts_rs::audio::resample(
            &mono,
            spec.sample_rate,
            target_sample_rate,
        )
        .context("Failed to resample Qwen3 reference audio.")?;
        resampled.truncate(expected_len);
        resampled
    };
    for sample in &mut samples {
        if !sample.is_finite() {
            *sample = 0.0;
        }
    }

    let max_samples = usize::try_from(
        u64::from(target_sample_rate) * u64::from(max_duration_seconds),
    )
    .context("Qwen3 reference duration limit is too large.")?;
    let truncated = samples.len() > max_samples;
    samples.truncate(max_samples);
    if samples.is_empty() {
        bail!("Qwen3 reference WAV contains no usable audio.");
    }

    let mut hasher = Sha1::new();
    hasher.update(target_sample_rate.to_le_bytes());
    for sample in &samples {
        hasher.update(sample.to_le_bytes());
    }

    Ok(PreparedReferenceWav {
        samples,
        sample_rate: target_sample_rate,
        digest: format!("{:x}", hasher.finalize()),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn wav_bytes(channels: u16, sample_rate: u32, samples: &[i16]) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        {
            let mut writer = hound::WavWriter::new(&mut bytes, spec).unwrap();
            for sample in samples {
                writer.write_sample(*sample).unwrap();
            }
            writer.finalize().unwrap();
        }
        bytes.into_inner()
    }

    #[test]
    fn decodes_downmixes_resamples_and_digests_reference_wav() {
        let stereo = [16_384_i16, 0_i16].repeat(1_024);
        let bytes = wav_bytes(2, 12_000, &stereo);
        let prepared = prepare_reference_wav(&bytes, 24_000, 20).unwrap();
        assert_eq!(prepared.sample_rate, 24_000);
        assert_eq!(prepared.samples.len(), 2_048);
        assert!((prepared.samples[1_024] - 0.25).abs() < 0.02);
        assert_eq!(prepared.digest.len(), 40);
        assert!(!prepared.truncated);
    }

    #[test]
    fn rejects_invalid_or_unsupported_reference_wav() {
        assert!(prepare_reference_wav(b"not wav", 24_000, 20).is_err());
        let three_channels = wav_bytes(3, 24_000, &[0, 0, 0]);
        assert!(prepare_reference_wav(&three_channels, 24_000, 20).is_err());
        assert!(prepare_reference_wav(&wav_bytes(1, 24_000, &[0]), 0, 20).is_err());
    }

    #[test]
    fn truncates_to_the_configured_duration() {
        let bytes = wav_bytes(1, 4, &[0, 1, 2, 3, 4, 5, 6, 7]);
        let prepared = prepare_reference_wav(&bytes, 4, 1).unwrap();
        assert_eq!(prepared.samples.len(), 4);
        assert!(prepared.truncated);
    }
}

use std::io::Cursor;

use anyhow::{Context, Result, bail, ensure};
use sha1::{Digest, Sha1};

#[cfg(test)]
use crate::reference_audio::{MAX_REFERENCE_WAV_SAMPLE_RATE, MIN_REFERENCE_WAV_SAMPLE_RATE};
use crate::reference_audio::{decode_bounded_mono_wav, ensure_reference_sample_rate};

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedReferenceWav {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub digest: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedReferenceWav {
    samples: Vec<f32>,
    sample_rate: u32,
    truncated: bool,
}

pub fn decode_reference_wav(
    bytes: &[u8],
    max_duration_seconds: u32,
) -> Result<DecodedReferenceWav> {
    ensure!(
        max_duration_seconds > 0,
        "Qwen3 reference duration limit must be positive."
    );
    let reader = hound::WavReader::new(Cursor::new(bytes))
        .context("Qwen3 reference must be a valid WAV file.")?;
    let decoded = decode_bounded_mono_wav(reader, "Qwen3 reference WAV", max_duration_seconds)?;
    ensure!(
        !decoded.samples.is_empty(),
        "Qwen3 reference WAV contains no audio."
    );
    Ok(DecodedReferenceWav {
        samples: decoded.samples,
        sample_rate: decoded.sample_rate,
        truncated: decoded.truncated,
    })
}

pub fn prepare_decoded_reference_wav(
    decoded: DecodedReferenceWav,
    target_sample_rate: u32,
    max_duration_seconds: u32,
) -> Result<PreparedReferenceWav> {
    ensure_reference_sample_rate(target_sample_rate, "Qwen3 reference target")?;
    ensure!(
        max_duration_seconds > 0,
        "Qwen3 reference duration limit must be positive."
    );

    let mut samples = if decoded.sample_rate == target_sample_rate {
        decoded.samples
    } else {
        let expected_len = ((decoded.samples.len() as u128 * u128::from(target_sample_rate))
            .div_ceil(u128::from(decoded.sample_rate))) as usize;
        let mut resampled = qwen3_tts_rs::audio::resample(
            &decoded.samples,
            decoded.sample_rate,
            target_sample_rate,
        )
        .context("Failed to resample Qwen3 reference audio.")?;
        resampled.truncate(expected_len);
        resampled
    };
    for sample in &mut samples {
        *sample = if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        };
    }

    let max_samples =
        usize::try_from(u64::from(target_sample_rate) * u64::from(max_duration_seconds))
            .context("Qwen3 reference duration limit is too large.")?;
    let truncated = decoded.truncated || samples.len() > max_samples;
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
pub fn prepare_reference_wav(
    bytes: &[u8],
    target_sample_rate: u32,
    max_duration_seconds: u32,
) -> Result<PreparedReferenceWav> {
    let decoded = decode_reference_wav(bytes, max_duration_seconds)?;
    prepare_decoded_reference_wav(decoded, target_sample_rate, max_duration_seconds)
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
        assert!(
            prepare_reference_wav(&wav_bytes(1, 1, &[0]), 24_000, 20)
                .unwrap_err()
                .to_string()
                .contains(&format!(
                    "between {MIN_REFERENCE_WAV_SAMPLE_RATE} and {MAX_REFERENCE_WAV_SAMPLE_RATE}"
                ))
        );
        assert!(prepare_reference_wav(&wav_bytes(1, 192_001, &[0]), 24_000, 20).is_err());
    }

    #[test]
    fn truncates_to_the_configured_duration() {
        let bytes = wav_bytes(1, 8_000, &vec![1_000; 8_001]);
        let prepared = prepare_reference_wav(&bytes, 16_000, 1).unwrap();
        assert_eq!(prepared.samples.len(), 16_000);
        assert!(prepared.truncated);
    }
}

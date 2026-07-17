use std::io::Read;

use anyhow::{Context, Result, ensure};

pub const MIN_REFERENCE_WAV_SAMPLE_RATE: u32 = 8_000;
pub const MAX_REFERENCE_WAV_SAMPLE_RATE: u32 = 192_000;
pub const MAX_REFERENCE_WAV_CHANNELS: usize = 2;

pub struct BoundedMonoWav {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub truncated: bool,
}

pub fn ensure_reference_sample_rate(sample_rate: u32, what: &str) -> Result<()> {
    ensure!(
        (MIN_REFERENCE_WAV_SAMPLE_RATE..=MAX_REFERENCE_WAV_SAMPLE_RATE).contains(&sample_rate),
        "{what} sample rate must be between {MIN_REFERENCE_WAV_SAMPLE_RATE} and {MAX_REFERENCE_WAV_SAMPLE_RATE} Hz."
    );
    Ok(())
}

/// Decode at most `max_duration_seconds` of a WAV and one additional frame.
/// The extra frame detects truncation without expanding an entire untrusted
/// upload to Float32 or passing an unbounded duration to a resampler.
pub fn decode_bounded_mono_wav<R: Read>(
    mut reader: hound::WavReader<R>,
    what: &str,
    max_duration_seconds: u32,
) -> Result<BoundedMonoWav> {
    ensure!(
        max_duration_seconds > 0,
        "{what} duration limit must be positive."
    );
    let spec = reader.spec();
    ensure_reference_sample_rate(spec.sample_rate, what)?;
    let channels = usize::from(spec.channels);
    ensure!(
        (1..=MAX_REFERENCE_WAV_CHANNELS).contains(&channels),
        "{what} must be mono or stereo."
    );
    let max_frames = usize::try_from(
        u64::from(spec.sample_rate)
            .checked_mul(u64::from(max_duration_seconds))
            .context("Reference WAV duration limit overflowed")?,
    )
    .context("Reference WAV duration limit does not fit this platform")?;
    let declared_frames = usize::try_from(reader.duration())
        .context("Reference WAV duration does not fit this platform")?;
    // RIFF's declared data size is attacker-controlled and hound can construct
    // a reader before discovering that the sample payload is truncated. Do
    // not let a tiny forged file reserve the entire 20-second ceiling eagerly.
    let initial_capacity = declared_frames
        .min(max_frames)
        .min(spec.sample_rate as usize);

    let (samples, detected_truncation) = match spec.sample_format {
        hound::SampleFormat::Float => collect_bounded_mono_frames(
            reader.samples::<f32>(),
            channels,
            max_frames,
            initial_capacity,
            what,
        )?,
        hound::SampleFormat::Int if spec.bits_per_sample <= 16 => {
            let denominator = 2_f32.powi(i32::from(spec.bits_per_sample.saturating_sub(1)));
            collect_bounded_mono_frames(
                reader
                    .samples::<i16>()
                    .map(|sample| sample.map(|value| f32::from(value) / denominator)),
                channels,
                max_frames,
                initial_capacity,
                what,
            )?
        }
        hound::SampleFormat::Int => {
            let denominator = 2_f32.powi(i32::from(spec.bits_per_sample.saturating_sub(1)));
            collect_bounded_mono_frames(
                reader
                    .samples::<i32>()
                    .map(|sample| sample.map(|value| value as f32 / denominator)),
                channels,
                max_frames,
                initial_capacity,
                what,
            )?
        }
    };

    Ok(BoundedMonoWav {
        samples,
        sample_rate: spec.sample_rate,
        truncated: detected_truncation || declared_frames > max_frames,
    })
}

fn collect_bounded_mono_frames<I>(
    samples: I,
    channels: usize,
    max_frames: usize,
    initial_capacity: usize,
    what: &str,
) -> Result<(Vec<f32>, bool)>
where
    I: Iterator<Item = std::result::Result<f32, hound::Error>>,
{
    let mut mono = Vec::with_capacity(initial_capacity);
    let mut frame_sum = 0.0_f32;
    let mut channel_index = 0_usize;

    for sample in samples {
        let sample = sample.with_context(|| format!("Failed reading {what} samples"))?;
        // Float WAV payloads are untrusted and hound intentionally preserves
        // out-of-range IEEE-754 values. Keep the normalized PCM domain before
        // summing channels so two finite f32::MAX samples cannot overflow the
        // stereo accumulator and feed Inf/NaN into a resampler or model.
        frame_sum += if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        channel_index += 1;
        if channel_index != channels {
            continue;
        }

        if mono.len() == max_frames {
            return Ok((mono, true));
        }
        mono.push(frame_sum / channels as f32);
        frame_sum = 0.0;
        channel_index = 0;
    }

    Ok((mono, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostile_float_pcm_is_finite_and_clamped_before_downmix() {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 16_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            for sample in [f32::MAX, f32::MAX, f32::NAN, f32::NEG_INFINITY] {
                writer.write_sample(sample).unwrap();
            }
            writer.finalize().unwrap();
        }
        let reader = hound::WavReader::new(std::io::Cursor::new(cursor.into_inner())).unwrap();
        let decoded = decode_bounded_mono_wav(reader, "test WAV", 1).unwrap();
        assert_eq!(decoded.samples, vec![1.0, 0.0]);
        assert!(decoded.samples.iter().all(|sample| sample.is_finite()));
    }
}

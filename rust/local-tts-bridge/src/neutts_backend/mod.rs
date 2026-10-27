//! NeuTTS as a bridge backend: a llama.cpp backbone and NeuCodec decoder from
//! the `neutts` crate, plus the RTen NeuCodec encoder for WAV references.
//! NeuTTS returns whole-text audio, which the request loop then frames.

use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result, ensure};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};

use crate::neucodec_encoder::{self, NeuCodecRtenEncoder};
use crate::protocol::{GenerationOutput, ensure_reference_audio_base64_len, round_secs};
use crate::reference_audio::decode_bounded_mono_wav;
use crate::resident_model;
use crate::ws::{Backend, WebSocketConnection};
use open_tts_bridge_core::neutts_request::{
    NEUTTS_DEFAULT_MODEL, NeuttsReference, ensure_neutts_codes_base64_len, neutts_codes_from_f32,
    parse_neutts_request, prevalidate_neutts_npy, validate_neutts_reference_codes,
};

/// Version of the `neutts` crate in Cargo.lock, reported by the probe.
const NEUTTS_PACKAGE_VERSION: &str = "0.1.1";
const NEUTTS_REFERENCE_MAX_DURATION_SECONDS: u32 = 20;

struct NeuttsHost {
    model_repo: String,
    model: neutts::NeuTTS,
}

pub struct NeuttsBackend {
    cache_dir: PathBuf,
    host: Option<NeuttsHost>,
    encoder: Option<NeuCodecRtenEncoder>,
}

impl NeuttsBackend {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            host: None,
            encoder: None,
        }
    }

    fn ensure_encoder(&mut self, progress: &mut dyn FnMut(String)) -> Result<&NeuCodecRtenEncoder> {
        if self.encoder.is_none() {
            self.encoder = Some(NeuCodecRtenEncoder::ensure(&self.cache_dir, progress)?);
        }
        Ok(self.encoder.as_ref().expect("encoder just set"))
    }

    fn ensure_model(&mut self, model_repo: &str) -> Result<()> {
        resident_model::ensure_resident_model(
            &mut self.host,
            |host| host.model_repo == model_repo,
            || {
                let model = neutts::download::load_from_hub(model_repo)
                    .with_context(|| format!("Failed to load Rust NeuTTS model {model_repo}"))?;
                Ok(NeuttsHost {
                    model_repo: model_repo.to_string(),
                    model,
                })
            },
        )
    }
}

impl Backend for NeuttsBackend {
    fn warm(&mut self, _payload: Value) -> Result<Value> {
        Ok(json!({
            "warmed": false,
            "message": "NeuTTS has no resident engine warm-up.",
        }))
    }

    fn generate(
        &mut self,
        request_id: &str,
        payload: Value,
        connection: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        let request = parse_neutts_request(payload)?;
        let started = Instant::now();
        let mut phase_timings = serde_json::Map::new();

        enum PreparedReference {
            Codes(Vec<i32>),
            Audio { samples: Vec<f32>, truncated: bool },
        }

        let reference_started = Instant::now();
        let prepared_reference = match &request.reference {
            NeuttsReference::Codes(encoded) => {
                PreparedReference::Codes(decode_neutts_reference_codes(encoded)?)
            }
            NeuttsReference::Audio(encoded) => {
                let (samples, truncated) = prepare_neutts_reference_samples(encoded)?;
                PreparedReference::Audio { samples, truncated }
            }
        };
        let reference_validation_elapsed = reference_started.elapsed();

        // NeuTTS inference is a single opaque call, so cancellation can only be
        // observed at the phase boundaries around it.
        connection.bail_if_cancelled(request_id)?;
        connection.send_progress(
            request_id,
            "model_load",
            format!("Loading Rust NeuTTS model: {}", request.model_repo),
            started,
        )?;
        let load_started = Instant::now();
        self.ensure_model(&request.model_repo)?;
        phase_timings.insert(
            "modelLoadSec".to_string(),
            json!(round_secs(load_started.elapsed().as_secs_f64())),
        );

        let reference_encoding_started = Instant::now();
        let mut warnings = Vec::new();
        let reference_codes = match prepared_reference {
            PreparedReference::Codes(codes) => codes,
            PreparedReference::Audio { samples, truncated } => {
                let mut progress = |message: String| {
                    let _ = connection.send_progress(
                        request_id,
                        "reference_encoding",
                        message,
                        started,
                    );
                };
                progress("Encoding WAV reference with NeuCodec...".to_string());
                if truncated {
                    warnings.push(
                        "Reference audio is longer than 20 seconds; only the first 20 seconds were used."
                            .to_string(),
                    );
                }
                self.ensure_encoder(&mut progress)?.encode(&samples)?
            }
        };
        let reference_elapsed = reference_validation_elapsed + reference_encoding_started.elapsed();
        phase_timings.insert(
            "referenceEncodingSec".to_string(),
            json!(round_secs(reference_elapsed.as_secs_f64())),
        );

        connection.bail_if_cancelled(request_id)?;
        connection.send_progress(
            request_id,
            "inference",
            "Running Rust NeuTTS inference...",
            started,
        )?;
        let inference_started = Instant::now();
        let host = self.host.as_ref().context("NeuTTS model was not loaded")?;
        let samples = host
            .model
            .infer(
                request.text.trim(),
                &reference_codes,
                request.reference_text.trim(),
            )
            .with_context(|| format!("NeuTTS inference failed for {}", host.model_repo))?;
        phase_timings.insert(
            "inferenceSec".to_string(),
            json!(round_secs(inference_started.elapsed().as_secs_f64())),
        );

        Ok(GenerationOutput {
            samples,
            sample_rate: neutts::SAMPLE_RATE as usize,
            model_repo: request.model_repo,
            device: None,
            warnings,
            streamed_audio: None,
            phase_timings,
        })
    }
}

pub fn probe_result() -> Value {
    json!({
        "ready": true,
        "message": "Rust NeuTTS runtime is ready. Upload a WAV reference clip or pre-encoded NeuCodec .npy codes before generating.",
        "runtime": "rust",
        "package": "neutts",
        "packageVersion": NEUTTS_PACKAGE_VERSION,
        "recommendedModelRepo": NEUTTS_DEFAULT_MODEL,
        "warnings": [
            "The first WAV reference triggers a one-time NeuCodec encoder download (~1.8 GB)."
        ],
    })
}

fn decode_neutts_reference_codes(encoded: &str) -> Result<Vec<i32>> {
    let encoded = encoded.trim();
    ensure_neutts_codes_base64_len(encoded.len())?;
    let bytes = BASE64
        .decode(encoded)
        .context("Failed to decode NeuTTS reference codes")?;
    prevalidate_neutts_npy(&bytes)?;

    let parsed = neutts::npy::parse_npy(&bytes).context("Failed to parse NeuTTS reference .npy")?;
    let codes = match parsed {
        neutts::npy::NpyData::Int32 { data, .. } => data,
        neutts::npy::NpyData::Float32 { data, .. } => neutts_codes_from_f32(data)?,
    };
    validate_neutts_reference_codes(&codes)?;
    Ok(codes)
}

fn prepare_neutts_reference_samples(encoded: &str) -> Result<(Vec<f32>, bool)> {
    ensure_reference_audio_base64_len(encoded.trim().len())?;
    let bytes = BASE64
        .decode(encoded.trim())
        .context("Failed to decode NeuTTS reference WAV")?;
    let reader = hound::WavReader::new(std::io::Cursor::new(bytes))
        .context("NeuTTS reference must be a valid WAV file")?;
    let decoded = decode_bounded_mono_wav(
        reader,
        "NeuTTS reference WAV",
        NEUTTS_REFERENCE_MAX_DURATION_SECONDS,
    )?;
    ensure!(
        !decoded.truncated,
        "NeuTTS reference audio exceeds 20 seconds. Provide a shorter clip and its exact transcript; audio cannot be trimmed independently."
    );
    ensure!(
        !decoded.samples.is_empty(),
        "NeuTTS reference WAV contains no audio."
    );
    let mut samples = neutts::codec::resample(
        &decoded.samples,
        decoded.sample_rate,
        neutts::ENCODER_SAMPLE_RATE,
    );
    for sample in &mut samples {
        *sample = if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        };
    }
    let truncated = decoded.truncated || samples.len() > neucodec_encoder::ENCODER_WINDOW_SAMPLES;
    samples.truncate(neucodec_encoder::ENCODER_WINDOW_SAMPLES);
    ensure!(
        samples.len() >= neucodec_encoder::MIN_REFERENCE_SAMPLES,
        "Reference audio is too short; provide at least half a second of speech."
    );
    Ok((samples, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use open_tts_bridge_core::neutts_request::{
        MAX_NEUTTS_REFERENCE_CODE_VALUE, MAX_NEUTTS_REFERENCE_CODES,
    };

    fn wav_base64_with_channels(channels: u16, sample_rate: u32, samples: &[i16]) -> String {
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            for sample in samples {
                writer.write_sample(*sample).unwrap();
            }
            writer.finalize().unwrap();
        }
        BASE64.encode(cursor.into_inner())
    }

    fn wav_base64(sample_rate: u32, samples: &[i16]) -> String {
        wav_base64_with_channels(1, sample_rate, samples)
    }

    fn npy_base64_with_header(header: &str, data: &[u8]) -> String {
        let header_len = u16::try_from(header.len()).unwrap();
        let mut bytes = Vec::with_capacity(10 + header.len() + data.len());
        bytes.extend_from_slice(b"\x93NUMPY");
        bytes.extend_from_slice(&[1, 0]);
        bytes.extend_from_slice(&header_len.to_le_bytes());
        bytes.extend_from_slice(header.as_bytes());
        bytes.extend_from_slice(data);
        BASE64.encode(bytes)
    }

    fn npy_base64_i32(codes: &[i32]) -> String {
        let header = format!(
            "{{'descr': '<i4', 'fortran_order': False, 'shape': ({},), }}\n",
            codes.len()
        );
        let data = codes
            .iter()
            .flat_map(|code| code.to_le_bytes())
            .collect::<Vec<_>>();
        npy_base64_with_header(&header, &data)
    }

    #[test]
    fn prepare_neutts_reference_samples_resamples_to_encoder_rate() {
        let encoded = wav_base64(48_000, &vec![1_000_i16; 48_000]);
        let (samples, truncated) = prepare_neutts_reference_samples(&encoded).unwrap();
        assert!(!truncated);
        assert!(samples.len().abs_diff(neutts::ENCODER_SAMPLE_RATE as usize) <= 2);
    }

    #[test]
    fn prepare_neutts_reference_samples_rejects_overlong_audio() {
        let encoded = wav_base64(16_000, &vec![1_000_i16; 16_000 * 25]);
        let error = prepare_neutts_reference_samples(&encoded).unwrap_err();
        assert!(error.to_string().contains("exact transcript"));
    }

    #[test]
    fn prepare_neutts_reference_samples_rejects_invalid_input() {
        assert!(prepare_neutts_reference_samples("not base64!").is_err());
        assert!(prepare_neutts_reference_samples(&BASE64.encode(b"not a wav file")).is_err());
        let too_slow = wav_base64(1, &[0]);
        assert!(
            prepare_neutts_reference_samples(&too_slow)
                .unwrap_err()
                .to_string()
                .contains("between 8000 and 192000")
        );
        let too_fast = wav_base64(192_001, &[0]);
        assert!(prepare_neutts_reference_samples(&too_fast).is_err());
        let three_channels = wav_base64_with_channels(3, 24_000, &[0, 0, 0]);
        assert!(prepare_neutts_reference_samples(&three_channels).is_err());
        let too_short = wav_base64(16_000, &vec![0; 7_999]);
        assert!(
            prepare_neutts_reference_samples(&too_short)
                .unwrap_err()
                .to_string()
                .contains("at least half a second")
        );
    }

    #[test]
    fn decode_neutts_reference_codes_accepts_bounded_integer_codes() {
        let encoded = npy_base64_i32(&[0, 42, MAX_NEUTTS_REFERENCE_CODE_VALUE]);
        assert_eq!(
            decode_neutts_reference_codes(&encoded).unwrap(),
            vec![0, 42, MAX_NEUTTS_REFERENCE_CODE_VALUE]
        );
    }

    #[test]
    fn decode_neutts_reference_codes_rejects_shape_overflow() {
        let header = format!(
            "{{'descr': '<i4', 'fortran_order': False, 'shape': ({}, 2), }}\n",
            usize::MAX
        );
        let encoded = npy_base64_with_header(&header, &[]);
        assert!(
            decode_neutts_reference_codes(&encoded)
                .unwrap_err()
                .to_string()
                .contains("shape dimensions overflowed")
        );
    }

    #[test]
    fn decode_neutts_reference_codes_rejects_oversized_valid_array() {
        let encoded = npy_base64_i32(&vec![0; MAX_NEUTTS_REFERENCE_CODES + 1]);
        assert!(
            decode_neutts_reference_codes(&encoded)
                .unwrap_err()
                .to_string()
                .contains("between 1 and 1000 codes")
        );
    }

    #[test]
    fn decode_neutts_reference_codes_rejects_out_of_range_values() {
        let encoded = npy_base64_i32(&[-1, MAX_NEUTTS_REFERENCE_CODE_VALUE + 1]);
        assert!(
            decode_neutts_reference_codes(&encoded)
                .unwrap_err()
                .to_string()
                .contains("between 0 and 65535")
        );
    }

    #[test]
    fn probe_reports_the_locked_neutts_version() {
        assert_eq!(
            crate::locked_package_version("neutts").as_deref(),
            Some(NEUTTS_PACKAGE_VERSION)
        );
        assert_eq!(probe_result()["packageVersion"], NEUTTS_PACKAGE_VERSION);
    }
}

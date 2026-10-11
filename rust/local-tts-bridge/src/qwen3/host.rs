//! The resident Qwen3 model: one loaded checkpoint per process, plus the
//! bounded cache of voice-clone references prepared on it.

use std::collections::VecDeque;
use std::path::PathBuf;

use anyhow::{Context, Result};
use qwen3_tts_rs::audio_encoder::AudioEncoder;
use qwen3_tts_rs::inference::TTSInference;
use qwen3_tts_rs::speaker_encoder::SpeakerEncoder;
use qwen3_tts_rs::tensor::Tensor;

use super::model_files::{ExpectedModelType, validate_model_dir};
use super::reference::{DecodedReferenceWav, prepare_decoded_reference_wav};
use super::target::inference_device;

const REFERENCE_CACHE_ENTRIES: usize = 4;
pub const REFERENCE_MAX_DURATION_SECONDS: u32 = 20;
// Qwen markets 3-second cloning; shorter clips give the speaker encoder and the
// in-context prompt too little voice to go on. Generation still runs, with a
// warning, because a short clip is a quality problem rather than an invalid one.
const REFERENCE_RECOMMENDED_MIN_SECONDS: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HostKey {
    pub model_path: PathBuf,
    pub model_type: ExpectedModelType,
}

impl HostKey {
    pub fn new(model_path: impl Into<PathBuf>, model_type: ExpectedModelType) -> Self {
        Self {
            model_path: model_path.into(),
            model_type,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReferenceCacheKey {
    digest: String,
    transcript: String,
    language: String,
}

#[derive(Clone)]
pub struct ReferenceFeatures {
    pub speaker_embedding: Tensor,
    pub codes: Vec<Vec<i64>>,
}

#[derive(Clone)]
pub struct PreparedReference {
    pub features: ReferenceFeatures,
    pub reference_text: String,
    pub truncated: bool,
    pub short: bool,
}

struct ReferenceCacheEntry {
    identity: ReferenceCacheKey,
    session_key: Option<String>,
    prepared: PreparedReference,
}

pub struct NativeQwenHost {
    pub key: HostKey,
    pub inference: TTSInference,
    speaker_encoder: Option<SpeakerEncoder>,
    audio_encoder: Option<AudioEncoder>,
    reference_cache: VecDeque<ReferenceCacheEntry>,
}

impl NativeQwenHost {
    pub fn load(key: HostKey) -> Result<Self> {
        validate_model_dir(&key.model_path, key.model_type)?;
        let device = inference_device();
        let inference = TTSInference::new(&key.model_path, device).with_context(|| {
            format!(
                "Failed to load Qwen3 model from {}",
                key.model_path.display()
            )
        })?;
        let (speaker_encoder, audio_encoder) = if key.model_type == ExpectedModelType::Base {
            let speaker_encoder = SpeakerEncoder::load(
                inference.weights(),
                &inference.config().speaker_encoder_config,
                device,
            )
            .context("Failed to load Qwen3 speaker encoder.")?;
            let audio_encoder = AudioEncoder::load(
                &key.model_path.join("speech_tokenizer/model.safetensors"),
                device,
            )
            .context("Failed to load Qwen3 reference audio encoder.")?;
            (Some(speaker_encoder), Some(audio_encoder))
        } else {
            (None, None)
        };

        Ok(Self {
            key,
            inference,
            speaker_encoder,
            audio_encoder,
            reference_cache: VecDeque::new(),
        })
    }

    pub fn prepare_reference(
        &mut self,
        decoded: DecodedReferenceWav,
        transcript: &str,
        language: &str,
        session_key: Option<&str>,
        progress: &mut dyn FnMut(&str, &str) -> Result<()>,
    ) -> Result<PreparedReference> {
        let sample_rate = self.inference.config().speaker_encoder_config.sample_rate;
        let prepared =
            prepare_decoded_reference_wav(decoded, sample_rate, REFERENCE_MAX_DURATION_SECONDS)?;
        let short = is_short_reference(prepared.samples.len(), prepared.sample_rate);
        let key = ReferenceCacheKey {
            digest: prepared.digest,
            transcript: transcript.to_owned(),
            language: language.to_owned(),
        };
        if let Some(index) = self
            .reference_cache
            .iter()
            .position(|entry| entry.identity == key)
        {
            let mut entry = self
                .reference_cache
                .remove(index)
                .expect("cache index exists");
            if let Some(session_key) = session_key {
                entry.session_key = Some(session_key.to_owned());
            }
            let prepared = entry.prepared.clone();
            self.reference_cache.push_back(entry);
            return Ok(prepared);
        }

        let speaker_encoder = self
            .speaker_encoder
            .as_ref()
            .context("Qwen3 Base speaker encoder was not loaded.")?;
        let audio_encoder = self
            .audio_encoder
            .as_ref()
            .context("Qwen3 Base audio encoder was not loaded.")?;
        // Each encoder is one opaque native call, so a cancel can only be
        // observed between them; the progress callback polls for it.
        progress(
            "reference_encoding",
            "Extracting the Qwen3 voice reference speaker embedding.",
        )?;
        let speaker_embedding = speaker_encoder
            .extract_embedding(&prepared.samples)
            .context("Failed to extract Qwen3 reference speaker embedding.")?;
        progress(
            "reference_encoding",
            "Encoding the Qwen3 voice reference audio codes.",
        )?;
        let codes = audio_encoder
            .encode(&prepared.samples)
            .context("Failed to encode Qwen3 reference audio.")?;
        let prepared_reference = PreparedReference {
            features: ReferenceFeatures {
                speaker_embedding,
                codes,
            },
            reference_text: transcript.to_owned(),
            truncated: prepared.truncated,
            short,
        };
        self.reference_cache.push_back(ReferenceCacheEntry {
            identity: key,
            session_key: session_key.map(str::to_owned),
            prepared: prepared_reference.clone(),
        });
        while self.reference_cache.len() > REFERENCE_CACHE_ENTRIES {
            self.reference_cache.pop_front();
        }
        Ok(prepared_reference)
    }

    pub fn cached_reference(&mut self, session_key: &str) -> Result<PreparedReference> {
        let index = self
            .reference_cache
            .iter()
            .position(|entry| entry.session_key.as_deref() == Some(session_key))
            .context("Qwen3 reference cache entry was not found; resend the reference WAV.")?;
        let entry = self
            .reference_cache
            .remove(index)
            .expect("cache index exists");
        let prepared = entry.prepared.clone();
        self.reference_cache.push_back(entry);
        Ok(prepared)
    }
}

fn is_short_reference(sample_count: usize, sample_rate: u32) -> bool {
    let recommended = u64::from(sample_rate) * u64::from(REFERENCE_RECOMMENDED_MIN_SECONDS);
    u64::try_from(sample_count).unwrap_or(u64::MAX) < recommended
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_under_three_seconds_are_flagged_short() {
        assert!(is_short_reference(0, 24_000));
        assert!(is_short_reference(71_999, 24_000));
        assert!(!is_short_reference(72_000, 24_000));
        assert!(!is_short_reference(480_000, 24_000));
    }

    #[test]
    fn resident_host_key_includes_canonical_path_and_model_type() {
        let custom = HostKey::new("/models/qwen", ExpectedModelType::CustomVoice);
        let same = HostKey::new("/models/qwen", ExpectedModelType::CustomVoice);
        let base = HostKey::new("/models/qwen", ExpectedModelType::Base);
        let other = HostKey::new("/models/qwen-large", ExpectedModelType::CustomVoice);
        assert_eq!(custom, same);
        assert_ne!(custom, base);
        assert_ne!(custom, other);
    }
}

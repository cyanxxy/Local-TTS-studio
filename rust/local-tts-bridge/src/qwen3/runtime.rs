use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result, ensure};
use qwen3_tts_rs::audio_encoder::AudioEncoder;
use qwen3_tts_rs::inference::TTSInference;
use qwen3_tts_rs::speaker_encoder::SpeakerEncoder;
use qwen3_tts_rs::tensor::{Device, Tensor};

use super::config::{GenerationControls, normalize_language, normalize_speaker};
use super::model_files::{ExpectedModelType, validate_model_dir};
use super::reference::{DecodedReferenceWav, decode_reference_wav, prepare_decoded_reference_wav};
use super::text::split_text_units;

const CUSTOM_VOICE_UNIT_CHARS: usize = 400;
const REFERENCE_CACHE_ENTRIES: usize = 4;
const REFERENCE_MAX_DURATION_SECONDS: u32 = 20;
const VOICE_CLONE_STREAMING_CHUNK_SIZE: usize = 4;

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
struct ReferenceFeatures {
    speaker_embedding: Tensor,
    codes: Vec<Vec<i64>>,
}

#[derive(Clone)]
struct PreparedReference {
    features: ReferenceFeatures,
    reference_text: String,
    truncated: bool,
}

struct ReferenceCacheEntry {
    identity: ReferenceCacheKey,
    session_key: Option<String>,
    prepared: PreparedReference,
}

struct NativeQwenHost {
    key: HostKey,
    inference: TTSInference,
    speaker_encoder: Option<SpeakerEncoder>,
    audio_encoder: Option<AudioEncoder>,
    reference_cache: VecDeque<ReferenceCacheEntry>,
}

impl NativeQwenHost {
    fn load(key: HostKey) -> Result<Self> {
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

    fn prepare_reference(
        &mut self,
        decoded: DecodedReferenceWav,
        transcript: &str,
        language: &str,
        session_key: Option<&str>,
    ) -> Result<PreparedReference> {
        let sample_rate = self.inference.config().speaker_encoder_config.sample_rate;
        let prepared =
            prepare_decoded_reference_wav(decoded, sample_rate, REFERENCE_MAX_DURATION_SECONDS)?;
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
        let prepared_reference = PreparedReference {
            features: ReferenceFeatures {
                speaker_embedding: speaker_encoder
                    .extract_embedding(&prepared.samples)
                    .context("Failed to extract Qwen3 reference speaker embedding.")?,
                codes: audio_encoder
                    .encode(&prepared.samples)
                    .context("Failed to encode Qwen3 reference audio.")?,
            },
            reference_text: transcript.to_owned(),
            truncated: prepared.truncated,
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

    fn cached_reference(&mut self, session_key: &str) -> Result<PreparedReference> {
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

impl CustomVoiceEngine for TTSInference {
    fn generate_custom_voice(
        &mut self,
        text: &str,
        speaker: &str,
        language: &str,
        instruct: &str,
        controls: GenerationControls,
    ) -> Result<GeneratedAudio> {
        let (samples, sample_rate) = self
            .generate_with_instruct(
                text,
                speaker,
                language,
                instruct,
                controls.temperature,
                controls.top_k,
                controls.max_new_tokens,
            )
            .context("Qwen3 CustomVoice inference failed.")?;
        Ok(GeneratedAudio {
            samples,
            sample_rate,
        })
    }
}

impl VoiceDesignEngine for TTSInference {
    fn generate_voice_design(
        &mut self,
        text: &str,
        language: &str,
        instruct: &str,
        controls: GenerationControls,
    ) -> Result<GeneratedAudio> {
        let (samples, sample_rate) = self
            .generate_with_instruct(
                text,
                "",
                language,
                instruct,
                controls.temperature,
                controls.top_k,
                controls.max_new_tokens,
            )
            .context("Qwen3 VoiceDesign inference failed.")?;
        Ok(GeneratedAudio {
            samples,
            sample_rate,
        })
    }
}

pub struct Qwen3Runtime {
    host: Option<NativeQwenHost>,
}

impl Qwen3Runtime {
    pub fn new() -> Self {
        Self { host: None }
    }

    fn ensure_host(
        &mut self,
        model_path: &Path,
        model_type: ExpectedModelType,
    ) -> Result<&mut NativeQwenHost> {
        let canonical_path = fs::canonicalize(model_path).with_context(|| {
            format!(
                "Failed to resolve Qwen3 model directory {}",
                model_path.display()
            )
        })?;
        let key = HostKey::new(canonical_path, model_type);
        if self.host.as_ref().is_none_or(|host| host.key != key) {
            self.host = Some(NativeQwenHost::load(key)?);
        }
        self.host.as_mut().context("Qwen3 host was not loaded.")
    }

    pub fn warm(&mut self, model_path: &Path, model_type: ExpectedModelType) -> Result<()> {
        self.ensure_host(model_path, model_type).map(|_| ())
    }

    pub fn generate_custom_voice(
        &mut self,
        model_path: &Path,
        request: &CustomVoiceRequest<'_>,
        sink: &mut dyn AudioSink,
    ) -> Result<GenerationSummary> {
        let host = self.ensure_host(model_path, ExpectedModelType::CustomVoice)?;
        generate_custom_voice_units(&mut host.inference, request, sink)
    }

    pub fn generate_voice_design(
        &mut self,
        model_path: &Path,
        request: &VoiceDesignRequest<'_>,
        sink: &mut dyn AudioSink,
    ) -> Result<GenerationSummary> {
        let host = self.ensure_host(model_path, ExpectedModelType::VoiceDesign)?;
        generate_voice_design_units(&mut host.inference, request, sink)
    }

    pub fn generate_voice_clone(
        &mut self,
        model_path: &Path,
        request: VoiceCloneRequest<'_>,
        sink: &mut dyn AudioSink,
    ) -> Result<GenerationSummary> {
        let VoiceCloneRequest {
            text,
            language,
            reference,
            controls,
        } = request;
        let language = normalize_language(language)?;
        ensure!(!text.trim().is_empty(), "Qwen3 voice-clone text is empty.");
        let host = self.ensure_host(model_path, ExpectedModelType::Base)?;
        let prepared = match reference {
            VoiceCloneReference::Audio {
                reference_wav,
                reference_text,
                session_key,
            } => {
                ensure!(
                    !reference_text.trim().is_empty(),
                    "Qwen3 reference transcript is empty."
                );
                sink.progress("reference_validation", "Validating Qwen3 voice reference.")?;
                let decoded_reference =
                    decode_reference_wav(&reference_wav, REFERENCE_MAX_DURATION_SECONDS)?;
                drop(reference_wav);
                sink.progress("reference_encoding", "Encoding Qwen3 voice reference.")?;
                host.prepare_reference(decoded_reference, reference_text, &language, session_key)?
            }
            VoiceCloneReference::Cached { session_key } => {
                sink.progress(
                    "reference_cache",
                    "Reusing the prepared Qwen3 voice reference.",
                )?;
                host.cached_reference(session_key)?
            }
        };
        sink.progress("inference", "Running Qwen3 voice-clone inference.")?;

        let mut sample_rate = None;
        let mut sample_count = 0usize;
        let mut audio_chunk_count = 0usize;
        let mut sink_error = None;
        host.inference
            .generate_with_icl_streaming(
                text,
                &prepared.reference_text,
                &prepared.features.codes,
                &prepared.features.speaker_embedding,
                &language,
                controls.temperature,
                controls.top_k,
                controls.max_new_tokens,
                VOICE_CLONE_STREAMING_CHUNK_SIZE,
                |samples, current_sample_rate| {
                    let cleaned = match clean_audio(samples.to_vec()) {
                        Ok(cleaned) => cleaned,
                        Err(error) => {
                            sink_error = Some(error);
                            return false;
                        }
                    };
                    if current_sample_rate == 0
                        || sample_rate.is_some_and(|expected| expected != current_sample_rate)
                    {
                        sink_error = Some(anyhow::anyhow!(
                            "Qwen3 voice clone returned an invalid or inconsistent sample rate."
                        ));
                        return false;
                    }
                    sample_rate = Some(current_sample_rate);
                    if let Err(error) =
                        sink.audio_chunk(&cleaned, current_sample_rate, audio_chunk_count, 0, 0)
                    {
                        sink_error = Some(error);
                        return false;
                    }
                    sample_count = sample_count.saturating_add(cleaned.len());
                    audio_chunk_count += 1;
                    true
                },
            )
            .context("Qwen3 voice-clone inference failed.")?;
        if let Some(error) = sink_error {
            return Err(error);
        }
        ensure!(
            audio_chunk_count > 0,
            "Qwen3 voice clone returned no audio."
        );
        Ok(GenerationSummary {
            sample_rate: sample_rate.unwrap_or_default(),
            sample_count,
            audio_chunk_count,
            reference_truncated: prepared.truncated,
        })
    }
}

impl Default for Qwen3Runtime {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
pub struct VoiceCloneRequest<'a> {
    pub text: &'a str,
    pub language: &'a str,
    pub reference: VoiceCloneReference<'a>,
    pub controls: GenerationControls,
}

#[derive(Debug)]
pub enum VoiceCloneReference<'a> {
    Audio {
        reference_wav: Vec<u8>,
        reference_text: &'a str,
        session_key: Option<&'a str>,
    },
    Cached {
        session_key: &'a str,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompiledProvider {
    #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
    Mlx,
    #[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
    LibTorch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeTarget {
    pub provider: &'static str,
    pub device: &'static str,
    pub accelerated: bool,
    tensor_device: Device,
}

fn select_runtime_target(provider: CompiledProvider, accelerator_available: bool) -> RuntimeTarget {
    match (provider, accelerator_available) {
        #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
        (CompiledProvider::Mlx, true) => RuntimeTarget {
            provider: "mlx",
            device: "metal",
            accelerated: true,
            tensor_device: Device::Gpu(0),
        },
        #[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
        (CompiledProvider::LibTorch, true) => RuntimeTarget {
            provider: "libtorch",
            device: "cuda",
            accelerated: true,
            tensor_device: Device::Gpu(0),
        },
        #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), test))]
        (CompiledProvider::Mlx, false) => RuntimeTarget {
            provider: "mlx",
            device: "cpu",
            accelerated: false,
            tensor_device: Device::Cpu,
        },
        #[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
        (CompiledProvider::LibTorch, false) => RuntimeTarget {
            provider: "libtorch",
            device: "cpu",
            accelerated: false,
            tensor_device: Device::Cpu,
        },
    }
}

fn detect_runtime_target() -> RuntimeTarget {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let mut metal_available = false;
        unsafe {
            qwen3_tts_rs::backend::mlx::ffi::mlx_metal_is_available(&mut metal_available);
        }
        select_runtime_target(CompiledProvider::Mlx, metal_available)
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        select_runtime_target(CompiledProvider::LibTorch, tch::Cuda::is_available())
    }
}

pub fn resolved_runtime_target() -> RuntimeTarget {
    static TARGET: OnceLock<RuntimeTarget> = OnceLock::new();
    *TARGET.get_or_init(detect_runtime_target)
}

fn inference_device() -> Device {
    let target = resolved_runtime_target();
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        qwen3_tts_rs::backend::mlx::stream::init_mlx(target.accelerated);
    }
    target.tensor_device
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct CustomVoiceRequest<'a> {
    pub text: &'a str,
    pub speaker: &'a str,
    pub language: &'a str,
    pub instruct: &'a str,
    pub controls: GenerationControls,
}

#[derive(Debug, Clone, Copy)]
pub struct VoiceDesignRequest<'a> {
    pub text: &'a str,
    pub language: &'a str,
    pub instruct: &'a str,
    pub controls: GenerationControls,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenerationSummary {
    pub sample_rate: u32,
    pub sample_count: usize,
    pub audio_chunk_count: usize,
    pub reference_truncated: bool,
}

pub trait CustomVoiceEngine {
    fn generate_custom_voice(
        &mut self,
        text: &str,
        speaker: &str,
        language: &str,
        instruct: &str,
        controls: GenerationControls,
    ) -> Result<GeneratedAudio>;
}

pub trait VoiceDesignEngine {
    fn generate_voice_design(
        &mut self,
        text: &str,
        language: &str,
        instruct: &str,
        controls: GenerationControls,
    ) -> Result<GeneratedAudio>;
}

pub trait AudioSink {
    fn progress(&mut self, phase: &str, message: &str) -> Result<()>;

    fn audio_chunk(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        index: usize,
        total: usize,
        silence_after_samples: usize,
    ) -> Result<()>;
}

pub fn generate_custom_voice_units(
    engine: &mut impl CustomVoiceEngine,
    request: &CustomVoiceRequest<'_>,
    sink: &mut dyn AudioSink,
) -> Result<GenerationSummary> {
    let units = split_text_units(request.text, CUSTOM_VOICE_UNIT_CHARS)?;
    let speaker = normalize_speaker(request.speaker)?;
    let language = normalize_language(request.language)?;
    let total = units.len();
    let mut sample_rate = None;
    let mut sample_count = 0usize;

    for (index, unit) in units.iter().enumerate() {
        sink.progress(
            "inference",
            &format!("Generating Qwen3 section {} of {total}.", index + 1),
        )?;
        let generated = engine.generate_custom_voice(
            unit,
            &speaker,
            &language,
            request.instruct,
            request.controls,
        )?;
        ensure!(
            generated.sample_rate > 0,
            "Qwen3 returned an invalid sample rate."
        );
        if let Some(expected) = sample_rate {
            ensure!(
                generated.sample_rate == expected,
                "Qwen3 returned inconsistent sample rates."
            );
        } else {
            sample_rate = Some(generated.sample_rate);
        }
        let samples = clean_audio(generated.samples)?;
        let silence_after_samples = if index + 1 == total {
            0
        } else {
            usize::try_from(generated.sample_rate / 5).unwrap_or_default()
        };
        sample_count = sample_count
            .saturating_add(samples.len())
            .saturating_add(silence_after_samples);
        sink.audio_chunk(
            &samples,
            generated.sample_rate,
            index,
            total,
            silence_after_samples,
        )?;
    }

    Ok(GenerationSummary {
        sample_rate: sample_rate.unwrap_or_default(),
        sample_count,
        audio_chunk_count: total,
        reference_truncated: false,
    })
}

pub fn generate_voice_design_units(
    engine: &mut impl VoiceDesignEngine,
    request: &VoiceDesignRequest<'_>,
    sink: &mut dyn AudioSink,
) -> Result<GenerationSummary> {
    let units = split_text_units(request.text, CUSTOM_VOICE_UNIT_CHARS)?;
    let language = normalize_language(request.language)?;
    let total = units.len();
    let mut sample_rate = None;
    let mut sample_count = 0usize;

    for (index, unit) in units.iter().enumerate() {
        sink.progress(
            "inference",
            &format!(
                "Generating Qwen3 VoiceDesign section {} of {total}.",
                index + 1
            ),
        )?;
        let generated =
            engine.generate_voice_design(unit, &language, request.instruct, request.controls)?;
        ensure!(
            generated.sample_rate > 0,
            "Qwen3 returned an invalid sample rate."
        );
        if let Some(expected) = sample_rate {
            ensure!(
                generated.sample_rate == expected,
                "Qwen3 returned inconsistent sample rates."
            );
        } else {
            sample_rate = Some(generated.sample_rate);
        }
        let samples = clean_audio(generated.samples)?;
        let silence_after_samples = if index + 1 == total {
            0
        } else {
            usize::try_from(generated.sample_rate / 5).unwrap_or_default()
        };
        sample_count = sample_count
            .saturating_add(samples.len())
            .saturating_add(silence_after_samples);
        sink.audio_chunk(
            &samples,
            generated.sample_rate,
            index,
            total,
            silence_after_samples,
        )?;
    }

    Ok(GenerationSummary {
        sample_rate: sample_rate.unwrap_or_default(),
        sample_count,
        audio_chunk_count: total,
        reference_truncated: false,
    })
}

pub fn clean_audio(mut samples: Vec<f32>) -> Result<Vec<f32>> {
    ensure!(!samples.is_empty(), "Qwen3 generated empty audio.");
    for sample in &mut samples {
        if !sample.is_finite() {
            *sample = 0.0;
        }
    }
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq)]
    struct Call {
        text: String,
        speaker: String,
        language: String,
        instruct: String,
        controls: GenerationControls,
    }

    #[derive(Default)]
    struct RecordingEngine {
        calls: Vec<Call>,
    }

    impl VoiceDesignEngine for RecordingEngine {
        fn generate_voice_design(
            &mut self,
            text: &str,
            language: &str,
            instruct: &str,
            controls: GenerationControls,
        ) -> Result<GeneratedAudio> {
            self.calls.push(Call {
                text: text.to_owned(),
                speaker: String::new(),
                language: language.to_owned(),
                instruct: instruct.to_owned(),
                controls,
            });
            Ok(GeneratedAudio {
                samples: vec![0.25],
                sample_rate: 24_000,
            })
        }
    }

    impl CustomVoiceEngine for RecordingEngine {
        fn generate_custom_voice(
            &mut self,
            text: &str,
            speaker: &str,
            language: &str,
            instruct: &str,
            controls: GenerationControls,
        ) -> Result<GeneratedAudio> {
            self.calls.push(Call {
                text: text.to_owned(),
                speaker: speaker.to_owned(),
                language: language.to_owned(),
                instruct: instruct.to_owned(),
                controls,
            });
            Ok(GeneratedAudio {
                samples: vec![f32::NAN, 0.5],
                sample_rate: 24_000,
            })
        }
    }

    #[derive(Debug, Default)]
    struct RecordingSink {
        chunks: Vec<(Vec<f32>, u32, usize, usize, usize)>,
    }

    impl AudioSink for RecordingSink {
        fn progress(&mut self, _phase: &str, _message: &str) -> Result<()> {
            Ok(())
        }

        fn audio_chunk(
            &mut self,
            samples: &[f32],
            sample_rate: u32,
            index: usize,
            total: usize,
            silence_after_samples: usize,
        ) -> Result<()> {
            self.chunks.push((
                samples.to_vec(),
                sample_rate,
                index,
                total,
                silence_after_samples,
            ));
            Ok(())
        }
    }

    #[test]
    fn cleans_non_finite_audio_without_peak_normalizing() {
        let cleaned = clean_audio(vec![f32::NAN, f32::INFINITY, -2.0, 0.5]).unwrap();
        assert_eq!(cleaned, vec![0.0, 0.0, -2.0, 0.5]);
        assert!(clean_audio(Vec::new()).is_err());
    }

    #[test]
    fn propagates_controls_and_emits_clean_unicode_safe_units() {
        let text = format!("First sentence. {}", "你".repeat(450));
        let controls = GenerationControls::new(0.7, 27, 777);
        let mut engine = RecordingEngine::default();
        let mut sink = RecordingSink::default();

        let summary = generate_custom_voice_units(
            &mut engine,
            &CustomVoiceRequest {
                text: &text,
                speaker: "Uncle_Fu",
                language: "Italian",
                instruct: "Speak warmly",
                controls,
            },
            &mut sink,
        )
        .unwrap();

        assert!(engine.calls.len() >= 3);
        assert_eq!(
            engine
                .calls
                .iter()
                .map(|call| call.text.as_str())
                .collect::<String>(),
            text
        );
        assert!(engine.calls.iter().all(|call| call.speaker == "uncle_fu"));
        assert!(engine.calls.iter().all(|call| call.language == "italian"));
        assert!(
            engine
                .calls
                .iter()
                .all(|call| call.instruct == "Speak warmly")
        );
        assert!(engine.calls.iter().all(|call| call.controls == controls));
        assert_eq!(summary.audio_chunk_count, engine.calls.len());
        assert_eq!(summary.sample_rate, 24_000);
        assert_eq!(sink.chunks.len(), engine.calls.len());
        assert!(sink.chunks.iter().all(|chunk| chunk.0 == [0.0, 0.5]));
        assert!(
            sink.chunks
                .iter()
                .all(|chunk| chunk.3 == engine.calls.len())
        );
        assert_eq!(sink.chunks.last().unwrap().4, 0);
        assert!(
            sink.chunks[..sink.chunks.len() - 1]
                .iter()
                .all(|chunk| chunk.4 == 4_800)
        );
    }

    #[test]
    fn voice_design_uses_instruction_without_a_speaker() {
        let mut engine = RecordingEngine::default();
        let mut sink = RecordingSink::default();
        let controls = GenerationControls::new(0.8, 40, 512);
        let summary = generate_voice_design_units(
            &mut engine,
            &VoiceDesignRequest {
                text: "A short designed voice sample.",
                language: "English",
                instruct: "A warm, low, reassuring narrator",
                controls,
            },
            &mut sink,
        )
        .unwrap();

        assert_eq!(summary.audio_chunk_count, 1);
        assert_eq!(engine.calls[0].speaker, "");
        assert_eq!(engine.calls[0].language, "english");
        assert_eq!(engine.calls[0].instruct, "A warm, low, reassuring narrator");
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

    #[test]
    fn runtime_target_selection_tracks_backend_and_accelerator_availability() {
        let mlx_gpu = select_runtime_target(CompiledProvider::Mlx, true);
        assert_eq!(mlx_gpu.provider, "mlx");
        assert_eq!(mlx_gpu.device, "metal");
        assert!(mlx_gpu.accelerated);
        assert_eq!(mlx_gpu.tensor_device, Device::Gpu(0));

        let mlx_cpu = select_runtime_target(CompiledProvider::Mlx, false);
        assert_eq!(mlx_cpu.provider, "mlx");
        assert_eq!(mlx_cpu.device, "cpu");
        assert!(!mlx_cpu.accelerated);
        assert_eq!(mlx_cpu.tensor_device, Device::Cpu);

        let libtorch_gpu = select_runtime_target(CompiledProvider::LibTorch, true);
        assert_eq!(libtorch_gpu.provider, "libtorch");
        assert_eq!(libtorch_gpu.device, "cuda");
        assert!(libtorch_gpu.accelerated);
        assert_eq!(libtorch_gpu.tensor_device, Device::Gpu(0));

        let libtorch_cpu = select_runtime_target(CompiledProvider::LibTorch, false);
        assert_eq!(libtorch_cpu.provider, "libtorch");
        assert_eq!(libtorch_cpu.device, "cpu");
        assert!(!libtorch_cpu.accelerated);
        assert_eq!(libtorch_cpu.tensor_device, Device::Cpu);
    }
}

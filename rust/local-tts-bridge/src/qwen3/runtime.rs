use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result, bail, ensure};
use qwen3_tts_rs::audio_encoder::AudioEncoder;
use qwen3_tts_rs::inference::TTSInference;
use qwen3_tts_rs::speaker_encoder::SpeakerEncoder;
use qwen3_tts_rs::tensor::{Device, Tensor};

use super::config::{
    GenerationControls, MAX_TEXT_UNIT_GENERATION_TOKENS, normalize_language, normalize_speaker,
};
use super::model_files::{ExpectedModelType, validate_model_dir};
use super::reference::{DecodedReferenceWav, decode_reference_wav, prepare_decoded_reference_wav};
use super::text::split_text_units;

// Smaller inference units bound each request's live MLX KV-cache/Metal working
// set. A 400-character unit can peak above 20 GB on the 0.6B model even when
// the allocator cache is cleared afterward.
const CUSTOM_VOICE_UNIT_CHARS: usize = 200;
const REFERENCE_CACHE_ENTRIES: usize = 4;
const REFERENCE_MAX_DURATION_SECONDS: u32 = 20;
const VOICE_CLONE_STREAMING_CHUNK_SIZE: usize = 4;
// CustomVoice and VoiceDesign stream on the same cadence as voice cloning, so
// first audio arrives after a few code frames rather than after the whole text
// unit has been generated.
const TEXT_UNIT_STREAMING_CHUNK_SIZE: usize = 4;

struct InferenceCacheCleanupGuard<'a> {
    cleanup: &'a mut dyn FnMut(),
}

impl Drop for InferenceCacheCleanupGuard<'_> {
    fn drop(&mut self) {
        (self.cleanup)();
    }
}

fn run_with_inference_cache_cleanup<T>(
    cleanup: &mut dyn FnMut(),
    operation: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let _cleanup_guard = InferenceCacheCleanupGuard { cleanup };
    operation()
}

fn clear_inference_cache() {
    #[cfg(all(target_os = "macos", target_arch = "aarch64", not(test)))]
    unsafe {
        // MLX keeps released Metal buffers in a process-wide allocator cache.
        // Clearing that cache only releases unused scratch storage; tensors
        // holding the resident model and cached reference features remain live.
        qwen3_tts_rs::backend::mlx::ffi::mlx_clear_cache();
    }
}

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
    fn generate_custom_voice_streaming(
        &mut self,
        text: &str,
        speaker: &str,
        language: &str,
        instruct: &str,
        controls: GenerationControls,
        on_audio: StreamedAudio<'_>,
    ) -> Result<()> {
        self.generate_with_instruct_streaming(
            text,
            speaker,
            language,
            instruct,
            controls.temperature,
            controls.top_k,
            controls.max_new_tokens,
            TEXT_UNIT_STREAMING_CHUNK_SIZE,
            on_audio,
        )
        .context("Qwen3 CustomVoice inference failed.")
    }
}

impl VoiceDesignEngine for TTSInference {
    fn generate_voice_design_streaming(
        &mut self,
        text: &str,
        language: &str,
        instruct: &str,
        controls: GenerationControls,
        on_audio: StreamedAudio<'_>,
    ) -> Result<()> {
        self.generate_with_instruct_streaming(
            text,
            "",
            language,
            instruct,
            controls.temperature,
            controls.top_k,
            controls.max_new_tokens,
            TEXT_UNIT_STREAMING_CHUNK_SIZE,
            on_audio,
        )
        .context("Qwen3 VoiceDesign inference failed.")
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
            if self.host.take().is_some() {
                clear_inference_cache();
            }
            let mut cleanup = clear_inference_cache;
            self.host = Some(run_with_inference_cache_cleanup(&mut cleanup, || {
                NativeQwenHost::load(key)
            })?);
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
        let mut cleanup = clear_inference_cache;
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
                run_with_inference_cache_cleanup(&mut cleanup, || {
                    host.prepare_reference(
                        decoded_reference,
                        reference_text,
                        &language,
                        session_key,
                    )
                })?
            }
            VoiceCloneReference::Cached { session_key } => {
                sink.progress(
                    "reference_cache",
                    "Reusing the prepared Qwen3 voice reference.",
                )?;
                host.cached_reference(session_key)?
            }
        };
        let mut sample_rate = None;
        let mut sample_count = 0usize;
        let mut audio_chunk_count = 0usize;
        let units = split_text_units(text, CUSTOM_VOICE_UNIT_CHARS)?;
        let unit_total = units.len();
        for (unit_index, unit) in units.iter().enumerate() {
            sink.progress(
                "inference",
                &format!(
                    "Running Qwen3 voice-clone section {} of {unit_total}.",
                    unit_index + 1
                ),
            )?;
            let mut sink_error = None;
            let unit_controls =
                controls.effective_for_text(unit, &language, MAX_TEXT_UNIT_GENERATION_TOKENS);
            run_with_inference_cache_cleanup(&mut cleanup, || {
                host.inference
                    .generate_with_icl_streaming(
                        unit,
                        &prepared.reference_text,
                        &prepared.features.codes,
                        &prepared.features.speaker_embedding,
                        &language,
                        unit_controls.temperature,
                        unit_controls.top_k,
                        unit_controls.max_new_tokens,
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
                                || sample_rate
                                    .is_some_and(|expected| expected != current_sample_rate)
                            {
                                sink_error = Some(anyhow::anyhow!(
                                    "Qwen3 voice clone returned an invalid or inconsistent sample rate."
                                ));
                                return false;
                            }
                            sample_rate = Some(current_sample_rate);
                            if let Err(error) = sink.audio_chunk(
                                &cleaned,
                                current_sample_rate,
                                audio_chunk_count,
                                0,
                                0,
                            ) {
                                sink_error = Some(error);
                                return false;
                            }
                            sample_count = sample_count.saturating_add(cleaned.len());
                            audio_chunk_count += 1;
                            true
                        },
                    )
                    .map_err(anyhow::Error::from)
            })
            .with_context(|| {
                format!(
                    "Qwen3 voice-clone inference failed in section {} of {unit_total}.",
                    unit_index + 1
                )
            })?;
            if let Some(error) = sink_error {
                return Err(error);
            }
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

/// Receives decoded audio as it is generated. Returning `false` stops
/// generation for the current text unit.
pub type StreamedAudio<'a> = &'a mut dyn FnMut(&[f32], u32) -> bool;

pub trait CustomVoiceEngine {
    /// Streams one text unit. Audio arrives in decode-order batches rather than
    /// as one buffer per unit, so playback can start mid-sentence.
    fn generate_custom_voice_streaming(
        &mut self,
        text: &str,
        speaker: &str,
        language: &str,
        instruct: &str,
        controls: GenerationControls,
        on_audio: StreamedAudio<'_>,
    ) -> Result<()>;
}

pub trait VoiceDesignEngine {
    fn generate_voice_design_streaming(
        &mut self,
        text: &str,
        language: &str,
        instruct: &str,
        controls: GenerationControls,
        on_audio: StreamedAudio<'_>,
    ) -> Result<()>;
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

/// Forwards streamed chunks to the sink, one text unit at a time.
///
/// Each chunk is held back until the next one arrives. The client applies a
/// chunk's `silence_after_samples` *after* that chunk, so the unit's trailing
/// gap has to ride on its final chunk — which is only identifiable once the
/// unit ends. Deferring by one is what lets a streamed unit keep the same
/// inter-unit spacing the one-chunk-per-unit path produced.
struct StreamingUnitSink<'a> {
    sink: &'a mut dyn AudioSink,
    unit_index: usize,
    unit_total: usize,
    pending: Option<Vec<f32>>,
    sample_rate: Option<u32>,
    sample_count: usize,
    chunk_count: usize,
    error: Option<anyhow::Error>,
}

impl<'a> StreamingUnitSink<'a> {
    fn new(sink: &'a mut dyn AudioSink, unit_total: usize) -> Self {
        Self {
            sink,
            unit_index: 0,
            unit_total,
            pending: None,
            sample_rate: None,
            sample_count: 0,
            chunk_count: 0,
            error: None,
        }
    }

    fn begin_unit(&mut self, unit_index: usize) {
        self.unit_index = unit_index;
    }

    /// Callback for the engine. `false` stops generation for this unit.
    fn push(&mut self, samples: &[f32], sample_rate: u32) -> bool {
        match self.try_push(samples, sample_rate) {
            Ok(()) => true,
            Err(error) => {
                self.error = Some(error);
                false
            }
        }
    }

    fn try_push(&mut self, samples: &[f32], sample_rate: u32) -> Result<()> {
        // A chunk shorter than the vocoder's lookahead decodes to no samples;
        // that is buffered state, not an empty generation.
        if samples.is_empty() {
            return Ok(());
        }
        ensure!(sample_rate > 0, "Qwen3 returned an invalid sample rate.");
        match self.sample_rate {
            Some(expected) => ensure!(
                expected == sample_rate,
                "Qwen3 returned inconsistent sample rates."
            ),
            None => self.sample_rate = Some(sample_rate),
        }
        let cleaned = clean_audio(samples.to_vec())?;
        if let Some(previous) = self.pending.replace(cleaned) {
            // Not the last chunk of this unit after all, so no trailing gap.
            self.emit(previous, 0)?;
        }
        Ok(())
    }

    /// Take any error the sink raised while streaming. The engine reports a
    /// sink refusal as a clean stop, so this is the only place the real cause
    /// survives — callers must consult it before trusting the engine's result.
    fn take_error(&mut self) -> Option<anyhow::Error> {
        self.error.take()
    }

    /// Flush the unit's final chunk, carrying the inter-unit gap.
    ///
    /// Callers must only reach this once the unit generated successfully; a
    /// pending chunk left over from a failed unit must never be emitted.
    fn end_unit(&mut self, silence_after_samples: usize) -> Result<()> {
        let Some(last) = self.pending.take() else {
            // Silently skipping would drop a sentence from the output with no
            // signal. The buffered path failed here too (`clean_audio` rejects
            // an empty buffer), so this keeps that contract.
            bail!(
                "Qwen3 produced no audio for section {} of {}.",
                self.unit_index + 1,
                self.unit_total
            );
        };
        self.emit(last, silence_after_samples)
    }

    fn emit(&mut self, samples: Vec<f32>, silence_after_samples: usize) -> Result<()> {
        let sample_rate = self.sample_rate.unwrap_or_default();
        self.sample_count = self
            .sample_count
            .saturating_add(samples.len())
            .saturating_add(silence_after_samples);
        self.chunk_count = self.chunk_count.saturating_add(1);
        // Keep passing the text-unit index/count: the client turns these into
        // textUnitIndex/textUnitTotal and maps chunks back to sentences with
        // them. Passing 0 here would collapse that mapping.
        self.sink.audio_chunk(
            &samples,
            sample_rate,
            self.unit_index,
            self.unit_total,
            silence_after_samples,
        )
    }
}

/// The 0.2 s gap inserted between text units, but never after the last one.
fn inter_unit_silence(unit_index: usize, unit_total: usize, sample_rate: u32) -> usize {
    if unit_index + 1 == unit_total {
        return 0;
    }
    usize::try_from(sample_rate / 5).unwrap_or_default()
}

pub fn generate_custom_voice_units(
    engine: &mut impl CustomVoiceEngine,
    request: &CustomVoiceRequest<'_>,
    sink: &mut dyn AudioSink,
) -> Result<GenerationSummary> {
    let mut cleanup = clear_inference_cache;
    generate_custom_voice_units_with_cleanup(engine, request, sink, &mut cleanup)
}

fn generate_custom_voice_units_with_cleanup(
    engine: &mut impl CustomVoiceEngine,
    request: &CustomVoiceRequest<'_>,
    sink: &mut dyn AudioSink,
    cleanup: &mut dyn FnMut(),
) -> Result<GenerationSummary> {
    let units = split_text_units(request.text, CUSTOM_VOICE_UNIT_CHARS)?;
    let speaker = normalize_speaker(request.speaker)?;
    let language = normalize_language(request.language)?;
    let total = units.len();
    let mut streaming = StreamingUnitSink::new(sink, total);

    for (index, unit) in units.iter().enumerate() {
        streaming.sink.progress(
            "inference",
            &format!("Generating Qwen3 section {} of {total}.", index + 1),
        )?;
        streaming.begin_unit(index);
        let controls =
            request
                .controls
                .effective_for_text(unit, &language, MAX_TEXT_UNIT_GENERATION_TOKENS);
        let streamed = run_with_inference_cache_cleanup(cleanup, || {
            engine.generate_custom_voice_streaming(
                unit,
                &speaker,
                &language,
                request.instruct,
                controls,
                &mut |samples, rate| streaming.push(samples, rate),
            )
        });
        // A sink failure stops the engine by returning false, which the engine
        // reports as a clean Ok — so check the stored cause first. Then let the
        // engine's own error through before flushing, so a failed unit never
        // emits a trailing chunk and gap on its way out.
        if let Some(error) = streaming.take_error() {
            return Err(error);
        }
        streamed.with_context(|| {
            format!(
                "Qwen3 CustomVoice inference failed in section {} of {total}.",
                index + 1
            )
        })?;
        streaming.end_unit(inter_unit_silence(
            index,
            total,
            streaming.sample_rate.unwrap_or_default(),
        ))?;
    }

    let sample_rate = streaming.sample_rate;
    let sample_count = streaming.sample_count;
    let audio_chunk_count = streaming.chunk_count;
    ensure!(audio_chunk_count > 0, "Qwen3 returned no audio.");

    Ok(GenerationSummary {
        sample_rate: sample_rate.unwrap_or_default(),
        sample_count,
        audio_chunk_count,
        reference_truncated: false,
    })
}

pub fn generate_voice_design_units(
    engine: &mut impl VoiceDesignEngine,
    request: &VoiceDesignRequest<'_>,
    sink: &mut dyn AudioSink,
) -> Result<GenerationSummary> {
    let mut cleanup = clear_inference_cache;
    generate_voice_design_units_with_cleanup(engine, request, sink, &mut cleanup)
}

fn generate_voice_design_units_with_cleanup(
    engine: &mut impl VoiceDesignEngine,
    request: &VoiceDesignRequest<'_>,
    sink: &mut dyn AudioSink,
    cleanup: &mut dyn FnMut(),
) -> Result<GenerationSummary> {
    let units = split_text_units(request.text, CUSTOM_VOICE_UNIT_CHARS)?;
    let language = normalize_language(request.language)?;
    let total = units.len();
    let mut streaming = StreamingUnitSink::new(sink, total);

    for (index, unit) in units.iter().enumerate() {
        streaming.sink.progress(
            "inference",
            &format!(
                "Generating Qwen3 VoiceDesign section {} of {total}.",
                index + 1
            ),
        )?;
        streaming.begin_unit(index);
        let controls =
            request
                .controls
                .effective_for_text(unit, &language, MAX_TEXT_UNIT_GENERATION_TOKENS);
        let streamed = run_with_inference_cache_cleanup(cleanup, || {
            engine.generate_voice_design_streaming(
                unit,
                &language,
                request.instruct,
                controls,
                &mut |samples, rate| streaming.push(samples, rate),
            )
        });
        if let Some(error) = streaming.take_error() {
            return Err(error);
        }
        streamed.with_context(|| {
            format!(
                "Qwen3 VoiceDesign inference failed in section {} of {total}.",
                index + 1
            )
        })?;
        streaming.end_unit(inter_unit_silence(
            index,
            total,
            streaming.sample_rate.unwrap_or_default(),
        ))?;
    }

    let sample_rate = streaming.sample_rate;
    let sample_count = streaming.sample_count;
    let audio_chunk_count = streaming.chunk_count;
    ensure!(audio_chunk_count > 0, "Qwen3 returned no audio.");

    Ok(GenerationSummary {
        sample_rate: sample_rate.unwrap_or_default(),
        sample_count,
        audio_chunk_count,
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
        fn generate_voice_design_streaming(
            &mut self,
            text: &str,
            language: &str,
            instruct: &str,
            controls: GenerationControls,
            on_audio: StreamedAudio<'_>,
        ) -> Result<()> {
            self.calls.push(Call {
                text: text.to_owned(),
                speaker: String::new(),
                language: language.to_owned(),
                instruct: instruct.to_owned(),
                controls,
            });
            on_audio(&[0.25], 24_000);
            Ok(())
        }
    }

    impl CustomVoiceEngine for RecordingEngine {
        fn generate_custom_voice_streaming(
            &mut self,
            text: &str,
            speaker: &str,
            language: &str,
            instruct: &str,
            controls: GenerationControls,
            on_audio: StreamedAudio<'_>,
        ) -> Result<()> {
            self.calls.push(Call {
                text: text.to_owned(),
                speaker: speaker.to_owned(),
                language: language.to_owned(),
                instruct: instruct.to_owned(),
                controls,
            });
            // Two chunks per unit, the first carrying a non-finite sample, so
            // the tests cover both per-chunk cleaning and the deferred flush
            // that places the inter-unit gap on a unit's final chunk.
            on_audio(&[f32::NAN, 0.5], 24_000);
            on_audio(&[0.75], 24_000);
            Ok(())
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
        let mut cleanup_count = 0usize;
        let mut cleanup = || cleanup_count += 1;

        let summary = generate_custom_voice_units_with_cleanup(
            &mut engine,
            &CustomVoiceRequest {
                text: &text,
                speaker: "Uncle_Fu",
                language: "Italian",
                instruct: "Speak warmly",
                controls,
            },
            &mut sink,
            &mut cleanup,
        )
        .unwrap();

        assert_eq!(cleanup_count, engine.calls.len());
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
        assert!(engine.calls.iter().all(|call| {
            call.controls
                == controls.effective_for_text(
                    &call.text,
                    &call.language,
                    MAX_TEXT_UNIT_GENERATION_TOKENS,
                )
        }));
        // Each unit streams two chunks now, so the chunk count tracks emitted
        // audio rather than text units.
        let units = engine.calls.len();
        assert_eq!(sink.chunks.len(), units * 2);
        assert_eq!(summary.audio_chunk_count, sink.chunks.len());
        assert_eq!(summary.sample_rate, 24_000);
        // Non-finite samples are cleaned per chunk, not per unit.
        assert!(
            sink.chunks
                .iter()
                .enumerate()
                .all(|(position, chunk)| if position % 2 == 0 {
                    chunk.0 == [0.0, 0.5]
                } else {
                    chunk.0 == [0.75]
                })
        );
        // Every chunk still carries its text-unit index and count, so the
        // client can map streamed audio back to sentences.
        assert!(sink.chunks.iter().all(|chunk| chunk.3 == units));
        assert!(
            sink.chunks
                .iter()
                .enumerate()
                .all(|(position, chunk)| chunk.2 == position / 2)
        );
        // The inter-unit gap rides on the LAST chunk of each unit and never on
        // the final unit — the property the deferred flush exists to preserve.
        for (position, chunk) in sink.chunks.iter().enumerate() {
            let is_unit_end = position % 2 == 1;
            let is_final_unit = position / 2 + 1 == units;
            let expected = if is_unit_end && !is_final_unit {
                4_800
            } else {
                0
            };
            assert_eq!(chunk.4, expected, "silence at chunk {position}");
        }
        // Total duration must be unchanged by streaming: real samples plus one
        // gap per boundary.
        assert_eq!(summary.sample_count, units * 3 + (units - 1) * 4_800);
    }

    #[test]
    fn a_unit_that_streams_no_audio_is_reported_not_skipped() {
        // Silently dropping the unit would remove a sentence from the output
        // with no signal to the caller.
        struct SilentEngine;
        impl CustomVoiceEngine for SilentEngine {
            fn generate_custom_voice_streaming(
                &mut self,
                _text: &str,
                _speaker: &str,
                _language: &str,
                _instruct: &str,
                _controls: GenerationControls,
                _on_audio: StreamedAudio<'_>,
            ) -> Result<()> {
                Ok(())
            }
        }

        let mut sink = RecordingSink::default();
        let mut engine = SilentEngine;
        let error = generate_custom_voice_units(
            &mut engine,
            &CustomVoiceRequest {
                text: "A single spoken sentence.",
                speaker: "Uncle_Fu",
                language: "English",
                instruct: "",
                controls: GenerationControls::new(0.8, 40, 512),
            },
            &mut sink,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("produced no audio for section"),
            "unexpected error: {error}"
        );
        assert!(sink.chunks.is_empty());
    }

    #[test]
    fn a_failing_unit_does_not_emit_its_pending_chunk() {
        // The engine fails after already streaming audio. The buffered chunk
        // and its inter-unit gap must not reach the sink, and the engine's own
        // message must survive with the section that produced it.
        struct FailingEngine;
        impl CustomVoiceEngine for FailingEngine {
            fn generate_custom_voice_streaming(
                &mut self,
                _text: &str,
                _speaker: &str,
                _language: &str,
                _instruct: &str,
                _controls: GenerationControls,
                on_audio: StreamedAudio<'_>,
            ) -> Result<()> {
                on_audio(&[0.5], 24_000);
                anyhow::bail!("token budget exhausted")
            }
        }

        let mut sink = RecordingSink::default();
        let mut engine = FailingEngine;
        let error = generate_custom_voice_units(
            &mut engine,
            &CustomVoiceRequest {
                text: "A single spoken sentence.",
                speaker: "Uncle_Fu",
                language: "English",
                instruct: "",
                controls: GenerationControls::new(0.8, 40, 512),
            },
            &mut sink,
        )
        .unwrap_err();
        let rendered = format!("{error:#}");
        assert!(rendered.contains("token budget exhausted"), "{rendered}");
        assert!(rendered.contains("section 1 of"), "{rendered}");
        assert!(sink.chunks.is_empty());
    }

    #[test]
    fn streamed_units_drop_empty_chunks_and_keep_one_gap_per_boundary() {
        // A chunk shorter than the vocoder's lookahead decodes to no samples.
        // It must not reach the sink, must not be counted, and must not be
        // mistaken for the unit's final chunk and so swallow the gap.
        struct SparseEngine;
        impl CustomVoiceEngine for SparseEngine {
            fn generate_custom_voice_streaming(
                &mut self,
                _text: &str,
                _speaker: &str,
                _language: &str,
                _instruct: &str,
                _controls: GenerationControls,
                on_audio: StreamedAudio<'_>,
            ) -> Result<()> {
                on_audio(&[0.5], 24_000);
                on_audio(&[], 24_000);
                Ok(())
            }
        }

        let mut sink = RecordingSink::default();
        let mut engine = SparseEngine;
        // Long enough to split past CUSTOM_VOICE_UNIT_CHARS into several units.
        let text = format!("First sentence. {}", "你".repeat(450));
        let summary = generate_custom_voice_units(
            &mut engine,
            &CustomVoiceRequest {
                text: &text,
                speaker: "Uncle_Fu",
                language: "English",
                instruct: "",
                controls: GenerationControls::new(0.8, 40, 512),
            },
            &mut sink,
        )
        .unwrap();

        let units = sink.chunks.last().unwrap().3;
        assert!(units >= 2, "expected the text to split into units");
        // One real chunk per unit; the empty one never reached the sink.
        assert_eq!(sink.chunks.len(), units);
        assert_eq!(summary.audio_chunk_count, units);
        assert!(sink.chunks.iter().all(|chunk| chunk.0 == [0.5]));
        // The gap still lands on each non-final unit despite the trailing
        // empty chunk.
        for (index, chunk) in sink.chunks.iter().enumerate() {
            let expected = if index + 1 == units { 0 } else { 4_800 };
            assert_eq!(chunk.4, expected, "silence at unit {index}");
        }
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
        assert_eq!(
            engine.calls[0].controls,
            controls.effective_for_text(
                "A short designed voice sample.",
                "english",
                MAX_TEXT_UNIT_GENERATION_TOKENS,
            )
        );
    }

    #[test]
    fn inference_cache_cleanup_runs_on_success_and_error() {
        let mut successful_cleanup_count = 0usize;
        let value = run_with_inference_cache_cleanup(&mut || successful_cleanup_count += 1, || {
            Ok::<_, anyhow::Error>(42)
        })
        .unwrap();
        assert_eq!(value, 42);
        assert_eq!(successful_cleanup_count, 1);

        let mut failed_cleanup_count = 0usize;
        let error = run_with_inference_cache_cleanup(
            &mut || failed_cleanup_count += 1,
            || -> Result<()> { anyhow::bail!("inference stopped") },
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "inference stopped");
        assert_eq!(failed_cleanup_count, 1);
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

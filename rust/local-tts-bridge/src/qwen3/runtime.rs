//! The Qwen3 runtime the bridge drives. It keeps one resident host, keyed by
//! canonical model path and mode, prepares voice-clone references on it, and
//! runs every mode through the shared streaming driver.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result, ensure};

use super::config::{GenerationControls, normalize_language};
use super::engines::VoiceCloneSession;
use super::host::{HostKey, NativeQwenHost, REFERENCE_MAX_DURATION_SECONDS};
use super::model_files::ExpectedModelType;
use super::reference::decode_reference_wav;
use super::streaming::{
    AudioSink, CustomVoiceRequest, GenerationSummary, VoiceDesignRequest,
    generate_custom_voice_units, generate_voice_clone_units, generate_voice_design_units,
    run_with_inference_cache_cleanup,
};

fn clear_inference_cache() {
    #[cfg(all(target_os = "macos", target_arch = "aarch64", not(test)))]
    unsafe {
        // MLX keeps released Metal buffers in a process-wide allocator cache.
        // Clearing that cache only releases unused scratch storage; tensors
        // holding the resident model and cached reference features remain live.
        qwen3_tts_rs::backend::mlx::ffi::mlx_clear_cache();
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
        let mut cleanup = clear_inference_cache;
        generate_custom_voice_units(&mut host.inference, request, sink, &mut cleanup)
    }

    pub fn generate_voice_design(
        &mut self,
        model_path: &Path,
        request: &VoiceDesignRequest<'_>,
        sink: &mut dyn AudioSink,
    ) -> Result<GenerationSummary> {
        let host = self.ensure_host(model_path, ExpectedModelType::VoiceDesign)?;
        let mut cleanup = clear_inference_cache;
        generate_voice_design_units(&mut host.inference, request, sink, &mut cleanup)
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
                        &mut |phase, message| sink.progress(phase, message),
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
        let mut session = VoiceCloneSession {
            inference: &host.inference,
            reference: &prepared,
        };
        let mut summary = generate_voice_clone_units(
            &mut session,
            text,
            &language,
            controls,
            sink,
            &mut cleanup,
        )?;
        summary.reference_truncated = prepared.truncated;
        summary.reference_short = prepared.short;
        Ok(summary)
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

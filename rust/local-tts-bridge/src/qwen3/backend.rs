//! Qwen3 as a bridge backend: maps validated requests onto the resident
//! runtime and streams its audio to the client while it is generated.

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};

use super::request::{
    CloneReference, Mode, parse_generate_request, parse_warm_request, qwen_reference_warnings,
};
use super::runtime::{Qwen3Runtime, VoiceCloneReference, VoiceCloneRequest};
use super::streaming::{AudioSink, CustomVoiceRequest, GenerationSummary, VoiceDesignRequest};
use super::target::resolved_runtime_target;
use crate::protocol::{
    GenerationOutput, MAX_AUDIO_CHUNK_SAMPLES, StreamedAudioSummary, float32_to_le_bytes,
    round_secs,
};
use crate::ws::{Backend, WebSocketConnection};

const QWEN3_MLX_CUSTOMVOICE_06B_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
const QWEN3_MLX_BASE_06B_MODEL: &str = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
const QWEN3_LIBTORCH_CUSTOMVOICE_06B_MODEL: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice";
const QWEN3_LIBTORCH_BASE_06B_MODEL: &str = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";

pub struct Qwen3Backend {
    runtime: Qwen3Runtime,
}

impl Qwen3Backend {
    pub fn new() -> Self {
        Self {
            runtime: Qwen3Runtime::new(),
        }
    }
}

impl Default for Qwen3Backend {
    fn default() -> Self {
        Self::new()
    }
}

impl Backend for Qwen3Backend {
    fn warm(&mut self, payload: Value) -> Result<Value> {
        let target = resolved_runtime_target();
        let request = parse_warm_request(payload)?;
        self.runtime
            .warm(Path::new(&request.model_path), request.model_type)?;
        Ok(json!({
            "warmed": true,
            "message": "Qwen3 model is loaded in the resident Rust bridge.",
            "provider": target.provider,
            "device": target.device,
            "accelerated": target.accelerated,
        }))
    }

    fn generate(
        &mut self,
        request_id: &str,
        payload: Value,
        connection: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        let request = parse_generate_request(payload)?;
        let started = Instant::now();
        let inference_started = Instant::now();
        let model_path = Path::new(&request.model_path);
        let mut sink = WebSocketQwenSink {
            request_id,
            connection,
            started,
            audio_chunk_count: 0,
        };
        let mut summary = match request.mode {
            Mode::CustomVoice { speaker, instruct } => self.runtime.generate_custom_voice(
                model_path,
                &CustomVoiceRequest {
                    text: &request.text,
                    speaker: &speaker,
                    language: &request.language,
                    instruct: &instruct,
                    controls: request.controls,
                },
                &mut sink,
            )?,
            Mode::VoiceDesign { instruct } => self.runtime.generate_voice_design(
                model_path,
                &VoiceDesignRequest {
                    text: &request.text,
                    language: &request.language,
                    instruct: &instruct,
                    controls: request.controls,
                },
                &mut sink,
            )?,
            Mode::VoiceClone(CloneReference::Audio {
                wav_base64,
                transcript,
                session_key,
            }) => {
                let reference_wav = BASE64
                    .decode(wav_base64.trim())
                    .context("Failed to decode Qwen3 reference WAV.")?;
                drop(wav_base64);
                self.runtime.generate_voice_clone(
                    model_path,
                    VoiceCloneRequest {
                        text: &request.text,
                        language: &request.language,
                        reference: VoiceCloneReference::Audio {
                            reference_wav,
                            reference_text: &transcript,
                            session_key: session_key.as_deref(),
                        },
                        controls: request.controls,
                    },
                    &mut sink,
                )?
            }
            Mode::VoiceClone(CloneReference::Cached { session_key }) => {
                self.runtime.generate_voice_clone(
                    model_path,
                    VoiceCloneRequest {
                        text: &request.text,
                        language: &request.language,
                        reference: VoiceCloneReference::Cached {
                            session_key: &session_key,
                        },
                        controls: request.controls,
                    },
                    &mut sink,
                )?
            }
        };
        summary.audio_chunk_count = sink.audio_chunk_count;
        qwen_generation_output(summary, request.model_repo, inference_started.elapsed())
    }
}

fn qwen_generation_output(
    summary: GenerationSummary,
    model_repo: String,
    inference_elapsed: Duration,
) -> Result<GenerationOutput> {
    let target = resolved_runtime_target();
    ensure!(
        summary.sample_rate > 0,
        "Qwen3 returned an invalid sample rate."
    );
    let mut phase_timings = serde_json::Map::new();
    phase_timings.insert(
        "inferenceSec".to_string(),
        json!(round_secs(inference_elapsed.as_secs_f64())),
    );
    Ok(GenerationOutput {
        samples: Vec::new(),
        sample_rate: usize::try_from(summary.sample_rate).context("Invalid Qwen3 sample rate")?,
        model_repo,
        device: Some(target.device.to_string()),
        warnings: qwen_reference_warnings(summary.reference_truncated, summary.reference_short),
        streamed_audio: Some(StreamedAudioSummary {
            sample_count: summary.sample_count,
            audio_chunk_count: summary.audio_chunk_count,
        }),
        phase_timings,
    })
}

struct WebSocketQwenSink<'a> {
    request_id: &'a str,
    connection: &'a mut WebSocketConnection,
    started: Instant,
    audio_chunk_count: usize,
}

impl WebSocketQwenSink<'_> {
    /// Abort the generation if the client asked for it. Every Qwen3 mode now
    /// streams audio during a text unit, so a Stop is observed within a few
    /// code frames and unwinds through the normal error path, leaving the
    /// loaded model in place.
    fn bail_if_cancelled(&mut self) -> Result<()> {
        self.connection.bail_if_cancelled(self.request_id)
    }
}

impl AudioSink for WebSocketQwenSink<'_> {
    fn progress(&mut self, phase: &str, message: &str) -> Result<()> {
        self.bail_if_cancelled()?;
        self.connection
            .send_progress(self.request_id, phase, message, self.started)
    }

    fn audio_chunk(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        index: usize,
        total: usize,
        silence_after_samples: usize,
    ) -> Result<()> {
        self.bail_if_cancelled()?;
        for (part_index, chunk) in samples.chunks(MAX_AUDIO_CHUNK_SAMPLES).enumerate() {
            let is_last_part = (part_index + 1) * MAX_AUDIO_CHUNK_SAMPLES >= samples.len();
            let mut metadata = json!({
                "type": "audio_chunk",
                "requestId": self.request_id,
                "index": self.audio_chunk_count,
                // The final transport chunk count is not known while Qwen is
                // streaming. The result envelope supplies the authoritative
                // count after generation completes.
                "total": 0,
                "sampleRate": sample_rate,
                "sampleCount": chunk.len(),
                "silenceAfterSamples": if is_last_part { silence_after_samples } else { 0 },
            });
            if total > 0 {
                metadata["textUnitIndex"] = json!(index);
                metadata["textUnitTotal"] = json!(total);
            }
            self.connection.send_json(&metadata)?;
            self.connection.send_binary(float32_to_le_bytes(chunk))?;
            self.audio_chunk_count = self.audio_chunk_count.saturating_add(1);
        }
        Ok(())
    }
}

pub fn probe_result() -> Value {
    let target = resolved_runtime_target();
    let (recommended_model, recommended_base_model) = if cfg!(target_os = "macos") {
        (QWEN3_MLX_CUSTOMVOICE_06B_MODEL, QWEN3_MLX_BASE_06B_MODEL)
    } else {
        (
            QWEN3_LIBTORCH_CUSTOMVOICE_06B_MODEL,
            QWEN3_LIBTORCH_BASE_06B_MODEL,
        )
    };
    let warnings: Vec<&str> = if target.accelerated {
        Vec::new()
    } else {
        vec!["No supported GPU accelerator was detected; Qwen3 will use its local CPU fallback."]
    };
    json!({
        "ready": true,
        "message": "Native Qwen3-TTS runtime is ready. Download or select a validated model directory before generation.",
        "runtime": "rust",
        "package": "qwen3-tts-rs",
        "packageVersion": super::PACKAGE_VERSION,
        "upstreamRevision": super::UPSTREAM_REVISION,
        "provider": target.provider,
        "device": target.device,
        "accelerated": target.accelerated,
        "recommendedModelRepo": recommended_model,
        "recommendedBaseModelRepo": recommended_base_model,
        "warnings": warnings,
    })
}

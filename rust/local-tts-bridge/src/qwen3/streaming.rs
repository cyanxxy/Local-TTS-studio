//! The streaming unit driver every Qwen3 mode shares. It splits a request into
//! bounded text units, budgets each unit, streams its audio through a
//! mode-specific engine, and forwards the chunks with their text-unit metadata
//! and inter-unit gaps. Engines are traits, so nothing here links a tensor
//! backend and `npm run test:rust:policy` exercises it with fake engines.

use anyhow::{Context, Result, bail, ensure};

use super::config::{
    GenerationControls, MAX_TEXT_UNIT_GENERATION_TOKENS, normalize_language, normalize_speaker,
};
use super::text::split_text_units;

// Smaller inference units bound each request's live MLX KV-cache/Metal working
// set. A 400-character unit can peak above 20 GB on the 0.6B model even when
// the allocator cache is cleared afterward.
const CUSTOM_VOICE_UNIT_CHARS: usize = 200;

struct InferenceCacheCleanupGuard<'a> {
    cleanup: &'a mut dyn FnMut(),
}

impl Drop for InferenceCacheCleanupGuard<'_> {
    fn drop(&mut self) {
        (self.cleanup)();
    }
}

/// Run `operation`, then `cleanup` whether it succeeded, failed, or panicked.
pub fn run_with_inference_cache_cleanup<T>(
    cleanup: &mut dyn FnMut(),
    operation: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let _cleanup_guard = InferenceCacheCleanupGuard { cleanup };
    operation()
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
    pub reference_short: bool,
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

pub trait VoiceCloneEngine {
    /// Streams one text unit conditioned on the engine's prepared reference.
    fn generate_voice_clone_streaming(
        &mut self,
        text: &str,
        language: &str,
        controls: GenerationControls,
        on_audio: StreamedAudio<'_>,
    ) -> Result<()>;
}

pub trait AudioSink {
    fn progress(&mut self, phase: &str, message: &str) -> Result<()>;

    /// `samples` is the engine's output as it came, never empty but possibly
    /// non-finite: the transport scrubs while it encodes, so cleaning here too
    /// would cost every chunk a second pass.
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
        // The engine's buffer is only lent for this call, and the chunk waits
        // here until the next one arrives.
        if let Some(previous) = self.pending.replace(samples.to_vec()) {
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
            // signal. The buffered path failed here too (it rejected an empty
            // buffer), so this keeps that contract.
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

/// Streams CustomVoice text. `cleanup` runs after every unit, whether or not it
/// succeeded; production passes the MLX allocator-cache release.
pub fn generate_custom_voice_units(
    engine: &mut impl CustomVoiceEngine,
    request: &CustomVoiceRequest<'_>,
    sink: &mut dyn AudioSink,
    cleanup: &mut dyn FnMut(),
) -> Result<GenerationSummary> {
    let speaker = normalize_speaker(request.speaker)?;
    let language = normalize_language(request.language)?;
    generate_units(
        "CustomVoice",
        request.text,
        &language,
        request.controls,
        sink,
        cleanup,
        &mut |unit, controls, on_audio| {
            engine.generate_custom_voice_streaming(
                unit,
                &speaker,
                &language,
                request.instruct,
                controls,
                on_audio,
            )
        },
    )
}

/// Streams VoiceDesign text; `cleanup` as for [`generate_custom_voice_units`].
pub fn generate_voice_design_units(
    engine: &mut impl VoiceDesignEngine,
    request: &VoiceDesignRequest<'_>,
    sink: &mut dyn AudioSink,
    cleanup: &mut dyn FnMut(),
) -> Result<GenerationSummary> {
    let language = normalize_language(request.language)?;
    generate_units(
        "VoiceDesign",
        request.text,
        &language,
        request.controls,
        sink,
        cleanup,
        &mut |unit, controls, on_audio| {
            engine.generate_voice_design_streaming(
                unit,
                &language,
                request.instruct,
                controls,
                on_audio,
            )
        },
    )
}

/// Streams voice-clone text; `cleanup` as for [`generate_custom_voice_units`].
pub fn generate_voice_clone_units(
    engine: &mut impl VoiceCloneEngine,
    text: &str,
    language: &str,
    controls: GenerationControls,
    sink: &mut dyn AudioSink,
    cleanup: &mut dyn FnMut(),
) -> Result<GenerationSummary> {
    let language = normalize_language(language)?;
    generate_units(
        "voice-clone",
        text,
        &language,
        controls,
        sink,
        cleanup,
        &mut |unit, controls, on_audio| {
            engine.generate_voice_clone_streaming(unit, &language, controls, on_audio)
        },
    )
}

/// Streams every mode the same way: split into bounded units, budget each
/// unit, stream its chunks, and carry the inter-unit gap on each unit's final
/// chunk. `generate_unit` is the only mode-specific step.
fn generate_units(
    mode_label: &str,
    text: &str,
    language: &str,
    controls: GenerationControls,
    sink: &mut dyn AudioSink,
    cleanup: &mut dyn FnMut(),
    generate_unit: &mut dyn FnMut(&str, GenerationControls, StreamedAudio<'_>) -> Result<()>,
) -> Result<GenerationSummary> {
    let units = split_text_units(text, CUSTOM_VOICE_UNIT_CHARS)?;
    let total = units.len();
    let mut streaming = StreamingUnitSink::new(sink, total);

    for (index, unit) in units.iter().enumerate() {
        streaming.sink.progress(
            "inference",
            &format!(
                "Generating Qwen3 {mode_label} section {} of {total}.",
                index + 1
            ),
        )?;
        streaming.begin_unit(index);
        let unit_controls =
            controls.effective_for_text(unit, language, MAX_TEXT_UNIT_GENERATION_TOKENS);
        let streamed = run_with_inference_cache_cleanup(cleanup, || {
            generate_unit(unit, unit_controls, &mut |samples, rate| {
                streaming.push(samples, rate)
            })
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
                "Qwen3 {mode_label} inference failed in section {} of {total}.",
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
        reference_short: false,
    })
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

    impl VoiceCloneEngine for RecordingEngine {
        fn generate_voice_clone_streaming(
            &mut self,
            text: &str,
            language: &str,
            controls: GenerationControls,
            on_audio: StreamedAudio<'_>,
        ) -> Result<()> {
            self.calls.push(Call {
                text: text.to_owned(),
                speaker: String::new(),
                language: language.to_owned(),
                instruct: String::new(),
                controls,
            });
            on_audio(&[0.5], 24_000);
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
            // the tests cover both raw pass-through and the deferred flush
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

    fn no_cleanup() {}

    #[test]
    fn propagates_controls_and_emits_clean_unicode_safe_units() {
        let text = format!("First sentence. {}", "你".repeat(450));
        let controls = GenerationControls::new(0.7, 27, 777);
        let mut engine = RecordingEngine::default();
        let mut sink = RecordingSink::default();
        let mut cleanup_count = 0usize;
        let mut cleanup = || cleanup_count += 1;

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
        // Chunks reach the sink unchanged and unnormalized; the transport
        // scrubs the non-finite sample while encoding it.
        assert!(
            sink.chunks
                .iter()
                .enumerate()
                .all(|(position, chunk)| if position % 2 == 0 {
                    chunk.0.len() == 2 && chunk.0[0].is_nan() && chunk.0[1] == 0.5
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
            &mut no_cleanup,
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
        let mut cleanup_count = 0usize;
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
            &mut || cleanup_count += 1,
        )
        .unwrap_err();
        let rendered = format!("{error:#}");
        assert!(rendered.contains("token budget exhausted"), "{rendered}");
        assert!(rendered.contains("section 1 of"), "{rendered}");
        assert!(sink.chunks.is_empty());
        // The failed unit still released its inference scratch memory.
        assert_eq!(cleanup_count, 1);
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
            &mut no_cleanup,
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
    fn voice_clone_units_stream_with_text_unit_metadata_and_gaps() {
        // Voice clone used to bypass the unit sink: no inter-unit gap, no
        // textUnitIndex. It must now match CustomVoice chunk for chunk.
        let text = format!("First sentence. {}", "你".repeat(450));
        let controls = GenerationControls::new(0.7, 27, 300);
        let mut engine = RecordingEngine::default();
        let mut sink = RecordingSink::default();
        let summary = generate_voice_clone_units(
            &mut engine,
            &text,
            "Auto",
            controls,
            &mut sink,
            &mut no_cleanup,
        )
        .unwrap();

        let units = engine.calls.len();
        assert!(units >= 3);
        assert_eq!(
            engine
                .calls
                .iter()
                .map(|call| call.text.as_str())
                .collect::<String>(),
            text
        );
        assert!(engine.calls.iter().all(|call| call.language == "auto"));
        assert!(engine.calls.iter().all(|call| {
            call.controls
                == controls.effective_for_text(&call.text, "auto", MAX_TEXT_UNIT_GENERATION_TOKENS)
        }));
        assert_eq!(sink.chunks.len(), units * 2);
        assert_eq!(summary.audio_chunk_count, units * 2);
        assert!(!summary.reference_truncated);
        assert!(sink.chunks.iter().all(|chunk| chunk.3 == units));
        for (position, chunk) in sink.chunks.iter().enumerate() {
            assert_eq!(chunk.2, position / 2);
            let is_unit_end = position % 2 == 1;
            let is_final_unit = position / 2 + 1 == units;
            let expected = if is_unit_end && !is_final_unit {
                4_800
            } else {
                0
            };
            assert_eq!(chunk.4, expected, "silence at chunk {position}");
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
            &mut no_cleanup,
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
}

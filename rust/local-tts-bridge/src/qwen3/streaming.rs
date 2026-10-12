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
    ) -> Result<()>;

    /// A text unit ended and `silence_samples` of silence follow its audio.
    /// Sent after the unit's last chunk, never after the request's last unit,
    /// and only when the gap is not empty.
    fn unit_gap(
        &mut self,
        sample_rate: u32,
        index: usize,
        total: usize,
        silence_samples: usize,
    ) -> Result<()>;
}

/// Forwards streamed chunks to the sink, one text unit at a time.
///
/// Every chunk is forwarded the moment the engine decodes it, so the first
/// audible chunk of a request never waits for a second decode batch. The
/// inter-unit gap cannot ride on a unit's final chunk (it is only identifiable
/// once the unit ends), so the unit's end is reported as its own `unit_gap`
/// event instead.
struct StreamingUnitSink<'a> {
    sink: &'a mut dyn AudioSink,
    unit_index: usize,
    unit_total: usize,
    unit_samples: usize,
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
            unit_samples: 0,
            sample_rate: None,
            sample_count: 0,
            chunk_count: 0,
            error: None,
        }
    }

    fn begin_unit(&mut self, unit_index: usize) {
        self.unit_index = unit_index;
        self.unit_samples = 0;
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
        self.unit_samples = self.unit_samples.saturating_add(samples.len());
        self.sample_count = self.sample_count.saturating_add(samples.len());
        self.chunk_count = self.chunk_count.saturating_add(1);
        // Keep passing the text-unit index/count: the client turns these into
        // textUnitIndex/textUnitTotal and maps chunks back to sentences with
        // them. Passing 0 here would collapse that mapping.
        self.sink
            .audio_chunk(samples, sample_rate, self.unit_index, self.unit_total)
    }

    /// Take any error the sink raised while streaming. The engine reports a
    /// sink refusal as a clean stop, so this is the only place the real cause
    /// survives — callers must consult it before trusting the engine's result.
    fn take_error(&mut self) -> Option<anyhow::Error> {
        self.error.take()
    }

    /// Close the unit and report the inter-unit gap that follows it.
    ///
    /// Callers must only reach this once the unit generated successfully.
    fn end_unit(&mut self, silence_samples: usize) -> Result<()> {
        if self.unit_samples == 0 {
            // Silently skipping would drop a sentence from the output with no
            // signal. The buffered path failed here too (it rejected an empty
            // buffer), so this keeps that contract.
            bail!(
                "Qwen3 produced no audio for section {} of {}.",
                self.unit_index + 1,
                self.unit_total
            );
        }
        if silence_samples == 0 {
            return Ok(());
        }
        self.sample_count = self.sample_count.saturating_add(silence_samples);
        self.sink.unit_gap(
            self.sample_rate.unwrap_or_default(),
            self.unit_index,
            self.unit_total,
            silence_samples,
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
/// unit, stream its chunks as they decode, and report the inter-unit gap when a
/// unit ends. `generate_unit` is the only mode-specific step.
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
        // engine's own error through before closing the unit, so a failed unit
        // never reports a gap on its way out.
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
            // the tests cover both raw pass-through and unit-end
            // gap event that follows the last of them.
            on_audio(&[f32::NAN, 0.5], 24_000);
            on_audio(&[0.75], 24_000);
            Ok(())
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    enum Event {
        Chunk {
            samples: Vec<f32>,
            sample_rate: u32,
            index: usize,
            total: usize,
        },
        Gap {
            sample_rate: u32,
            index: usize,
            total: usize,
            silence: usize,
        },
    }

    #[derive(Debug, Default)]
    struct RecordingSink {
        events: Vec<Event>,
    }

    impl RecordingSink {
        fn chunks(&self) -> Vec<(&[f32], usize, usize)> {
            self.events
                .iter()
                .filter_map(|event| match event {
                    Event::Chunk {
                        samples,
                        index,
                        total,
                        ..
                    } => Some((samples.as_slice(), *index, *total)),
                    Event::Gap { .. } => None,
                })
                .collect()
        }

        /// The (unit index, silence) of every gap, in arrival order.
        fn gaps(&self) -> Vec<(usize, usize)> {
            self.events
                .iter()
                .filter_map(|event| match event {
                    Event::Gap { index, silence, .. } => Some((*index, *silence)),
                    Event::Chunk { .. } => None,
                })
                .collect()
        }
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
        ) -> Result<()> {
            self.events.push(Event::Chunk {
                samples: samples.to_vec(),
                sample_rate,
                index,
                total,
            });
            Ok(())
        }

        fn unit_gap(
            &mut self,
            sample_rate: u32,
            index: usize,
            total: usize,
            silence: usize,
        ) -> Result<()> {
            self.events.push(Event::Gap {
                sample_rate,
                index,
                total,
                silence,
            });
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
        // Each unit streams two chunks, so the chunk count tracks emitted
        // audio rather than text units.
        let units = engine.calls.len();
        let chunks = sink.chunks();
        assert_eq!(chunks.len(), units * 2);
        assert_eq!(summary.audio_chunk_count, chunks.len());
        assert_eq!(summary.sample_rate, 24_000);
        // Chunks reach the sink unchanged and unnormalized; the transport
        // scrubs the non-finite sample while encoding it.
        assert!(
            chunks
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
        assert!(chunks.iter().all(|chunk| chunk.2 == units));
        assert!(
            chunks
                .iter()
                .enumerate()
                .all(|(position, chunk)| chunk.1 == position / 2)
        );
        // The inter-unit gap is its own event after each unit's last chunk and
        // never follows the final unit.
        let expected_gaps: Vec<(usize, usize)> = (0..units - 1).map(|unit| (unit, 4_800)).collect();
        assert_eq!(sink.gaps(), expected_gaps);
        for (position, event) in sink.events.iter().enumerate() {
            if let Event::Gap { index, total, .. } = event {
                assert_eq!(*total, units);
                assert!(
                    matches!(&sink.events[position - 1], Event::Chunk { index: previous, .. } if previous == index),
                    "gap {index} must directly follow that unit's last chunk"
                );
            }
        }
        // Total duration must be unchanged by streaming: real samples plus one
        // gap per boundary.
        assert_eq!(summary.sample_count, units * 3 + (units - 1) * 4_800);
    }

    #[test]
    fn the_first_chunk_of_a_request_is_forwarded_without_waiting_for_the_next() {
        // The sink used to hold every chunk until its successor arrived, which
        // delayed first audio by a whole decode batch.
        struct ObservingEngine<'s> {
            seen_after_first: &'s std::cell::Cell<Option<usize>>,
            events: &'s std::cell::RefCell<Vec<usize>>,
        }
        impl CustomVoiceEngine for ObservingEngine<'_> {
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
                self.seen_after_first.set(Some(self.events.borrow().len()));
                on_audio(&[0.25], 24_000);
                Ok(())
            }
        }
        struct CountingSink<'s>(&'s std::cell::RefCell<Vec<usize>>);
        impl AudioSink for CountingSink<'_> {
            fn progress(&mut self, _phase: &str, _message: &str) -> Result<()> {
                Ok(())
            }
            fn audio_chunk(&mut self, samples: &[f32], _: u32, _: usize, _: usize) -> Result<()> {
                self.0.borrow_mut().push(samples.len());
                Ok(())
            }
            fn unit_gap(&mut self, _: u32, _: usize, _: usize, _: usize) -> Result<()> {
                Ok(())
            }
        }

        let seen = std::cell::Cell::new(None);
        let events = std::cell::RefCell::new(Vec::new());
        let mut engine = ObservingEngine {
            seen_after_first: &seen,
            events: &events,
        };
        let mut sink = CountingSink(&events);
        generate_custom_voice_units(
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
        .unwrap();
        assert_eq!(
            seen.get(),
            Some(1),
            "first chunk must reach the sink at once"
        );
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
        assert!(sink.events.is_empty());
    }

    #[test]
    fn a_failing_unit_reports_no_gap() {
        // The engine fails after already streaming audio. That audio has gone
        // out, but the failed unit's inter-unit gap must not follow it, and the
        // engine's own message must survive with the section that produced it.
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

        let text = format!("First sentence. {}", "你".repeat(450));
        let mut sink = RecordingSink::default();
        let mut engine = FailingEngine;
        let mut cleanup_count = 0usize;
        let error = generate_custom_voice_units(
            &mut engine,
            &CustomVoiceRequest {
                text: &text,
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
        assert_eq!(sink.chunks().len(), 1);
        assert!(sink.gaps().is_empty());
        // The failed unit still released its inference scratch memory.
        assert_eq!(cleanup_count, 1);
    }

    #[test]
    fn streamed_units_drop_empty_chunks_and_keep_one_gap_per_boundary() {
        // A chunk shorter than the vocoder's lookahead decodes to no samples.
        // It must not reach the sink or be counted.
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

        let chunks = sink.chunks();
        let units = chunks.last().unwrap().2;
        assert!(units >= 2, "expected the text to split into units");
        // One real chunk per unit; the empty one never reached the sink.
        assert_eq!(chunks.len(), units);
        assert_eq!(summary.audio_chunk_count, units);
        assert!(chunks.iter().all(|chunk| chunk.0 == [0.5]));
        // Every boundary still gets exactly one gap despite the trailing empty
        // chunk, and the final unit gets none.
        let expected_gaps: Vec<(usize, usize)> = (0..units - 1).map(|unit| (unit, 4_800)).collect();
        assert_eq!(sink.gaps(), expected_gaps);
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
        let chunks = sink.chunks();
        assert_eq!(chunks.len(), units * 2);
        assert_eq!(summary.audio_chunk_count, units * 2);
        assert!(!summary.reference_truncated);
        assert!(chunks.iter().all(|chunk| chunk.2 == units));
        for (position, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.1, position / 2);
        }
        let expected_gaps: Vec<(usize, usize)> = (0..units - 1).map(|unit| (unit, 4_800)).collect();
        assert_eq!(sink.gaps(), expected_gaps);
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

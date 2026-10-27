//! The WebSocket wire contract with `electron/webSocketBridgeWorker.ts`:
//! request envelopes, the limits both sides mirror, and how generated audio
//! and results are framed. Nothing here touches a socket or a model runtime.

use anyhow::{Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};

// Electron accepts reference-audio base64 strings up to 60,000,000 bytes. Keep
// the transport ceiling above that payload plus its bounded JSON envelope.
pub const MAX_WEBSOCKET_TEXT_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_AUDIO_CHUNK_SAMPLES: usize = 262_144;
// Cancellation unwinds generation through the normal error path; the exact
// text is what the client matches on to keep the worker warm.
pub const CANCELLED_MESSAGE: &str = "Generation cancelled.";
/// The `type` of the frame that reports the silence after a finished text unit.
pub const UNIT_GAP_FRAME_TYPE: &str = "unit_gap";
pub const MAX_LOCAL_TTS_TEXT_CHARS: usize = 6_000;
pub const MAX_REFERENCE_TEXT_CHARS: usize = 2_000;
pub const MAX_REFERENCE_AUDIO_BASE64_CHARS: usize = 60_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSocketRequest {
    pub request_id: Option<String>,
    pub payload: Option<Value>,
    pub command: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum BufferedRequest {
    /// A cancel for this request id.
    Cancel(String),
    /// Anything else the peer sent out of turn; replayed by `recv_text`.
    Deferred(String),
    /// A cancel carrying no usable request id.
    Ignored,
}

pub fn classify_buffered_request(text: String) -> BufferedRequest {
    let Ok(request) = serde_json::from_str::<WebSocketRequest>(&text) else {
        return BufferedRequest::Deferred(text);
    };
    if request.command.as_deref() != Some("cancel") {
        return BufferedRequest::Deferred(text);
    }
    match request.request_id {
        Some(request_id) if !request_id.trim().is_empty() => BufferedRequest::Cancel(request_id),
        _ => BufferedRequest::Ignored,
    }
}

/// The text-only frame sent after a streamed text unit's last audio chunk when
/// `silence_samples` of silence follow it. The client inserts the silence at
/// that point of its timeline; it never counts toward `audioChunkCount`.
pub fn unit_gap_frame(
    request_id: &str,
    sample_rate: u32,
    text_unit_index: usize,
    text_unit_total: usize,
    silence_samples: usize,
) -> Value {
    json!({
        "type": UNIT_GAP_FRAME_TYPE,
        "requestId": request_id,
        "sampleRate": sample_rate,
        "textUnitIndex": text_unit_index,
        "textUnitTotal": text_unit_total,
        "silenceSamples": silence_samples,
    })
}

pub fn ensure_reference_audio_base64_len(encoded_len: usize) -> Result<()> {
    ensure!(
        encoded_len <= MAX_REFERENCE_AUDIO_BASE64_CHARS,
        "Reference audio payload exceeds the {MAX_REFERENCE_AUDIO_BASE64_CHARS}-character base64 limit."
    );
    Ok(())
}

/// What one generation produced. Streaming backends have already sent their
/// audio and report only its totals; the others hand back every sample.
pub struct GenerationOutput {
    pub samples: Vec<f32>,
    pub sample_rate: usize,
    pub model_repo: String,
    pub device: Option<String>,
    pub warnings: Vec<String>,
    pub streamed_audio: Option<StreamedAudioSummary>,
    pub phase_timings: serde_json::Map<String, Value>,
}

pub struct StreamedAudioSummary {
    pub sample_count: usize,
    pub audio_chunk_count: usize,
}

impl GenerationOutput {
    /// Samples and transport chunks the client receives for this output.
    pub fn audio_totals(&self) -> (usize, usize) {
        let streamed_audio = self.streamed_audio.as_ref();
        let sample_count = streamed_audio
            .map(|summary| summary.sample_count)
            .unwrap_or(self.samples.len());
        let chunk_count = streamed_audio
            .map(|summary| summary.audio_chunk_count)
            .unwrap_or_else(|| sample_count.div_ceil(MAX_AUDIO_CHUNK_SAMPLES));
        (sample_count, chunk_count)
    }
}

pub fn validate_generation_output(output: &GenerationOutput) -> Result<()> {
    if output.samples.is_empty() && output.streamed_audio.is_none() {
        bail!("Generation produced no audio samples.");
    }
    if output.sample_rate == 0 {
        bail!("Generation returned an invalid sample rate.");
    }
    let (sample_count, chunk_count) = output.audio_totals();
    ensure!(
        sample_count > 0 && chunk_count > 0,
        "Generation produced no audio samples."
    );
    Ok(())
}

pub fn is_elapsed_phase_timing(key: &str) -> bool {
    matches!(
        key,
        "modelLoadSec"
            | "referenceEncodingSec"
            | "inferenceSec"
            | "outputEncodingSec"
            | "transportEncodingSec"
    )
}

pub fn round_secs(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

/// Encode samples as the little-endian Float32 the client plays, turning
/// non-finite samples into silence in the same pass. This is the only place
/// audio is scrubbed before it leaves the bridge, so producers can hand over
/// raw model output and each chunk is cleaned and encoded with one copy.
pub fn float32_to_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = vec![0; std::mem::size_of_val(samples)];
    let (encoded_samples, _) = bytes.as_chunks_mut::<4>();
    for (encoded, sample) in encoded_samples.iter_mut().zip(samples) {
        let clean = if sample.is_finite() { *sample } else { 0.0 };
        *encoded = clean.to_le_bytes();
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unit_gap_frame_carries_exactly_the_documented_fields() {
        assert_eq!(
            unit_gap_frame("r1", 24_000, 2, 5, 4_800),
            json!({
                "type": "unit_gap",
                "requestId": "r1",
                "sampleRate": 24_000,
                "textUnitIndex": 2,
                "textUnitTotal": 5,
                "silenceSamples": 4_800,
            })
        );
    }

    fn output_with(
        samples: Vec<f32>,
        sample_rate: usize,
        streamed_audio: Option<StreamedAudioSummary>,
    ) -> GenerationOutput {
        GenerationOutput {
            samples,
            sample_rate,
            model_repo: "test/repo".to_string(),
            device: None,
            warnings: Vec::new(),
            streamed_audio,
            phase_timings: serde_json::Map::new(),
        }
    }

    #[test]
    fn validate_generation_output_accepts_buffered_and_streamed_audio() {
        assert!(validate_generation_output(&output_with(vec![0.0; 4], 24_000, None)).is_ok());
        assert!(
            validate_generation_output(&output_with(
                Vec::new(),
                24_000,
                Some(StreamedAudioSummary {
                    sample_count: 4,
                    audio_chunk_count: 1,
                }),
            ))
            .is_ok()
        );
    }

    #[test]
    fn validate_generation_output_rejects_empty_audio_and_zero_rate() {
        assert!(validate_generation_output(&output_with(Vec::new(), 24_000, None)).is_err());
        assert!(validate_generation_output(&output_with(vec![0.0; 4], 0, None)).is_err());
    }

    #[test]
    fn elapsed_phase_timing_excludes_milestones() {
        assert!(is_elapsed_phase_timing("modelLoadSec"));
        assert!(is_elapsed_phase_timing("inferenceSec"));
        assert!(!is_elapsed_phase_timing("firstAudioSec"));
    }

    #[test]
    fn float32_transport_cleans_non_finite_samples_without_normalizing() {
        let bytes = float32_to_le_bytes(&[f32::NAN, f32::INFINITY, -1.5]);
        let samples = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .copied()
            .map(f32::from_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(samples, vec![0.0, 0.0, -1.5]);
    }

    #[test]
    fn float32_transport_keeps_finite_samples_bit_exact() {
        let subnormal = f32::MIN_POSITIVE / 2.0;
        let samples = [-0.0, subnormal, f32::MAX, f32::MIN, 0.25, f32::NEG_INFINITY];
        let bytes = float32_to_le_bytes(&samples);
        assert_eq!(bytes.len(), samples.len() * 4);
        let encoded = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .copied()
            .map(u32::from_le_bytes)
            .collect::<Vec<_>>();
        let expected = [-0.0, subnormal, f32::MAX, f32::MIN, 0.25, 0.0].map(f32::to_bits);
        assert_eq!(encoded, expected);
        assert!(float32_to_le_bytes(&[]).is_empty());
    }

    #[test]
    fn buffered_requests_separate_cancels_from_deferred_work() {
        assert_eq!(
            classify_buffered_request(r#"{"command":"cancel","requestId":"r1"}"#.to_string()),
            BufferedRequest::Cancel("r1".to_string()),
        );
        // A cancel with no usable id must not abort whatever is running.
        assert_eq!(
            classify_buffered_request(r#"{"command":"cancel"}"#.to_string()),
            BufferedRequest::Ignored,
        );
        assert_eq!(
            classify_buffered_request(r#"{"command":"cancel","requestId":"  "}"#.to_string()),
            BufferedRequest::Ignored,
        );
        // Anything that is not a cancel is replayed to the request loop rather
        // than swallowed by the mid-generation poll.
        let generate = r#"{"requestId":"r2","payload":{"text":"hi"}}"#.to_string();
        assert_eq!(
            classify_buffered_request(generate.clone()),
            BufferedRequest::Deferred(generate),
        );
        let garbage = "not json".to_string();
        assert_eq!(
            classify_buffered_request(garbage.clone()),
            BufferedRequest::Deferred(garbage),
        );
    }

    #[test]
    fn reference_audio_base64_is_capped_at_the_electron_limit() {
        assert!(ensure_reference_audio_base64_len(MAX_REFERENCE_AUDIO_BASE64_CHARS).is_ok());
        assert!(
            ensure_reference_audio_base64_len(MAX_REFERENCE_AUDIO_BASE64_CHARS + 1)
                .unwrap_err()
                .to_string()
                .contains("60000000-character")
        );
    }

    #[test]
    fn websocket_frame_limit_covers_electron_reference_audio_payload() {
        const { assert!(MAX_WEBSOCKET_TEXT_FRAME_BYTES > 60_000_000) };
    }
}

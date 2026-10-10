//! Binds the streaming driver's engine traits to the vendored qwen3-tts-rs
//! inference API.

use anyhow::{Context, Result};
use qwen3_tts_rs::inference::TTSInference;

use super::config::GenerationControls;
use super::host::PreparedReference;
use super::streaming::{CustomVoiceEngine, StreamedAudio, VoiceCloneEngine, VoiceDesignEngine};

const VOICE_CLONE_STREAMING_CHUNK_SIZE: usize = 4;
// CustomVoice and VoiceDesign stream on the same cadence as voice cloning, so
// first audio arrives after a few code frames rather than after the whole text
// unit has been generated.
const TEXT_UNIT_STREAMING_CHUNK_SIZE: usize = 4;

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
        qwen3_tts_rs::tensor::set_sampling_seed(controls.seed);
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
        qwen3_tts_rs::tensor::set_sampling_seed(controls.seed);
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

/// Binds a loaded Base model to one prepared reference so the shared unit
/// driver can stream voice-clone units without seeing tensors.
pub struct VoiceCloneSession<'a> {
    pub inference: &'a TTSInference,
    pub reference: &'a PreparedReference,
}

impl VoiceCloneEngine for VoiceCloneSession<'_> {
    fn generate_voice_clone_streaming(
        &mut self,
        text: &str,
        language: &str,
        controls: GenerationControls,
        on_audio: StreamedAudio<'_>,
    ) -> Result<()> {
        qwen3_tts_rs::tensor::set_sampling_seed(controls.seed);
        self.inference
            .generate_with_icl_streaming(
                text,
                &self.reference.reference_text,
                &self.reference.features.codes,
                &self.reference.features.speaker_embedding,
                language,
                controls.temperature,
                controls.top_k,
                controls.max_new_tokens,
                VOICE_CLONE_STREAMING_CHUNK_SIZE,
                on_audio,
            )
            .context("Qwen3 voice-clone inference failed.")
    }
}

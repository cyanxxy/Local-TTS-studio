mod config;
mod model_files;
#[cfg(qwen3_native)]
mod reference;
#[cfg(qwen3_native)]
mod runtime;
mod text;

pub const UPSTREAM_REVISION: &str = "288a716ce38a91c826dd67968c75d1dd4b0f07bc";

pub(super) use config::{
    DEFAULT_CUSTOM_VOICE_LANGUAGE, DEFAULT_CUSTOM_VOICE_SPEAKER, GenerationControls,
    MAX_GENERATION_TOKENS,
};
pub(super) use model_files::ExpectedModelType;
#[cfg(qwen3_native)]
pub(super) use runtime::{
    AudioSink, CustomVoiceRequest, GenerationSummary, Qwen3Runtime, VoiceCloneReference,
    VoiceCloneRequest, VoiceDesignRequest, resolved_runtime_target,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_the_pinned_runtime_revision() {
        assert_eq!(
            UPSTREAM_REVISION,
            "288a716ce38a91c826dd67968c75d1dd4b0f07bc"
        );
    }
}

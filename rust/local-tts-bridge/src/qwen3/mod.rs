mod config;
#[cfg(qwen3_native)]
mod engines;
#[cfg(qwen3_native)]
mod host;
mod model_files;
#[cfg(qwen3_native)]
mod reference;
#[cfg(qwen3_native)]
mod runtime;
// Model-free: compiled for tests on every target so its fake-engine suite runs
// even where no tensor provider exists. `bridge-policy-tests` includes it too.
#[cfg(any(test, qwen3_native))]
mod streaming;
#[cfg(qwen3_native)]
mod target;
mod text;

pub const UPSTREAM_REVISION: &str = "288a716ce38a91c826dd67968c75d1dd4b0f07bc";

pub(super) use config::{
    DEFAULT_CUSTOM_VOICE_LANGUAGE, DEFAULT_CUSTOM_VOICE_SPEAKER, GenerationControls,
    MAX_GENERATION_TOKENS,
};
pub(super) use model_files::ExpectedModelType;
#[cfg(qwen3_native)]
pub(super) use runtime::{Qwen3Runtime, VoiceCloneReference, VoiceCloneRequest};
#[cfg(qwen3_native)]
pub(super) use streaming::{AudioSink, CustomVoiceRequest, GenerationSummary, VoiceDesignRequest};
#[cfg(qwen3_native)]
pub(super) use target::resolved_runtime_target;

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

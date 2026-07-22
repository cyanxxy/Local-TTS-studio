mod config;
mod model_files;
#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
))]
mod reference;
#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
))]
mod runtime;
mod text;

pub const UPSTREAM_REVISION: &str = "288a716ce38a91c826dd67968c75d1dd4b0f07bc";

pub(super) use config::GenerationControls;
pub(super) use model_files::ExpectedModelType;
#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
))]
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

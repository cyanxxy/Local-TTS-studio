mod config;
mod model_files;
#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    target_os = "windows"
))]
mod reference;
#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    target_os = "windows"
))]
mod runtime;
mod text;

pub const UPSTREAM_REVISION: &str = "288a716ce38a91c826dd67968c75d1dd4b0f07bc";

pub const fn compiled_provider() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "mlx"
    }
    #[cfg(target_os = "windows")]
    {
        "libtorch"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        target_os = "windows"
    )))]
    {
        "unsupported"
    }
}

pub(super) use config::GenerationControls;
pub(super) use model_files::ExpectedModelType;
#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    target_os = "windows"
))]
pub(super) use runtime::{
    AudioSink, CustomVoiceRequest, GenerationSummary, Qwen3Runtime, VoiceCloneRequest,
    resolved_provider,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_the_pinned_runtime_revision_and_platform_provider() {
        assert_eq!(
            UPSTREAM_REVISION,
            "288a716ce38a91c826dd67968c75d1dd4b0f07bc"
        );
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        assert_eq!(compiled_provider(), "mlx");
        #[cfg(target_os = "windows")]
        assert_eq!(compiled_provider(), "libtorch");
    }
}

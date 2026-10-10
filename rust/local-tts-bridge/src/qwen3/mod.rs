//! Qwen3-TTS hosted in the bridge through the vendored `qwen3-tts-rs`.
//!
//! The model-free modules (config, model_files, request, streaming, text) are
//! compiled for tests on every target, and `bridge-policy-tests` includes them,
//! so their suites run without a tensor provider. The rest needs
//! `cfg(qwen3_native)`; other targets get the `unavailable` backend instead.

#[cfg(qwen3_native)]
mod backend;
#[cfg(any(test, qwen3_native))]
mod config;
#[cfg(qwen3_native)]
mod engines;
#[cfg(qwen3_native)]
mod host;
#[cfg(any(test, qwen3_native))]
mod model_files;
#[cfg(qwen3_native)]
mod reference;
#[cfg(any(test, qwen3_native))]
mod request;
#[cfg(qwen3_native)]
mod runtime;
#[cfg(any(test, qwen3_native))]
mod streaming;
#[cfg(qwen3_native)]
mod target;
#[cfg(any(test, qwen3_native))]
mod text;
#[cfg(any(test, not(qwen3_native)))]
mod unavailable;

pub const UPSTREAM_REVISION: &str = "288a716ce38a91c826dd67968c75d1dd4b0f07bc";
/// Version of the vendored crate, reported by the probe.
pub const PACKAGE_VERSION: &str = "0.2.2";

#[cfg(qwen3_native)]
pub use backend::{Qwen3Backend, probe_result};
#[cfg(not(qwen3_native))]
pub use unavailable::{Qwen3Backend, probe_result};

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

    #[test]
    fn probe_reports_the_locked_qwen3_tts_rs_version() {
        assert_eq!(
            crate::locked_package_version("qwen3-tts-rs").as_deref(),
            Some(PACKAGE_VERSION)
        );
    }
}

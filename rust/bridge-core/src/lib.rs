//! The model-free half of the Open TTS local bridge: the loopback WebSocket
//! transport (`ws`), the wire contract (`protocol`), and the request,
//! streaming, and file policy of each backend. The `open-tts-local-bridge`
//! binary adds the model runtimes on top.
//!
//! Nothing here may link a native runtime: `npm run test:rust:policy` runs
//! this crate's tests without MLX, Metal, or LibTorch.

pub mod neutts_request;
pub mod protocol;
pub mod qwen3;
pub mod reference_audio;
pub mod resident_model;
pub mod ws;

// Exercise the vendored sampler/prompt policy with the model-free tests.
#[cfg(test)]
#[allow(
    clippy::allow_attributes_without_reason,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    reason = "vendored upstream source, kept as upstream wrote it"
)]
#[path = "../../vendor/qwen3-tts-rs/src/generation_policy.rs"]
mod qwen_generation_policy;

//! Model-free tests reuse production source without linking native runtimes.
//! Run with `npm run test:rust:policy`; full bridge tests remain `test:rust`.
//!
//! The bridge's model-free files are compiled here at the same module paths
//! they have in the bridge, so their `crate::` and `super::` imports resolve
//! unchanged. `ws` comes in through its own `mod.rs`, which keeps the whole
//! transport native-free: a native dependency there fails this build. It is
//! public because its `mod.rs` re-exports the API only the bridge's `main.rs`
//! consumes. The `neutts_backend` and `qwen3` trees list only their model-free
//! files.

#[cfg(test)]
#[path = "../../vendor/qwen3-tts-rs/src/generation_policy.rs"]
mod generation_policy;
#[cfg(test)]
#[path = "../../local-tts-bridge/src/protocol.rs"]
mod protocol;
#[cfg(test)]
#[path = "../../local-tts-bridge/src/reference_audio.rs"]
mod reference_audio;
#[cfg(test)]
#[path = "../../local-tts-bridge/src/resident_model.rs"]
mod resident_model;
#[cfg(test)]
#[path = "../../local-tts-bridge/src/ws/mod.rs"]
pub mod ws;

#[cfg(test)]
#[path = "../../local-tts-bridge/src/neutts_backend"]
mod neutts_backend {
    mod request;
}

#[cfg(test)]
#[path = "../../local-tts-bridge/src/qwen3"]
mod qwen3 {
    mod config;
    mod model_files;
    mod request;
    mod streaming;
    mod text;
}

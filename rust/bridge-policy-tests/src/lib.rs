//! Model-free tests reuse production source without linking native runtimes.
//! Run with `npm run test:rust:policy`; full bridge tests remain `test:rust`.

#[cfg(test)]
#[path = "../../local-tts-bridge/src/qwen3/config.rs"]
mod config;
#[cfg(test)]
#[path = "../../vendor/qwen3-tts-rs/src/generation_policy.rs"]
mod generation_policy;
#[cfg(test)]
#[path = "../../local-tts-bridge/src/resident_model.rs"]
mod resident_model;
#[cfg(test)]
#[path = "../../local-tts-bridge/src/qwen3/text.rs"]
mod text;

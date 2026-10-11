//! Sets `cfg(qwen3_native)` on the targets that link a Qwen3 tensor provider:
//! MLX on Apple Silicon macOS and LibTorch on x64 Windows.
//!
//! Cargo cannot select dependencies with a custom cfg, so this condition must
//! stay in step with the target-specific `qwen3-tts-rs` tables in Cargo.toml.
//! Code gated on `qwen3_native` that is compiled without that dependency fails
//! to build, so a drift between the two shows up immediately.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rustc-check-cfg=cfg(qwen3_native)");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if matches!(
        (target_os.as_str(), target_arch.as_str()),
        ("macos", "aarch64") | ("windows", "x86_64")
    ) {
        println!("cargo::rustc-cfg=qwen3_native");
    }
}

# Qwen3 Single Rust Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Qwen subprocess/Candle path with one in-process Qwen3 runtime inside `open-tts-local-bridge`, using MLX on Apple Silicon and LibTorch CUDA/CPU on Windows, with one Electron contract and one shared renderer controller.

**Architecture:** Electron keeps its authenticated loopback WebSocket connection to the single resident Rust bridge. The bridge owns a focused `qwen3` module built on the pinned `badlogic/qwen3_tts_rs` `TTSInference` API; target-specific Cargo features select MLX or LibTorch without creating separate product backends. Electron owns immutable model profiles and downloads, while one React context owns Qwen settings and request state for Studio, Reader, and the settings page.

**Tech Stack:** Rust 2024, `qwen3-tts-rs` revision `288a716ce38a91c826dd67968c75d1dd4b0f07bc`, MLX/Metal, `tch` 0.20 + LibTorch 2.7.1/CUDA 12.6, tungstenite, Electron 42, React 19, TypeScript 5.9, Vitest.

## Global Constraints

- Qwen is Electron-only; browser Kokoro and Supertonic behavior must not change.
- Electron launches exactly one Qwen process: `open-tts-local-bridge`.
- No Qwen HTTP server, CLI generator, inner worker, Python interpreter, or stdout/base64 audio fallback may remain.
- Pin `qwen3_tts_rs` to Git revision `288a716ce38a91c826dd67968c75d1dd4b0f07bc` in Cargo metadata and `Cargo.lock`.
- Apple Silicon builds `qwen3_tts_rs` with `default-features = false, features = ["mlx"]` and defaults to the 0.6B CustomVoice 6-bit MLX profile.
- Windows builds with `features = ["tch-backend"]`, MSVC, `tch` 0.20, release LibTorch 2.7.1/CUDA 12.6, CUDA device 0 when available, and CPU otherwise.
- Model downloads use immutable Hugging Face revisions from the approved design, never `resolve/main`.
- Supported language choices are Auto plus Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, and Italian.
- Supported speakers are Vivian, Serena, Uncle_Fu, Dylan, Eric, Ryan, Aiden, Ono_Anna, and Sohee; Rust lowercases only at model lookup.
- The user-facing generation controls are `temperature`, `topK`, and `maxNewTokens`; remove `topP`, `deviceMap`, `dtype`, and `attnImplementation`.
- Text splitting must be Unicode-scalar safe and preserve all non-whitespace input.
- Rust audio serialization removes NaN/Inf but does not peak-normalize; the renderer owns peak normalization.
- Audio remains WebSocket binary with model-provided sample rate and Float32 renderer delivery.
- Warm-up may load only an already-downloaded, validated model and must never download.
- Breaking Qwen IPC and persisted-state changes are allowed; do not retain compatibility adapters for removed Qwen fields.
- Native Windows support must be reported as unverified until CUDA, GPU-less CPU fallback, and clean-VM packaged tests run on Windows hardware.

---

### Task 1: Pin and Prove the Native Runtime Dependency

**Files:**
- Modify: `rust/local-tts-bridge/Cargo.toml`
- Modify: `rust/local-tts-bridge/Cargo.lock`
- Create: `rust/local-tts-bridge/src/qwen3/mod.rs`
- Create: `scripts/rust-target-dir.mjs`
- Create: `scripts/test-rust-bridge.mjs`
- Modify: `package.json`
- Test: `rust/local-tts-bridge/src/qwen3/mod.rs`

**Interfaces:**
- Consumes: the pinned upstream `qwen3_tts_rs::inference::TTSInference` and `qwen3_tts_rs::tensor::Device` APIs.
- Produces: `qwen3::UPSTREAM_REVISION: &str` and `qwen3::compiled_provider() -> &'static str` for probe/build diagnostics.

- [ ] **Step 1: Write the failing dependency-contract test**

```rust
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cargo test --manifest-path rust/local-tts-bridge/Cargo.toml qwen3::tests::exposes_the_pinned_runtime_revision_and_platform_provider`

Expected: compilation fails because `mod qwen3`, `UPSTREAM_REVISION`, or `compiled_provider` does not exist.

- [ ] **Step 3: Add target-specific dependencies and the minimal module**

```toml
[target.'cfg(all(target_os = "macos", target_arch = "aarch64"))'.dependencies]
qwen3-tts-rs = { git = "https://github.com/badlogic/qwen3_tts_rs.git", rev = "288a716ce38a91c826dd67968c75d1dd4b0f07bc", default-features = false, features = ["mlx"] }

[target.'cfg(target_os = "windows")'.dependencies]
qwen3-tts-rs = { git = "https://github.com/badlogic/qwen3_tts_rs.git", rev = "288a716ce38a91c826dd67968c75d1dd4b0f07bc", default-features = false, features = ["tch-backend"] }
```

```rust
pub const UPSTREAM_REVISION: &str = "288a716ce38a91c826dd67968c75d1dd4b0f07bc";

pub const fn compiled_provider() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "mlx" }
    #[cfg(target_os = "windows")]
    { "libtorch" }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        target_os = "windows"
    )))]
    { "unsupported" }
}
```

Add `mod qwen3;` to `main.rs`. Do not call `Qwen3TTSModel`; its generation methods at the pinned revision return placeholder silence. All production inference will use `TTSInference`.

- [ ] **Step 4: Verify GREEN and lock the exact revision**

Run: `cargo test --manifest-path rust/local-tts-bridge/Cargo.toml qwen3::tests::exposes_the_pinned_runtime_revision_and_platform_provider`

Expected: one focused test passes and `Cargo.lock` records the exact Git revision.

- [ ] **Step 5: Commit**

The pinned crate's unconditional `mp3lame-sys` dependency uses an autotools install step that breaks when Cargo's target path contains spaces. Route Rust tests through `scripts/test-rust-bridge.mjs`, which sets `CARGO_TARGET_DIR` to a workspace-keyed directory beneath `os.tmpdir()` unless the caller explicitly supplies one. Reuse `resolveRustTargetDir()` from the production build script in Task 8.

```bash
git add rust/local-tts-bridge/Cargo.toml rust/local-tts-bridge/Cargo.lock rust/local-tts-bridge/src/main.rs rust/local-tts-bridge/src/qwen3/mod.rs scripts/rust-target-dir.mjs scripts/test-rust-bridge.mjs package.json docs/superpowers/plans/2026-07-10-qwen3-single-rust-backend.md
git commit -m "build: pin native Qwen runtime"
```

### Task 2: Add Unicode-Safe Qwen Text Units

**Files:**
- Create: `rust/local-tts-bridge/src/qwen3/text.rs`
- Modify: `rust/local-tts-bridge/src/qwen3/mod.rs`
- Test: `rust/local-tts-bridge/src/qwen3/text.rs`

**Interfaces:**
- Consumes: validated non-empty UTF-8 text and a scalar-value budget.
- Produces: `pub fn split_text_units(text: &str, max_chars: usize) -> anyhow::Result<Vec<String>>`.

- [ ] **Step 1: Write failing Unicode preservation tests**

```rust
#[test]
fn cjk_without_spaces_never_slices_utf8_or_loses_text() {
    let text = "你好世界。".repeat(240);
    let units = split_text_units(&text, 120).unwrap();
    assert!(units.iter().all(|unit| unit.chars().count() <= 120));
    assert_eq!(units.concat(), text);
}

#[test]
fn emoji_combining_marks_and_long_urls_round_trip() {
    let text = "Ame\u{301}lie🙂 https://example.test/".to_string() + &"路".repeat(300);
    let units = split_text_units(&text, 64).unwrap();
    assert!(units.iter().all(|unit| unit.chars().count() <= 64));
    assert_eq!(units.concat(), text);
}

#[test]
fn empty_or_zero_budget_is_rejected() {
    assert!(split_text_units("   ", 40).is_err());
    assert!(split_text_units("speech", 0).is_err());
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path rust/local-tts-bridge/Cargo.toml qwen3::text::tests`

Expected: fails because `split_text_units` does not exist.

- [ ] **Step 3: Implement scalar-safe boundary selection**

Implement `split_text_units` by iterating `char_indices()`, remembering the last sentence boundary (`. ! ? 。！？；;\n`) and clause boundary (`, : ，：、`), and slicing only at recorded byte offsets. Hard-split at the byte offset belonging to the `max_chars`-th scalar when no punctuation is available. Preserve punctuation and whitespace exactly; only use `trim().is_empty()` to reject the complete input.

```rust
pub fn split_text_units(text: &str, max_chars: usize) -> Result<Vec<String>> {
    ensure!(max_chars > 0, "Qwen3 text-unit budget must be positive.");
    ensure!(!text.trim().is_empty(), "Qwen3 text is empty.");
    let mut output = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        let mut count = 0usize;
        let mut preferred = None;
        let mut hard_end = text.len();
        for (offset, ch) in text[start..].char_indices() {
            count += 1;
            let end = start + offset + ch.len_utf8();
            if matches!(ch, '.' | '!' | '?' | '。' | '！' | '？' | '；' | ';' | '\n' | ',' | ':' | '，' | '：' | '、') {
                preferred = Some(end);
            }
            if count == max_chars {
                hard_end = end;
                break;
            }
        }
        let end = preferred.filter(|end| *end <= hard_end).unwrap_or(hard_end);
        ensure!(end > start, "Qwen3 splitter made no progress.");
        output.push(text[start..end].to_owned());
        start = end;
    }
    Ok(output)
}
```

- [ ] **Step 4: Verify GREEN**

Run: `cargo test --manifest-path rust/local-tts-bridge/Cargo.toml qwen3::text::tests`

Expected: all splitter tests pass, including the previously crashing long Chinese case.

- [ ] **Step 5: Commit**

```bash
git add rust/local-tts-bridge/src/qwen3/mod.rs rust/local-tts-bridge/src/qwen3/text.rs
git commit -m "fix: split Qwen text without slicing UTF-8"
```

### Task 3: Centralize Profiles, Languages, Controls, and Model Validation

**Files:**
- Create: `electron/qwen3Profiles.ts`
- Create: `electron/qwen3Profiles.test.ts`
- Create: `rust/local-tts-bridge/src/qwen3/config.rs`
- Create: `rust/local-tts-bridge/src/qwen3/model_files.rs`
- Modify: `rust/local-tts-bridge/src/qwen3/mod.rs`
- Test: `rust/local-tts-bridge/src/qwen3/config.rs`
- Test: `rust/local-tts-bridge/src/qwen3/model_files.rs`

**Interfaces:**
- Produces TypeScript `Qwen3Profile`, `QWEN3_PROFILES`, `getQwen3Profiles(platform)`, `getQwen3Profile(repo)`.
- Produces Rust `QwenMode`, `GenerationControls`, `ValidatedRequest`, `validate_model_dir(path, expected_type)`.

- [ ] **Step 1: Add failing TypeScript profile tests**

Assert exact repo/revision/provider/model-type mappings for all eight approved profiles; assert macOS defaults to `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit`; assert Windows defaults to `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`; assert the language list contains Auto plus all ten official languages.

- [ ] **Step 2: Add failing Rust validation tests**

Create temporary model directories and assert rejection for missing `config.json`, wrong `tts_model_type`, missing root `model.safetensors`, empty weights, and missing `speech_tokenizer/model.safetensors`; assert a structurally complete directory is accepted.

- [ ] **Step 3: Run both suites and verify RED**

Run: `npx vitest run electron/qwen3Profiles.test.ts`

Run: `cargo test --manifest-path rust/local-tts-bridge/Cargo.toml qwen3::config::tests`

Run: `cargo test --manifest-path rust/local-tts-bridge/Cargo.toml qwen3::model_files::tests`

Expected: both fail because the profile and validation modules do not exist.

- [ ] **Step 4: Implement the exact profile contract**

Each TypeScript profile contains `repo`, `revision`, `mode`, `parameters`, `provider`, `platforms`, `weightFormat`, and `label`. Export the speaker and language arrays from the same file so Electron sanitizer and renderer import one source.

- [ ] **Step 5: Implement Rust request and directory validation**

`ValidatedRequest` must contain `text`, `mode`, `model_repo`, `model_path`, `speaker`, `language`, `instruct`, optional Base reference data, and clamped `GenerationControls { temperature: f64, top_k: i64, max_new_tokens: i64 }`. Reject unknown JSON fields with serde's `deny_unknown_fields` on the Qwen payload struct. Parse `config.json` and validate its `tts_model_type` and `codec_language_id` before model load.

- [ ] **Step 6: Verify GREEN**

Run the commands from Step 3. Expected: both suites pass.

- [ ] **Step 7: Commit**

```bash
git add electron/qwen3Profiles.ts electron/qwen3Profiles.test.ts rust/local-tts-bridge/src/qwen3
git commit -m "feat: centralize Qwen profiles and validation"
```

### Task 4: Implement the In-Process Rust Inference Host

**Files:**
- Create: `rust/local-tts-bridge/src/qwen3/runtime.rs`
- Create: `rust/local-tts-bridge/src/qwen3/reference.rs`
- Modify: `rust/local-tts-bridge/src/qwen3/mod.rs`
- Test: `rust/local-tts-bridge/src/qwen3/runtime.rs`
- Test: `rust/local-tts-bridge/src/qwen3/reference.rs`

**Interfaces:**
- Produces `Qwen3Runtime::new()`, `warm(&WarmRequest)`, `generate(&ValidatedRequest, &mut dyn AudioSink)`, and `provider_metadata()`.
- Defines `AudioSink::progress(&mut self, phase, message)`, `AudioSink::audio_chunk(&mut self, samples, sample_rate, index, total, silence_after_samples)`, and `AudioSink::cancelled()`.

- [ ] **Step 1: Write failing adapter tests with a fake inference engine**

Verify that model/profile changes drop the old host, same-profile requests reuse it, every CustomVoice text unit receives the three controls, speaker lookup is lowercase, output sample rate is preserved, NaN/Inf becomes zero, empty audio fails, and Base streaming reports `total: 0` until completion.

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path rust/local-tts-bridge/Cargo.toml qwen3::runtime::tests`

Run: `cargo test --manifest-path rust/local-tts-bridge/Cargo.toml qwen3::reference::tests`

Expected: fails because `Qwen3Runtime` and reference preparation do not exist.

- [ ] **Step 3: Implement the production engine around `TTSInference`**

On Apple Silicon, call `qwen3_tts_rs::backend::mlx::stream::init_mlx(true)` on the resident inference thread before constructing tensors. Pass `Device::Cpu` to `TTSInference::new` because the pinned MLX tensor adapter intentionally ignores the unified `Device` value and uses the initialized global MLX Metal stream; this matches the pinned upstream binaries. On Windows, select `Device::Gpu(0)` only when `tch::Cuda::is_available()` is true, otherwise select `Device::Cpu`. Use `generate_with_params` or `generate_with_instruct` for CustomVoice. Use the pinned runtime's audio encoder/speaker encoder and `generate_with_icl_streaming` for Base voice cloning. Do not call `Qwen3TTSModel`.

- [ ] **Step 4: Implement reference WAV handling**

Decode PCM/float WAV with `hound`, reject more than two channels, reject zero/invalid rates, downmix stereo, resample to the encoder rate, cap reference duration, hash the normalized bytes, and cache encoded reference codes/embedding by `(model path, digest, transcript, language)` with a bounded least-recently-used map.

- [ ] **Step 5: Verify GREEN and compile the MLX path**

Run: `cargo test --manifest-path rust/local-tts-bridge/Cargo.toml qwen3::runtime::tests`

Run: `cargo test --manifest-path rust/local-tts-bridge/Cargo.toml qwen3::reference::tests`

Run: `cargo check --release --manifest-path rust/local-tts-bridge/Cargo.toml`

Expected: tests pass and the pinned MLX backend compiles in-process on Apple Silicon.

- [ ] **Step 6: Commit**

```bash
git add rust/local-tts-bridge/src/qwen3
git commit -m "feat: run Qwen inference inside the Rust bridge"
```

### Task 5: Cut the WebSocket Bridge Over and Delete Old Rust Qwen Paths

**Files:**
- Modify: `rust/local-tts-bridge/src/main.rs`
- Modify: `rust/local-tts-bridge/Cargo.toml`
- Modify: `rust/local-tts-bridge/Cargo.lock`
- Test: `rust/local-tts-bridge/src/main.rs`
- Test: `electron/rustLocalBridge.test.ts`

**Interfaces:**
- Consumes `qwen3::Qwen3Runtime` and existing WebSocket audio sink.
- Preserves `probe`, `serve-ws`, `warm`, shutdown, progress frames, audio metadata + binary frame, and final result semantics.

- [ ] **Step 1: Replace old-path tests with failing single-process assertions**

Assert probe returns `package: "qwen3-tts-rs"`, pinned revision, and `provider: "mlx" | "cuda" | "cpu"`; assert source and built diagnostics contain no `OPEN_TTS_QWEN3_MLX_*`, `api_server`, `pibot-tts-worker`, or Qwen child spawning.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run electron/rustLocalBridge.test.ts && cargo test --manifest-path rust/local-tts-bridge/Cargo.toml`

Expected: old probe/path assertions fail.

- [ ] **Step 3: Route Qwen requests directly to `Qwen3Runtime`**

Keep the current WebSocket server and `WebSocketAudioSink`, but replace `Qwen3MlxApiServerHost`, `Qwen3MlxWorkerHost`, Candle `Qwen3Host`, and all Qwen subprocess functions with the focused module call. Cancellation still terminates the bridge when inference is inside a blocking provider call.

- [ ] **Step 4: Remove obsolete dependencies and code**

Remove `qwen_tts`, Qwen-only `candle-core`, Qwen-only `hf-hub`, and Qwen-only HTTP client calls. Keep `ureq` only if NeuCodec still uses it. Delete Qwen environment resolution, SSE parsing, child process groups, temp output WAV handling, and stdout frame protocols.

- [ ] **Step 5: Verify GREEN**

Run commands from Step 2. Expected: all Rust and Electron bridge tests pass.

- [ ] **Step 6: Commit**

```bash
git add rust/local-tts-bridge electron/rustLocalBridge.test.ts
git commit -m "refactor: cut Qwen over to one Rust process"
```

### Task 6: Replace Qwen IPC and Download Contracts

**Files:**
- Rename: `electron/qwen3MlxDownload.ts` to `electron/qwen3ModelDownload.ts`
- Rename: `electron/qwen3MlxDownload.test.ts` to `electron/qwen3ModelDownload.test.ts`
- Modify: `electron/localTtsIpc.ts`
- Modify: `electron/localTtsIpc.test.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/electron.d.ts`

**Interfaces:**
- Produces generic `getQwen3Setup`, `downloadQwen3Model`, `chooseQwen3ModelDir`, and `subscribeQwen3DownloadProgress` APIs.
- Produces sanitized payload containing only the new generation contract.

- [ ] **Step 1: Write failing sanitizer and downloader tests**

Assert Russian/Portuguese/Italian are accepted; obsolete controls and unknown fields are rejected; every approved profile requires its platform; downloads call `/resolve/<exact revision>/`; a manifest records repo, revision, files, sizes, and digests; setup distinguishes `verified` from `structural` readiness.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run electron/localTtsIpc.test.ts electron/qwen3ModelDownload.test.ts`

Expected: tests fail until APIs and filenames are replaced.

- [ ] **Step 3: Implement the breaking IPC contract**

Remove `deviceMap`, `dtype`, `attnImplementation`, and `topP` from sanitizer, preload, renderer types, profiling payloads, and warm payloads. Rename `baseModelPath` to `modelPath` for both CustomVoice and Base. Require Base reference WAV and exact transcript only for `voiceClone`.

- [ ] **Step 4: Implement revision-pinned downloads and manifests**

Fetch Hub metadata for the profile revision, download only profile-required files, store to a `.download` temporary path, validate length/digest, atomically rename, and write `open-tts-model.json` last. Reject incomplete, mismatched, wrong-type, or stale-manifest directories.

- [ ] **Step 5: Verify GREEN**

Run the command from Step 2. Expected: both suites pass.

- [ ] **Step 6: Commit**

```bash
git add electron src/electron.d.ts
git commit -m "refactor: replace Qwen IPC and download contracts"
```

### Task 7: Unify Renderer Qwen State

**Files:**
- Create: `src/contexts/Qwen3RuntimeContext.tsx`
- Create: `src/contexts/Qwen3RuntimeContext.test.tsx`
- Modify: `src/hooks/useQwen3LocalRuntime.ts`
- Modify: `src/components/LocalRuntimePage.tsx`
- Modify: `src/components/localRuntime/LocalRuntimeModelInputs.tsx`
- Modify: `src/components/localRuntime/LocalRuntimeRuntimeSettings.tsx`
- Modify: `src/components/localRuntime/modelOptions.ts`
- Modify: `src/shared/SynthesisApp.tsx`
- Modify: affected component tests

**Interfaces:**
- Produces one `Qwen3RuntimeProvider` and `useQwen3Runtime()` context.
- Context owns profile, path, speaker, language, instruction, temperature, topK, maxNewTokens, setup/probe/download/warm/generate/cancel/progress/audio/error, and stale-request guards.

- [ ] **Step 1: Write failing shared-state tests**

Render Studio and Qwen settings under one provider; change profile/speaker/language in settings; assert Studio's next generation uses the same values. Assert Reader observes the same settings, profile switches clear incompatible paths, stale results cannot replace current audio, and Qwen controls are absent when `window.electron.localTts` is absent.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/contexts/Qwen3RuntimeContext.test.tsx src/shared/SynthesisApp.test.tsx src/components/LocalRuntimePage.test.tsx`

Expected: fails because settings are still duplicated.

- [ ] **Step 3: Implement the provider and thin consumers**

Move all Qwen settings and lifecycle refs from `useQwen3LocalRuntime` and `LocalRuntimePage` into the provider. Keep audio playback scheduling ref-backed. Convert the old hook to a thin adapter that supplies the active text/player and invokes the shared controller. Import profile and language data from `electron/qwen3Profiles.ts` through type-safe pure exports.

- [ ] **Step 4: Remove obsolete UI controls and fallback copy**

Delete device, dtype, attention, top-p, Candle fallback, API server, CLI, and worker language. Display the resolved native provider and whether a selected directory is revision-verified or structurally validated.

- [ ] **Step 5: Verify GREEN**

Run the command from Step 2. Expected: all context, shell, and local-runtime page tests pass.

- [ ] **Step 6: Commit**

```bash
git add src electron/qwen3Profiles.ts
git commit -m "refactor: unify Qwen renderer state"
```

### Task 8: Simplify Build and Packaging to One Binary

**Files:**
- Modify: `scripts/build-rust-bridge.mjs`
- Create: `vite.buildRustBridge.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete: `scripts/build-qwen3-mlx-worker.mjs`
- Delete: `patches/qwen3_tts_rs/mlx-api-current-thread.patch`
- Delete: `electron/qwen3ProfileCli.ts`
- Delete: `electron/qwen3Profiling.ts`
- Delete: `electron/qwen3Profiling.test.ts`

**Interfaces:**
- `npm run build:rust` produces `dist-rust/open-tts-local-bridge[.exe]` plus only required provider libraries/resources.

- [ ] **Step 1: Write failing packaging tests**

Assert the build script has no Qwen tool-name scan or environment lookup; assert its artifact allowlist permits only the bridge, `mlx.metallib`/required dylibs on macOS, or LibTorch/CUDA DLL closure on Windows; assert removed npm scripts do not exist.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run vite.buildRustBridge.test.ts`

Expected: fails because the old build still copies every Qwen development binary.

- [ ] **Step 3: Delete the old build surface and implement strict artifacts**

Remove `build:qwen3-mlx-worker`, `build:qwen3-mlx-tools`, `build:rust:all`, and `profile:qwen3`. Build only the bridge. On macOS copy and relink only native dependencies referenced by the bridge plus the MLX metallib. On Windows collect the DLL closure from the pinned LibTorch distribution and fail if required release DLLs are missing.

- [ ] **Step 4: Verify GREEN and build Apple Silicon desktop**

Run: `npx vitest run vite.buildRustBridge.test.ts`

Run: `npm run build:desktop`

Expected: exactly one executable appears in `dist-rust`; desktop build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A scripts patches electron package.json package-lock.json vite.buildRustBridge.test.ts
git commit -m "build: package one Qwen Rust backend"
```

### Task 9: Remove Dead Contracts and Update Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: relevant `electron/*.test.ts`, `src/**/*.test.tsx`, and Rust tests
- Delete: any remaining Qwen MLX child-host source or types found by the scan below

**Interfaces:**
- Produces documentation and tests matching the new one-process architecture.

- [ ] **Step 1: Run the dead-contract scan**

Run:

```bash
rg -n 'OPEN_TTS_QWEN3_MLX|api_server|pibot-tts-worker|build:qwen3-mlx|Candle fallback|deviceMap|attnImplementation|topP|qwen3Mlx' electron src rust scripts package.json README.md AGENTS.md
```

Expected: only migration documentation or intentional historical design text may match; product code matches must be removed.

- [ ] **Step 2: Update docs and tests**

Document the single bridge, macOS MLX default, Windows CUDA/CPU behavior, immutable model downloads, new IPC fields, and platform verification status. Remove tests whose only purpose was compatibility with deleted child protocols.

- [ ] **Step 3: Re-run the scan**

Expected: no product-code matches for old environment variables, engines, or removed controls.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md electron src rust scripts package.json
git commit -m "docs: describe the single Qwen backend"
```

### Task 10: Full Verification and Native Evidence

**Files:**
- Modify only files needed to fix failures exposed by verification, with a new failing test before each behavioral fix.

**Interfaces:**
- Produces release evidence and an explicit Windows verification status.

- [ ] **Step 1: Run static and automated verification**

Run in order:

```bash
npm run lint
npm test
npm run build
npm run build:desktop
git diff --check
```

Expected: all commands exit 0; JS reports at least the existing 410 tests plus new tests; Rust reports at least the existing 22 tests plus new tests.

- [ ] **Step 2: Run Apple Silicon live smoke tests**

Using the pinned local 0.6B MLX CustomVoice profile, generate English and at least 200 Chinese characters without a crash; verify audio is non-empty, finite, uses the returned sample rate, and repeat generation reuses the loaded host. Using the Base profile, generate with a short reference WAV/transcript and verify streamed chunks form playable audio.

- [ ] **Step 3: Audit packaged artifacts**

Run: `find dist-rust -maxdepth 1 -type f -print | sort`

Expected on macOS: one `open-tts-local-bridge`, one `mlx.metallib`, and only dynamically referenced libraries; no `api_server`, `tts`, `voice_clone`, `pibot-tts-worker`, trace, or CLI executable.

- [ ] **Step 4: Record Windows as pending until native jobs run**

Do not claim Windows support from this Mac. Required external evidence is: native `x86_64-pc-windows-msvc` release build, 0.6B CustomVoice and Base model load, CUDA generation, the same package generating on a GPU-less Windows machine, and clean-VM launch without Rust/Python/`LIBTORCH`/build-machine PATH.

- [ ] **Step 5: Commit any verification-only corrections**

```bash
git add -A
git commit -m "test: verify native Qwen overhaul"
```

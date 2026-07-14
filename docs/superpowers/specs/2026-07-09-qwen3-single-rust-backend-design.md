# Qwen3 Single Rust Backend Design

## Summary

Replace the current Qwen3 implementation—which combines an in-process Candle path with three nested MLX subprocess paths—with one Electron-facing Rust backend. `open-tts-local-bridge` remains the only process and protocol endpoint used by Electron. It integrates `badlogic/qwen3_tts_rs` revision `288a716ce38a91c826dd67968c75d1dd4b0f07bc` **in-process** via the real working surface `qwen3_tts_rs::inference::TTSInference` (not the high-level `Qwen3TTSModel` stubs) and compiles that library with the fastest platform provider:

- Apple Silicon macOS: MLX with Metal acceleration and 6-bit MLX model profiles.
- Windows: LibTorch with CUDA when available and CPU fallback from the same Windows runtime.

“One backend” means one product runtime, one Rust inference API (`TTSInference`), one model/cache contract, and one Electron protocol. MLX and LibTorch are compile-time tensor providers, not independently orchestrated product backends.

## Goals

- Make Qwen3 an Electron-only feature with no browser runtime or server dependency.
- Use a single resident `open-tts-local-bridge` process for Qwen3 inference.
- Preserve Apple Silicon MLX performance.
- Support Windows NVIDIA CUDA and Windows CPU fallback.
- Support CustomVoice and Base voice cloning through the same Rust runtime abstraction.
- Support all ten Qwen3 languages advertised by the model configuration—Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, and Italian—plus the model's Auto selection mode.
- Preserve raw Float32 renderer audio (NaN/Inf cleaned only; peak-normalization stays in the renderer), model-provided sample rates, WebSocket binary transport, cancellation, warm-up, and resident model reuse.
- Make long and multilingual text splitting Unicode-safe in Open TTS–owned code (never via upstream byte-offset chunkers).
- Ensure every displayed generation control changes generation behavior.
- Make model downloads, validation, build inputs, and packaged native artifacts deterministic.
- Remove obsolete MLX HTTP, CLI, worker, patch, and packaging code.

## Non-goals

- Qwen3 inference in the browser build.
- DirectML support for AMD or Intel Windows GPUs in this change.
- Loading two Qwen3 models concurrently.
- Token-level CustomVoice streaming if the selected Rust library API only returns complete text-unit audio.
- Supporting arbitrary user-supplied Hugging Face repositories outside the approved Qwen3 model profiles.
- Supporting sharded model weights; every approved profile in this design currently publishes one root `model.safetensors`.
- Keeping compatibility with the internal MLX API-server, `tts`, or `pibot-tts-worker` protocols.
- **Preserving Qwen on Intel Mac or other non–Apple Silicon / non-Windows desktops.** After migration, Qwen is available only on Apple Silicon (MLX) and Windows (LibTorch). Candle is deleted without a LibTorch macOS path; those platforms return an explicit Qwen3-unavailable probe. This is an intentional product cut, not an accident.
- Using `Qwen3TTSModel` / `generate_custom_voice` / `generate_voice_clone` high-level APIs at pin `288a716` (they return placeholder silence; see [Pinned library API contract](#pinned-library-api-contract)).
- Calling upstream `qwen3_tts_rs::api::chunking::chunk_text` / `chunk_text_streaming` for product splitting (byte-offset slicing; unsafe for CJK).

## Architecture

```text
Electron renderer
  -> trusted IPC
Electron main process
  -> authenticated loopback WebSocket
open-tts-local-bridge (single resident Rust process)
  -> Qwen3Runtime (single product API)
     -> TTSInference + MLX on macOS arm64
     -> TTSInference + LibTorch on Windows
  -> WebSocket audio metadata + binary Float32 PCM frames
Electron main process
  -> raw Float32 audio events (NaN/Inf cleaned only; no peak-normalization)
Renderer audio player/export pipeline
  -> peak-normalization only at WAV/export (float32ChunksToWavBytes)
```

The bridge continues to serialize generation per model. A Qwen3 host owns at most one loaded model. Changing the model profile drops the previous host before loading the next one, bounding memory use and avoiding concurrent entry into an inference implementation that is not designed for it.

## Platform Runtime Profiles

### Apple Silicon macOS

- Build `qwen3_tts_rs` with `default-features = false` and the `mlx` feature.
- Initialize MLX and execute model loading and inference on the same resident bridge thread.
- Default to `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit`.
- Offer the matching 1.7B CustomVoice and 0.6B/1.7B Base 6-bit profiles as explicit quality or voice-clone choices.
- Do not launch an internal HTTP server or any Qwen child process.

### Windows

- Build the same pinned `qwen3_tts_rs` revision with its `tch-backend` feature.
- Use the MSVC Rust target `x86_64-pc-windows-msvc`, `tch` 0.20 from the pinned dependency graph, and release LibTorch 2.7.1 with CUDA 12.6. Debug LibTorch is not ABI-compatible with release builds on Windows and is not a supported packaging input.
- Select `Device::Gpu(0)` only when LibTorch reports CUDA available; otherwise select `Device::Cpu`.
- Default to the official `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` profile.
- Use official Base model weights for voice cloning.
- Bundle the required LibTorch native DLLs. A CUDA-enabled distribution may use CPU fallback, accepting a larger Windows package to avoid separate product backends.
- Report the resolved `cuda` or `cpu` provider in probe and generation results.
- Treat Windows support as unproven until a native release build loads both approved 0.6B model types, generates CustomVoice audio on CUDA, and generates audio on a machine without an NVIDIA GPU using the same packaged runtime. Do not delete the old implementation solely on the strength of a cross-compile.

### Unsupported platforms (explicit cut)

Intel Mac (x86_64), non-Windows Linux desktops, and any other host that is not Apple Silicon or Windows return an explicit Qwen3-unavailable probe result. Existing browser Kokoro and Supertonic behavior is unchanged. Do not silently fall back to Candle after this migration.

## Dependency Ownership

- Pin `qwen3_tts_rs` to `https://github.com/badlogic/qwen3_tts_rs.git` revision `288a716ce38a91c826dd67968c75d1dd4b0f07bc` in Cargo metadata and `Cargo.lock`. Floating branches are forbidden.
- Use the same revision for macOS and Windows builds.
- Remove the ignored `rust/qwen3_tts_rs` build checkout from the normal product build.
- Delete `scripts/build-qwen3-mlx-worker.mjs` and `patches/qwen3_tts_rs/mlx-api-current-thread.patch` after the in-process integration passes platform tests.
- Record the pinned upstream revision in probe metadata and build diagnostics.
- Upgrade the revision only in a dedicated change that runs the complete Qwen3 contract and platform smoke suites.

## Pinned library API contract

At revision `288a716ce38a91c826dd67968c75d1dd4b0f07bc`, the **only** supported in-process generation surface is:

| Role | API |
| --- | --- |
| Load | `TTSInference::new(model_path: &Path, device: Device)` |
| CustomVoice (no instruct) | `generate_with_params(text, speaker, language, temperature, top_k, max_codes)` → `(Vec<f32>, u32)` |
| CustomVoice (with instruct) | `generate_with_instruct(text, speaker, language, instruct, temperature, top_k, max_codes)` → `(Vec<f32>, u32)` |
| Base voice clone (ICL) | `generate_with_icl(text, ref_text, ref_codes, speaker_embedding, language, temperature, top_k, max_codes)` → `(Vec<f32>, u32)` |
| Base streaming (when used) | `generate_with_icl_streaming(..., chunk_size, on_audio: FnMut(&[f32], u32) -> bool)` |

Rules:

1. **Do not call** `Qwen3TTSModel`, `generate_custom_voice`, `generate_voice_design`, or `generate_voice_clone`. At this pin those methods are placeholders that return ~2s of silence (`// Placeholder: Actual generation would happen here` in `model.rs`). An implementer who follows them will “succeed” with silent audio.
2. **Speaker / language keys** passed into `TTSInference` are lowercased by the library when resolving `spk_id` / `codec_language_id`. The product still lowercases only in Rust after display-case UI/IPC values (same as today’s `qwen3_speaker_id` policy): keep capitalized display names in the renderer and IPC.
3. **Payload → library map** (every remaining user control must hit a real parameter):

| Product field | Maps to |
| --- | --- |
| `text` | Per-unit `text` argument after Open TTS splitting |
| `speaker` | `speaker` (CustomVoice); ignored for Base ICL (embedding/codes own the voice) |
| `language` | `language` string; validated against loaded model `codec_language_id` |
| `instruct` | `instruct` on `generate_with_instruct`; empty/absent → `generate_with_params` |
| `temperature` | `temperature: f64` |
| `topK` | `top_k: i64` |
| `maxNewTokens` | `max_codes: i64` |
| reference WAV + transcript | Base only: decode WAV → speaker embedding + codec codes via library encoders; `ref_text` is the exact transcript |

4. **`topP` is not applied** on this path; do not surface it in the UI. The library has no portable top-p on both MLX and LibTorch for `TTSInference`.
5. **Sample rate** always comes from the `u32` returned with the waveform, never hardcoded.
6. **Audio samples** are raw `Vec<f32>` / `&[f32]`. Rust only replaces NaN/Inf before serialization; no peak-normalization in the bridge.
7. Migration step 1 and all acceptance smokes must prove **non-silent** audio from `TTSInference`, not from `Qwen3TTSModel`.

If a future pin replaces the stubs with real high-level APIs, upgrade in a dedicated change; until then the adapter binds only to `TTSInference`.

## Rust Module Boundaries

Move Qwen3 responsibilities out of `rust/local-tts-bridge/src/main.rs`:

- `qwen3/mod.rs`: public bridge-facing runtime API, host selection, warm-up, and generation routing.
- `qwen3/config.rs`: model profiles, supported modes, languages, controls, provider selection, and payload validation.
- `qwen3/text.rs`: **Open TTS–owned** Unicode-safe text-unit splitting and punctuation boundaries. Must **not** call `qwen3_tts_rs::api::chunking::chunk_text` or `chunk_text_streaming` (those use `text.len()` / `split_at` / byte slices and can panic or corrupt multi-byte CJK, combining marks, and emoji).
- `qwen3/model_files.rs`: local directory inspection and model-type/required-file validation.
- `qwen3/runtime.rs`: `TTSInference` adapter, resident host keys, CustomVoice, Base voice cloning, and Float32 NaN/Inf cleanup only.
- `qwen3/reference.rs`: validated reference WAV decoding, resampling requirements, speaker embedding / codec encoding for ICL, digesting, and bounded cache cleanup.

`main.rs` retains CLI parsing, the shared WebSocket server, the NeuTTS runtime, and dispatch into `qwen3::Qwen3Runtime`.

The Qwen module consumes a narrow audio sink interface supplied by the WebSocket layer. It must not know about Electron IPC or Node types.

## Electron and Renderer State

Qwen remains visible only when `window.electron.localTts` exists.

A single Qwen controller instance owns:

- selected model profile and local directory;
- speaker, language, instruction, and supported generation controls;
- probe, download, warm, generate, progress, audio, cancel, and error state;
- active request/version guards;
- generated chunk history used for playback and export.

Studio, Reader, and the dedicated Qwen settings view consume this controller rather than creating separate Qwen state machines. The dedicated page may expose advanced controls, but changing them updates the same state used by inline generation.

Electron owns the TypeScript Qwen model/profile contract. Renderer options and IPC validation consume the same pure configuration module, preventing model, language, and control allowlists from drifting. The ten official language display names (plus Auto) are defined once in that module and generate both renderer options and the IPC allowlist; Rust model-config validation remains the final gate at generation time.

### IPC / download migration (drop MLX-named surface)

Today’s Electron surface is MLX-branded (`getQwen3MlxSetup`, `downloadQwen3MlxModel`, `chooseQwen3MlxModelDir`, `qwen3MlxDownload.ts`, and `/resolve/main/...` URLs). Windows official weights and revision-pinned downloads cannot live under “Mlx” APIs without false advertising.

| Today (remove or rename) | Target |
| --- | --- |
| `getQwen3MlxSetup` | `getQwen3Setup` (platform-aware: AS MLX profiles vs Windows LibTorch profiles) |
| `downloadQwen3MlxModel` | `downloadQwen3Model` |
| `chooseQwen3MlxModelDir` | `chooseQwen3ModelDir` |
| `qwen3MlxDownload.ts` | `qwen3Download.ts` (shared HF allowlist, redirect-SSRF guards, inactivity watchdog) |
| HF `/resolve/main/...` | `/resolve/<pinned-revision>/...` only |
| Preload / `src/electron.d.ts` MLX names | Renamed to match; no dual MLX+generic public API long-term |

Keep the same security posture: HTTPS-only, Hugging Face host allowlist re-checked on redirects, socket timeout, body inactivity watchdog, Content-Length verification before promoting temp files.

## Model Profiles and Files

Each approved profile declares:

- repository ID;
- model type: `custom_voice` or `base`;
- parameter size and quality label;
- supported platforms/providers;
- expected weight format;
- required root files (see below);
- required `speech_tokenizer` files;
- default speaker/language/control values.

Initial profiles are pinned to these Hugging Face revisions; downloads use `/resolve/<revision>/...`, never `/resolve/main/...`:

| Platform | Profile | Repository | Revision |
| --- | --- | --- | --- |
| macOS AS | 0.6B CustomVoice 6-bit | `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit` | `7dc92af14613355896fcab13b268c19ede233139` |
| macOS AS | 1.7B CustomVoice 6-bit | `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit` | `1c6c0ff58c43afa8df571facde2efa077efd85e2` |
| macOS AS | 0.6B Base 6-bit | `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit` | `4e44ed4bcee28a0f89a493e07bde16e6dccd43eb` |
| macOS AS | 1.7B Base 6-bit | `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-6bit` | `34ff5318365b59cba9c03ff729f2eee0814caf72` |
| Windows | 0.6B CustomVoice | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | `85e237c12c027371202489a0ec509ded67b5e4b5` |
| Windows | 1.7B CustomVoice | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | `0c0e3051f131929182e2c023b9537f8b1c68adfe` |
| Windows | 0.6B Base | `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | `5d83992436eae1d760afd27aff78a71d676296fc` |
| Windows | 1.7B Base | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `fd4b254389122332181a7c3db7f27e918eec64e3` |

### Required files (from `TTSInference::new`)

A directory is ready only when **all** of the following hold (deterministic downloader manifest + structural checks):

| Path | Requirement |
| --- | --- |
| `config.json` | Parses; `tts_model_type` matches the selected profile (`custom_voice` vs `base`) |
| `model.safetensors` | Single root weight file; non-empty; size matches recorded Hub size / published digest when available |
| Tokenizer | Either `tokenizer.json` **or** both `vocab.json` and `merges.txt` |
| `speech_tokenizer/model.safetensors` | Required for real audio (missing vocoder yields placeholder/silent synthesis in the library — treat as incomplete, not ready) |
| `speech_tokenizer` config files | Whatever the Hub profile ships that the vocoder load path needs; reject if vocoder load would fail |
| Download manifest (app downloads only) | Repository ID, pinned revision, file names, expected sizes, optional SHA-256/LFS object IDs |

Manually chosen directories receive the same structural and model-type validation, without requiring an app-generated download manifest. Because a manual directory has no trusted download manifest, the UI labels it as structurally validated rather than revision-verified.

Changing model profiles clears an incompatible directory. A directory is retained only if validation proves it matches the new profile.

## Generation Contract

The Electron-to-bridge payload remains camelCase. **Wire field names that already exist stay stable** unless explicitly listed under removals below. In particular, the local model directory field remains **`baseModelPath`** (Rust: `base_model_path`) — do **not** rename to `modelPath`. A rename would break live IPC/preload/renderer contracts in `electron/localTtsIpc.ts`, `useQwen3LocalRuntime`, and AGENTS.md.

Payload contains:

- `text`;
- `mode`: `customVoice` or `voiceClone`;
- `modelRepo` and validated `baseModelPath` when the profile requires a local directory;
- `speaker`, `language`, optional `instruct`;
- voice-clone reference WAV and exact transcript when in Base mode;
- `temperature`, `topK`, and `maxNewTokens`.

**Removals only** (not renames): drop `deviceMap`, `dtype`, `attnImplementation`, and `topP` from the user-facing Qwen contract:

- provider/device/dtype are selected by the packaged platform runtime, not by an end user;
- `TTSInference` does not implement top-p on this path, so presenting it would be misleading;
- attention implementation is a build/runtime capability rather than a portable request option.

Every remaining control is passed into both CustomVoice and Base generation via the parameter map in [Pinned library API contract](#pinned-library-api-contract). Values are clamped and validated at IPC and Rust boundaries.

The worker protocol between Electron and `open-tts-local-bridge` remains unchanged except for those field **removals**. No field is renamed for this migration.

## Language and Speaker Contract

The renderer and IPC expose the nine documented CustomVoice speakers with display capitalization. Rust lowercases only when resolving model speaker keys (before calling `TTSInference`).

The shared pure TypeScript config module defines all ten official language display names plus Auto once; renderer options and IPC allowlist are generated from that single list so IPC never rejects a language the UI offers. Before generation, the selected language must exist in the loaded model's `codec_language_id`. Final validation is model-derived rather than a second hard-coded subset in Rust.

Dialect speaker behavior remains owned by the model configuration.

## Text Splitting and Streaming

Text splitting is implemented only in Open TTS `qwen3/text.rs`. It operates on Unicode scalar values (character indices / `char_indices`) and never slices UTF-8 at arbitrary byte offsets.

- Prefer sentence and clause boundaries.
- Use a smaller first unit to reduce first-audio latency.
- Enforce a character budget even for text without whitespace, including CJK and long URLs.
- Preserve punctuation and never drop non-whitespace input.
- Reject empty post-split output.
- **Forbidden:** `qwen3_tts_rs::api::chunking::chunk_text`, `chunk_text_streaming`, or any helper that uses `text.len()` / `split_at` / `&text[..n]` as character budgets. Contract tests must include inputs that would panic those upstream helpers (dense CJK runs, combining marks, emoji) and assert Open TTS splitting succeeds and round-trips non-whitespace content.

CustomVoice generates one text unit at a time via `generate_with_params` / `generate_with_instruct` and emits each completed unit as an audio chunk with known `total`. This is text-unit streaming, not token streaming. Inter-unit silence (e.g. 0.2s) may match today’s Candle path for UX consistency.

Base voice cloning uses `generate_with_icl_streaming` when supported and emits `total: 0` until the final chunk count is known; otherwise `generate_with_icl` plus the same bounded transport chunking as CustomVoice.

### Binary frame encoding

For the new in-process Qwen path, audio binary frames are **Float32 only** (`sampleCount * 4` bytes after NaN/Inf cleanup). Do **not** emit `encoding:"pcm16"` for Qwen after migration; that encoding existed for MLX api_server/worker Int16 relays. Electron `webSocketBridgeWorker` may keep pcm16 conversion for NeuTTS or transition cleanup, but Qwen metadata frames omit `encoding` (default Float32) or set an explicit Float32 default consistent with the existing protocol.

`audioChunkCount` on the final `result` frame counts emitted audio segments. Known-`total` CustomVoice streams and open-ended Base streams both end with exactly one `result` frame.

Audio sample rate always comes from model output. Rust removes NaN/Inf values but does **not** peak-normalize. The renderer (`float32ChunksToWavBytes`) remains the sole peak-normalization owner for WAV/export.

## Cancellation and Lifecycle

- Electron cancellation terminates the resident bridge process when inference is inside a non-interruptible library call.
- Process termination drops the in-process model and releases MLX/LibTorch resources.
- The next request transparently starts a new bridge and reloads the model.
- Warm-up loads only an already-downloaded, validated model and never downloads weights.
- Idle eviction continues to stop the resident bridge after the configured timeout.
- Heartbeat diagnostics continue during blocking model load and inference so the host watchdog detects only genuine output inactivity.

### Warm-up by profile

| Profile | Warm command behavior |
| --- | --- |
| CustomVoice (with validated `baseModelPath`) | Load `TTSInference` from local files only; return `warmed: true` on success. Never download. |
| CustomVoice (missing path / incomplete dir) | `warmed: false` with an actionable message. |
| Base voice-clone | Return `warmed: false` with message that reference audio is required at generate time (same product contract as today). Do **not** claim a resident Base host from warm alone unless a future design explicitly preloads Base weights without reference codes — and even then document the distinction between “weights loaded” and “ICL-ready.” |
| Unsupported platform / non-Qwen | `warmed: false`. |

The renderer must not assume Base is resident after warm. CustomVoice warm is best-effort from the shared controller when the selected profile becomes usable.

## Error Handling

Errors must identify the failing boundary and remain actionable:

- unsupported platform/provider (including Intel Mac and non-Windows non-AS);
- missing or incompatible native runtime;
- incomplete, wrong-type, or mismatched model directory (including missing vocoder / tokenizer);
- unsupported language/speaker for the loaded model;
- invalid reference WAV/transcript;
- model load or generation failure;
- invalid/empty/silent audio output (reject placeholder silence as failure when vocoder path is misconfigured);
- cancellation;
- WebSocket protocol failure.

A failing generation returns one `ok:false` result when the bridge remains healthy. Fatal inference-provider corruption or cancellation allows Electron to replace the bridge process. Partial audio is discarded by the renderer on failure.

## Build and Packaging

- `build:rust` builds the single `open-tts-local-bridge` executable for the target platform.
- macOS packages the executable plus the one required `mlx.metallib` and only transitive native libraries referenced by the executable.
- Windows packages the release executable and the required LibTorch 2.7.1/CUDA 12.6 DLL closure. A clean Windows VM test verifies that no build-machine PATH entries are required.
- No Qwen development CLIs, trace tools, API server, or worker executables are copied.
- Desktop packaging fails if the target Qwen provider or required native resources are missing.
- The web production build still compiles, but does not expose or invoke Qwen runtime controls.

## Migration

1. **Spike (gate all later steps):** prove the pinned library is consumed **in-process via `TTSInference`** by the bridge on Apple Silicon and in a native Windows MSVC release build. Concrete acceptance for the spike only:
   - non-silent CustomVoice **and** non-silent Base on Apple Silicon MLX (0.6B profiles);
   - non-silent CustomVoice on Windows CUDA and on Windows CPU with the same package;
   - Windows loads the approved 0.6B CustomVoice and Base model directory layouts;
   - measured package size documented;
   - no use of `Qwen3TTSModel` in the spike path.
2. Introduce the pinned in-process runtime and contract tests while the old paths still compile (dual-compile adapter only after step 1).
3. Add the single renderer controller, platform-aware model profiles, and rename MLX IPC/download APIs to Qwen-generic ones with revision-pinned downloads.
4. Switch generation and warm-up to the in-process host (`baseModelPath` retained).
5. Validate CustomVoice and Base generation on Apple Silicon MLX (English + long Chinese; short Base reference).
6. Validate a packaged Windows CUDA run and the same package's CPU fallback on a GPU-less Windows machine.
7. Remove the Candle `qwen_tts` dependency, internal MLX process hosts, environment variables, API/CLI/worker protocols, build script, compatibility patch, and extra-resource copying only after both platform gates pass. Accept that Intel Mac / non-AS non-Windows Qwen is gone at this step.
8. Update product copy and project documentation (AGENTS.md / Claude.md local bridge protocol) to describe the single Rust backend, Float32-only Qwen frames, and the platform cut.

## Test Strategy

### Rust unit and contract tests

- Unicode-safe CJK, emoji, combining-character, long-word, URL, and punctuation splitting in `qwen3/text.rs`.
- Explicit tests that would panic upstream `chunk_text*` (byte-budget CJK) but pass Open TTS splitting.
- Every text unit respects its character budget and round-trips all non-whitespace content.
- Ten-language plus Auto normalization and model-derived validation.
- Speaker normalization (display → model key only in Rust).
- Platform profile/model-type validation; unsupported platform probe.
- Complete, incomplete, mismatched, and wrong-type single-weight model directories (including missing `speech_tokenizer/model.safetensors` and missing tokenizer files).
- Generation-control propagation into the `TTSInference` adapter (`temperature`, `top_k`, `max_codes`, instruct routing).
- Float32 framing only (no pcm16 for Qwen), sample-rate consistency, empty/silent audio rejection, and phase timing.
- Reference WAV validation and cache bounds.
- Warm-up: CustomVoice `warmed:true` from cache only; Base `warmed:false`; never downloads.

### Electron and renderer tests

- Qwen is Electron-only.
- Studio, Reader, and settings share one selected model and settings state.
- Model switches clear incompatible paths.
- Download manifests and readiness state match the selected profile; `/resolve/<revision>/` only.
- IPC rejects obsolete fields (`topP`, `deviceMap`, `dtype`, `attnImplementation`) and preserves supported controls including **`baseModelPath`** (not `modelPath`).
- Shared language list drives UI options and IPC allowlist together.
- Progress, audio, cancellation, stale-result suppression, and export remain correct.
- Probe reports MLX on Apple Silicon, CUDA/CPU resolution on Windows fixtures, and unavailable on Intel Mac / unsupported OS fixtures.
- Renamed Qwen download/setup IPC surface (no remaining public `*Mlx*` product API for Qwen).

### Build and smoke tests

- `npm run lint`.
- `npm run test`.
- `npm run build`.
- `npm run build:desktop` on Apple Silicon.
- Windows cross-platform compile in CI, plus native Windows CUDA and CPU smoke jobs.
- Windows release build uses MSVC and the pinned LibTorch 2.7.1/CUDA 12.6 runtime; debug/release mixing fails the build validation.
- Packaged Windows bridge starts on a clean VM without `LIBTORCH`, Python, Rust, or build-machine PATH configuration.
- Live Apple Silicon MLX CustomVoice generation with English and long Chinese input (non-silent).
- Live Apple Silicon MLX Base voice cloning with a short reference WAV (non-silent).
- Native Windows CUDA CustomVoice smoke test and Windows CPU fallback probe/generation smoke test (non-silent).

## Acceptance Criteria

- Electron communicates with exactly one Qwen process: `open-tts-local-bridge`.
- No Qwen HTTP server, CLI generator, or inner worker is launched.
- Generation uses `TTSInference` only; never silent `Qwen3TTSModel` placeholders.
- macOS Apple Silicon reports and uses MLX; Intel Mac and non-Windows non-AS report Qwen unavailable.
- Windows uses CUDA when available and CPU otherwise.
- CustomVoice and Base voice cloning generate playable non-silent audio through WebSocket **Float32** binary frames.
- Payload field `baseModelPath` remains the local directory field; obsolete fields are removed, not renamed.
- Long CJK input no longer crashes and produces all expected text units; Open TTS owns splitting.
- All ten official languages plus Auto are selectable; UI and IPC allowlists stay in sync; model validates final keys.
- Every displayed generation control affects inference; unsupported controls are absent.
- Model readiness rejects incomplete and mismatched directories (including missing vocoder/tokenizer).
- Studio, Reader, and settings cannot drift to different Qwen configurations.
- Only required native artifacts are packaged.
- Lint, all JS/Rust tests, web build, and available native desktop builds pass.

## Risks and Mitigations

- **Windows package size:** CUDA-enabled LibTorch is large. Keep 0.6B as default, copy only the DLL dependency closure, and measure the packaged result before release.
- **Windows path is not yet proven in this repository:** upstream describes LibTorch as cross-platform, but its detailed build recipe is Linux-focused. Require native Windows MSVC compile, model-load, CUDA, CPU-fallback, and clean-VM packaging evidence before claiming Windows support or removing the old implementation.
- **Upstream high-level API is stubbed:** bind only to `TTSInference`; treat `Qwen3TTSModel` as unusable until a pin replaces the placeholders. Gate upgrades with non-silent smoke tests.
- **Upstream `chunk_text` is byte-unsafe:** never call it; own splitting and test CJK/emoji/combining marks.
- **Intel Mac / non-AS product regression:** document in UI copy and probe messages; do not leave users on a dead Candle path.
- **Upstream instability:** pin an exact revision and gate upgrades behind contract and smoke suites.
- **MLX thread affinity:** initialize and execute MLX on the same resident bridge thread; do not move inference through an async worker pool.
- **Blocking cancellation:** retain process-level cancellation and transparent bridge restart.
- **Cross-provider output differences:** use provider-specific golden tolerances for structure/performance, not byte-identical audio.
- **Windows hardware diversity:** expose the resolved provider and retain CPU fallback; do not claim AMD/Intel GPU acceleration.
- **Missing vocoder looks like success:** reject directories without loadable `speech_tokenizer` weights so placeholder silence cannot pass readiness or generation success checks.

## Upstream Basis

- [Official Qwen3-TTS repository](https://github.com/QwenLM/Qwen3-TTS): supported model families, speakers, languages, and generation concepts.
- [Pinned Rust runtime fork](https://github.com/badlogic/qwen3_tts_rs/tree/288a716ce38a91c826dd67968c75d1dd4b0f07bc): the exact MLX/LibTorch library source proposed for both platform builds; working surface is `inference::TTSInference`, not `Qwen3TTSModel`.
- [Parent Rust runtime documentation](https://github.com/second-state/qwen3_tts_rs): LibTorch and MLX setup and backend scope; its detailed LibTorch recipe is Linux-oriented, which is why native Windows proof remains a release gate.
- [`tch-rs` setup documentation](https://github.com/LaurentMazare/tch-rs/blob/main/README.md): LibTorch version matching, Windows MSVC, and runtime-library requirements.
- Hugging Face repository revisions in the model table were resolved from each repository's Git `HEAD` on 2026-07-09 and are intentionally immutable build inputs.

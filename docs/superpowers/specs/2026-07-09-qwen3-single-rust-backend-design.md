# Qwen3 Single Rust Backend Design

## Summary

Replace the current Qwen3 implementation—which combines an in-process Candle path with three nested MLX subprocess paths—with one Electron-facing Rust backend. `open-tts-local-bridge` remains the only process and protocol endpoint used by Electron. It integrates a pinned revision of `qwen3_tts_rs` directly as a Rust library and compiles that library with the fastest platform provider:

- Apple Silicon macOS: MLX with Metal acceleration and 6-bit MLX model profiles.
- Windows: LibTorch with CUDA when available and CPU fallback from the same Windows runtime.

“One backend” means one product runtime, one Rust inference API, one model/cache contract, and one Electron protocol. MLX and LibTorch are compile-time tensor providers, not independently orchestrated product backends.

## Goals

- Make Qwen3 an Electron-only feature with no browser runtime or server dependency.
- Use a single resident `open-tts-local-bridge` process for Qwen3 inference.
- Preserve Apple Silicon MLX performance.
- Support Windows NVIDIA CUDA and Windows CPU fallback.
- Support CustomVoice and Base voice cloning through the same Rust runtime abstraction.
- Support all ten Qwen3 languages advertised by the model configuration: Auto, Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, and Italian.
- Preserve Float32 renderer audio, model-provided sample rates, WebSocket binary transport, cancellation, warm-up, and resident model reuse.
- Make long and multilingual text splitting Unicode-safe.
- Ensure every displayed generation control changes generation behavior.
- Make model downloads, validation, build inputs, and packaged native artifacts deterministic.
- Remove obsolete MLX HTTP, CLI, worker, patch, and packaging code.

## Non-goals

- Qwen3 inference in the browser build.
- DirectML support for AMD or Intel Windows GPUs in this change.
- Loading two Qwen3 models concurrently.
- Token-level CustomVoice streaming if the selected Rust library API only returns complete text-unit audio.
- Supporting arbitrary user-supplied Hugging Face repositories outside the approved Qwen3 model profiles.
- Keeping compatibility with the internal MLX API-server, `tts`, or `pibot-tts-worker` protocols.

## Architecture

```text
Electron renderer
  -> trusted IPC
Electron main process
  -> authenticated loopback WebSocket
open-tts-local-bridge (single resident Rust process)
  -> Qwen3Runtime (single product API)
     -> qwen3_tts_rs + MLX on macOS arm64
     -> qwen3_tts_rs + LibTorch on Windows
  -> WebSocket audio metadata + binary PCM frames
Electron main process
  -> normalized Float32 audio events
Renderer audio player/export pipeline
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
- Select `Device::Gpu(0)` only when LibTorch reports CUDA available; otherwise select `Device::Cpu`.
- Default to the official `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` profile.
- Use official Base model weights for voice cloning.
- Bundle the required LibTorch native DLLs. A CUDA-enabled distribution may use CPU fallback, accepting a larger Windows package to avoid separate product backends.
- Report the resolved `cuda` or `cpu` provider in probe and generation results.

Unsupported operating systems return an explicit Qwen3-unavailable probe result until a platform package is designed and tested. Existing browser Kokoro and Supertonic behavior is unchanged.

## Dependency Ownership

- Pin `qwen3_tts_rs` to an exact Git revision in Cargo metadata. Floating branches are forbidden.
- Use the same revision for macOS and Windows builds.
- Remove the ignored `rust/qwen3_tts_rs` build checkout from the normal product build.
- Delete `scripts/build-qwen3-mlx-worker.mjs` and `patches/qwen3_tts_rs/mlx-api-current-thread.patch` after the in-process integration passes platform tests.
- Record the pinned upstream revision in probe metadata and build diagnostics.
- Upgrade the revision only in a dedicated change that runs the complete Qwen3 contract and platform smoke suites.

## Rust Module Boundaries

Move Qwen3 responsibilities out of `rust/local-tts-bridge/src/main.rs`:

- `qwen3/mod.rs`: public bridge-facing runtime API, host selection, warm-up, and generation routing.
- `qwen3/config.rs`: model profiles, supported modes, languages, controls, provider selection, and payload validation.
- `qwen3/text.rs`: Unicode-safe text-unit splitting and punctuation boundaries.
- `qwen3/model_files.rs`: local directory inspection and model-type/required-file validation.
- `qwen3/runtime.rs`: pinned `qwen3_tts_rs` adapter, resident host keys, CustomVoice, Base voice cloning, and tensor-to-audio conversion.
- `qwen3/reference.rs`: validated reference WAV decoding, normalization/resampling requirements, digesting, and bounded cache cleanup.

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

Electron owns the TypeScript Qwen model/profile contract. Renderer options and IPC validation consume the same pure configuration module, preventing model, language, and control allowlists from drifting.

## Model Profiles and Files

Each approved profile declares:

- repository ID;
- model type: `custom_voice` or `base`;
- parameter size and quality label;
- supported platforms/providers;
- expected weight format;
- required root files;
- required `speech_tokenizer` files;
- default speaker/language/control values.

The downloader writes a manifest containing repository ID, resolved Hub revision, file names, and expected sizes. A directory is ready only when:

- `config.json` parses;
- `tts_model_type` matches the selected profile;
- tokenizer/config files required by the runtime exist;
- the main weight file or every shard referenced by its index exists and is non-empty;
- required `speech_tokenizer` weights/config exist and are non-empty;
- the downloaded manifest matches the selected repository and all expected sizes.

Manually chosen directories receive the same structural and model-type validation, without requiring an app-generated download manifest.

Changing model profiles clears an incompatible directory. A directory is retained only if validation proves it matches the new profile.

## Generation Contract

The Electron-to-bridge payload remains camelCase and contains:

- `text`;
- `mode`: `customVoice` or `voiceClone`;
- `modelRepo` and validated `modelPath`;
- `speaker`, `language`, optional `instruct`;
- voice-clone reference WAV and exact transcript when in Base mode;
- `temperature`, `topK`, and `maxNewTokens`.

Remove `deviceMap`, `dtype`, `attnImplementation`, and `topP` from the user-facing Qwen contract:

- provider/device/dtype are selected by the packaged platform runtime, not by an end user;
- the chosen `qwen3_tts_rs` inference API does not implement top-p consistently across MLX and LibTorch, so presenting it would be misleading;
- attention implementation is a build/runtime capability rather than a portable request option.

Every remaining control is passed into both CustomVoice and Base generation. Values are clamped and validated at IPC and Rust boundaries.

## Language and Speaker Contract

The renderer and IPC expose the nine documented CustomVoice speakers with display capitalization. Rust lowercases only when resolving model speaker keys.

The runtime accepts all ten official language names plus Auto and normalizes them to lowercase model keys. Before generation, the selected language must exist in the loaded model's `codec_language_id`. Validation is model-derived rather than maintained as an unrelated hard-coded subset.

Dialect speaker behavior remains owned by the model configuration.

## Text Splitting and Streaming

Text splitting operates on Unicode scalar values and never slices UTF-8 at arbitrary byte offsets.

- Prefer sentence and clause boundaries.
- Use a smaller first unit to reduce first-audio latency.
- Enforce a character budget even for text without whitespace, including CJK and long URLs.
- Preserve punctuation and never drop non-whitespace input.
- Reject empty post-split output.

CustomVoice generates one text unit at a time and emits each completed unit as an audio chunk with known `total`. This is text-unit streaming, not token streaming.

Base voice cloning uses the library's streaming callback when supported and emits `total: 0` until the final chunk count is known. Otherwise it uses the same bounded transport chunking as CustomVoice.

Audio sample rate always comes from model output. Rust removes NaN/Inf values but does not peak-normalize. The renderer remains responsible for WAV peak handling.

## Cancellation and Lifecycle

- Electron cancellation terminates the resident bridge process when inference is inside a non-interruptible library call.
- Process termination drops the in-process model and releases MLX/LibTorch resources.
- The next request transparently starts a new bridge and reloads the model.
- Warm-up loads only an already-downloaded, validated model and never downloads weights.
- Idle eviction continues to stop the resident bridge after the configured timeout.
- Heartbeat diagnostics continue during blocking model load and inference so the host watchdog detects only genuine output inactivity.

## Error Handling

Errors must identify the failing boundary and remain actionable:

- unsupported platform/provider;
- missing or incompatible native runtime;
- incomplete, wrong-type, or mismatched model directory;
- unsupported language/speaker for the loaded model;
- invalid reference WAV/transcript;
- model load or generation failure;
- invalid/empty audio output;
- cancellation;
- WebSocket protocol failure.

A failing generation returns one `ok:false` result when the bridge remains healthy. Fatal inference-provider corruption or cancellation allows Electron to replace the bridge process. Partial audio is discarded by the renderer on failure.

## Build and Packaging

- `build:rust` builds the single `open-tts-local-bridge` executable for the target platform.
- macOS packages the executable plus the one required `mlx.metallib` and only transitive native libraries referenced by the executable.
- Windows packages the executable and required LibTorch/CUDA DLL closure.
- No Qwen development CLIs, trace tools, API server, or worker executables are copied.
- Desktop packaging fails if the target Qwen provider or required native resources are missing.
- The web production build still compiles, but does not contain or expose Qwen runtime controls.

## Migration

1. Introduce the pinned in-process runtime and contract tests while the old paths still compile.
2. Add the single renderer controller and platform-aware model profiles.
3. Switch generation and warm-up to the in-process host.
4. Validate CustomVoice and Base generation on Apple Silicon MLX.
5. Add Windows LibTorch build and device-selection coverage.
6. Remove the Candle `qwen_tts` dependency, internal MLX process hosts, environment variables, API/CLI/worker protocols, build script, compatibility patch, and extra-resource copying.
7. Update product copy and project documentation to describe the single Rust backend.

The worker protocol between Electron and `open-tts-local-bridge` remains unchanged except for removal of obsolete Qwen payload fields. Audio stays WebSocket-binary only.

## Test Strategy

### Rust unit and contract tests

- Unicode-safe CJK, emoji, combining-character, long-word, URL, and punctuation splitting.
- Every text unit respects its character budget and round-trips all non-whitespace content.
- Ten-language normalization and model-derived validation.
- Speaker normalization.
- Platform profile/model-type validation.
- Complete, sharded, incomplete, mismatched, and wrong-type model directories.
- Generation-control propagation into the runtime adapter.
- Float32/PCM framing, sample-rate consistency, empty audio rejection, and phase timing.
- Reference WAV validation and cache bounds.

### Electron and renderer tests

- Qwen is Electron-only.
- Studio, Reader, and settings share one selected model and settings state.
- Model switches clear incompatible paths.
- Download manifests and readiness state match the selected profile.
- IPC rejects obsolete/unsupported fields and preserves supported controls.
- Progress, audio, cancellation, stale-result suppression, and export remain correct.
- Probe reports MLX on Apple Silicon and CUDA/CPU resolution on Windows fixtures.

### Build and smoke tests

- `npm run lint`.
- `npm run test`.
- `npm run build`.
- `npm run build:desktop` on Apple Silicon.
- Windows cross-platform compile in CI, plus native Windows CUDA and CPU smoke jobs.
- Live Apple Silicon MLX CustomVoice generation with English and long Chinese input.
- Live Apple Silicon MLX Base voice cloning with a short reference WAV.
- Native Windows CUDA CustomVoice smoke test and Windows CPU fallback probe/generation smoke test.

## Acceptance Criteria

- Electron communicates with exactly one Qwen process: `open-tts-local-bridge`.
- No Qwen HTTP server, CLI generator, or inner worker is launched.
- macOS Apple Silicon reports and uses MLX.
- Windows uses CUDA when available and CPU otherwise.
- CustomVoice and Base voice cloning generate playable audio through the existing WebSocket binary protocol.
- Long CJK input no longer crashes and produces all expected text units.
- All ten official languages are selectable and validated against the loaded model.
- Every displayed generation control affects inference; unsupported controls are absent.
- Model readiness rejects incomplete and mismatched directories.
- Studio, Reader, and settings cannot drift to different Qwen configurations.
- Only required native artifacts are packaged.
- Lint, all JS/Rust tests, web build, and available native desktop builds pass.

## Risks and Mitigations

- **Windows package size:** CUDA-enabled LibTorch is large. Keep 0.6B as default, copy only the DLL dependency closure, and measure the packaged result before release.
- **Upstream instability:** pin an exact revision and gate upgrades behind contract and smoke suites.
- **MLX thread affinity:** initialize and execute MLX on the same resident bridge thread; do not move inference through an async worker pool.
- **Blocking cancellation:** retain process-level cancellation and transparent bridge restart.
- **Cross-provider output differences:** use provider-specific golden tolerances for structure/performance, not byte-identical audio.
- **Windows hardware diversity:** expose the resolved provider and retain CPU fallback; do not claim AMD/Intel GPU acceleration.

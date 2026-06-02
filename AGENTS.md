# AGENTS.md — Open TTS WebGPU + Local Runtimes

## Project Goal
Build and maintain a browser-native, fully local text-to-speech app with two core browser models:
- Kokoro-82M via `kokoro-js`
- Supertonic via `@huggingface/transformers`

Inference runs client-side (WebGPU with fallback behavior), with optional Electron packaging from the same codebase.
Electron also exposes optional local Python-runtime integrations for NeuTTS Nano, Kani-TTS-2, and Qwen3-TTS.

## Stack
- React 19 + TypeScript 5.9 + Vite 7
- Tailwind CSS 4
- `@huggingface/transformers` (Supertonic pipeline)
- `kokoro-js` (Kokoro generation)
- Electron 42.3.0 (desktop wrapper)
- Python local bridge (`python/local_tts_bridge.py`) for Electron local-runtime models
- Vitest + Testing Library + jsdom

## Commands
```sh
npm run dev            # Web app on localhost:5173
npm run dev:web        # Explicit web app on localhost:5173
npm run dev:desktop    # Vite + Electron together
npm run dev:electron   # Alias for dev:desktop
npm run build          # Type check + production web build
npm run build:web      # Explicit production web build
npm run build:desktop  # Build web + compile Electron main/preload
npm run build:electron # Alias for build:desktop
npm run dist           # Build + package desktop app via electron-builder
npm run test           # Run tests once
npm run test:watch     # Watch tests
npm run lint           # ESLint
```

## Source Map
```txt
electron/
  main.ts              # BrowserWindow + WebGPU switches + dev/prod loading
  preload.ts           # Minimal contextBridge exposure

src/
  index.css            # Tailwind + design tokens
  types.ts             # Worker protocol + shared app types
  constants.ts         # Model IDs/voices/ranges/defaults/example text

  apps/
    web/               # Browser shell + entrypoint; routes /studio and /reader
    desktop/           # Electron renderer shell + entrypoint; routes /desktop/*
  shared/
    SynthesisApp.tsx   # Shared orchestration for model loading, generation, UI state
    SynthesisApp.test.tsx

  hooks/
    useModelLoader.ts  # Creates workers, loads selected model lazily
    useTTS.ts          # Sends GENERATE/CANCEL, tracks generation stats
    useAudioPlayer.ts  # Web Audio playback, seek, download

  workers/
    kokoro.worker.ts     # Kokoro model load/generate/cancel
    supertonic.worker.ts # Supertonic model load/generate/cancel
    export.worker.ts     # Off-thread audio export (WAV/MP3 + mastering)

  lib/
    splitter.ts        # Sentence splitting with abbreviation/URL handling
    chunking.ts        # Supertonic text chunking + retry chunking
    audio.ts           # WAV header + Float32 WAV blob helpers
    audioOutput.ts     # Raw model output normalization
    textTuning.ts      # Pronunciation rules, emphasis, pause/speed tuning
    voices.ts          # Kokoro voice fallback/selection helpers
    exportAudio.ts     # Export pipeline (WAV/MP3 + mastering)
    captions.ts        # SRT/VTT/JSON caption builders
    persistentCache.ts # IndexedDB-backed Cache API fallback
    modelCache.ts      # Cache listing + model cache clearing

  components/
    TextInput.tsx
    ModelToggle.tsx
    VoiceSelector.tsx
    Controls.tsx
    AudioPlayer.tsx
    DownloadProgress.tsx
    AdvancedReaderPage.tsx
    LocalRuntimePage.tsx

python/
  local_tts_bridge.py # Electron local-runtime probe/serve-ws bridge
```

Desktop host helpers live in `electron/` (e.g. `webSocketBridgeWorker.ts` for the resident WebSocket worker pool shared by all three local runtimes, `generateRateLimiter.ts`).

## Runtime Contracts (Do Not Break)

### Worker protocol
Defined in `src/types.ts`:
- Main thread -> worker: `LOAD`, `GENERATE`, `CANCEL`
- Worker -> main thread: `LOAD_PROGRESS`, `READY`, `AUDIO_CHUNK`, `GENERATION_COMPLETE`, `ERROR`

If you add fields/events, update both workers and all hook/component consumers.

### Local bridge protocol
`python/local_tts_bridge.py` has exactly two `--action` values: `probe` and `serve-ws`. The legacy stdin `serve()` worker and the one-shot `generate` action are removed; generation is WebSocket-only with no stdout/base64 fallback.
- Action `probe` is the only one-shot subprocess call, over stdin/stdout. Results and progress use stdout lines prefixed `__PROGRESS__` and `__RESULT__` (JSON after the prefix), keeping bridge messages separable from library noise. `emit`/`emit_progress` target the real stdout (`_REAL_STDOUT`), captured before any `redirect_stdout_to_stderr()` swap.
- Action `serve-ws` is the resident generation worker for **all three** local runtimes (NeuTTS, Kani, Qwen3). Electron spawns `--action serve-ws --model <m> --cache-dir <dir> --host 127.0.0.1 --port <p>`, then request/progress/result metadata travels over WebSocket JSON frames and audio travels over binary Float32 frames. There is no stdout result fallback and no base64 audio payload for this path; `serve-ws` emits nothing via `__PROGRESS__`/`__RESULT__` (progress routes through the module-global `_PROGRESS_SINK` to the socket).
- `serve-ws` loads the model once and reads WebSocket requests `{"requestId", "payload"}` (or `{"command":"shutdown"}`). Per request it emits zero or more `progress` frames, then for each audio segment an `audio_chunk` TEXT frame `{index,total,sampleRate,sampleCount,silenceAfterSamples}` immediately followed by one binary Float32 frame of exactly `sampleCount*4` bytes, then exactly one `result` frame. The `result` carries `{sampleRate, modelRepo, durationSec, elapsedSec, audioTransport:"websocket-binary", audioChunkCount, phaseTimingsSec, ...}` and no `wavBase64`. A failing request reports `ok:false` but keeps the worker alive.
- `make_model_host(model)` builds the right resident host for the worker's `--model`, and a per-model dispatch routes generation:
  - `Qwen3ModelHost` keyed by (repo, device, dtype, attention) — text is chunked and streamed one binary frame per chunk.
  - `NeuttsModelHost` keyed by (backbone_repo, codec_repo, backbone_device, codec_device). The reference audio/text/text vary per request, so `encode_reference`/`infer` run fresh every request — reference codes are NOT cached on the host.
  - `KaniModelHost` keyed by (model_repo, device_map, max_new_tokens). `max_new_tokens` is a `KaniTTS` constructor arg, so changing it forces a reload; `language_tag`/`temperature`/`top_p`/`repetition_penalty` vary per request and stay out of the key.
  Each host reloads only when its key changes, releasing the previous model first.
- NeuTTS/Kani inference stays byte-identical to the prior one-shot path: whole-text generation (no sentence chunking), a single `audio_chunk` (index 0, total 1, `silenceAfterSamples 0`) per request, same `encode_reference`/`infer` (NeuTTS) and `KaniTTS(...)`/`.generate()` (Kani) calls. `durationSec` is computed from the streamed sample count.
- `audio_to_float32_bytes` is the single binary serializer for all three models — it ships raw Float32 (only `nan_to_num`, no normalization). The renderer's `float32ChunksToWavBytes` (`src/components/localRuntime/utils.ts`) owns peak-normalization (`peak>1` → scale → int16), reproducing what the old base64 WAV path did, so binary output is byte-equivalent after renderer encoding. Do not add normalization to the Python serializer.
- Latency: `serve-ws` sets `TCP_NODELAY` on the accepted loopback socket (best-effort, try/except) to disable Nagle, uses the literal `127.0.0.1` (never `localhost`, to skip DNS/IPv6 fallback), and keeps resident hosts warm so repeat generations are inference-only.
- Host side: `electron/webSocketBridgeWorker.ts` owns the worker pool (process lifecycle, WebSocket connection/retry, progress routing, per-request stall watchdog, output caps, cancellation, idle eviction). It uses the Node global `WebSocket` (no `ws` dependency) and pure stdlib loopback sockets on the Python side, so the transport works on macOS, Windows, and Linux. It is injected with `spawn` and unit-tested without Electron. Generation is serialized per model by `generateRateLimiter`, so a resident model is never entered concurrently. The one-shot `probe` subprocess path stays separate.
- Cached loads force Hugging Face offline mode (`qwen3_snapshot_present` → `huggingface_offline`) so a cached generation makes no network request; first-run downloads and incomplete caches fall back to online.

### Audio path
- Playback is Web Audio API based (`AudioContext` + `AudioBufferSourceNode`), not `<audio>`.
- Audio chunks are `Float32Array`.
- WAV export is IEEE Float 32-bit PCM (`AudioFormat = 3`) via `src/lib/audio.ts`.
- Sampling rate must come from model output; never hardcode it.

### Local runtime product policy
- Treat Electron local runtimes as product features for arbitrary user machines, not dev-machine fixes.
- Detect the user's OS, accelerator, Python compatibility, and installed packages before choosing setup steps or defaults.
- Managed setup should install the runtime build that matches the detected device class (CUDA, Apple MPS, or CPU) and should repair incompatible managed envs instead of surfacing raw package errors.
- Model defaults should prioritize fastest practical generation for the detected device; larger/slower models should remain explicit quality choices.
- Probe warnings must describe the detected runtime profile and the app's selected fallback, not assume CUDA-only hardware.

### Model specifics
- Kokoro:
  - Worker builds inference units via the shared `buildKokoroInferenceUnits()` helper in `lib/chunking.ts` (sentences merged up to a per-backend character budget) and calls `KokoroTTS.generate(string, ...)` per unit. `tts.stream()` is not used.
  - The reader preview (`chunkTextForModelDetailed`) reuses the same builder so the editor's section boundaries match the segments generation emits; keep them in sync if you change the merge logic.
  - `list_voices()` may not always return an array; fallback voices are required.
- Supertonic:
  - Uses transformers text-to-speech pipeline in worker.
  - Aggregates file download progress dynamically (no hardcoded file count assumptions).
  - Text is chunked with min/max character constraints and 0.5s silence padding between chunks.

### Loading strategy
`useModelLoader` initializes workers on startup and loads models lazily when selected. Keep this behavior unless explicitly changing product requirements.

## TypeScript Notes
- Project is strict (`strict`, `noUnusedLocals`, `noUnusedParameters`, etc.).
- Typed array interoperability can require explicit copies/casts (`Float32Array<ArrayBufferLike>` vs `Float32Array<ArrayBuffer>`), especially around Web Audio and Blob/WAV assembly.
- Prefer `@ts-expect-error` over `@ts-ignore` if suppression is necessary.

## Testing
- Tests live beside source as `*.test.ts` and `*.test.tsx`.
- Vitest config: `vitest.config.ts`.
- Setup file: `src/test-setup.ts`.
- jsdom limitations apply; test WAV structure through helpers (for example `buildWavHeader`) rather than browser-only Blob APIs when needed.

## UI/Styling Constraints
- Design tokens live in `src/index.css` (`@theme` variables).
- Design direction is **Liquid Glass** (Apple): translucent blurred surfaces with specular edges over an ambient color field. Reuse the `.glass*` utility classes and `shadow-glass-*` tokens in `src/index.css` rather than inventing new effects.
- The `.glass*` classes are unlayered (win over Tailwind utilities) — use them only on static containers; build stateful/interactive controls from Tailwind utilities (`backdrop-blur-md`, translucent `bg-white/40`, `shadow-glass-sm`).
- Electron (macOS) relies on native `vibrancy` + transparent window + `hiddenInset` title bar; keep the `is-electron`/`is-mac` `<html>` classes and their CSS scoping intact.

## Agent Workflow Expectations
- Before large refactors, inspect `src/types.ts`, `src/hooks/*`, and both worker files to preserve protocol compatibility.
- For behavior changes, run:
  1. `npm run lint`
  2. `npm run test`
  3. `npm run build`
- Keep changes scoped and avoid introducing server-side dependencies; this app is designed for local on-device inference.

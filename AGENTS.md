# AGENTS.md — Open TTS WebGPU + Local Runtimes

## Project Goal
Build and maintain a browser-native, fully local text-to-speech app with two core browser models:
- Kokoro-82M via `kokoro-js`
- Supertonic via `@huggingface/transformers`

Inference runs client-side (WebGPU with fallback behavior), with optional Electron packaging from the same codebase.
Electron also exposes optional local-runtime integrations for NeuTTS Nano and Qwen3-TTS through a Rust bridge.

## Stack
- React 19 + TypeScript 5.9 + Vite 7
- Tailwind CSS 4
- `@huggingface/transformers` (Supertonic pipeline)
- `kokoro-js` (Kokoro generation)
- Electron 42.3.0 (desktop wrapper)
- Rust local bridge (`rust/local-tts-bridge`) for Electron probe/WebSocket transport and local model execution
- Vitest + Testing Library + jsdom

## Commands
```sh
npm run dev            # Web app on localhost:5173
npm run dev:web        # Explicit web app on localhost:5173
npm run dev:desktop    # Vite + Electron together
npm run dev:electron   # Alias for dev:desktop
npm run build          # Type check + production web build
npm run build:web      # Explicit production web build
npm run build:rust     # Build and copy Rust local bridge to dist-rust/
npm run build:desktop  # Build web + Rust bridge + compile Electron main/preload
npm run build:electron # Alias for build:desktop
npm run dist           # Build + package desktop app via electron-builder
npm run test           # Run Vitest + Rust bridge tests once
npm run test:js        # Run Vitest once
npm run test:rust      # Run Rust bridge tests once
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

rust/
  local-tts-bridge/   # Rust probe/WebSocket bridge and local model runtime binary
```

Desktop host helpers live in `electron/` (e.g. `webSocketBridgeWorker.ts` for the resident WebSocket worker pool shared by local runtimes, `qwen3MlxDownload.ts` for Qwen3 MLX model downloads, `generateRateLimiter.ts`).

## Runtime Contracts (Do Not Break)

### Worker protocol
Defined in `src/types.ts`:
- Main thread -> worker: `LOAD`, `GENERATE`, `CANCEL`
- Worker -> main thread: `LOAD_PROGRESS`, `READY`, `AUDIO_CHUNK`, `GENERATION_COMPLETE`, `ERROR`

If you add fields/events, update both workers and all hook/component consumers.

### Local bridge protocol
`open-tts-local-bridge` has exactly two `--action` values: `probe` and `serve-ws`. Electron launches it directly; there are no interpreter, adapter-script, or one-shot `generate` arguments. Generation is WebSocket-only with no stdout/base64 fallback.
- Action `probe` is the only one-shot subprocess call. It returns an Electron-facing `__RESULT__` envelope with Rust runtime metadata.
- Action `serve-ws` is the resident generation worker for NeuTTS and Qwen3. Electron spawns `open-tts-local-bridge --action serve-ws --model <m> --cache-dir <dir> --host 127.0.0.1 --port 0 --auth-token <token>`, waits for the Rust `__PORT__<actual-port>` stdout announcement, then connects to `ws://127.0.0.1:<actual-port>/<token>`. Request/progress/result metadata travels over WebSocket JSON frames and audio travels over binary frames — Float32 by default, or raw Int16 PCM when the chunk metadata carries `encoding:"pcm16"` (used by the Qwen3 MLX api_server and voice-clone worker relays; halves audio transport bytes). There is no stdout result fallback and no base64 audio payload for this path.
- Rust owns the WebSocket server through `tungstenite`, plus TCP socket options, request loop, model loading, inference, Float32 serialization, and binary frame relay.
- `serve-ws` reads WebSocket requests `{"requestId", "payload"}` (or `{"command":"shutdown"}` or `{"command":"warm", "requestId", "payload"}`). Per request it emits zero or more `progress` frames, then for each audio segment an `audio_chunk` TEXT frame `{index,total,sampleRate,sampleCount,silenceAfterSamples[,encoding]}` immediately followed by one binary frame of exactly `sampleCount*4` bytes (Float32, the default) or `sampleCount*2` bytes when `encoding:"pcm16"` (Int16 PCM; the host worker converts to Float32 before delivering to the renderer), then exactly one `result` frame. The `result` carries `{sampleRate, modelRepo, durationSec, elapsedSec, audioTransport:"websocket-binary", audioChunkCount, phaseTimingsSec, ...}` and no `wavBase64`. A failing request reports `ok:false` but keeps the worker alive. Client disconnect during send is non-fatal: the bridge closes that connection and keeps the resident server loop running.
- The Rust bridge owns model host reuse. Qwen3 is MLX-first on macOS: the UI defaults to the upstream 0.6B CustomVoice 6-bit MLX profile and exposes Electron setup metadata plus a native model-directory picker. Qwen3 MLX CustomVoice prefers the resident upstream `api_server` when `OPEN_TTS_QWEN3_MLX_API_SERVER` is available (SSE PCM deltas relayed as multiple `pcm16` WebSocket chunks with `total: 0` until the final `audioChunkCount`; a failed request evicts the server, and if no audio was sent yet the bridge respawns it and retries once before erroring; SSE reads use a 10-minute inactivity deadline before the first audio delta and a 2-minute deadline mid-stream); otherwise it falls back to the one-shot upstream `tts` CLI per text unit inside the bridge process, reading each `output.wav` and relaying it over the normal WebSocket binary path. Neither MLX CustomVoice path requires reference audio. Qwen3 Candle CustomVoice is keyed by (repo, device, dtype, attention). Qwen3 Base voice cloning keeps the upstream MLX `pibot-tts-worker` resident by model directory, reference WAV digest, reference transcript, language, output sample rate, block size, streaming chunk size, top-k, temperature, and max-new-token settings. NeuTTS is keyed by model repo and accepts pre-encoded `.npy` reference codes or a WAV clip (encoded in-bridge via NeuCodec on first use).
- Qwen3 speaker names are capitalized in the UI/IPC (display names) but the model's `spk_id` keys are lowercase and `qwen_tts` validation is case-sensitive, so the Rust bridge lowercases the speaker (`qwen3_speaker_id`) before generation. Do not lowercase in the IPC/frontend layer — keep display names there.
- Qwen3 Candle CustomVoice uses the `qwen_tts` backend and streams at text-unit granularity: the bridge splits longer text into sentence-sized units, calls `generate_custom_voice_from_text()` per unit, and emits each completed unit as a WebSocket audio chunk with a known `total` and 0.2s trailing silence between units. This is not token-level model streaming; a single short unit still blocks until its inference finishes. Qwen3 MLX CustomVoice via `api_server` streams SSE PCM deltas as multiple chunks (`total: 0`); the `tts` CLI fallback emits one chunk per text unit with a known `total`. Base voice-clone streaming also uses `total: 0` while chunks arrive.
- NeuTTS inference is whole-text generation (no sentence chunking). Short outputs stream as a single `audio_chunk` (`index 0`, known `total`, `silenceAfterSamples 0`); very long outputs may be split at transport time when buffered sample count exceeds the bridge chunk cap.
- Rust Float32 serialization ships raw Float32 with only NaN/Inf cleanup and no normalization. The renderer's `float32ChunksToWavBytes` (`src/components/localRuntime/utils.ts`) owns peak-normalization (`peak>1` → scale → int16). Do not add normalization to the Rust serializer or relay.
- Latency: the Rust bridge sets `TCP_NODELAY` on the accepted loopback socket (best-effort) to disable Nagle, uses the literal `127.0.0.1` (never `localhost`, to skip DNS/IPv6 fallback), and keeps resident hosts warm so repeat generations are inference-only.
- Warm-up (`{"command":"warm"}`): with no `modelRepo` (or an MLX CustomVoice repo) it pre-starts the resident MLX api_server; with a Candle CustomVoice repo it pre-loads the in-process Candle model, but only from already-downloaded HF cache files (warm-up must never trigger a download). Base voice-clone repos return `warmed:false` (the worker needs reference audio at spawn). The renderer fires warm best-effort from `useQwen3LocalRuntime`/`LocalRuntimePage` when the selected profile becomes usable.
- Host side: `electron/webSocketBridgeWorker.ts` owns the worker pool (process lifecycle, authenticated WebSocket connection/retry, progress routing, per-request stall watchdog, diagnostic stdout/stderr caps, cancellation, idle eviction). Before `SIGTERM`/`SIGKILL`, the host sends `{"command":"shutdown"}` on the open WebSocket when possible so the bridge can drop resident MLX children cleanly. The stall watchdog re-arms on any child stdout/stderr or socket frame; because model download and CPU inference are single blocking calls, the Rust bridge emits a periodic stderr heartbeat for the duration of each request so the watchdog only fires on a genuinely silent (stuck) worker; since the heartbeat masks a wedged child from the host, the bridge enforces its own 10-minute output-inactivity deadline on resident MLX worker/api_server reads. MLX grandchildren are spawned in their own process groups and reaped on bridge `Drop`, `shutdown`, or `SIGTERM`/`SIGINT`. It uses the Node global `WebSocket` (no `ws` dependency), and generation is serialized per model by `generateRateLimiter`, so a resident model is never entered concurrently. The one-shot `probe` subprocess path stays separate.
- Model caches live under the per-model app data cache. First-run downloads are expected; cached runs reuse those files.

### Audio path
- Playback is Web Audio API based (`AudioContext` + `AudioBufferSourceNode`), not `<audio>`.
- Audio chunks are `Float32Array`.
- Playback scheduling, export history, and download/caption data stay ref-backed and immediate; only rendered stats/progress and segment/timeline UI state are coalesced to the next UI frame to avoid per-chunk React render pressure.
- WAV export is IEEE Float 32-bit PCM (`AudioFormat = 3`) via `src/lib/audio.ts`.
- Sampling rate must come from model output; never hardcode it.

### Local runtime product policy
- Treat Electron local runtimes as product features for arbitrary user machines, not dev-machine fixes.
- Model defaults should prioritize fastest practical generation for the supported Rust runtime profile; larger/slower models should remain explicit quality choices.
- Probe warnings must describe the Rust runtime profile and selected fallback.

### Model specifics
- Kokoro:
  - Worker builds inference units via the shared `buildKokoroInferenceUnits()` helper in `lib/chunking.ts` (sentences merged up to a per-backend character budget) and calls `KokoroTTS.generate(string, ...)` per unit. `tts.stream()` is not used.
  - The reader preview (`chunkTextForModelDetailed`) reuses the same builder so the editor's section boundaries match the segments generation emits; keep them in sync if you change the merge logic.
  - `list_voices()` may not always return an array; fallback voices are required.
  - WebGPU loads run one small warmup generation before `READY`; forced reload disposes the previous model if kokoro-js exposes `dispose()`. WASM fallback configures a safe multi-thread count through the kokoro-js bundle transform in `vite.kokoroAssets.ts`.
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

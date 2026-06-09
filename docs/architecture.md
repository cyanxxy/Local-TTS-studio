# Architecture

This document keeps maintainer-facing architecture details out of the top-level README.

## Tech Stack

- React 19 + TypeScript 5.9 in strict mode + Vite 7 + Tailwind CSS 4
- `@huggingface/transformers` v4 for the Supertonic TTS pipeline
- `kokoro-js` v1 for Kokoro-82M generation with custom phonemization
- Electron 42.3.0 for the optional desktop wrapper
- Rust local bridge for Electron probe/WebSocket transport
- Vitest 3 + Testing Library + jsdom for tests
- `lucide-react` for icons

## Source Map

```text
electron/        Desktop shell, custom protocol, preload bridge, runtime helpers
rust/            Rust local bridge for Electron probe/WebSocket transport
src/
|-- apps/
|   |-- web/      Browser renderer shell and entrypoint
|   `-- desktop/  Electron renderer shell and entrypoint
|-- shared/      Shared synthesis app orchestration and tests
|-- components/  Studio, Reader, player, settings, local-runtime UI
|-- hooks/       Model loading, playback, generation, routing, creator state
|-- lib/         Audio, chunking, captions, cache, browser/runtime helpers
|-- workers/     Kokoro + Supertonic inference workers and the audio export worker
`-- types.ts     Worker protocol and shared UI types
```

## Worker Protocol

The browser inference path is a strict message contract between the main thread and Web Workers. The canonical TypeScript definitions live in `src/types.ts`.

```text
Main -> Worker:  LOAD, GENERATE, CANCEL
Worker -> Main:  LOAD_PROGRESS, READY, AUDIO_CHUNK, GENERATION_COMPLETE, ERROR
```

Workers are created at startup and load models lazily on selection.

## Browser Audio Path

This contract applies to Studio, Reader, and Electron local-runtime playback. Browser models stream chunks from Web Workers; Electron local-runtime pages (NeuTTS and Qwen3) generate through the resident Rust WebSocket bridge worker (`electron/webSocketBridgeWorker.ts` driving `open-tts-local-bridge --action serve-ws`), which streams binary Float32 audio chunks that the renderer schedules through the same Web Audio player. Qwen3 defaults to CustomVoice 6-bit MLX on macOS when configured, relaying upstream `tts` WAV output as Float32 chunks; Base voice cloning remains available as an advanced upstream worker profile, and Candle CustomVoice remains available as a fallback. See [Desktop local runtimes](./local-runtimes.md) for the bridge protocol.

- Playback uses the Web Audio API: `AudioContext` + `AudioBufferSourceNode`.
- Audio chunks are `Float32Array`.
- Streaming chunk handling keeps playback/export refs immediate, while `useTTS` stats/progress and `useAudioPlayer` segment/timeline UI state are coalesced to the next UI frame to avoid per-chunk React render pressure.
- Export supports `wav-f32`, `wav-pcm24`, `wav-pcm16`, and `mp3`.
- Sample rate comes from model output unless the user selects an export resample target.

## Model-Specific Notes

- **Kokoro** builds inference units through `buildKokoroInferenceUnits()` in `src/lib/chunking.ts`, merging sentence ranges up to the selected backend budget and splitting oversized single ranges before generation. It calls `tts.generate(string, ...)` per unit; `tts.stream()` is not used. `list_voices()` may return `void` in some `kokoro-js` versions, so fallback voices are required. WebGPU loads run a small warmup generation before READY, forced reload disposes the previous model when supported, and WASM fallback sets a safe multi-thread count when cross-origin isolation allows SharedArrayBuffer.
- **Supertonic** chunks text with min 100 / max 1000 chars per chunk, with 0.5 seconds of silence padding between chunks. Per-file download progress is aggregated dynamically.

## Browser Support Notes

- Desktop browsers expose both browser models.
- iPhone and iPad browsers expose Supertonic only.
- WebGPU is preferred where available; WASM fallback is supported where the selected model is enabled.
- Electron enables Chromium's `enable-unsafe-webgpu` switch because WebGPU is otherwise unavailable in the packaged desktop shell.
- Cross-origin isolation matters. Without COOP/COEP headers, WASM fallback can degrade to single-threaded execution.

# Architecture

This document keeps maintainer-facing architecture details out of the top-level README.

## Tech Stack

- React 19 + TypeScript 5.9 in strict mode + Vite 7 + Tailwind CSS 4
- `@huggingface/transformers` v4 for the Supertonic TTS pipeline
- `kokoro-js` v1 for Kokoro-82M generation with custom phonemization
- Electron 42.3.0 for the optional desktop wrapper
- Vitest 3 + Testing Library + jsdom for tests
- `lucide-react` for icons

## Source Map

```text
electron/        Desktop shell, custom protocol, preload bridge, Python runtime helpers
python/          Local TTS bridge for NeuTTS Nano, Kani-TTS-2, and Qwen3-TTS
src/
|-- apps/
|   |-- web/      Browser renderer shell and entrypoint
|   `-- desktop/  Electron renderer shell and entrypoint
|-- shared/      Shared synthesis app orchestration and tests
|-- components/  Studio, Reader, player, settings, local-runtime UI
|-- hooks/       Model loading, playback, generation, routing, creator state
|-- lib/         Audio, chunking, captions, cache, browser/runtime helpers
|-- workers/     Browser inference workers for Kokoro and Supertonic
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

This contract applies to the Studio and Reader browser-model path. Electron local-runtime pages generate complete files through the Python bridge and render their result separately.

- Playback uses the Web Audio API: `AudioContext` + `AudioBufferSourceNode`.
- Audio chunks are `Float32Array`.
- Export supports `wav-f32`, `wav-pcm24`, `wav-pcm16`, and `mp3`.
- Sample rate comes from model output unless the user selects an export resample target.

## Model-Specific Notes

- **Kokoro** splits text via the local `split()` helper and calls `tts.generate(string, ...)` per unit. `tts.stream()` is not used. `list_voices()` may return `void` in some `kokoro-js` versions, so fallback voices are required.
- **Supertonic** chunks text with min 100 / max 1000 chars per chunk, with 0.5 seconds of silence padding between chunks. Per-file download progress is aggregated dynamically.

## Browser Support Notes

- Desktop browsers expose both browser models.
- iPhone and iPad browsers expose Supertonic only.
- WebGPU is preferred where available; WASM fallback is supported where the selected model is enabled.
- Electron enables Chromium's `enable-unsafe-webgpu` switch because WebGPU is otherwise unavailable in the packaged desktop shell.
- Cross-origin isolation matters. Without COOP/COEP headers, WASM fallback can degrade to single-threaded execution.

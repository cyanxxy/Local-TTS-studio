# Architecture

This document keeps maintainer-facing architecture details out of the top-level README.

## Tech Stack

- React 19 + TypeScript 5.9 in strict mode + Vite 7 + Tailwind CSS 4
- `@huggingface/transformers` v4 for the Supertonic TTS pipeline
- `onnxruntime-web` for the Electron-only Supertonic 3 graph sessions
- `kokoro-js` v1 for Kokoro-82M generation with custom phonemization
- Electron 42.3.0 for the optional desktop wrapper
- Rust local bridge for Electron probe/WebSocket transport
- Vitest 3 + Testing Library + jsdom for tests
- `lucide-react` for icons

## Source Map

```text
electron/        Desktop shell, custom protocol, preload bridge, runtime helpers
rust/            Rust local bridge plus the scoped Hugging Face Xet download helper
src/
|-- apps/
|   |-- web/      Browser renderer shell and entrypoint
|   `-- desktop/  Electron renderer shell and entrypoint
|-- shared/      Shared synthesis app orchestration and tests
|-- components/  Studio, Reader, player, settings, local-runtime UI
|-- hooks/       Model loading, playback, generation, routing, creator state
|-- lib/         Audio, chunking, captions, cache, browser/runtime helpers
|-- workers/     Kokoro + Supertonic 2/3 inference workers and the audio export worker
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

This contract applies to Studio, Reader, and Electron local-runtime playback. Browser models stream chunks from Web Workers; Supertonic 3 uses a separate worker imported only by the Electron renderer. Electron local-runtime pages (NeuTTS and Qwen3) generate through the resident Rust WebSocket bridge worker (`electron/webSocketBridgeWorker.ts` driving `open-tts-local-bridge --action serve-ws`), which streams binary Float32 audio chunks that the renderer schedules through the same Web Audio player. Qwen3 runs in-process through the pinned `qwen3-tts-rs` `TTSInference` APIs: the target package supplies MLX on Apple Silicon or LibTorch on Windows x64, and the bridge dynamically resolves Metal/CUDA availability with a provider-local CPU fallback. Long Qwen jobs carry ordered continuation metadata through main-process admission, reuse Base reference features by worker-session key, and roll back audio from a failed section before exposing partial results. CustomVoice, Base voice cloning, and VoiceDesign share this runtime contract; there is no Candle or upstream Qwen worker fallback. See [Desktop local runtimes](./local-runtimes.md) for the bridge protocol.

- Playback uses the Web Audio API: `AudioContext` + `AudioBufferSourceNode`.
- Audio chunks are `Float32Array`.
- Streaming chunk handling keeps playback/export refs immediate, while `useTTS` stats/progress and `useAudioPlayer` segment/timeline UI state are coalesced to the next UI frame to avoid per-chunk React render pressure.
- Export supports `wav-f32`, `wav-pcm24`, `wav-pcm16`, and `mp3`.
- Sample rate comes from model output unless the user selects an export resample target.

## Long-Book Reader

Reader keeps the complete normalized document and its real chapter table of contents as the canonical model. `buildReaderSections()` derives deterministic paragraph/sentence-aligned working windows inside those chapters (8,000-character target, 12,000-character maximum). Only the active window is rendered and sent to synthesis, so a very large book never becomes one giant DOM tree, model request, or audio timeline. The active window renders as real paragraph blocks (one `<p>` per source line, with blank-line separation preserved through margins); each block carries its character offset so DOM selections, jumps, and highlight scrolling map exactly back to text offsets. Plain clicks never move playback — seeking is an explicit double-click — and auto-follow pauses as soon as the user scrolls during playback, until they resume it. Arrow keys page between sections, and the library sidebar adds full-text search across the whole book.

- Progress, bookmarks, notes, and chapter navigation use absolute whole-book text offsets. Audio segment offsets and playback time remain local to the active section; `SynthesisApp` translates between the two boundaries.
- Section IDs are derived from stable chapter IDs and their in-chapter order. They are not a second table of contents.
- Generated PCM is cached independently by `[documentId, sectionId]`. A signature of section text plus model, voice, quality, and tuning invalidates only incompatible audio. IndexedDB uses small metadata records for LRU pruning and is bounded to 96 sections or 512 MiB; the faster session-memory LRU is separately bounded to 12 sections or 192 MiB.
- IndexedDB version 3 keeps the document, settings, and section-audio stores, but deletes the obsolete document-level `audio` store during upgrade; legacy audio is discarded rather than migrated. Records loaded from older profiles are normalized in memory to add section IDs while preserving book text and annotations.
- At a section boundary, Reader flushes the completed cache before restoring a compatible next section or generating it. Automatic continuation is a persisted Reader preference, enabled by default, and can be disabled.

## Model-Specific Notes

- **Kokoro** builds inference units through `buildKokoroInferenceUnits()` in `src/lib/chunking.ts`, merging sentence ranges up to the selected backend budget and splitting oversized single ranges before generation. It calls `tts.generate(string, ...)` per unit; `tts.stream()` is not used. `list_voices()` may return `void` in some `kokoro-js` versions, so fallback voices are required. Because `kokoro-js` 1.2.1 does not forward a model `revision`, the worker pins Transformers.js's remote path template to the immutable Kokoro revision and separately rewrites model/voice fetch URL variants to that revision. WebGPU loads run a small warmup generation before READY, forced reload disposes the previous model when supported, and WASM fallback sets a safe multi-thread count when cross-origin isolation allows SharedArrayBuffer.
- **Supertonic 2 and 3** build semantic units for headings, lists, quotes, code, sentences, and paragraph boundaries, then adapt target and maximum chunk sizes to the active backend and quality. Failed chunks are subdivided and retried with bounded depth. Inter-chunk pauses are shaped by boundary kind (`none`, comma, sentence, or paragraph) and user overrides; they are not a fixed 0.5-second pad. Per-file download progress is aggregated dynamically. Supertonic 2 is web/iOS-only; Electron does not list or initialize its worker. Supertonic 3's revision-pinned direct ONNX runtime, 31-language table, and preset style loader exist only in the desktop dependency graph. The app-level `onnxruntime-web` version is an exact lockstep dependency of Transformers.js because both consumers use its emitted WASM assets; upgrading it independently can create an ABI mismatch, so `vite.onnxRuntimeVersion.test.ts` guards that relationship until Transformers.js moves to a stable runtime release.

## Browser Support Notes

- Desktop web browsers expose both browser models; the Electron shell exposes Kokoro plus Supertonic 3 instead of Supertonic 2.
- iPhone and iPad browsers expose Supertonic only.
- WebGPU is preferred where available; WASM fallback is supported where the selected model is enabled.
- Electron enables Chromium's `enable-unsafe-webgpu` switch because WebGPU is otherwise unavailable in the packaged desktop shell.
- Cross-origin isolation matters. Without COOP/COEP headers, WASM fallback can degrade to single-threaded execution.

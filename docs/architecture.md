# Architecture

This document keeps maintainer-facing architecture details out of the top-level README.

## Tech Stack

- React 19 + TypeScript 5.9 in strict mode + Vite 7 + Tailwind CSS 4
- `@huggingface/transformers` v4 for the Supertonic TTS pipeline
- `onnxruntime-web` for the Electron-only Supertonic 3 graph sessions
- `onnxruntime-node` for the Electron-only Audio8 graph sessions, run natively in a `worker_threads` worker
- `kokoro-js` v1 for Kokoro-82M generation with custom phonemization
- Electron 42.3.0 for the optional desktop wrapper
- Rust local bridge for Electron probe/WebSocket transport
- Vitest 3 + Testing Library + jsdom for tests
- `lucide-react` for icons

## Source Map

```text
electron/        Desktop shell, custom protocol, preload bridge, runtime helpers and native workers
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

Studio is the landing surface and ships in the entry chunk. The Reader page, the
per-model local-runtime pages, the app settings dialog, and document import
(Readability + zip) are loaded on demand via `React.lazy` / dynamic `import()`,
so opening the app does not parse code for surfaces the session never reaches.
Tests that assert into one of those subtrees must await its mount
(`findBy*`/`waitFor`) rather than querying synchronously after `render`.

The Audio8 runtime is spread across `electron/` by ownership rather than by
feature: `audio8Model.ts` holds the pinned revisions, asset table, and voice
catalogue that every other module reads; `audio8NativeWorker.ts` is the worker
thread that downloads, loads, and runs the graphs; `audio8AssetCache.ts` does
the download and integrity verification; `audio8SharedTask.ts` provides the
reference-counted single-flight both use; `audio8NativeClient.ts` is the
main-process client that owns the worker; `audio8Cache.ts` reports, clears, and
prunes the on-disk cache; and `audio8Threading.ts` picks the intra-op thread
count. The renderer half is `src/hooks/useAudio8Runtime.ts` and
`src/components/Audio8InlineSettings.tsx`, with display metadata in
`src/constants.ts`.

## Worker Protocol

The browser inference path is a strict message contract between the main thread and Web Workers. The canonical TypeScript definitions live in `src/types.ts`.

```text
Main -> Worker:  LOAD, GENERATE, CANCEL
Worker -> Main:  LOAD_PROGRESS, READY, AUDIO_CHUNK, GENERATION_COMPLETE, ERROR
```

Workers are created at startup and load models lazily on selection.

Audio8 uses a separate contract, because its worker is a Node `worker_threads`
worker owned by Electron's main process rather than a Web Worker owned by the
renderer. The canonical definitions live in `electron/audio8NativeClient.ts`.

```text
Renderer -> Main (IPC):  audio8:load, audio8:generate, audio8:cancel,
                         audio8:cache-info, audio8:clear-cache
Main -> Renderer:        audio8:progress
Main -> Worker:          load, generate, cancel
Worker -> Main:          progress, result, error
```

Every message on the worker side carries a `requestId`, and progress is
delivered to the request that produced it rather than fanned out, so a second
window's download percentages cannot appear in an unrelated progress bar. One
worker serves the whole app: it is spawned on the first request and reused by
every window. Generated audio comes back as one transferred `ArrayBuffer` of
Float32 PCM per request — there is no chunk stream on this path, so the
renderer chunks the text instead and schedules each returned buffer through the
same player. A worker that exits, errors, or goes
`AUDIO8_REQUEST_INACTIVITY_TIMEOUT_MS` (five minutes) without sending anything
rejects everything waiting on it; the next request starts a fresh worker.

## Desktop Document Import

Desktop import crosses three bounded ownership layers. The renderer asks through
the preload bridge; Electron's main process owns the native file dialog, validates
the request, reads direct-text formats, and returns the result over IPC. Formats
that require LiteParse (PDF, Office/OpenDocument, and images) are delegated by
`DocumentParseWorkerClient` to the one-shot `documentParseWorker` worker thread.
That worker dynamically loads LiteParse, performs conversion/OCR, and returns only
bounded text plus a page count. The client terminates it after success, failure,
shutdown, or the five-minute deadline, keeping parser CPU work and native parser
state out of the long-lived main process. EPUB bytes are transferred to the
renderer, where archive and document structure are parsed under separate limits.

## Browser Audio Path

This contract applies to Studio, Reader, and Electron local-runtime playback. Browser models stream chunks from Web Workers; Supertonic 3 uses a separate worker imported only by the Electron renderer. Electron local-runtime pages (NeuTTS and Qwen3) generate through the resident Rust WebSocket bridge worker (`electron/webSocketBridgeWorker.ts` driving `open-tts-local-bridge --action serve-ws`), which streams binary Float32 audio chunks that the renderer schedules through the same Web Audio player. Qwen3 runs in-process through the pinned `qwen3-tts-rs` `TTSInference` APIs: the target package supplies MLX on Apple Silicon or LibTorch on Windows x64, and the bridge dynamically resolves Metal/CUDA availability with a provider-local CPU fallback. Long Qwen jobs carry ordered continuation metadata through main-process admission, reuse Base reference features by worker-session key, and roll back audio from a failed section before exposing partial results. CustomVoice, Base voice cloning, and VoiceDesign share this runtime contract; there is no Candle or upstream Qwen worker fallback. Audio8 uses neither transport: the renderer asks the main process over IPC, the main process runs the graphs in a Node worker thread, and each request returns one Float32 buffer that the renderer schedules through the same player. See [Desktop local runtimes](./local-runtimes.md) for the bridge protocol and the Audio8 worker.

- Playback uses the Web Audio API: `AudioContext` + `AudioBufferSourceNode`.
- Audio chunks are `Float32Array`.
- Streaming chunk handling keeps playback/export refs immediate, while `useTTS` stats/progress and `useAudioPlayer` segment/timeline UI state are coalesced to the next UI frame to avoid per-chunk React render pressure.
- The playback position is **not** React state. It advances every animation frame, so `useAudioPlayer` publishes it through a `PlaybackClock` external store (`src/lib/playbackClock.ts`); components subscribe with `usePlaybackTime` at a leaf that needs frame-rate updates, or with `usePlaybackSelector` to re-render only when a derived value (an active word index, a whole-second readout) changes. Effects and callbacks read it imperatively via `getCurrentTime()`. Adding `currentTime` back to a render path re-renders the whole app 60 times a second.
- The player materialises `AudioBuffer`s and source nodes only `AUDIO_PLAYER_SCHEDULE_HORIZON_SECONDS` ahead of the playhead and releases decoded buffers `AUDIO_PLAYER_RETAIN_BEHIND_SECONDS` behind it, rebuilding them from the retained Float32 PCM on a seek. Because the horizon is short, the schedule is topped up both from the animation-frame loop and from a one-second timer, so playback does not run dry in a hidden browser tab where frames stop. The Electron window additionally sets `backgroundThrottling: false`.
- Export supports `wav-f32`, `wav-pcm24`, `wav-pcm16`, and `mp3`.
- Sample rate comes from model output unless the user selects an export resample target.

## Long-Book Reader

Reader keeps the complete normalized document and its real chapter table of contents as the canonical model. `buildReaderSections()` derives deterministic paragraph/sentence-aligned working windows inside those chapters (8,000-character target, 12,000-character maximum). Only the active window is rendered and sent to synthesis, so a very large book never becomes one giant DOM tree, model request, or audio timeline. The active window renders as real paragraph blocks (one `<p>` per source line, with blank-line separation preserved through margins); each block carries its character offset so DOM selections, jumps, and highlight scrolling map exactly back to text offsets. Plain clicks never move playback — seeking is an explicit double-click — and auto-follow pauses as soon as the user scrolls during playback, until they resume it. Arrow keys page between sections, and the library sidebar adds full-text search across the whole book.

- Progress, bookmarks, notes, and chapter navigation use absolute whole-book text offsets. Audio segment offsets and playback time remain local to the active section; `SynthesisApp` translates between the two boundaries.
- Section IDs are derived from stable chapter IDs and their in-chapter order. They are not a second table of contents.
- Generated PCM is cached independently by `[documentId, sectionId]`. A signature of section text plus model, voice, quality, and tuning invalidates only incompatible audio. Persistent storage uses small metadata records for LRU pruning and is bounded to 96 sections or 512 MiB; the faster session-memory LRU is separately bounded to 12 sections or 192 MiB.
- The web build uses IndexedDB version 3 for document, settings, and section-audio stores. Electron uses the public-domain SQLite engine bundled with its Node.js runtime, owns the connection in a dedicated worker, and streams PCM to that worker in bounded chunks. It stores the same Reader contract under the local app-data directory. See [Local persistence](./storage.md).
- IndexedDB upgrades delete the obsolete document-level `audio` store rather than migrating it. Records loaded from older profiles are normalized in memory to add section IDs while preserving book text and annotations.
- The first desktop read imports documents a pre-SQLite release left in the renderer's IndexedDB, ahead of the "empty library, seed a starter document" path, so an upgrade never presents an empty library. Cached audio is not carried over; the IndexedDB copy is left intact.
- Quitting the desktop app asks each renderer to flush its debounced Reader writes and waits for them before closing the worker; window and tab teardown flush the same way on both targets.
- At a section boundary, Reader flushes the completed cache before restoring a compatible next section or generating it. Automatic continuation is a persisted Reader preference, enabled by default, and can be disabled.

## Model-Specific Notes

- **Kokoro** builds inference units through `buildKokoroInferenceUnits()` in `src/lib/chunking.ts`, merging sentence ranges up to the selected backend budget and splitting oversized single ranges before generation. It calls `tts.generate(string, ...)` per unit; `tts.stream()` is not used. `list_voices()` may return `void` in some `kokoro-js` versions, so fallback voices are required. Because `kokoro-js` 1.2.1 does not forward a model `revision`, the worker pins Transformers.js's remote path template to the immutable Kokoro revision and separately rewrites model/voice fetch URL variants to that revision. WebGPU loads run a small warmup generation before READY, forced reload disposes the previous model when supported, and WASM fallback sets a safe multi-thread count when cross-origin isolation allows SharedArrayBuffer.
- **Supertonic 2 and 3** build semantic units for headings, lists, quotes, code, sentences, and paragraph boundaries, then adapt target and maximum chunk sizes to the active backend and quality. Failed chunks are subdivided and retried with bounded depth. Inter-chunk pauses are shaped by boundary kind (`none`, comma, sentence, or paragraph) and user overrides; they are not a fixed 0.5-second pad. Per-file download progress is aggregated dynamically. Supertonic 2 is web/iOS-only; Electron does not list or initialize its worker. Supertonic 3's revision-pinned direct ONNX runtime, 31-language table, and preset style loader exist only in the desktop dependency graph. The app-level `onnxruntime-web` version is an exact lockstep dependency of Transformers.js because both consumers use its emitted WASM assets; upgrading it independently can create an ABI mismatch, so `vite.onnxRuntimeVersion.test.ts` guards that relationship until Transformers.js moves to a stable runtime release.
- **Audio8** is desktop-only and native: `electron/audio8NativeWorker.ts` runs three `onnxruntime-node` CPU sessions in a worker thread — a slow autoregressive transformer that emits one semantic token and a hidden state per frame, a fast transformer that expands that hidden state into the remaining acoustic codebooks, and a codec decoder that turns the finished code matrix into 44.1 kHz Float32 PCM. Everything shape-dependent (sequence lengths, layer and head counts, codebook size, token ids) is read from the model's own `runtime_manifest.json` rather than hard-coded, and everything repository-dependent (pinned model and voice-Space revisions, asset table, voice ids, text limit) lives in `electron/audio8Model.ts`. The renderer keeps only display metadata for the same voices in `src/constants.ts`, because importing the desktop module would pull the download machinery into the web bundle; `vite.audio8Catalogue.test.ts` asserts the two lists and the quoted download size stay in agreement. The sampler is seeded (mulberry32, seed 42), so one text, voice, and revision reproduce the same audio, which is what makes a regression in the inference loop detectable. The renderer chunks text to 180 characters because the voice-reference prompt is re-prefilled before every chunk's first token, while the IPC boundary independently rejects anything over `AUDIO8_MAX_TEXT_CHARACTERS` (1,000) so a malformed payload cannot pin a core. Intra-op threads use up to four Apple performance cores on arm64 macOS and `min(6, availableParallelism())` elsewhere; using efficiency cores hurts latency, while the cap avoids the memory-bandwidth regression measured above four threads on M1 Pro. The app-level `onnxruntime-node` version is pinned exactly and re-pinned through `overrides`: Transformers.js and `kokoro-js` depend on it too, Transformers.js imports it from a static top-level import, and the Audio8 worker loads both — so a second resolved copy would load a second native ONNX Runtime into that one thread. `vite.onnxRuntimeVersion.test.ts` therefore checks the installed version and that the whole lockfile resolves exactly one.

## Browser Support Notes

- Desktop web browsers expose both browser models; the Electron shell exposes Kokoro plus Supertonic 3 instead of Supertonic 2.
- iPhone and iPad browsers expose Supertonic only.
- WebGPU is preferred where available; WASM fallback is supported where the selected model is enabled.
- Electron enables Chromium's `enable-unsafe-webgpu` switch because WebGPU is otherwise unavailable in the packaged desktop shell.
- Cross-origin isolation matters. Without COOP/COEP headers, WASM fallback can degrade to single-threaded execution.

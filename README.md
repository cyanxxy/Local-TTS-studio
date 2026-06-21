<div align="center">

# Open TTS

**A local-first text-to-speech studio that runs entirely on your device.**

Browser-native neural speech synthesis through WebGPU, plus optional Electron desktop runtimes through a local Rust bridge — no server, no account, no API key, no usage cap.

[![React 19](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![TypeScript 5.9](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite 7](https://img.shields.io/badge/Vite-7-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev)
[![Tailwind 4](https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Electron 42](https://img.shields.io/badge/Electron-42-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org)
[![Rust](https://img.shields.io/badge/Rust-local%20bridge-B7410E?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![WebGPU](https://img.shields.io/badge/WebGPU-Preferred-FF6F00?style=flat-square)](https://www.w3.org/TR/webgpu/)
[![Local first](https://img.shields.io/badge/Inference-100%25%20Local-1D1D1F?style=flat-square)](#capabilities)
[![License](https://img.shields.io/badge/License-Apache%202.0-1D1D1F?style=flat-square)](./LICENSE)

[Quick Start](#quick-start) · [Models](#models) · [Capabilities](#capabilities) · [Docs](#documentation)

</div>

---

## Overview

Open TTS is two applications built from a single codebase:

- **Web** — a browser-native Studio and Reader at `/studio` and `/reader`, with every inference step running client-side in Web Workers.
- **Desktop** — an Electron shell that serves the same Studio and Reader under `/desktop/*`, adds Qwen3-TTS as an in-place Studio/Reader model option, and exposes optional local-runtime setup pages through a Rust bridge.
- **Shared core** — model loading, generation, playback, export, and routing live in shared React/TypeScript modules used by both shells.

Browser models prefer WebGPU, fall back to WASM where supported, and cache their weights after first load for offline reuse. Electron local runtimes run through `open-tts-local-bridge`, a compiled Rust binary that Electron probes and keeps warm as an authenticated loopback WebSocket worker. Nothing you type or generate leaves the machine.

---

## Screenshots

### Studio

![Open TTS Studio](./docs/screenshots/studio.png)

### Reader

![Open TTS Reader](./docs/screenshots/reader.png)

### Qwen3-TTS MLX Runtime

![Open TTS Qwen3-TTS MLX runtime](./docs/screenshots/qwen3-mlx.png)

---

## Models

| Model / runtime | Source | Routes | Web | Desktop | Notes |
|---|---|---|:---:|:---:|---|
| **Kokoro-82M** | `onnx-community/Kokoro-82M-v1.0-ONNX` via `kokoro-js` | `/studio`, `/reader` (`/desktop/*` on desktop) | Yes | Yes | 24 kHz browser model, 24 named voices |
| **Supertonic TTS** | `onnx-community/Supertonic-TTS-2-ONNX` via `@huggingface/transformers` | `/studio`, `/reader` (`/desktop/*` on desktop) | Yes | Yes | 44.1 kHz browser model, 10 voices |
| **NeuTTS Nano** | Neuphonic GGUF variants via Rust `neutts` | `/desktop/neutts` | No | Yes | Rust-only local runtime; requires pre-encoded `.npy` reference codes |
| **Qwen3-TTS MLX + CustomVoice** | Apple-first CustomVoice 6-bit via upstream MLX `tts`; Base cloning via upstream MLX worker; Candle fallback via Rust `qwen_tts` | `/desktop/studio`, `/desktop/reader`, `/desktop/qwen3` | No | Yes | Rust-only local runtime; Studio and Reader expose the default CustomVoice profile directly, while `/desktop/qwen3` keeps setup, downloads, and advanced cloning controls |

> The deployed web app exposes browser Studio and Reader only. Desktop routes live under `/desktop/*` and are opened by Electron.

---

## Capabilities

| | |
|---|---|
| **Local & private** | All synthesis runs on-device — no server, account, API key, or usage cap. |
| **Two browser models** | Kokoro-82M and Supertonic, accelerated by WebGPU with an automatic WASM fallback. |
| **Studio & Reader** | A focused synthesis workspace, plus a long-form reading mode with sentence-aware chunking. |
| **Studio-grade export** | WAV (32-bit float, 24-bit, 16-bit PCM) and MP3, with optional loudness mastering (−14 LUFS / −1 dBTP) and resampling. |
| **Timed captions** | Export aligned SRT, VTT, or JSON alongside the audio. |
| **Creator presets** | One-click TikTok Voiceover, YouTube Shorts, and YouTube Long-form profiles. |
| **Delivery tuning** | Adjustable speed, pause shaping, and pronunciation / emphasis rules. |
| **Offline-ready** | Model weights cache in-browser (IndexedDB + Cache API) for repeat, network-free use. |
| **Desktop runtimes** | Electron adds Qwen3-TTS to Studio/Reader and exposes NeuTTS Nano and Qwen3 setup pages through a resident Rust WebSocket bridge. |

---

## Rust Local Bridge

The desktop-only NeuTTS Nano and Qwen3-TTS integrations run through a compiled Rust binary at `rust/local-tts-bridge`. Electron launches `open-tts-local-bridge` directly; there is no Python runtime, adapter script, interpreter discovery, or managed virtual environment.

The bridge has two actions:

- `probe` — a one-shot readiness check that reports Rust runtime metadata.
- `serve-ws` — a resident per-model worker used for generation.

For generation, Electron starts the bridge with `--host 127.0.0.1 --port 0 --auth-token <token>`. Rust binds the loopback socket, prints `__PORT__<actual-port>` on stdout, and accepts WebSocket traffic only on `/<token>`. Metadata travels as JSON frames, while audio streams as raw Float32 binary chunks. The renderer schedules those chunks with Web Audio and owns WAV normalization/export.

`npm run build:rust` builds the release bridge and copies the binary plus native runtime libraries into `dist-rust/` for Electron packaging.

---

## Quick Start

### Requirements

- Node.js 22.12 or newer.
- Rust + Cargo for Electron desktop development, desktop builds, packaging, and Rust bridge tests.
- The web app alone can run without Rust; desktop commands build `rust/local-tts-bridge` before launching Electron.

```bash
npm install            # install dependencies (run once)

npm run dev:web        # web app    -> http://localhost:5173/studio
npm run dev:desktop    # Vite + Electron desktop app
```

The web app is served at [`http://localhost:5173/studio`](http://localhost:5173/studio).
The Electron app opens the desktop shell under `/desktop/*`; Qwen3 appears as an Electron-only model option in Studio and Reader after the Rust bridge probes successfully.

### All scripts

| Command | Description |
|---|---|
| `npm run dev` · `npm run dev:web` | Vite web app on `localhost:5173` |
| `npm run dev:desktop` · `npm run dev:electron` | Vite + Electron desktop app |
| `npm run build` · `npm run build:web` | Type check + production web build |
| `npm run build:rust` | Build and copy the Rust local bridge into `dist-rust/` |
| `npm run build:desktop` · `npm run build:electron` | Web build + Rust bridge + compile Electron main process |
| `npm run build:electron:main` | Build Rust bridge and compile Electron main/preload code only |
| `npm run dist` | Package the desktop app into `release/` |
| `npm run preview` | Preview the production web build locally |
| `npm run lint` | ESLint |
| `npm run test` | Vitest + Rust bridge unit tests |
| `npm run test:js` · `npm run test:watch` · `npm run test:coverage` | Vitest |
| `npm run test:rust` | Rust bridge unit tests |
| `npm run eval:inference` | Reproducible inference-speed benchmark (see [docs](./docs/performance.md)) |

Packaged desktop builds bundle the Electron shell and the Rust local bridge binary. They do **not** ship model weights; first use downloads model assets into the app data cache. On macOS the build makes the bridge self-contained — its native libraries are bundled into `dist-rust/` and relinked to `@rpath` — so it runs without Homebrew; distributing the app still requires a Developer ID signature and notarization. There is no adapter script, interpreter discovery, or managed virtual environment setup; see [local runtime setup](./docs/local-runtimes.md).

---

## Runtime Notes

- Browser model assets download on first use and cache locally for offline reuse.
- WebGPU is preferred where available; the WASM fallback is expected behavior.
- iPhone and iPad browsers expose Supertonic only — Kokoro is intentionally disabled on iOS pending further validation.
- Electron enables Chromium's `enable-unsafe-webgpu` switch for desktop WebGPU support.
- Electron local runtimes generate through `open-tts-local-bridge --action serve-ws --port 0 --auth-token <token>`; Rust announces the bound loopback port, metadata travels over authenticated WebSocket JSON, and audio streams as binary Float32 chunks.
- Local-runtime models download on first generation (Qwen3 is roughly 1–2 GB); the bridge streams progress and emits a heartbeat so a slow first-run download or long CPU inference is not mistaken for a stalled worker. NeuTTS additionally requires a pre-encoded `.npy` reference-code file plus its transcript. Qwen3 MLX CustomVoice requires a local upstream `tts` binary and MLX model directory; Base voice cloning additionally requires `pibot-tts-worker`, a reference WAV, and its transcript.
- `vercel.json` provides SPA rewrites plus COOP/COEP headers, which keep the WASM fallback cross-origin isolated (and multi-threaded) for the browser build.

---

## Project Layout

```text
electron/        Desktop shell, custom protocol, preload bridge, runtime helpers
rust/            Rust local bridge binary for probe and WebSocket transport
src/
├─ apps/
│  ├─ web/       Browser renderer shell and entrypoint
│  └─ desktop/   Electron renderer shell and entrypoint
├─ shared/       Shared synthesis app orchestration and tests
├─ components/   Studio, Reader, player, settings, local-runtime UI
├─ hooks/        Model loading, playback, generation, routing, creator state
├─ lib/          Audio, chunking, captions, cache, browser/runtime helpers
├─ workers/      Kokoro + Supertonic inference workers and the audio export worker
└─ types.ts      Worker protocol and shared UI types
```

---

## Documentation

- [Architecture](./docs/architecture.md) — source map, worker protocol, and audio path
- [Desktop local runtimes](./docs/local-runtimes.md) — Rust bridge protocol, setup, and troubleshooting
- [Performance benchmarks](./docs/performance.md) — reproducible inference-speed eval
- [Design system](./docs/design-system.md) — tokens, typography, and color
- [Agent workflow and runtime contracts](./AGENTS.md) — the canonical project map

---

## License

Open TTS is licensed under the [Apache License 2.0](./LICENSE).

<div align="center">

**Built to run on your machine. Yours to keep.**

</div>

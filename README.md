<div align="center">

# Open TTS

**A local-first text-to-speech studio that runs entirely on your device.**

Browser-native neural speech synthesis through WebGPU — no server, no account, no API key, no usage cap.

[![React 19](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![TypeScript 5.9](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite 7](https://img.shields.io/badge/Vite-7-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev)
[![Tailwind 4](https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Electron 42](https://img.shields.io/badge/Electron-42-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org)
[![WebGPU](https://img.shields.io/badge/WebGPU-Preferred-FF6F00?style=flat-square)](https://www.w3.org/TR/webgpu/)
[![Local first](https://img.shields.io/badge/Inference-100%25%20Local-1D1D1F?style=flat-square)](#capabilities)
[![License](https://img.shields.io/badge/License-Apache%202.0-1D1D1F?style=flat-square)](./LICENSE)

[Quick Start](#quick-start) · [Models](#models) · [Capabilities](#capabilities) · [Docs](#documentation)

</div>

---

## Overview

Open TTS is two applications built from a single codebase:

- **Web** — a browser-native Studio and Reader at `/studio` and `/reader`, with every inference step running client-side in Web Workers.
- **Desktop** — an Electron shell that serves the same Studio and Reader under `/desktop/*`, and adds three optional Python-backed local runtimes.
- **Shared core** — model loading, generation, playback, export, and routing live in shared React/TypeScript modules used by both shells.

Browser models prefer WebGPU, fall back to WASM where supported, and cache their weights after first load for offline reuse. Nothing you type or generate leaves the machine.

---

## Models

| Model / runtime | Source | Routes | Web | Desktop | Notes |
|---|---|---|:---:|:---:|---|
| **Kokoro-82M** | `onnx-community/Kokoro-82M-v1.0-ONNX` via `kokoro-js` | `/studio`, `/reader` (`/desktop/*` on desktop) | Yes | Yes | 24 kHz browser model, 24 named voices |
| **Supertonic TTS** | `onnx-community/Supertonic-TTS-2-ONNX` via `@huggingface/transformers` | `/studio`, `/reader` (`/desktop/*` on desktop) | Yes | Yes | 44.1 kHz browser model, 10 voices |
| **NeuTTS Nano** | Neuphonic, via local Python bridge | `/desktop/neutts` | No | Yes | Reference-audio voice cloning; Python runtime is external |
| **Kani-TTS-2** | `nineninesix/kani-tts-2-en`, via local Python bridge | `/desktop/kani` | No | Yes | Language/accent tags, no named voices |
| **Qwen3-TTS CustomVoice** | Qwen 0.6B / 1.7B, via local Python bridge | `/desktop/qwen3` | No | Yes | Auto-selects model + device profile for CUDA, Apple MPS, or CPU |

> The deployed web app exposes Studio and Reader. Desktop-only routes live under `/desktop/*` and are opened by Electron.

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
| **Desktop runtimes** | Electron adds optional NeuTTS Nano, Kani-TTS-2, and Qwen3-TTS through a local Python bridge. |

---

## Quick Start

```bash
npm install            # install dependencies (run once)

npm run dev:web        # web app    -> http://localhost:5173/studio
npm run dev:desktop    # Vite + Electron desktop app
```

The web app is served at [`http://localhost:5173/studio`](http://localhost:5173/studio).

### All scripts

| Command | Description |
|---|---|
| `npm run dev` · `npm run dev:web` | Vite web app on `localhost:5173` |
| `npm run dev:desktop` · `npm run dev:electron` | Vite + Electron desktop app |
| `npm run build` · `npm run build:web` | Type check + production web build |
| `npm run build:desktop` · `npm run build:electron` | Web build + compile Electron main process |
| `npm run dist` | Package the desktop app into `release/` |
| `npm run lint` | ESLint |
| `npm run test` · `npm run test:watch` · `npm run test:coverage` | Vitest |
| `npm run eval:inference` | Reproducible inference-speed benchmark (see [docs](./docs/performance.md)) |

Packaged desktop builds bundle the Electron shell and the Python bridge script. They do **not** ship Python or model-specific Python dependencies — see [local runtime setup](./docs/local-runtimes.md).

---

## Runtime Notes

- Browser model assets download on first use and cache locally for offline reuse.
- WebGPU is preferred where available; the WASM fallback is expected behavior.
- iPhone and iPad browsers expose Supertonic only — Kokoro is intentionally disabled on iOS pending further validation.
- Electron enables Chromium's `enable-unsafe-webgpu` switch for desktop WebGPU support.
- `vercel.json` provides SPA rewrites plus COOP/COEP headers, which keep the WASM fallback cross-origin isolated (and multi-threaded) for the browser build.

---

## Project Layout

```text
electron/        Desktop shell, custom protocol, preload bridge, Python runtime helpers
python/          Local TTS bridge for NeuTTS Nano, Kani-TTS-2, and Qwen3-TTS
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
- [Desktop local runtimes](./docs/local-runtimes.md) — Python discovery, setup, and troubleshooting
- [Performance benchmarks](./docs/performance.md) — reproducible inference-speed eval
- [Design system](./docs/design-system.md) — tokens, typography, and color
- [Agent workflow and runtime contracts](./AGENTS.md) — the canonical project map

---

## License

Open TTS is licensed under the [Apache License 2.0](./LICENSE).

<div align="center">

**Built to run on your machine. Yours to keep.**

</div>

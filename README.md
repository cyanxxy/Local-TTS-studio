<div align="center">

# Open TTS

**A local-first text-to-speech studio that runs on your device.**

Browser-native inference through WebGPU where available, with no server, account, subscription, or usage cap.

[![React 19](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![TypeScript 5.9](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite 7](https://img.shields.io/badge/Vite-7-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev)
[![Tailwind 4](https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Electron 42](https://img.shields.io/badge/Electron-42-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org)
[![WebGPU](https://img.shields.io/badge/WebGPU-Preferred-FF6F00?style=flat-square)](https://www.w3.org/TR/webgpu/)
[![License](https://img.shields.io/badge/License-Apache%202.0-1D1D1F?style=flat-square)](./LICENSE)

</div>

## What It Is

Open TTS is two runnable apps in one repo:

- **Web app**: browser-native Studio and Reader at `/studio` and `/reader`.
- **Desktop app**: Electron shell at `/desktop/*`, with the same Studio and Reader plus Python-backed local runtime pages.
- **Shared core**: the synthesis UI, browser model loading, generation, playback, export, and routing contracts live in shared React/TypeScript modules.

Browser models run in Web Workers, prefer WebGPU, fall back to WASM where supported, and cache model assets after first use. No server, account, subscription, API key, or usage cap is required for the browser synthesis path.

## Surfaces

| Model / runtime | Source | Routes | Web | Desktop | Notes |
|---|---|---|:---:|:---:|---|
| Kokoro-82M | `onnx-community/Kokoro-82M-v1.0-ONNX` via `kokoro-js` | Web: `/studio`, `/reader`; Desktop: `/desktop/studio`, `/desktop/reader` | Yes | Yes | 24 kHz browser model with Kokoro fallback voices |
| Supertonic TTS | `onnx-community/Supertonic-TTS-2-ONNX` via `@huggingface/transformers` | Web: `/studio`, `/reader`; Desktop: `/desktop/studio`, `/desktop/reader` | Yes | Yes | 44.1 kHz browser model with 10 voices |
| NeuTTS Nano | Neuphonic via local Python bridge | `/desktop/neutts` | No | Yes | Reference-audio generation; Python runtime is external |
| Kani-TTS-2 | `nineninesix/kani-tts-2-en` via local Python bridge | `/desktop/kani` | No | Yes | Local desktop generation; Python runtime is external |
| Qwen3-TTS CustomVoice | Qwen 0.6B/1.7B via local Python bridge | `/desktop/qwen3` | No | Yes | Auto-selects model/runtime for CUDA, Apple MPS, or CPU |

The deployed web app exposes Studio and Reader. Desktop-only routes live under `/desktop/*` and are opened by Electron.

## Quick Start

Install once:

```bash
npm install
```

Run the web app:

```bash
npm run dev:web
```

The web app is served at [`http://localhost:5173/studio`](http://localhost:5173/studio).

Run the Electron desktop app:

```bash
npm run dev:desktop
```

Build targets:

```bash
npm run dev            # Alias for dev:web
npm run dev:electron   # Alias for dev:desktop
npm run lint           # ESLint
npm run test           # Vitest
npm run build:web      # Type check + production web build
npm run build          # Alias for build:web
npm run build:desktop  # Web build + Electron compile
npm run build:electron # Alias for build:desktop
npm run dist           # Package the desktop app into release/
```

Packaged desktop builds include the Electron shell and Python bridge script. They do not bundle Python or model-specific Python dependencies; see [local runtime setup](./docs/local-runtimes.md).

## Runtime Notes

- Browser model assets download on first use and cache locally for offline reuse.
- WebGPU is preferred where available; WASM fallback is expected behavior.
- iPhone and iPad browsers expose Supertonic only. Kokoro is intentionally disabled on iOS.
- Electron enables Chromium's `enable-unsafe-webgpu` switch for desktop WebGPU support.
- `vercel.json` includes SPA rewrites plus COOP/COEP headers for the browser build.

## Project Layout

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

## Further Docs

- [Architecture](./docs/architecture.md)
- [Desktop local runtimes](./docs/local-runtimes.md)
- [Performance benchmarks](./docs/performance.md)
- [Design system](./docs/design-system.md)
- [Agent workflow and runtime contracts](./AGENTS.md)

## License

Open TTS is licensed under the [Apache License 2.0](./LICENSE).

<div align="center">

**Built to run on your machine. Yours to keep.**

</div>

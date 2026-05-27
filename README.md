<div align="center">

# Open TTS

**A local-first text-to-speech studio that runs entirely on your device.**
Browser-native inference through WebGPU. No cloud. No subscription. No usage caps.

[![React 19](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![TypeScript 5.9](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite 7](https://img.shields.io/badge/Vite-7-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev)
[![Tailwind 4](https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Electron 41](https://img.shields.io/badge/Electron-41-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org)
[![WebGPU](https://img.shields.io/badge/WebGPU-Preferred-FF6F00?style=flat-square)](https://www.w3.org/TR/webgpu/)
[![License](https://img.shields.io/badge/License-See%20LICENSE-1D1D1F?style=flat-square)](./LICENSE)

</div>

---

## The Problem

Modern text-to-speech is **gated, metered, and centralized**. The good voices live behind API keys, monthly minutes, and "free tier" rate limits. Every request is a network hop. Every script you generate gets logged, processed, and stored on infrastructure you do not control.

That model breaks for the people who actually need TTS the most:

- **Writers and creators** who churn through thousands of words and hit billing walls before they hit a deliverable.
- **Audiobook narrators and podcasters** who need to retake a single sentence at 2 a.m. without burning credits or waiting on a queue.
- **Privacy-sensitive workflows** — medical, legal, internal corporate, journalism — where uploading the script to a third-party API is simply not allowed.
- **Offline-first environments** — flights, field work, classrooms, regions with unreliable connectivity — where "the API is down" means the work stops.
- **Developers and tinkerers** who want to ship a TTS feature without renting GPUs or signing enterprise contracts.

The hardware already exists. Modern laptops and phones have GPUs sitting idle while we pay someone else to run inference in another data center.

## The Approach

**Open TTS moves the entire pipeline onto the device.** State-of-the-art neural TTS models, compiled to ONNX, executed in your browser through WebGPU — with a WASM fallback for everything that doesn't support it yet.

You open the page. The model downloads once. It caches. From that point on, generation is local, instant, unmetered, and offline-capable. The same codebase ships as an Electron desktop app, with optional Python-backed runtimes for higher-end models that don't yet fit in a browser tab.

> **Local-first, not cloud-optional.** There is no server. There is no telemetry. There is no account. The model weights live on your disk; the inference happens on your silicon; the audio never leaves the machine.

---

## Highlights

| | |
|---|---|
| **Two browser models, zero servers** | Kokoro-82M and Supertonic TTS run natively in the browser through Web Workers, with WebGPU acceleration preferred and WASM fallback when it isn't. |
| **Three desktop runtimes, optional** | NeuTTS Nano, Kani-TTS-2, and Qwen3-TTS run through a local Python bridge inside Electron — for users who want bleeding-edge voice cloning, multilingual synthesis, or larger local models on their own machine. |
| **Studio + Reader workflows** | A Studio mode for script generation, voice tuning, and export. A Reader mode for long-form narration with chunk highlighting, section navigation, and per-segment retake. |
| **Professional export pipeline** | WAV (Float32 / PCM24 / PCM16) and MP3 audio output. SRT / VTT / JSON caption export. Sample rate is taken from the model, never hardcoded. |
| **Designed to feel native** | Self-hosted Inter / Outfit / JetBrains Mono. Flat, minimal interface. A design system built on tokens, not hex values. |

---

## Models

| Model | Source | Library | Sample Rate | Voices | Runs In |
|---|---|---|---:|---:|---|
| **Kokoro-82M** | `onnx-community/Kokoro-82M-v1.0-ONNX` | `kokoro-js` | 24 kHz | 24 | Web + Electron |
| **Supertonic TTS** | `onnx-community/Supertonic-TTS-2-ONNX` | `@huggingface/transformers` | 44.1 kHz | 10 (F1–F5, M1–M5) | Web + Electron |
| **NeuTTS Nano** | Neuphonic | Python bridge | model-defined | reference-cloned | Electron only |
| **Kani-TTS-2** | `nineninesix/kani-tts-2-en` | Python bridge | model-defined | model-defined | Electron only |
| **Qwen3-TTS CustomVoice** | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | Python bridge | model-defined | 9 built-in speakers | Electron only |

Model assets download on first use and cache locally. Subsequent generations are fully offline.

---

## Feature Matrix

| Surface | Web | Desktop | What it does |
|---|:---:|:---:|---|
| `/studio` | ✓ | ✓ | Primary workspace — Kokoro & Supertonic, voice selection, creator presets, pause/speed/pronunciation tuning, playback, audio export, caption export, cache controls |
| `/reader` | ✓ | ✓ | Long-form narration view — chunk highlighting, section navigation, playback sync, per-segment retake |
| `/neutts` | — | ✓ | Python-backed NeuTTS Nano page — reference-text + reference-audio synthesis, runtime probe, cache management |
| `/kani` | — | ✓ | Python-backed Kani-TTS-2 page — model selection, optional language-tag and sampling controls, runtime probe, cache management |
| `/qwen3` | — | ✓ | Python-backed Qwen3-TTS page — speaker/language selection, instruction prompt, sampling controls, runtime probe, cache management |

The desktop local-runtime pages are dedicated tools for Python-backed generation. They do not duplicate the browser export pipeline.

---

## Quick Start

### Install

```bash
npm install
```

### Run the web app

```bash
npm run dev
```

Opens at [`http://localhost:5173/studio`](http://localhost:5173/studio).

### Run the desktop app in development

```bash
npm run dev:electron
```

Starts Vite and launches Electron against the local dev server in one command.

### Verify the build

```bash
npm run lint           # ESLint
npm run test           # Vitest
npm run build          # tsc -b + vite build
npm run build:electron # Web + Electron compile
npm run eval:inference # Benchmark inference speed
npm run preview        # Preview the production build
```

### Package the desktop app

```bash
npm run dist
```

Packaged builds land in `release/`. Studio and Reader work out of the box. NeuTTS, Kani, and Qwen3 still require their Python dependencies — see [Desktop Local Runtime Setup](#desktop-local-runtime-setup) below.

The default macOS package is unsigned for local development (`build.mac.identity = null`). For distribution, configure a Developer ID signing identity and notarization in electron-builder. If you intentionally share an unsigned build, users may need to remove quarantine locally after downloading it.

---

## Architecture

### Tech Stack

- **React 19** + **TypeScript 5.9** (strict mode) + **Vite 7** + **Tailwind CSS 4**
- **`@huggingface/transformers` v4** — Supertonic TTS pipeline
- **`kokoro-js` v1** — Kokoro-82M streaming with custom phonemization
- **Electron 41.1.0** — optional desktop wrapper
- **Vitest 3** + **@testing-library/react** — testing
- **lucide-react** — icons

### Source Map

```text
electron/        Desktop shell, custom protocol, preload bridge, Python runtime helpers
python/          Local TTS bridge for NeuTTS Nano, Kani-TTS-2, and Qwen3-TTS
src/
├── App.tsx          Root app shell, routing, shared state
├── components/      Studio, Reader, player, settings, local-runtime UI
├── hooks/           Model loading, playback, generation, routing, creator state
├── lib/             Audio, chunking, captions, cache, browser/runtime helpers
├── workers/         Browser inference workers (Kokoro, Supertonic, export)
└── types.ts         Worker protocol + shared UI types
```

### Worker Protocol

The browser inference path is a strict message contract between the main thread and Web Workers, defined in `src/types.ts`:

```text
Main → Worker:   LOAD · GENERATE · CANCEL
Worker → Main:   LOAD_PROGRESS · READY · AUDIO_CHUNK · GENERATION_COMPLETE · ERROR
```

Workers are created at startup and load models lazily on selection.

### Audio Path

- Playback uses the **Web Audio API** (`AudioContext` + `AudioBufferSourceNode`) — not `<audio>`.
- Chunks are scheduled with `source.start(nextPlayTime)` for gapless streaming.
- WAV export is **IEEE Float 32-bit PCM** (`AudioFormat = 3`) via `src/lib/audio.ts`.
- Sample rate is taken from model output. **Never hardcoded.**

### Model-Specific Notes

- **Kokoro** splits text via a local `split()` helper and calls `tts.generate(string, ...)` per sentence. Adjacent short sentences are grouped into larger inference chunks, with a fallback to smaller retry chunks. `list_voices()` may return `void` in some `kokoro-js` versions — a fallback array is always provided.
- **Supertonic** chunks text with min 100 / max 1000 chars per chunk, with 0.5 s silence padding between chunks. Per-file download progress is aggregated dynamically — no hardcoded file counts.

---

## Performance

### Inference Speed Eval

A reproducible benchmark runs the same Web Worker inference path the app uses in production:

```bash
npm run eval:inference
npm run eval:inference -- --model kokoro     --iterations 3 --warmups 1
npm run eval:inference -- --model supertonic --iterations 3 --warmups 1
```

The eval launches a hidden Electron window, serves `public/inference-speed.html` through Vite, loads the selected model, runs warmups, then records generation latency, first-chunk latency, chars/sec, RTF, backend, and WebGPU status. Reports are written to `reports/inference-speed/*.json`. Compare against a saved baseline with `--baseline <path>`.

### Recent Local Results — WebGPU on Mac

| Model | Baseline | Current | Δ |
|---|---:|---:|---:|
| Kokoro | 5,382.7 ms | 4,567.8 ms | **15.14 % faster** |
| Supertonic | 375.1 ms | 377.2 ms | 0.55 % slower |

The current browser WebGPU tuning improves Kokoro raw generation by ~15 %. Larger gains likely require a native Mac backend (MLX, Core ML, native ONNX Runtime) or trading off quality settings.

### Browser Support Notes

- Desktop browsers expose both browser models.
- iPhone and iPad browsers expose **Supertonic only**. Kokoro is intentionally disabled on iOS.
- Open TTS **prefers** WebGPU but does not require it. WASM is the fallback.
- Electron enables Chromium's `enable-unsafe-webgpu` switch because WebGPU is otherwise unavailable in the packaged desktop shell. Re-check this switch during Electron upgrades and remove it when regular WebGPU is sufficient.
- Kokoro uses WebGPU `fp16` when available, WASM `q8` as fallback.
- **Cross-origin isolation matters.** Without the COOP/COEP headers, WASM fallback can degrade to single-threaded. `vercel.json` ships with the required headers preconfigured.

---

## Deploy the Web App

Vercel is preconfigured in `vercel.json`. Import the repository in Vercel — no additional setup is required.

- Vercel deploys the web app **only**. It does not package Electron or the Python bridge.
- The deployed app exposes Studio and Reader.
- On the web, visits to `/neutts`, `/kani`, or `/qwen3` normalize back to `/studio` — those routes render only inside Electron.
- `vercel.json` already includes SPA rewrites and the COOP/COEP headers used by the browser build.
- If Vercel does not auto-detect settings, use `npm run build` as the build command and `dist` as the output directory.

---

## Desktop Local Runtime Setup

The Electron build packages the desktop shell and the Python bridge script. It **does not bundle Python**, ship prebuilt virtual environments, or install `neutts`, `kani-tts-2`, `qwen-tts`, `torch`, or `espeak-ng` for you.

### Python Discovery Order

Electron resolves a usable Python runtime in this order:

1. The Python executable entered in the app's runtime settings
2. `TTS_NEUTTS_PYTHON_BIN`, `TTS_KANI_PYTHON_BIN`, or `TTS_QWEN3_PYTHON_BIN` for the selected model
3. `TTS_PYTHON_BIN`
4. Local virtualenv names, if they exist:
   - **NeuTTS** — `.venv-neutts` → `.venv313` → shared `.venv`
   - **Kani**   — `.venv-kani`   → `.venv313` → shared `.venv`
   - **Qwen3**  — `.venv-qwen3`  → `.venv-qwen` → `.venv312` → shared `.venv`
5. System Python (`python3.13` → `python3.12` → `python3.11` → `python3.10` → `python3` → `python` on macOS/Linux; `py` → `python` on Windows)

In development, Electron resolves virtualenv names from the repo root. **In packaged apps, runtime discovery is stricter** — Electron searches only the packaged app path and its resources directory unless you provide an explicit Python executable or environment variable. It will not search arbitrary working directories or executable parent paths.

### NeuTTS Nano

Open TTS supports both:

- legacy repo environments like `.venv-neutts` with `neutts 0.1.x`
- current official NeuTTS installs from Neuphonic docs (**preferred**)

**Current requirements:**

- Python 3.10 – 3.13
- `pip install neutts`
- `espeak-ng` on `PATH` (`espeak` fallback may work on some legacy setups)
- A reference transcript plus a real mono WAV clip

**Development setup:**

```bash
python3.13 -m venv .venv-neutts
source .venv-neutts/bin/activate
pip install --upgrade pip
pip install neutts
brew install espeak-ng   # macOS
```

**Packaged-app caveats:**

- Python remains external. `npm run dist` packages the bridge script, not the runtime.
- `TTS_NEUTTS_PYTHON_BIN` is the most reliable override for packaged builds.
- Finder / Explorer launches may not inherit a useful `PATH`, so the probe can fail on `espeak-ng` even when terminal runs succeed.
- On Windows, install eSpeak NG and set `PHONEMIZER_ESPEAK_LIBRARY` and `PHONEMIZER_ESPEAK_PATH` if phonemizer still cannot locate it.

### Kani-TTS-2

**Requirements:**

- Python 3.10+
- `pip install kani-tts-2`
- `pip install "transformers>=4.56,<5"`
- An importable `kani_tts`
- First-use model download (cached afterward)
- On macOS, the bridge defaults Kani to **CPU** to avoid known MPS issues

### Qwen3-TTS CustomVoice

Open TTS supports `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` as an Electron-only local runtime. It is **not** wired into the browser WebGPU worker path because the released model ships Qwen-specific `qwen-tts` / safetensors assets rather than ONNX / Transformers.js browser artifacts.

**Requirements:**

- Python 3.10+
- An importable `qwen_tts`
- An importable `torch`
- First-use model download (cached afterward)
- CUDA-capable GPU strongly recommended for practical generation speed
- FlashAttention 2 optional, but recommended by the Qwen runtime for lower GPU memory usage

**Development setup:**

```bash
python3.12 -m venv .venv-qwen3
source .venv-qwen3/bin/activate
pip install --upgrade pip
pip install qwen-tts torch
```

If you have a CUDA environment, install the PyTorch build and optional FlashAttention package that match your driver/toolkit before launching Electron. You can also point Open TTS at a pre-existing environment with `TTS_QWEN3_PYTHON_BIN=/absolute/path/to/python`.

The Qwen3 page exposes:

- speaker selection (`Ryan`, `Aiden`, `Vivian`, `Serena`, `Uncle_Fu`, `Dylan`, `Eric`, `Ono_Anna`, `Sohee`)
- language selection (`Auto`, Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian)
- optional instruction prompt
- device map, dtype, and attention implementation controls
- temperature, top-p, and max token controls

### Runtime Probe

The probe reports:

- resolved interpreter path
- where that interpreter came from
- Python version
- detected package and version
- NeuTTS compatibility mode (`legacy_0_1_x` or current `1.2.x+`)
- `espeak-ng` status
- Qwen3 CUDA / FlashAttention warnings when relevant

A successful probe means the interpreter can launch the bridge and expose the required package. It does **not** prove that every reference WAV or generation request will succeed.

### Troubleshooting

| App message | Meaning | Fix |
|---|---|---|
| `No usable Python runtime found` | Electron could not resolve a Python interpreter | Set Python in app settings, or set `TTS_NEUTTS_PYTHON_BIN`, `TTS_KANI_PYTHON_BIN`, or `TTS_QWEN3_PYTHON_BIN` |
| `NeuTTS currently requires Python 3.10-3.13` | Interpreter is too new/old for current NeuTTS | Point the app at Python 3.10 – 3.13 |
| `Failed to import neutts` | Python launched, but the environment does not expose `neutts` | Activate that environment and run `pip install neutts` |
| `Failed to import qwen_tts` | Python launched, but the environment does not expose Qwen's TTS package | Activate that environment and install `qwen-tts` |
| `Qwen3-TTS requires torch` | Qwen runtime is present, but PyTorch is missing | Install the PyTorch build that matches your CPU/GPU environment |
| `CUDA was not detected` | Qwen3 can try CPU/MPS, but the 1.7B model is slow and memory-heavy there | Use a CUDA environment when possible, or expect long generation times |
| `espeak-ng was not found` | NeuTTS is installed, but phonemizer support is missing | Install `espeak-ng`, then relaunch with a usable PATH (or use `TTS_NEUTTS_PYTHON_BIN`) |
| `Reference audio must be a valid WAV file` | Uploaded reference clip is not a readable WAV | Convert the clip to WAV before uploading |
| `Reference text is required` | NeuTTS needs the exact transcript of the reference clip | Paste the spoken transcript exactly as heard in the WAV |

---

## Design System

Open TTS aims for a flat, minimal, "OS-native" feel — typography forward, with subtle ambient depth.

| Token | Value |
|---|---|
| `font-sans` | Inter Variable (self-hosted) |
| `font-display` | Outfit Variable (self-hosted) |
| `font-mono` | JetBrains Mono Variable (self-hosted) |
| `--color-surface` | `#F5F5F7` |
| `--color-panel` | `#FFFFFF` |
| `--color-accent` | `#0071E3` |
| `--color-text-primary` | `#1D1D1F` |
| Shadows | `--shadow-xs/sm/md/lg`, `--shadow-accent-sm/md/lg` |
| Icon sizes | `xs=12px` (tight) · `sm=14px` (standard) · `md=16px` (standalone) |

All colors and effects flow through `@theme` variables in `src/index.css`. No hardcoded hex values in components — use tokens or `color-mix()`.

---

## Routes

| Route | Surface | Purpose |
|---|---|---|
| `/studio` | Web + Electron | Main TTS workspace — script editing, model selection, playback, creator tuning, export, cache |
| `/reader` | Web + Electron | Reading-focused workflow — chunk overlays, active section tracking, navigation, retake |
| `/neutts` | Electron only | Desktop page for Python-backed NeuTTS Nano generation |
| `/kani`   | Electron only | Desktop page for Python-backed Kani-TTS-2 generation |
| `/qwen3`  | Electron only | Desktop page for Python-backed Qwen3-TTS CustomVoice generation |

---

## Limitations — Honestly

Open TTS is local-first, not magic. Knowing where the seams are makes it easier to use well.

- **Not fully offline from first launch.** Browser and desktop runtimes download model assets on first use, then cache them.
- **Not every model runs in the browser.** NeuTTS Nano, Kani-TTS-2, and Qwen3-TTS are Electron + Python only. Qwen3 currently lacks ONNX / Transformers.js browser artifacts in the supported repo.
- **Browser Supertonic is English-focused today.** This README does not claim broad multilingual browser support.
- **Not WebGPU-only.** WASM fallback is part of the intended behavior.
- **Packaged Electron builds do not bundle Python.** You install it yourself.
- **Electron local-runtime pages are not feature-parity with Studio/Reader.** They focus on Python-backed generation, probing, and cache management — not the full creator/export/caption pipeline.

---

## Contributing

The canonical project map and runtime contracts live in [`AGENTS.md`](./AGENTS.md). Read it before refactors.

Before sending changes:

```bash
npm run lint
npm run test
npm run build
```

Tests live beside source as `*.test.ts` / `*.test.tsx`. The repo follows TDD where practical. `jsdom` does not implement `Blob.arrayBuffer()` — test WAV headers through `buildWavHeader()` directly, not through a `Blob`.

---

## License

See [LICENSE](./LICENSE).

<div align="center">

**Built to run on your machine. Yours to keep.**

</div>

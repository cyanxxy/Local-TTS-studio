# Open TTS

Repository name: `offline-voice-studio`

Open TTS is a local-first text-to-speech app that runs Kokoro and Supertonic in the browser and adds optional Electron desktop runtimes for NeuTTS Nano and Kani-TTS-2.

- Browser-native inference through Web Workers, with WebGPU preferred and WASM fallback available
- Two main workflows: `Studio` for generation/export and `Reader` for long-form narration and retakes
- Optional Electron-only Python bridge for additional desktop local runtimes

## Overview

Open TTS keeps inference on-device. In the browser, it runs Kokoro and Supertonic locally and caches model assets after the first download. In Electron, the same app can expose additional desktop-only tools for NeuTTS Nano and Kani-TTS-2 through a local Python bridge.

The browser app focuses on script writing, playback, creator tuning, audio export, caption export, and browser cache controls. The Electron local-runtime pages are separate desktop tools for Python-backed generation and runtime/cache management.

Audio export supports WAV Float32, WAV PCM24, WAV PCM16, and MP3. Caption export supports SRT, VTT, and JSON.

## Feature Matrix

| Surface | Web | Electron | Notes |
| --- | --- | --- | --- |
| `Studio` | Yes | Yes | Main workspace for Kokoro and Supertonic, voice selection, creator presets, pause/speed/pronunciation tuning, playback, audio export, caption export, and browser cache controls |
| `Reader` | Yes | Yes | Long-form reading view with chunk highlighting, section navigation, playback sync, and per-segment retake |
| `NeuTTS Nano` | No | Yes | Desktop-only Python runtime page with reference-text + reference-audio synthesis, runtime probe, and cache management |
| `Kani-TTS-2` | No | Yes | Desktop-only Python runtime page with Kani-TTS-2 model selection, optional language-tag/sampling controls, runtime probe, and cache management |

Electron includes `Studio` and `Reader`, then adds the `NeuTTS Nano` and `Kani-TTS-2` pages. Those desktop local-runtime pages do not expose the browser creator/export/caption pipeline.

## Models and Runtime Support

| Runtime | Model | Notes |
| --- | --- | --- |
| Browser worker | `Kokoro` | `onnx-community/Kokoro-82M-v1.0-ONNX` via `kokoro-js` |
| Browser worker | `Supertonic` | `onnx-community/Supertonic-TTS-2-ONNX` via `@huggingface/transformers`; current browser UI exposes 10 voice presets (F1–F5, M1–M5) |
| Electron local runtime | `NeuTTS Nano` | Python bridge; requires reference text and reference audio |
| Electron local runtime | `Kani-TTS-2` | Python bridge for `nineninesix/kani-tts-2-en`; supports optional language-tag and sampling controls |

Model assets download on first use and then cache locally. The browser app prefers WebGPU when it can initialize a real device, and falls back to WASM when it cannot.

## Quick Start

### Install

```bash
npm install
```

### Run the web app

```bash
npm run dev
# http://localhost:5173/studio
```

### Run the desktop app in development

```bash
npm run dev:electron
```

This starts Vite and launches Electron against the local app.

### Build and verify locally

```bash
npm run lint
npm run test
npm run build
npm run build:electron
npm run eval:inference
npm run preview
```

### Package the desktop app

```bash
npm run dist
```

Packaged desktop builds are written to `release/`. `Studio` and `Reader` work inside Electron without extra setup. The optional `NeuTTS Nano` and `Kani-TTS-2` pages still require the Python dependencies listed below.

## Deploy the Web App

If you want to host the browser app yourself, Vercel is already configured for the web build in `vercel.json`.

- Vercel deploys the web app only. It does not package Electron or the Python bridge.
- Import the repository into Vercel instead of relying on a hardcoded clone URL in this README.
- The deployed app exposes the browser workflows, including `Studio` and `Reader`.
- On the web, visiting `/neutts` or `/kani` normalizes back to `/studio`. Those workflows render only inside Electron.
- `vercel.json` already includes SPA rewrites plus the COOP/COEP headers used by the browser build.
- If Vercel does not auto-detect the project settings, use `npm run build` as the build command and `dist` as the output directory.

## Desktop Local Runtime Setup

The Electron build packages the desktop shell and the Python bridge script from `python/local_tts_bridge.py`. It does not bundle Python itself, it does not ship prebuilt virtual environments, and it does not install `neutts`, `kani-tts-2`, or `espeak-ng` for you.

Supported bridge environment variables:

- `TTS_NEUTTS_PYTHON_BIN`
- `TTS_KANI_PYTHON_BIN`
- `TTS_PYTHON_BIN`

Electron resolves a usable Python runtime in this order:

1. the Python executable entered in the app runtime settings
2. `TTS_NEUTTS_PYTHON_BIN` or `TTS_KANI_PYTHON_BIN` for the selected model
3. `TTS_PYTHON_BIN`
4. local virtualenv names, if they exist:
   - NeuTTS checks `.venv-neutts`, then `.venv313`, then the optional shared `.venv`
   - Kani checks `.venv-kani`, then `.venv313`, then the optional shared `.venv`
5. system Python executables (`python3.13` through `python` on macOS/Linux, `py` or `python` on Windows)

Today this repo uses `.venv-neutts` for NeuTTS and `.venv313` as the shared Python 3.13 environment for Kani and fallback checks. `.venv-kani` remains a supported compatibility name, while `.venv` is only a catch-all fallback if you create it yourself.

In development, Electron can resolve those virtualenv names from the repo root. In packaged apps, runtime discovery is stricter: Electron searches the packaged app path, bundle-adjacent locations, nearby executable parents, and only then the current working directory. It does not search an arbitrary source checkout elsewhere on disk.

### NeuTTS Nano

This app supports both:

- legacy repo environments like `.venv-neutts` with `neutts 0.1.x`
- current official NeuTTS installs from Neuphonic docs, which are preferred

Current NeuTTS requirements:

- Python `3.10` to `3.13`
- `pip install neutts`
- `espeak-ng` available on `PATH` (`espeak` fallback can work on some legacy setups)
- reference text plus a real mono WAV clip for generation

Development example:

```bash
python3.13 -m venv .venv-neutts
source .venv-neutts/bin/activate
pip install --upgrade pip
pip install neutts
brew install espeak-ng   # macOS
```

Packaged app guidance:

- Python remains external. `npm run dist` packages the bridge script, not the runtime.
- `TTS_NEUTTS_PYTHON_BIN` is the most reliable packaged override.
- Finder / Explorer launches may not inherit a useful `PATH`, so probe can fail on `espeak-ng` even when terminal runs work.
- On Windows, install eSpeak NG and set `PHONEMIZER_ESPEAK_LIBRARY` and `PHONEMIZER_ESPEAK_PATH` if phonemizer still cannot locate it.

### Kani-TTS-2

Kani requirements:

- Python `3.10+`
- install `kani-tts-2`
- install `transformers==4.56.0`
- importable `kani_tts`
- local model downloads on first use
- on macOS, the bridge defaults Kani to CPU to avoid known MPS issues

The Electron local-runtime pages can probe the runtime, show cache location and size, clear cached files, and trigger a redownload by generating again. They are desktop-only tools, not drop-in replacements for the browser export workflow.

### What Probe Proves

The runtime probe now reports:

- resolved interpreter path
- where that interpreter came from
- Python version
- detected package and package version
- NeuTTS compatibility mode (`legacy_0_1_x` or current `1.2.x+`)
- `espeak-ng` status

Probe success means the selected interpreter can launch the bridge and expose the required package. It does not prove that every reference WAV or generation request is valid.

### Troubleshooting

| App state | Meaning | Fix |
| --- | --- | --- |
| `No usable Python runtime found` | Electron could not resolve a Python interpreter for that page | Set the Python executable in the app, or set `TTS_NEUTTS_PYTHON_BIN` / `TTS_KANI_PYTHON_BIN` |
| `NeuTTS currently requires Python 3.10-3.13` | The selected interpreter is too new or too old for current NeuTTS | Point the app at Python 3.10, 3.11, 3.12, or 3.13 |
| `Failed to import neutts` | Python launched, but the selected environment does not expose `neutts` cleanly | Activate that environment and run `pip install neutts` |
| `espeak-ng was not found` | NeuTTS package is installed, but phonemizer support is missing from the packaged app environment | Install `espeak-ng`, then relaunch with a usable PATH or keep using `TTS_NEUTTS_PYTHON_BIN` with a shell-launched app |
| `Reference audio must be a valid WAV file` | The uploaded reference clip is not a readable WAV | Convert the clip to WAV before uploading |
| `Reference text is required` | NeuTTS needs the exact transcript of the reference clip | Paste the spoken transcript exactly as heard in the WAV |

## Browser Support and Performance Notes

- Desktop browsers expose both browser models: `Kokoro` and `Supertonic`.
- iPhone and iPad browsers currently expose `Supertonic` only. `Kokoro` is intentionally disabled on iOS browsers.
- Open TTS prefers WebGPU, but it is not required. If WebGPU is unavailable, the app falls back to WASM.
- Kokoro currently uses WebGPU `fp16` when available and WASM `q8` as fallback.
- Kokoro generation groups adjacent short sentences into larger inference chunks, then falls back to smaller retry chunks if needed.
- Cross-origin isolation matters for performance. Without the required COOP/COEP headers, WASM fallback can become single-threaded.
- If you deploy the web app yourself, preserve the cross-origin isolation headers used in local development and `vercel.json`.

### Inference Speed Eval

Use the Electron-backed eval to measure the same Web Worker inference path the app uses in the browser runtime:

```bash
npm run eval:inference
```

Useful focused runs:

```bash
npm run eval:inference -- --model kokoro --iterations 3 --warmups 1
npm run eval:inference -- --model supertonic --iterations 3 --warmups 1
```

Reports are written to `reports/inference-speed/*.json`. To compare against a saved baseline:

```bash
npm run eval:inference -- --model kokoro --baseline reports/inference-speed/<baseline>.json
```

The eval launches a hidden Electron window, serves `public/inference-speed.html` through Vite, loads the selected model, runs warmup iterations, then records generation latency, first-chunk latency, chars/sec, RTF, backend, and WebGPU status.

Recent local WebGPU results from the current Mac development environment:

| Model | Baseline | Current | Change |
| --- | ---: | ---: | ---: |
| Kokoro | 5382.7 ms | 4567.8 ms | 15.14% faster |
| Supertonic | 375.1 ms | 377.2 ms | 0.55% slower |

The current browser WebGPU tuning improves Kokoro raw generation speed by about 15% in this local eval. Larger gains likely require a native Mac backend such as MLX, Core ML, or native ONNX Runtime, or accepting lower quality/runtime settings.

## Routes and Main Workflows

| Route | Surface | Purpose |
| --- | --- | --- |
| `/studio` | Web + Electron | Main TTS workspace with script editing, model selection, playback, creator tuning, export, and cache controls |
| `/reader` | Web + Electron | Reading-focused workflow with chunk overlays, active section tracking, navigation, and section retake |
| `/neutts` | Electron only | Desktop page for Python-backed NeuTTS Nano generation |
| `/kani` | Electron only | Desktop page for Python-backed Kani-TTS-2 generation |

`Studio` and `Reader` are the main public workflows. The Electron-only routes are separate desktop tools for local Python runtimes.

## Project Structure

```text
electron/      Electron shell, custom app protocol, preload bridge, desktop IPC
python/        Local runtime probe/generate bridge for NeuTTS and Kani
src/           React app, UI components, hooks, browser support helpers, audio/export logic
src/lib/       Chunking, audio, captions, cache, routing, runtime helpers
src/workers/   Browser inference workers for Kokoro/Supertonic and the export worker
```

## Current Limitations

- Open TTS is local-first, but it is not fully offline from first launch. Browser and desktop runtimes download model assets on first use before caching them locally.
- Not all models run in the browser. `NeuTTS Nano` and `Kani-TTS-2` are Electron + Python only.
- Browser `Supertonic` should be treated as an English-focused runtime today; this README does not claim broad multilingual browser support.
- The app is not WebGPU-only. WASM fallback is part of the intended behavior.
- Packaged Electron builds do not bundle Python.
- The Electron local-runtime pages do not provide feature parity with `Studio` and `Reader`; they focus on Python-backed generation, probing, and cache management rather than the browser creator/export/caption pipeline.

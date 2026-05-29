# CLAUDE.md — Open TTS WebGPU

## Project Overview

Browser-native TTS app with two WebGPU browser models (Kokoro-82M + Supertonic TTS). 100% local inference, no server or cloud. Ships as both a web app and an Electron desktop app from one codebase. The desktop app additionally exposes three optional Python-backed local runtimes — NeuTTS Nano, Kani-TTS-2, and Qwen3-TTS — through an IPC bridge (`python/local_tts_bridge.py`).

## Tech Stack

- **React 19** + **TypeScript 5.9** + **Vite 7** + **Tailwind CSS 4**
- **@huggingface/transformers** v4 — Supertonic TTS pipeline
- **kokoro-js** v1 — Kokoro-82M (custom phonemization, NOT standard pipeline)
- **Electron 42.3.0** — optional desktop wrapper (Chromium 148, bundles Node 24; dev/build requires Node >=22.12)
- **Python bridge** — desktop-only local runtimes (NeuTTS Nano, Kani-TTS-2, Qwen3-TTS) via `python/local_tts_bridge.py`
- **Vitest 3** + **@testing-library/react** — testing
- **lucide-react** — icons

## Commands

```sh
npm run dev          # Alias for dev:web
npm run dev:web      # Vite web app (localhost:5173)
npm run dev:desktop  # Vite + Electron concurrently
npm run dev:electron # Alias for dev:desktop
npm run build        # Alias for build:web
npm run build:web    # TypeScript check + Vite production web build
npm run build:desktop # Build web + compile Electron TS
npm run build:electron # Alias for build:desktop
npm run test         # vitest run
npm run test:watch   # vitest watch mode
npm run lint         # ESLint
npx tsc -b --noEmit  # Type check only
```

## Architecture

`AGENTS.md` is the canonical project map and runtime-contract document. Use it first before refactors.

Repo-local assistant skills live under `.claude/skills`. Do not recreate duplicate copies under `.agents/skills`.

Current high-level structure:

```txt
src/
  apps/web/          # Browser shell + entrypoint; routes /studio and /reader
  apps/desktop/      # Electron renderer shell + entrypoint; routes /desktop/*
  shared/            # Shared synthesis app orchestration and tests
  components/        # Studio, reader, player, settings, local runtime UI
  hooks/             # Model loading, playback, generation, routing, creator state
  lib/               # Audio, chunking, captions, cache, browser/runtime helpers
  workers/           # Browser inference workers for Kokoro, Supertonic, export
  types.ts           # Worker protocol + shared UI types

electron/            # Desktop shell, security, protocol, preload, Python runtime helpers
python/              # Local TTS bridge for NeuTTS Nano, Kani-TTS-2, and Qwen3-TTS
```

## Key Patterns

- **Worker protocol**: `WorkerInMessage` (LOAD, GENERATE, CANCEL) and `WorkerOutMessage` (LOAD_PROGRESS, READY, AUDIO_CHUNK, GENERATION_COMPLETE, ERROR) — defined in `src/types.ts`.
- **Audio playback**: Uses Web Audio API (`AudioContext` + `createBufferSource`), NOT `<audio>` element. Chunks scheduled with `source.start(nextPlayTime)`.
- **WAV encoding**: IEEE Float 32-bit PCM (AudioFormat = 3). Sample rate comes from model output, never hardcoded.
- **Kokoro voices**: `list_voices()` may return void in some kokoro-js versions — always use fallback array.
- **Kokoro generation**: Worker builds inference units via shared `buildKokoroInferenceUnits()` (`lib/chunking.ts`) — sentences merged greedily up to a per-backend budget (`KOKORO_WEBGPU/WASM_MAX_INFERENCE_CHARS`), then `tts.generate(string, ...)` per unit (no `tts.stream()`). The reader preview (`chunkTextForModelDetailed`) uses the same builder so editor section boundaries match generated segments. Voice param is a strict literal union — cast with `as any`.
- **Supertonic chunking**: min 100 / max 1000 chars per chunk. 0.5s silence padding between chunks.
- **Supertonic progress**: Aggregates per-file download progress dynamically (not hardcoded file counts).

## TypeScript Notes

- TS 5.9 strict typed arrays: `Float32Array<ArrayBufferLike>` vs `Float32Array<ArrayBuffer>`. When passing to `copyToChannel` or `Blob`, create a fresh copy or concatenate into a new `ArrayBuffer` first.
- `@ts-expect-error` preferred over `@ts-ignore` (ESLint rule).
- Explicit `useState<string>(...)` for values that would otherwise infer a string literal type.

## Testing

- TDD approach — tests in `*.test.ts` / `*.test.tsx` alongside source files.
- Test setup: `src/test-setup.ts` (imports `@testing-library/jest-dom`).
- Config: `vitest.config.ts` with jsdom environment and test-setup.
- Note: jsdom does not implement `Blob.arrayBuffer()` — test WAV headers via `buildWavHeader()` directly, not through Blob.

## Design Tokens (src/index.css)

Liquid Glass design (Apple): translucent, blurred, light-refracting surfaces floating over an ambient color field, with specular edge highlights and soft depth shadows.
- **Glass utilities** (defined in `src/index.css`, unlayered so they win over Tailwind utilities — only put them on static containers, never alongside competing `bg-*`/`border-*`/`shadow-*` utilities on the same element):
  - `.glass` / `.glass-panel` — translucent blurred surfaces (panels, cards, nav, popovers via `.glass-pop`).
  - `.glass-accent` — vivid tinted-glass primary button (the Generate CTA).
  - `.glass-inset` — recessed field look.
  - For interactive/stateful buttons use Tailwind utilities instead: `bg-white/40 backdrop-blur-md border border-white/55 shadow-glass-sm` + hover/active variants (predictable cascade).
- **Glass shadows**: `--shadow-glass-sm/md/lg` (`@theme` → `shadow-glass-*` utilities) bake in the drop shadow + inset top specular highlight.
- **Electron (macOS)**: window uses native `vibrancy: "under-window"` + transparent background + `titleBarStyle: "hiddenInset"`; the renderer adds `is-electron`/`is-mac` classes on `<html>` to make the body transparent (so the vibrancy shows) and inset/drag the header for traffic lights.
- **Fonts**: Self-hosted via `@fontsource-variable` (Inter, Outfit, JetBrains Mono) — no external CDN. Global: `font-optical-sizing: auto`, `text-rendering: optimizeLegibility`, `font-feature-settings: kern/liga/calt`.
  - `font-sans` (Inter) — body + UI text
  - `font-display` (Outfit) — all headings (h1/h2 content titles). Pair display sizes with this class.
  - `font-mono` (JetBrains Mono) — stats, code, numeric values (add `tabular-nums` for aligned digits)
- **Type scale** (one canonical scale in `@theme`, each token carries a tuned line-height; display tokens also carry negative tracking). ALWAYS use these utilities — never ad-hoc `text-[Npx]`/`text-[Nrem]`:
  - UI: `text-2xs` 9 · `text-xs` 10 · `text-sm` 11 · `text-base` 13 · `text-lg` 14 · `text-xl` 16 (px)
  - Display: `text-2xl` 1.5 · `text-3xl` 1.75 · `text-4xl` 2 · `text-5xl` 2.2 · `text-6xl` 2.8 (rem)
  - Small uppercase section labels: `text-xs font-semibold uppercase tracking-widest` (not `font-bold`).
- **Colors**: `--color-surface` #F5F5F7, `--color-panel` #FFFFFF, `--color-accent` #0071E3, `--color-text-primary` #1D1D1F
- **Shadows**: `--shadow-xs/sm/md/lg` (neutral), `--shadow-accent-sm/md/lg` (blue-tinted) — use Tailwind classes `shadow-md`, `shadow-accent-sm`, etc.
- **Icon sizes**: xs=12px (tight buttons), sm=14px (standard controls), md=16px (standalone buttons) — all via lucide-react `size` prop.
- Full palette defined as CSS `@theme` variables for Tailwind. No hardcoded colors — use `color-mix()` or tokens.

## Models

### Browser models (web + desktop, WebGPU)

| Model | ID | Library | Sample Rate | Voices |
|---|---|---|---|---|
| Kokoro-82M | `onnx-community/Kokoro-82M-v1.0-ONNX` | kokoro-js | 24000 Hz | 24 named voices |
| Supertonic | `onnx-community/Supertonic-TTS-2-ONNX` | @huggingface/transformers | 44100 Hz | F1–F5, M1–M5 (10 voices) |

### Desktop-only local runtimes (Electron + Python bridge)

Sample rate is read from each model's output at runtime, never hardcoded. Allowed repos/speakers are enforced in `electron/localTtsIpc.ts`.

| Model | ID(s) | Python package | Voices |
|---|---|---|---|
| NeuTTS Nano | `neuphonic/neutts-nano` (+ `-german`/`-french`/`-spanish`) | `neutts` (Python 3.10–3.13) | reference-audio voice cloning |
| Kani-TTS-2 | `nineninesix/kani-tts-2-en` | `kani-tts-2` (transformers 4.56, NVIDIA NeMo) | language-tagged, no named voices |
| Qwen3-TTS | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` (Auto default) + `…-1.7B-CustomVoice` | `qwen-tts` + device-profiled `torch` | 9 speakers, 11 language options |

**Qwen3 runs on a resident bridge worker** (`local_tts_bridge.py --action serve`, pooled by `electron/persistentBridgeWorker.ts`): the model loads once and serves many requests, so repeat generations skip the per-call import + model load + first-inference warmup (~2–3× faster warm). `Qwen3ModelHost` reuses the model keyed by (repo, device, dtype, attention) and reloads on change; the worker is idle-evicted after ~5 min and respawns on demand; cancel kills it. Cached loads force HF offline mode so a cached generation makes no network call. NeuTTS/Kani keep the one-shot subprocess path. See AGENTS.md → "Local bridge protocol".

## Maintenance Notes

- Keep the managed runtime virtualenvs (`.venv-neutts`, `.venv-kani`, `.venv-qwen3`) and the shared `.venv313` unchanged during normal cleanup work.
- If you revisit Python env dedupe, test any `Janome` or `wandb` pruning in a disposable `.venv313` copy first, or rebuild the runtime envs with a shared-link workflow such as `uv` before changing the runtime defaults.

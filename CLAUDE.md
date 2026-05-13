# CLAUDE.md — Open TTS WebGPU

## Project Overview

Browser-native TTS app with dual model support (Kokoro-82M + Supertonic TTS). 100% local inference via WebGPU, no server or cloud. Ships as both a web app and an Electron desktop app from one codebase.

## Tech Stack

- **React 19** + **TypeScript 5.9** + **Vite 7** + **Tailwind CSS 4**
- **@huggingface/transformers** v4 — Supertonic TTS pipeline
- **kokoro-js** v1 — Kokoro-82M (custom phonemization, NOT standard pipeline)
- **Electron 41.1.0** — optional desktop wrapper
- **Vitest 3** + **@testing-library/react** — testing
- **lucide-react** — icons

## Commands

```sh
npm run dev          # Vite dev server (localhost:5173)
npm run dev:electron # Vite + Electron concurrently
npm run build        # TypeScript check + Vite production build
npm run build:electron # Build web + compile Electron TS
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
  App.tsx            # Root app shell, routing, shared state
  components/        # Studio, reader, player, settings, local runtime UI
  hooks/             # Model loading, playback, generation, routing, creator state
  lib/               # Audio, chunking, captions, cache, browser/runtime helpers
  workers/           # Browser inference workers for Kokoro, Supertonic, export
  types.ts           # Worker protocol + shared UI types

electron/            # Desktop shell, security, protocol, preload, Python runtime helpers
python/              # Local TTS bridge for NeuTTS Nano and Kani-TTS-2
```

## Key Patterns

- **Worker protocol**: `WorkerInMessage` (LOAD, GENERATE, CANCEL) and `WorkerOutMessage` (LOAD_PROGRESS, READY, AUDIO_CHUNK, GENERATION_COMPLETE, ERROR) — defined in `src/types.ts`.
- **Audio playback**: Uses Web Audio API (`AudioContext` + `createBufferSource`), NOT `<audio>` element. Chunks scheduled with `source.start(nextPlayTime)`.
- **WAV encoding**: IEEE Float 32-bit PCM (AudioFormat = 3). Sample rate comes from model output, never hardcoded.
- **Kokoro voices**: `list_voices()` may return void in some kokoro-js versions — always use fallback array.
- **Kokoro generation**: Worker splits text via local `split()` and calls `tts.generate(string, ...)` per sentence (no `tts.stream()`). Voice param is a strict literal union — cast with `as any`.
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

Flat, minimal design with subtle ambient background treatment.
- **Fonts**: Self-hosted via `@fontsource-variable` (Inter, Outfit, JetBrains Mono) — no external CDN.
  - `font-sans` (Inter) — body text
  - `font-display` (Outfit) — headings/display
  - `font-mono` (JetBrains Mono) — stats, code, numeric values
- **Colors**: `--color-surface` #F5F5F7, `--color-panel` #FFFFFF, `--color-accent` #0071E3, `--color-text-primary` #1D1D1F
- **Shadows**: `--shadow-xs/sm/md/lg` (neutral), `--shadow-accent-sm/md/lg` (blue-tinted) — use Tailwind classes `shadow-md`, `shadow-accent-sm`, etc.
- **Icon sizes**: xs=12px (tight buttons), sm=14px (standard controls), md=16px (standalone buttons) — all via lucide-react `size` prop.
- Full palette defined as CSS `@theme` variables for Tailwind. No hardcoded colors — use `color-mix()` or tokens.

## Models

| Model | ID | Library | Sample Rate | Voices |
|---|---|---|---|---|
| Kokoro-82M | `onnx-community/Kokoro-82M-v1.0-ONNX` | kokoro-js | 24000 Hz | 24 named voices |
| Supertonic | `onnx-community/Supertonic-TTS-2-ONNX` | @huggingface/transformers | 44100 Hz | F1–F5, M1–M5 (10 voices) |

## Maintenance Notes

- Keep `.venv313` and `.venv-neutts` unchanged during normal cleanup work.
- If you revisit Python env dedupe, test any `Janome` or `wandb` pruning in a disposable `.venv313` copy first, or rebuild both envs with a shared-link workflow such as `uv` before changing the runtime defaults.

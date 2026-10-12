# Performance Benchmarks

Open TTS includes a reproducible inference-speed benchmark that runs the same browser Web Worker inference path used by the app. It covers Kokoro, Supertonic 2, and Supertonic 3 (`--model both` is Kokoro plus Supertonic 2; `--model all` is every browser runtime); it does not benchmark Kitten, Paradee, Piper, Chatterbox Turbo, Audio8, Qwen, or NeuTTS. Run `npm run eval:inference -- --help` for every option.

```bash
npm run eval:inference
npm run eval:inference -- --model kokoro --iterations 3 --warmups 1
npm run eval:inference -- --model supertonic --iterations 3 --warmups 1
npm run eval:inference -- --model supertonic3 --iterations 3 --warmups 1
```

Use `--warmups 0` to measure without a warm-up run. The JSON report is still written when a requested model fails, but the CLI exits nonzero so automation cannot mistake a partial or failed benchmark for success.

The eval launches a hidden, unthrottled Electron window, mirrors the desktop WebGPU switches (including Vulkan on Linux), serves `public/inference-speed.html` through Vite, loads the selected model, runs warmups, and records:

- generation latency
- first-chunk latency
- characters per second
- real-time factor
- backend
- WebGPU status

Each model also records a cold load (the first `LOAD` on a fresh worker, which downloads only if the cache is empty), a warm load (a second fresh worker, served from the cache), and first audio (the first chunk of the first generation after the warm load); generations then run on the warm worker. Supertonic 3 uses voice M1, English, and seed 0. Reports use schema 4, so they do not compare with schema 3 baselines.

Reports are written to `reports/inference-speed/*.json`. Compare against a saved baseline with:

```bash
npm run eval:inference -- --baseline reports/inference-speed/example.json
```

Baseline checks are strict and per model. A speed percentage is emitted only when both reports have successful measurements and the same report schema, model identifier and immutable revision, backend, voice, selected model set, input text, warm-up and measured iteration counts, quality, speed, Electron/Chromium/OS user agent, cross-origin isolation state, hidden-window throttling mode, WebGPU feature switches, host platform/architecture/CPU/memory fingerprint, and WebGPU status. A failed or missing model is recorded as `skipped`; any missing or different compatibility field is recorded as `incompatible`, with reasons in both the CLI output and JSON report. Older reports without the strict fingerprint fields are therefore not used for speed claims.

## Interpreting results

- The harness verifies every recorded compatibility field, including the pinned model revision, before comparing. You must still keep unrecorded conditions the same, especially cache state, background load, thermal state, power mode, and the physical GPU/driver behind a WebGPU backend.
- Treat first-load measurements separately from warm resident inference. Model downloads and graph compilation can dominate a cold run.
- Use first-chunk latency for responsiveness and real-time factor for sustained throughput. An RTF below `1.0` means generation is faster than the resulting audio duration.
- Run enough measured iterations to expose variance, and retain the raw JSON rather than only an average.
- Keep dated machine-specific results in `reports/inference-speed/` rather than presenting them as universal numbers in the top-level README.

## First-chunk ramp and the Kokoro context guard

To start speech sooner, the first chunk of a Kokoro or Supertonic generation is capped (140 and 160 characters) and later chunks double until they reach the full size. The consequence is that the first one or two Reader sections of those engines are shorter, and Reader audio cached under the old boundaries regenerates those sections once. Kokoro also guards its 512 phoneme-token context: a passage over the limit is split at natural boundaries instead of being silently truncated. Parts are concatenated without an added gap, so a pronunciation rule that spans the split point stops applying (rare).

Supertonic 3 uses `onnxruntime-web/webgpu` with the asyncify WASM build (the same as Transformers.js), warms WebGPU up before reporting ready, and overlaps its downloads with session creation; it runs about 7x faster than the WASM fallback it used to take, with first audio in roughly 0.3 s on Apple GPUs. The default `onnxruntime-web` entry needs the JSEP build instead.

## Export and Reader cache costs

Exports stream chunk by chunk through a precomputed polyphase resampler (about 10x faster than the previous filter). A plain export takes about 0.45 s per minute of audio; heavy-limiting loudness mastering takes up to four passes, about 2 s per minute at 48 kHz on the development machine, so a long book takes minutes and reports progress. Peak worker memory is the source PCM plus the encoded output. Reader audio caching skips unchanged PCM on restore and gaps, saves streaming sections about every 30 s, and compares metadata instead of reading audio, so a section is written once or a few times rather than at every chunk. Reading progress is a separate small record, written at most every 5 s while playing.

## Native Qwen evaluation

Qwen3-TTS runs inside the resident Rust bridge, outside the browser eval harness. Any Qwen report should identify:

- Open TTS version and commit
- Qwen profile and immutable upstream revision
- provider (`MLX/Metal`, `LibTorch CUDA`, or `LibTorch CPU`)
- machine, memory, OS, and GPU/driver details
- cold load time, first-audio latency, wall time, audio duration, RTF, and chunk count
- input text, speaker/language, sampling settings, warm-up count, and measured iterations

Do not compare Qwen native results with browser-model evals or measurements from the removed pre-v1.2 child-server/adapter architecture. Those paths have different loading, streaming, and transport costs.

## Native Audio8 evaluation

Audio8 runs on the CPU through `onnxruntime-node` in an Electron worker thread, outside both the browser eval harness and the Rust bridge. Any Audio8 report should identify:

- Open TTS version and commit
- pinned model revision and the voice used
- machine, CPU, and memory, plus the intra-op thread count the runtime selected (up to four Apple performance cores on arm64 macOS, `min(6, availableParallelism())` elsewhere)
- whether assets were already cached or downloaded during the run, and the load time separately from generation
- generation wall time, produced audio duration, and RTF
- the input text and its length, since the renderer splits at 180 characters and every chunk re-prefills the voice-reference prompt before its first token

`scripts/benchmark-native-runtimes.cjs` measures Audio8 load time, time to first audio, and real-time factor, together with the machine, and writes a JSON report. Audio8 does not stream, so first audio equals wall time, and RTF is wall time over audio time.

```bash
npm run build:electron:main && OPEN_TTS_AUDIO8_MODEL_DIR=<userData>/local-model-cache/audio8/<revision> \
  node scripts/benchmark-native-runtimes.cjs [--runs N] [--warmup N] [--voice id] [--seed n] [--temperature t] [--output file]
```

One compiled-worker smoke run on an M1 Pro, from a warm cache, produced 3.715 seconds of audio for a 49-character sentence in 6.23 seconds with four inference threads — an RTF of 1.68 — and loaded the sessions in 2.46 seconds. The six-thread comparison took 7.28 seconds and reached 1.96 RTF, confirming that these INT4 graphs become memory-bandwidth bound above four threads. This is one machine and one sentence, so it sets expectations for a CPU-only runtime rather than serving as a universal baseline. Run `npm run test:audio8-smoke` with `OPEN_TTS_AUDIO8_MODEL_DIR` pointing at a complete cached revision to reproduce the measurement on another system.

## Release validation

Performance observations complement correctness checks; they do not replace them. Before release, run:

```bash
npm run lint
npm run test
npm run build
```

For desktop releases, also run `npm run build:desktop` on each supported provider platform, or build the packaged artifact with `npm run dist`.

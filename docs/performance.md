# Performance Benchmarks

Open TTS includes a reproducible inference-speed benchmark that runs the same browser Web Worker inference path used by the app. It currently covers Kokoro and Supertonic 2; it does not benchmark the Electron-only Supertonic 3, Qwen, or NeuTTS runtimes.

```bash
npm run eval:inference
npm run eval:inference -- --model kokoro --iterations 3 --warmups 1
npm run eval:inference -- --model supertonic --iterations 3 --warmups 1
```

Use `--warmups 0` to measure without a warm-up run. The JSON report is still written when a requested model fails, but the CLI exits nonzero so automation cannot mistake a partial or failed benchmark for success.

The eval launches a hidden, unthrottled Electron window, mirrors the desktop WebGPU switches (including Vulkan on Linux), serves `public/inference-speed.html` through Vite, loads the selected model, runs warmups, and records:

- generation latency
- first-chunk latency
- characters per second
- real-time factor
- backend
- WebGPU status

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

## Native Qwen evaluation

Qwen3-TTS runs inside the resident Rust bridge, outside the browser eval harness. Any Qwen report should identify:

- Open TTS version and commit
- Qwen profile and immutable upstream revision
- provider (`MLX/Metal`, `LibTorch CUDA`, or `LibTorch CPU`)
- machine, memory, OS, and GPU/driver details
- cold load time, first-audio latency, wall time, audio duration, RTF, and chunk count
- input text, speaker/language, sampling settings, warm-up count, and measured iterations

Do not compare Qwen native results with browser-model evals or measurements from the removed pre-v1.2 child-server/adapter architecture. Those paths have different loading, streaming, and transport costs.

## Release validation

Performance observations complement correctness checks; they do not replace them. Before release, run:

```bash
npm run lint
npm run test
npm run build
```

For desktop releases, also run `npm run build:desktop` on each supported provider platform, or build the packaged artifact with `npm run dist`.

# Performance Benchmarks

Open TTS includes a reproducible inference-speed benchmark that runs the same Web Worker inference path used by the app.

```bash
npm run eval:inference
npm run eval:inference -- --model kokoro --iterations 3 --warmups 1
npm run eval:inference -- --model supertonic --iterations 3 --warmups 1
```

The eval launches a hidden Electron window, serves `public/inference-speed.html` through Vite, loads the selected model, runs warmups, and records:

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

Keep dated machine-specific results in `reports/inference-speed/` rather than in the top-level README.

#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const modelDir = process.env.OPEN_TTS_AUDIO8_MODEL_DIR;
if (!modelDir) {
  throw new Error(
    "Set OPEN_TTS_AUDIO8_MODEL_DIR to a downloaded Audio8 revision directory before running this smoke test.",
  );
}
if (!fs.existsSync(modelDir)) throw new Error(`Audio8 model directory does not exist: ${modelDir}`);

const { Audio8NativeClient } = require(path.resolve("dist-electron/audio8NativeClient.js"));
const client = new Audio8NativeClient(modelDir);

async function main() {
  const loadStarted = performance.now();
  const loaded = await client.load("smoke-load", () => undefined);
  const loadSeconds = (performance.now() - loadStarted) / 1000;
  const generationStarted = performance.now();
  const generated = await client.generate(
    "smoke-generate",
    "Local Audio8 inference is working on this computer.",
    "clara",
    () => undefined,
  );
  const wallSeconds = (performance.now() - generationStarted) / 1000;
  if (!(generated.audio instanceof ArrayBuffer)) throw new Error("Audio8 smoke test returned no audio buffer.");
  if (!Number.isFinite(generated.sampleRate) || generated.sampleRate <= 0) throw new Error("Audio8 smoke test returned an invalid sample rate.");
  const samples = generated.audio.byteLength / Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isInteger(samples) || samples <= 0) throw new Error("Audio8 smoke test returned an empty audio buffer.");
  const audioSeconds = samples / generated.sampleRate;
  const result = {
    modelDir,
    sampleRate: generated.sampleRate,
    samples,
    audioSeconds: Number(audioSeconds.toFixed(3)),
    loadSeconds: Number(loadSeconds.toFixed(3)),
    inferenceSeconds: Number((generated.elapsedSec ?? wallSeconds).toFixed(3)),
    wallSeconds: Number(wallSeconds.toFixed(3)),
    realTimeFactor: Number((wallSeconds / audioSeconds).toFixed(3)),
    readySampleRate: loaded.sampleRate,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main()
  .finally(() => client.destroy())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });

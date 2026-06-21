import { describe, expect, it } from "vitest";
import {
  buildQwen3BridgePayload,
  formatQwen3ProfileConsoleLines,
  parseQwen3ProfileArgs,
  summarizeQwen3ProfileRuns,
  toQwen3BridgeProfileRun,
} from "./qwen3Profiling";
import type { BridgeGenerateResult } from "./localTtsIpc";

const RESULT: BridgeGenerateResult = {
  sampleRate: 24_000,
  modelRepo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
  durationSec: 3,
  elapsedSec: 4.2,
  device: "metal",
  audioTransport: "websocket-binary",
  audioChunkCount: 2,
  phaseTimingsSec: {
    modelLoadSec: 0.7,
    firstAudioSec: 1.1,
    inferenceSec: 2.9,
    outputEncodingSec: 0.2,
  },
};

describe("parseQwen3ProfileArgs", () => {
  it("parses benchmark targets and runtime options", () => {
    const options = parseQwen3ProfileArgs([
      "--target=candle,mlx-api,sglang",
      "--iterations=4",
      "--warmups=2",
      "--timeout-ms=120000",
      "--text=Hello Qwen.",
      "--base-model-path=/models/qwen3-mlx",
      "--sglang-url=http://127.0.0.1:8000/v1/audio/speech",
    ]);

    expect(options.targets).toEqual(["candle", "mlx-api", "sglang"]);
    expect(options.iterations).toBe(4);
    expect(options.warmups).toBe(2);
    expect(options.timeoutMs).toBe(120_000);
    expect(options.text).toBe("Hello Qwen.");
    expect(options.baseModelPath).toBe("/models/qwen3-mlx");
    expect(options.sglangUrl).toBe("http://127.0.0.1:8000/v1/audio/speech");
  });

  it("rejects unknown benchmark targets", () => {
    expect(() => parseQwen3ProfileArgs(["--target=banana"]))
      .toThrow("Unsupported Qwen3 profile target");
  });
});

describe("buildQwen3BridgePayload", () => {
  it("builds a Candle CustomVoice payload", () => {
    const payload = buildQwen3BridgePayload("candle", {
      text: "Benchmark text.",
      speaker: "Ryan",
      language: "English",
      instruct: "Calm narration",
      deviceMap: "metal",
      dtype: "bfloat16",
      maxNewTokens: 1024,
    });

    expect(payload).toMatchObject({
      text: "Benchmark text.",
      modelRepo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
      speaker: "Ryan",
      language: "English",
      instruct: "Calm narration",
      deviceMap: "metal",
      dtype: "bfloat16",
      maxNewTokens: 1024,
    });
    expect(payload).not.toHaveProperty("baseModelPath");
  });

  it("builds an MLX api_server CustomVoice payload with a local model directory", () => {
    const payload = buildQwen3BridgePayload("mlx-api", {
      text: "Benchmark text.",
      baseModelPath: "/models/qwen3-mlx",
    });

    expect(payload).toMatchObject({
      text: "Benchmark text.",
      modelRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
      baseModelPath: "/models/qwen3-mlx",
      speaker: "Ryan",
      language: "English",
    });
  });
});

describe("toQwen3BridgeProfileRun", () => {
  it("extracts per-run bridge metrics and wall-clock RTF", () => {
    const run = toQwen3BridgeProfileRun({
      target: "candle",
      iteration: 1,
      warmup: false,
      text: "Hello world.",
      wallSec: 4.5,
      result: RESULT,
    });

    expect(run).toMatchObject({
      target: "candle",
      backend: "candle",
      modelRepo: RESULT.modelRepo,
      device: "metal",
      textLength: 12,
      durationSec: 3,
      wallSec: 4.5,
      elapsedSec: 4.2,
      rtf: 1.5,
      bridgeRtf: 1.4,
      audioChunkCount: 2,
      modelLoadSec: 0.7,
      firstAudioSec: 1.1,
      inferenceSec: 2.9,
      outputEncodingSec: 0.2,
    });
  });
});

describe("summarizeQwen3ProfileRuns", () => {
  it("summarizes measured runs and excludes warmups", () => {
    const runs = [
      toQwen3BridgeProfileRun({
        target: "candle",
        iteration: 1,
        warmup: true,
        text: "Hello world.",
        wallSec: 10,
        result: { ...RESULT, durationSec: 2, audioChunkCount: 1 },
      }),
      toQwen3BridgeProfileRun({
        target: "candle",
        iteration: 2,
        warmup: false,
        text: "Hello world.",
        wallSec: 4,
        result: { ...RESULT, durationSec: 2, audioChunkCount: 2 },
      }),
      toQwen3BridgeProfileRun({
        target: "candle",
        iteration: 3,
        warmup: false,
        text: "Hello world.",
        wallSec: 8,
        result: { ...RESULT, durationSec: 4, audioChunkCount: 3 },
      }),
    ];

    expect(summarizeQwen3ProfileRuns(runs)).toEqual({
      measuredRuns: 2,
      meanWallSec: 6,
      meanElapsedSec: 4.2,
      meanRtf: 2,
      meanBridgeRtf: 1.575,
      meanFirstAudioSec: 1.1,
      meanModelLoadSec: 0.7,
      meanInferenceSec: 2.9,
      totalAudioChunks: 5,
    });
  });
});

describe("formatQwen3ProfileConsoleLines", () => {
  it("prints report path, target summary, and target errors", () => {
    const run = toQwen3BridgeProfileRun({
      target: "candle",
      iteration: 1,
      warmup: false,
      text: "Hello world.",
      wallSec: 4.5,
      result: RESULT,
    });

    expect(formatQwen3ProfileConsoleLines({
      runner: {
        generatedAt: "2026-06-21T10:00:00.000Z",
        platform: "darwin",
        arch: "arm64",
        node: "v22.12.0",
        cwd: "/repo",
        bridgeBinary: "/repo/dist-rust/open-tts-local-bridge",
        cacheDir: "/repo/.model-cache/qwen3-profile",
      },
      options: {
        targets: ["candle", "sglang"],
        iterations: 1,
        warmups: 0,
        timeoutMs: 900_000,
        textLength: 12,
        speaker: "Ryan",
        language: "English",
        deviceMap: "auto",
        dtype: "auto",
        attnImplementation: "eager",
      },
      targets: [
        {
          target: "candle",
          backend: "candle",
          runs: [run],
          summary: summarizeQwen3ProfileRuns([run]),
        },
        {
          target: "sglang",
          backend: "sglang",
          runs: [],
          summary: null,
          error: "SGLang target requires --sglang-url.",
        },
      ],
    }, "/repo/reports/qwen3-profile/example.json")).toEqual([
      "Qwen3 profile report: /repo/reports/qwen3-profile/example.json",
      "candle: mean wall 4.500s, RTF 1.500, first audio 1.100s, model load 0.700s, inference 2.900s, chunks 2",
      "sglang: ERROR SGLang target requires --sglang-url.",
    ]);
  });
});

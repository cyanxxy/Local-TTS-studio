// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_RESULT_PREFIX,
  assertLocalModel,
  assertTrustedIpcSender,
  isRecord,
  isStringArray,
  parseBridgeEnvelopeResult,
  parseBridgeGenerateResult,
  parseBridgeProbeResult,
  parseBridgeProgressResult,
  parseBridgeResult,
  parseBridgeWarmResult,
  parseOptionalInteger,
  parseOptionalNumber,
  parseOptionalString,
  parseOptionalStringArray,
  parseRequestId,
  parseRequiredText,
  sanitizeCacheRequest,
  sanitizeCancelRequest,
  sanitizeGeneratePayload,
  sanitizeWarmRequest,
} from "./localTtsIpc";

function makeEvent(url: string, frameUrl?: string) {
  return {
    senderFrame: frameUrl === undefined ? undefined : { url: frameUrl },
    sender: {
      getURL: () => url,
    },
  };
}

describe("localTtsIpc sender and primitive parsers", () => {
  it("accepts trusted app senders and rejects untrusted IPC senders", () => {
    expect(() => assertTrustedIpcSender(makeEvent("https://evil.test", "app://-/studio") as never)).not.toThrow();
    expect(() => assertTrustedIpcSender(makeEvent("http://localhost:5173/qwen3") as never)).not.toThrow();
    expect(() => assertTrustedIpcSender(
      makeEvent("http://localhost:5173/qwen3") as never,
      { allowDevServer: false },
    )).toThrow("Rejected IPC");
    expect(() => assertTrustedIpcSender(makeEvent("https://example.com") as never)).toThrow("Rejected IPC");
  });

  it("validates local model identifiers and records", () => {
    expect(assertLocalModel("neutts")).toBe("neutts");
    expect(assertLocalModel("qwen3")).toBe("qwen3");
    expect(() => assertLocalModel("kani")).toThrow("Unsupported local model");
    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(["nope"])).toBe(false);
  });

  it("parses required and optional text, numeric, and request fields", () => {
    expect(parseRequiredText("  hello  ", "text")).toBe("hello");
    expect(() => parseRequiredText(1, "text")).toThrow("must be a string");
    expect(() => parseRequiredText("  ", "text")).toThrow("is required");
    expect(() => parseRequiredText("abcd", "text", 3)).toThrow("exceeds 3 characters");

    expect(parseOptionalString(undefined, "voice")).toBeUndefined();
    expect(parseOptionalString(" GPU ", "device", { pattern: /^(cpu|gpu)$/i })).toBe("GPU");
    expect(() => parseOptionalString(123, "voice")).toThrow("must be a string");
    expect(() => parseOptionalString("abcd", "voice", { maxLength: 3 })).toThrow("exceeds 3 characters");
    expect(() => parseOptionalString("metal", "device", { pattern: /^(cpu|gpu)$/i })).toThrow("invalid format");

    expect(parseOptionalNumber(1.25, "temperature", { min: 0, max: 2 })).toBe(1.25);
    expect(() => parseOptionalNumber(Number.NaN, "temperature", { min: 0, max: 2 })).toThrow("finite number");
    expect(() => parseOptionalNumber(-1, "temperature", { min: 0, max: 2 })).toThrow("between 0 and 2");

    expect(parseOptionalInteger(8, "maxNewTokens", { min: 1, max: 10 })).toBe(8);
    expect(() => parseOptionalInteger(1.5, "maxNewTokens", { min: 1, max: 10 })).toThrow("integer");
    expect(() => parseOptionalInteger(11, "maxNewTokens", { min: 1, max: 10 })).toThrow("between 1 and 10");

    expect(parseRequestId(undefined)).toBeUndefined();
    expect(parseRequestId(" request-1.2_ok ")).toBe("request-1.2_ok");
    expect(() => parseRequestId(undefined, { required: true })).toThrow("required");
    expect(() => parseRequestId(1)).toThrow("must be a string");
    expect(() => parseRequestId("x".repeat(121))).toThrow("exceeds 120");
    expect(() => parseRequestId("bad/id")).toThrow("may contain only");
    expect(() => parseRequestId("bad..id")).toThrow("consecutive dots");

    expect(parseOptionalStringArray(["a", "b"], "warnings")).toEqual(["a", "b"]);
    expect(() => parseOptionalStringArray(["a", 1], "warnings")).toThrow("array of strings");
    expect(isStringArray(["speaker"])).toBe(true);
    expect(isStringArray(["speaker", 1])).toBe(false);
  });
});

describe("localTtsIpc request sanitizers", () => {
  it("sanitizes NeuTTS Rust payloads with pre-encoded reference codes", () => {
    expect(sanitizeGeneratePayload("neutts", {
      text: "  Hello from NeuTTS. ",
      referenceText: " Reference transcript. ",
      referenceCodesBase64: " AQID ",
      modelRepo: "neuphonic/neutts-nano-q8-gguf",
    })).toEqual({
      text: "Hello from NeuTTS.",
      referenceText: "Reference transcript.",
      referenceCodesBase64: "AQID",
      modelRepo: "neuphonic/neutts-nano-q8-gguf",
    });

    expect(sanitizeGeneratePayload("neutts", {
      text: "Hello from NeuTTS.",
      referenceText: "Reference transcript.",
      referenceAudioBase64: " UklGRg== ",
      modelRepo: "neuphonic/neutts-nano-q8-gguf",
    })).toEqual({
      text: "Hello from NeuTTS.",
      referenceText: "Reference transcript.",
      referenceAudioBase64: "UklGRg==",
      modelRepo: "neuphonic/neutts-nano-q8-gguf",
    });

    expect(() => sanitizeGeneratePayload("neutts", {
      text: "Hello",
      referenceText: "ref",
    })).toThrow("referenceCodesBase64");
    expect(() => sanitizeGeneratePayload("neutts", {
      text: "Hello",
      referenceText: "ref",
      referenceCodesBase64: "x".repeat(25_000_001),
    })).toThrow("exceeds 25000000");
    expect(() => sanitizeGeneratePayload("neutts", {
      text: "Hello",
      referenceText: "ref",
      referenceAudioBase64: "x".repeat(60_000_001),
    })).toThrow("exceeds 60000000");
    expect(() => sanitizeGeneratePayload("neutts", {
      text: "Hello",
      referenceText: "ref",
      referenceCodesBase64: "abc",
      modelRepo: "neuphonic/neutts-nano",
    })).toThrow("Unsupported NeuTTS");
  });

  it("sanitizes Qwen3 Rust payloads", () => {
    const customRepo = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
    const baseRepo = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
    expect(sanitizeGeneratePayload("qwen3", {
      text: "  Hello from Qwen. ",
      mode: "customVoice",
      modelRepo: customRepo,
      modelPath: " /models/qwen3-customvoice ",
      speaker: "Aiden",
      language: "Italian",
      instruct: "Warm narration.",
      temperature: 0.75,
      topK: 64,
      maxNewTokens: 2304,
    }, "darwin")).toEqual({
      text: "Hello from Qwen.",
      mode: "customVoice",
      modelRepo: customRepo,
      modelPath: "/models/qwen3-customvoice",
      speaker: "Aiden",
      language: "Italian",
      instruct: "Warm narration.",
      temperature: 0.75,
      topK: 64,
      maxNewTokens: 2304,
    });

    expect(sanitizeGeneratePayload("qwen3", {
      text: "Built-in speaker.",
      mode: "customVoice",
      modelRepo: customRepo,
      modelPath: " /models/qwen3-customvoice-6bit ",
      speaker: "Ryan",
      language: "Russian",
    }, "darwin")).toMatchObject({
      text: "Built-in speaker.",
      mode: "customVoice",
      modelRepo: customRepo,
      modelPath: "/models/qwen3-customvoice-6bit",
      speaker: "Ryan",
      language: "Russian",
    });

    expect(sanitizeGeneratePayload("qwen3", {
      text: "Clone this.",
      mode: "voiceClone",
      modelRepo: baseRepo,
      modelPath: " /models/qwen3-base-6bit ",
      referenceText: "Exact reference words.",
      referenceAudioBase64: " AQID ",
      language: "Portuguese",
      topK: 30,
    }, "darwin")).toMatchObject({
      text: "Clone this.",
      mode: "voiceClone",
      modelRepo: baseRepo,
      modelPath: "/models/qwen3-base-6bit",
      referenceText: "Exact reference words.",
      referenceAudioBase64: "AQID",
      language: "Portuguese",
      topK: 30,
    });

    const valid = { text: "Hello", mode: "customVoice", modelRepo: customRepo, modelPath: "/model" };
    for (const removedField of ["deviceMap", "dtype", "attnImplementation", "topP", "baseModelPath"]) {
      expect(() => sanitizeGeneratePayload("qwen3", { ...valid, [removedField]: "removed" }, "darwin"))
        .toThrow(`Unknown Qwen3-TTS field: \`${removedField}\``);
    }
    expect(() => sanitizeGeneratePayload("qwen3", { ...valid, topK: 1001 }, "darwin"))
      .toThrow("between 0 and 1000");
    expect(() => sanitizeGeneratePayload("qwen3", { ...valid, mode: "voiceClone" }, "darwin"))
      .toThrow("does not match");
    expect(() => sanitizeGeneratePayload("qwen3", valid, "win32"))
      .toThrow("unavailable on win32");
    expect(() => sanitizeGeneratePayload("qwen3", { ...valid, extra: true }, "darwin"))
      .toThrow("Unknown Qwen3-TTS field");
  });

  it("sanitizes cache and cancellation requests", () => {
    expect(sanitizeCacheRequest({ model: "neutts" })).toEqual({ model: "neutts" });
    expect(sanitizeCancelRequest({ model: "qwen3", requestId: "req-1" })).toEqual({
      model: "qwen3",
      requestId: "req-1",
    });
    expect(() => sanitizeCacheRequest({ model: "kani" })).toThrow("Unsupported local model");
    expect(() => sanitizeCancelRequest({ model: "qwen3" })).toThrow("required");
  });

  it("sanitizes warm-up requests", () => {
    expect(sanitizeWarmRequest({ model: "qwen3", mode: "customVoice", modelPath: "/models/qwen3" })).toEqual({
      model: "qwen3",
      payload: { mode: "customVoice", modelPath: "/models/qwen3" },
    });
    expect(() => sanitizeWarmRequest({ model: "qwen3" })).toThrow("Unsupported Qwen3-TTS mode");
    expect(() => sanitizeWarmRequest({ model: "kani" })).toThrow("Unsupported local model");
    expect(() => sanitizeWarmRequest({ model: "qwen3", mode: "customVoice", modelPath: "a".repeat(1001) }))
      .toThrow("exceeds 1000 characters");
    expect(() => sanitizeWarmRequest(null)).toThrow("Invalid warm request payload");
    expect(() => sanitizeWarmRequest({ model: "qwen3", mode: "customVoice", modelPath: "/model", topP: 0.9 }))
      .toThrow("Unknown Qwen3-TTS warm-up field");
  });
});

describe("localTtsIpc bridge result parsing", () => {
  const probeResult = {
    ready: true,
    message: "Qwen3 Rust runtime is ready.",
    runtime: "rust",
    package: "qwen3-tts-rs",
    packageVersion: "0.2.2",
    upstreamRevision: "288a716ce38a91c826dd67968c75d1dd4b0f07bc",
    provider: "mlx",
    warnings: [],
    recommendedModelRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
    recommendedBaseModelRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit",
  };

  const generateResult = {
    sampleRate: 24000,
    modelRepo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    durationSec: 1.25,
    elapsedSec: 0.5,
    device: "metal",
    warnings: ["using Metal"],
    audioTransport: "websocket-binary",
    audioChunkCount: 1,
    phaseTimingsSec: {
      modelLoadSec: 0.1,
      inferenceSec: 0.4,
    },
  };

  it("parses Rust probe responses", () => {
    expect(parseBridgeProbeResult(probeResult)).toEqual(probeResult);
    expect(() => parseBridgeProbeResult({ ...probeResult, runtime: "node" })).toThrow("Rust runtime marker");
    expect(() => parseBridgeProbeResult({ ...probeResult, ready: "yes" })).toThrow("ready");
    expect(() => parseBridgeProbeResult({ ...probeResult, package: 1 })).toThrow("package");
    expect(() => parseBridgeProbeResult({ ...probeResult, provider: 1 })).toThrow("provider");
  });

  it("parses warm-up envelopes without throwing", () => {
    expect(parseBridgeWarmResult({
      type: "result",
      requestId: "qwen3-warm-1",
      ok: true,
      result: { warmed: true, message: "Qwen3 model is loaded in the resident Rust bridge." },
    })).toEqual({ warmed: true, message: "Qwen3 model is loaded in the resident Rust bridge." });
    expect(parseBridgeWarmResult({ ok: true, result: { warmed: false } })).toEqual({ warmed: false });
    expect(parseBridgeWarmResult({ ok: false, error: "model missing" }))
      .toEqual({ warmed: false, message: "model missing" });
    expect(parseBridgeWarmResult({ ok: true, result: { warmed: "yes" } }).warmed).toBe(false);
    expect(parseBridgeWarmResult(null).warmed).toBe(false);
  });

  it("parses progress and WebSocket generation responses", () => {
    expect(parseBridgeProgressResult({
      phase: "model_load",
      message: "Loading model.",
      elapsedSec: 0.25,
    })).toEqual({
      phase: "model_load",
      message: "Loading model.",
      elapsedSec: 0.25,
    });
    expect(() => parseBridgeProgressResult({ phase: "", message: "x" })).toThrow("phase");
    expect(parseBridgeGenerateResult(generateResult)).toEqual(generateResult);
    expect(() => parseBridgeGenerateResult({ ...generateResult, wavBase64: "abc" })).toThrow("wavBase64");
    expect(() => parseBridgeGenerateResult({ ...generateResult, audioTransport: "base64" })).toThrow("audioTransport");
    expect(() => parseBridgeGenerateResult({ ...generateResult, phaseTimingsSec: { bad: -1 } })).toThrow("phaseTimingsSec");
  });

  it("parses one-shot probe envelopes and rejects one-shot generate results", () => {
    const probeEnvelope = `${BRIDGE_RESULT_PREFIX}${JSON.stringify({ ok: true, result: probeResult })}`;
    expect(parseBridgeResult(`noise\n${probeEnvelope}\n`, "", "probe")).toEqual(probeResult);

    const generateEnvelope = `${BRIDGE_RESULT_PREFIX}${JSON.stringify({ ok: true, result: generateResult })}`;
    expect(() => parseBridgeResult(generateEnvelope, "", "generate"))
      .toThrow("One-shot generate bridge results are not supported");
    expect(() => parseBridgeResult("", "stderr text", "probe")).toThrow("stderr text");
    expect(() => parseBridgeResult(`${BRIDGE_RESULT_PREFIX}{bad`, "", "probe")).toThrow("Failed parsing");
    expect(() => parseBridgeResult(`${BRIDGE_RESULT_PREFIX}${JSON.stringify({ ok: false, error: "Bridge failed" })}`, "", "probe"))
      .toThrow("Bridge failed");
  });

  it("parses WebSocket envelopes", () => {
    expect(parseBridgeEnvelopeResult({ ok: true, result: generateResult }, "generate")).toEqual(generateResult);
    expect(parseBridgeEnvelopeResult({ ok: true, result: probeResult }, "probe")).toEqual(probeResult);
    expect(() => parseBridgeEnvelopeResult({ ok: false, error: "request failed" }, "generate"))
      .toThrow("request failed");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => parseBridgeEnvelopeResult({
      ok: false,
      error: "request failed",
      details: "stack",
    }, "generate")).toThrow("request failed");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("local bridge details\nstack"));
    errorSpy.mockRestore();
  });
});

// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_RESULT_PREFIX,
  assertLocalModel,
  assertTrustedIpcSender,
  extractUserFacingPythonProcessError,
  isRecord,
  isStringArray,
  parseBridgeGenerateResult,
  parseBridgeProbeResult,
  parseBridgeProgressResult,
  parseBridgeResult,
  parseOptionalInteger,
  parseOptionalNumber,
  parseOptionalString,
  parseOptionalStringArray,
  parseRequestId,
  parseRequiredText,
  sanitizeCacheRequest,
  sanitizeCancelRequest,
  sanitizeGeneratePayload,
} from "./localTtsIpc";

const pythonResolution = {
  pythonBinary: "/venv/bin/python",
  resolvedFrom: "request",
};

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
    expect(() => assertTrustedIpcSender(makeEvent("http://localhost:5173/kani") as never)).not.toThrow();
    expect(() => assertTrustedIpcSender(
      makeEvent("http://localhost:5173/kani") as never,
      { allowDevServer: false },
    )).toThrow("Rejected IPC");
    expect(() => assertTrustedIpcSender(makeEvent("https://example.com") as never)).toThrow("Rejected IPC");
  });

  it("validates local model identifiers and records", () => {
    expect(assertLocalModel("neutts")).toBe("neutts");
    expect(assertLocalModel("kani")).toBe("kani");
    expect(assertLocalModel("qwen3")).toBe("qwen3");
    expect(() => assertLocalModel("remote")).toThrow("Unsupported local model");
    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(["nope"])).toBe(false);
  });

  it("parses required and optional text fields", () => {
    expect(parseRequiredText("  hello  ", "text")).toBe("hello");
    expect(() => parseRequiredText(1, "text")).toThrow("must be a string");
    expect(() => parseRequiredText("  ", "text")).toThrow("is required");
    expect(() => parseRequiredText("abcd", "text", 3)).toThrow("exceeds 3 characters");

    expect(parseOptionalString(undefined, "voice")).toBeUndefined();
    expect(parseOptionalString(null, "voice")).toBeUndefined();
    expect(parseOptionalString("  ", "voice")).toBeUndefined();
    expect(parseOptionalString(" GPU ", "device", { pattern: /^(cpu|gpu)$/i })).toBe("GPU");
    expect(() => parseOptionalString(123, "voice")).toThrow("must be a string");
    expect(() => parseOptionalString("abcd", "voice", { maxLength: 3 })).toThrow("exceeds 3 characters");
    expect(() => parseOptionalString("metal", "device", { pattern: /^(cpu|gpu)$/i })).toThrow("invalid format");
  });

  it("parses optional numeric fields and request identifiers", () => {
    expect(parseOptionalNumber(undefined, "temperature", { min: 0, max: 2 })).toBeUndefined();
    expect(parseOptionalNumber(1.25, "temperature", { min: 0, max: 2 })).toBe(1.25);
    expect(() => parseOptionalNumber(Number.NaN, "temperature", { min: 0, max: 2 })).toThrow("finite number");
    expect(() => parseOptionalNumber(-1, "temperature", { min: 0, max: 2 })).toThrow("between 0 and 2");

    expect(parseOptionalInteger(null, "maxNewTokens", { min: 1, max: 10 })).toBeUndefined();
    expect(parseOptionalInteger(8, "maxNewTokens", { min: 1, max: 10 })).toBe(8);
    expect(() => parseOptionalInteger(1.5, "maxNewTokens", { min: 1, max: 10 })).toThrow("integer");
    expect(() => parseOptionalInteger(11, "maxNewTokens", { min: 1, max: 10 })).toThrow("between 1 and 10");

    expect(parseRequestId(undefined)).toBeUndefined();
    expect(parseRequestId("   ")).toBeUndefined();
    expect(parseRequestId(" request-1.2_ok ")).toBe("request-1.2_ok");
    expect(() => parseRequestId(undefined, { required: true })).toThrow("required");
    expect(() => parseRequestId("", { required: true })).toThrow("required");
    expect(() => parseRequestId(1)).toThrow("must be a string");
    expect(() => parseRequestId("x".repeat(121))).toThrow("exceeds 120");
    expect(() => parseRequestId("bad/id")).toThrow("may contain only");
    expect(() => parseRequestId("bad..id")).toThrow("consecutive dots");
  });

  it("parses optional string arrays", () => {
    expect(parseOptionalStringArray(undefined, "warnings")).toBeUndefined();
    expect(parseOptionalStringArray(["a", "b"], "warnings")).toEqual(["a", "b"]);
    expect(() => parseOptionalStringArray(["a", 1], "warnings")).toThrow("array of strings");
    expect(isStringArray(["speaker"])).toBe(true);
    expect(isStringArray(["speaker", 1])).toBe(false);
  });
});

describe("localTtsIpc request sanitizers", () => {
  it("sanitizes Kani generate payloads", () => {
    expect(sanitizeGeneratePayload("kani", {
      text: "  Hello from Kani. ",
      modelRepo: "nineninesix/kani-tts-2-en",
      languageTag: "en_US",
      temperature: 0.9,
      topP: 0.95,
      repetitionPenalty: 1.1,
      maxNewTokens: 512,
    })).toEqual({
      text: "Hello from Kani.",
      modelRepo: "nineninesix/kani-tts-2-en",
      languageTag: "en_us",
      temperature: 0.9,
      topP: 0.95,
      repetitionPenalty: 1.1,
      maxNewTokens: 512,
    });
    expect(sanitizeGeneratePayload("kani", { text: "Hello" })).toMatchObject({
      text: "Hello",
      languageTag: "en_us",
    });

    expect(() => sanitizeGeneratePayload("kani", null)).toThrow("Kani payload");
    expect(() => sanitizeGeneratePayload("kani", { text: "Hello", modelRepo: "bad/repo" })).toThrow("Unsupported Kani");
    expect(() => sanitizeGeneratePayload("kani", { text: "Hello", languageTag: "en!" })).toThrow("invalid format");
    expect(() => sanitizeGeneratePayload("kani", { text: "Hello", languageTag: "fr_fr" })).toThrow("Unsupported Kani language tag");
  });

  it("sanitizes NeuTTS generate payloads", () => {
    expect(sanitizeGeneratePayload("neutts", {
      text: "  Hello from NeuTTS. ",
      referenceText: " Reference transcript. ",
      referenceAudioBase64: " UklGRg== ",
      modelRepo: "neuphonic/neutts-nano",
      codecRepo: "neuphonic/neucodec",
      backboneDevice: "GPU",
      codecDevice: "cpu",
    })).toEqual({
      text: "Hello from NeuTTS.",
      referenceText: "Reference transcript.",
      referenceAudioBase64: "UklGRg==",
      modelRepo: "neuphonic/neutts-nano",
      codecRepo: "neuphonic/neucodec",
      backboneDevice: "gpu",
      codecDevice: "cpu",
    });

    expect(() => sanitizeGeneratePayload("neutts", [])).toThrow("NeuTTS payload");
    expect(() => sanitizeGeneratePayload("neutts", { text: "Hello", referenceText: "ref" })).toThrow("referenceAudioBase64");
    expect(() => sanitizeGeneratePayload("neutts", {
      text: "Hello",
      referenceText: "ref",
      referenceAudioBase64: "x".repeat(25_000_001),
    })).toThrow("too large");
    expect(() => sanitizeGeneratePayload("neutts", {
      text: "Hello",
      referenceText: "ref",
      referenceAudioBase64: "abc",
      modelRepo: "bad/model",
    })).toThrow("Unsupported NeuTTS model");
    expect(() => sanitizeGeneratePayload("neutts", {
      text: "Hello",
      referenceText: "ref",
      referenceAudioBase64: "abc",
      codecRepo: "bad/codec",
    })).toThrow("Unsupported NeuTTS codec");
  });

  it("sanitizes Qwen3 generate payloads", () => {
    expect(sanitizeGeneratePayload("qwen3", {
      text: "  Hello from Qwen3. ",
      modelRepo: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
      speaker: "Ryan",
      language: "English",
      instruct: " Calm and warm. ",
      deviceMap: "CUDA:0",
      dtype: "BFLOAT16",
      attnImplementation: "flash_attention_2",
      temperature: 0.8,
      topP: 0.95,
      maxNewTokens: 8192,
    })).toEqual({
      text: "Hello from Qwen3.",
      modelRepo: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
      speaker: "Ryan",
      language: "English",
      instruct: "Calm and warm.",
      deviceMap: "cuda:0",
      dtype: "bfloat16",
      attnImplementation: "flash_attention_2",
      temperature: 0.8,
      topP: 0.95,
      maxNewTokens: 8192,
    });
    expect(sanitizeGeneratePayload("qwen3", {
      text: "Hello from Qwen3.",
      modelRepo: "auto",
    })).toMatchObject({
      modelRepo: "auto",
    });
    expect(sanitizeGeneratePayload("qwen3", {
      text: "Hello from Qwen3.",
      modelRepo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    })).toMatchObject({
      modelRepo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    });

    expect(() => sanitizeGeneratePayload("qwen3", null)).toThrow("Qwen3 payload");
    expect(() => sanitizeGeneratePayload("qwen3", { text: "Hello", modelRepo: "bad/repo" })).toThrow("Unsupported Qwen3-TTS model");
    expect(() => sanitizeGeneratePayload("qwen3", { text: "Hello", speaker: "Unknown" })).toThrow("Unsupported Qwen3-TTS speaker");
    expect(() => sanitizeGeneratePayload("qwen3", { text: "Hello", language: "Dutch" })).toThrow("Unsupported Qwen3-TTS language");
    expect(() => sanitizeGeneratePayload("qwen3", { text: "Hello", deviceMap: "../bad" })).toThrow("invalid format");
    expect(() => sanitizeGeneratePayload("qwen3", { text: "Hello", dtype: "int8" })).toThrow("Unsupported Qwen3-TTS dtype");
    expect(() => sanitizeGeneratePayload("qwen3", { text: "Hello", attnImplementation: "bad" })).toThrow("Unsupported Qwen3-TTS attention");
    expect(() => sanitizeGeneratePayload("qwen3", { text: "Hello", maxNewTokens: 8193 })).toThrow("between 64 and 8192");
  });

  it("sanitizes cache and cancel requests", () => {
    expect(sanitizeCacheRequest({ model: "qwen3" })).toEqual({ model: "qwen3" });
    expect(sanitizeCancelRequest({ model: "neutts", requestId: "abc-123" })).toEqual({
      model: "neutts",
      requestId: "abc-123",
    });
    expect(() => sanitizeCacheRequest(null)).toThrow("Invalid cache");
    expect(() => sanitizeCancelRequest(null)).toThrow("Invalid cancel");
    expect(() => sanitizeCacheRequest({ model: "remote" })).toThrow("Unsupported local model");
    expect(() => sanitizeCancelRequest({ model: "kani" })).toThrow("required");
  });
});

describe("localTtsIpc bridge result parsers", () => {
  it("parses probe results with optional metadata", () => {
    expect(parseBridgeProbeResult({
      ready: true,
      message: "Ready",
      pythonVersion: "3.12.0",
      package: "neutts",
      packageVersion: "1.2.0",
      requiresPython: ">=3.10",
      compatibilityMode: "current_1_2_x_or_newer",
      warnings: ["explicit runtime"],
      espeakVersion: "1.52",
    }, pythonResolution)).toEqual({
      ready: true,
      message: "Ready",
      pythonVersion: "3.12.0",
      pythonBinary: "/venv/bin/python",
      resolvedFrom: "request",
      package: "neutts",
      packageVersion: "1.2.0",
      requiresPython: ">=3.10",
      compatibilityMode: "current_1_2_x_or_newer",
      warnings: ["explicit runtime"],
      espeakVersion: "1.52",
    });

    const nullableOptionalProbe = parseBridgeProbeResult({
      ready: false,
      message: "Missing package",
      pythonVersion: "3.10.0",
      packageVersion: null,
      compatibilityMode: "legacy_0_1_x",
      espeakVersion: null,
    }, pythonResolution);
    expect(nullableOptionalProbe).toMatchObject({
      ready: false,
      compatibilityMode: "legacy_0_1_x",
    });
    expect(nullableOptionalProbe).not.toHaveProperty("packageVersion");
    expect(nullableOptionalProbe).not.toHaveProperty("espeakVersion");
  });

  it("rejects malformed probe and progress results", () => {
    expect(() => parseBridgeProbeResult(null, pythonResolution)).toThrow("Invalid probe");
    expect(() => parseBridgeProbeResult({ message: "x", pythonVersion: "3" }, pythonResolution)).toThrow("ready");
    expect(() => parseBridgeProbeResult({ ready: true, pythonVersion: "3" }, pythonResolution)).toThrow("message");
    expect(() => parseBridgeProbeResult({ ready: true, message: "x" }, pythonResolution)).toThrow("pythonVersion");
    expect(() => parseBridgeProbeResult({
      ready: true,
      message: "x",
      pythonVersion: "3",
      package: 1,
    }, pythonResolution)).toThrow("package");
    expect(() => parseBridgeProbeResult({
      ready: true,
      message: "x",
      pythonVersion: "3",
      packageVersion: 1,
    }, pythonResolution)).toThrow("packageVersion");
    expect(() => parseBridgeProbeResult({
      ready: true,
      message: "x",
      pythonVersion: "3",
      requiresPython: 1,
    }, pythonResolution)).toThrow("requiresPython");
    expect(() => parseBridgeProbeResult({
      ready: true,
      message: "x",
      pythonVersion: "3",
      compatibilityMode: "bad",
    }, pythonResolution)).toThrow("compatibilityMode");
    expect(() => parseBridgeProbeResult({
      ready: true,
      message: "x",
      pythonVersion: "3",
      espeakVersion: 1,
    }, pythonResolution)).toThrow("espeakVersion");

    expect(parseBridgeProgressResult({ phase: "load", message: "Loading", elapsedSec: 1.2 })).toEqual({
      phase: "load",
      message: "Loading",
      elapsedSec: 1.2,
    });
    expect(parseBridgeProgressResult({ phase: "load", message: "Loading" })).toEqual({
      phase: "load",
      message: "Loading",
    });
    expect(() => parseBridgeProgressResult(null)).toThrow("Invalid progress");
    expect(() => parseBridgeProgressResult({ phase: "", message: "x" })).toThrow("phase");
    expect(() => parseBridgeProgressResult({ phase: "x", message: "" })).toThrow("message");
    expect(() => parseBridgeProgressResult({ phase: "x", message: "x", elapsedSec: -1 })).toThrow("elapsedSec");
  });

  it("parses and validates generate results", () => {
    expect(parseBridgeGenerateResult({
      wavBase64: "UklGRg==",
      sampleRate: 24000,
      modelRepo: "model/repo",
      durationSec: 1.2,
      elapsedSec: 0.4,
      speakerStatus: "loaded",
      speakers: ["alice"],
    })).toEqual({
      wavBase64: "UklGRg==",
      sampleRate: 24000,
      modelRepo: "model/repo",
      durationSec: 1.2,
      elapsedSec: 0.4,
      speakerStatus: "loaded",
      speakers: ["alice"],
    });

    const valid = {
      wavBase64: "UklGRg==",
      sampleRate: 24000,
      modelRepo: "model/repo",
      durationSec: 1.2,
      elapsedSec: 0.4,
    };
    expect(() => parseBridgeGenerateResult(null)).toThrow("Invalid generation");
    expect(() => parseBridgeGenerateResult({ ...valid, wavBase64: "" })).toThrow("wavBase64");
    expect(() => parseBridgeGenerateResult({ ...valid, wavBase64: "x".repeat(100_000_001) })).toThrow("exceeds");
    expect(() => parseBridgeGenerateResult({ ...valid, sampleRate: 0 })).toThrow("sampleRate");
    expect(() => parseBridgeGenerateResult({ ...valid, modelRepo: "" })).toThrow("modelRepo");
    expect(() => parseBridgeGenerateResult({ ...valid, durationSec: -1 })).toThrow("durationSec");
    expect(() => parseBridgeGenerateResult({ ...valid, elapsedSec: Number.POSITIVE_INFINITY })).toThrow("elapsedSec");
    expect(() => parseBridgeGenerateResult({ ...valid, speakerStatus: 1 })).toThrow("speakerStatus");
    expect(() => parseBridgeGenerateResult({ ...valid, speakers: [1] })).toThrow("speakers");
  });

  it("parses bridge stdout result envelopes", () => {
    const probeEnvelope = `${BRIDGE_RESULT_PREFIX}${JSON.stringify({
      ok: true,
      result: {
        ready: true,
        message: "Ready",
        pythonVersion: "3.12.0",
      },
    })}`;
    expect(parseBridgeResult(`noise\n${probeEnvelope}\n`, "", "probe", pythonResolution)).toMatchObject({
      ready: true,
      pythonBinary: "/venv/bin/python",
    });

    const generateEnvelope = `${BRIDGE_RESULT_PREFIX}${JSON.stringify({
      ok: true,
      result: {
        wavBase64: "UklGRg==",
        sampleRate: 22050,
        modelRepo: "model/repo",
        durationSec: 1,
        elapsedSec: 0.5,
      },
    })}`;
    expect(parseBridgeResult(generateEnvelope, "", "generate", pythonResolution)).toMatchObject({
      wavBase64: "UklGRg==",
      sampleRate: 22050,
    });
  });

  it("reports bridge envelope failures clearly", () => {
    expect(() => parseBridgeResult("", "", "probe", pythonResolution)).toThrow("No bridge result returned. No output.");
    expect(() => parseBridgeResult("", "stderr text", "probe", pythonResolution)).toThrow("stderr text");
    expect(() => parseBridgeResult(`${BRIDGE_RESULT_PREFIX}{bad`, "", "probe", pythonResolution)).toThrow("Failed parsing");
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "non-error parse failure";
    });
    expect(() => parseBridgeResult(`${BRIDGE_RESULT_PREFIX}{}`, "", "probe", pythonResolution)).toThrow("non-error parse failure");
    expect(() => parseBridgeResult(`${BRIDGE_RESULT_PREFIX}${JSON.stringify({ ok: "yes" })}`, "", "probe", pythonResolution)).toThrow("Missing required");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => parseBridgeResult(`${BRIDGE_RESULT_PREFIX}${JSON.stringify({
      ok: false,
      error: "Bridge failed",
      details: "stack",
    })}`, "", "generate", pythonResolution)).toThrow("Bridge failed");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Python bridge details"));

    expect(() => parseBridgeResult(`${BRIDGE_RESULT_PREFIX}${JSON.stringify({ ok: false })}`, "", "probe", pythonResolution)).toThrow("Python bridge failed");
  });
});

describe("localTtsIpc Python process error extraction", () => {
  it("selects user-facing stderr lines over traceback frames", () => {
    expect(extractUserFacingPythonProcessError([
      "Traceback (most recent call last):",
      "File \"bridge.py\", line 1",
      "ModuleNotFoundError: No module named 'kani'",
    ].join("\n"), 1)).toBe("ModuleNotFoundError: No module named 'kani'");

    expect(extractUserFacingPythonProcessError("  \n", null)).toBe("Python process exited with code unknown.");
  });
});

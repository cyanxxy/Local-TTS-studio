// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  dataToArrayBuffer,
  dataToText,
  encodeCancel,
  encodeRequest,
  isTerminalResultFor,
  MAX_AUDIO_CHUNK_SAMPLES,
  MAX_AUDIO_SILENCE_SAMPLES,
  MAX_PORT_ANNOUNCEMENT_BUFFER_BYTES,
  MAX_REQUEST_AUDIO_CHUNKS,
  parseAudioChunkMetadata,
  parseBridgeMessage,
  parsePortAnnouncement,
  parseResultAudioMetadata,
  parseStartupFailure,
  parseUnitGapMetadata,
  SHUTDOWN_COMMAND,
} from "./protocol";

const CHUNK = {
  type: "audio_chunk",
  requestId: "r1",
  index: 0,
  total: 2,
  sampleRate: 24_000,
  sampleCount: 480,
  silenceAfterSamples: 0,
};

describe("frame data", () => {
  it("reads text from strings, buffers and views", () => {
    const bytes = new TextEncoder().encode("{\"a\":1}");
    expect(dataToText("plain")).toBe("plain");
    expect(dataToText(bytes.buffer)).toBe("{\"a\":1}");
    expect(dataToText(new Uint8Array([0, ...bytes]).subarray(1))).toBe("{\"a\":1}");
    expect(dataToText(42)).toBe("42");
  });

  it("returns binary frames as a standalone ArrayBuffer and text frames as null", () => {
    const buffer = new Float32Array([0.5]).buffer;
    expect(dataToArrayBuffer(buffer)).toBe(buffer);
    const view = new Uint8Array([9, 1, 2, 3]).subarray(1);
    const copy = dataToArrayBuffer(view)!;
    expect([...new Uint8Array(copy)]).toEqual([1, 2, 3]);
    expect(copy.byteLength).toBe(3);
    expect(dataToArrayBuffer("text")).toBeNull();
  });
});

describe("startup lines", () => {
  it("reads the announced port and ignores other lines", () => {
    expect(parsePortAnnouncement("__PORT__ 51234")).toBe(51234);
    expect(parsePortAnnouncement("loading model")).toBeNull();
  });

  it.each(["__PORT__0", "__PORT__65536", "__PORT__abc", "__PORT__1.5"])("rejects the invalid port in %s", (line) => {
    expect(() => parsePortAnnouncement(line)).toThrow("announced an invalid WebSocket port");
  });

  it("turns a reported startup failure into an error", () => {
    expect(parseStartupFailure("__RESULT__{\"ok\":false,\"error\":\"No model.\"}")?.message).toBe("No model.");
    expect(parseStartupFailure("__RESULT__{\"ok\":false,\"error\":\"  \"}")?.message)
      .toBe("Rust local bridge reported a startup failure.");
    expect(parseStartupFailure("__RESULT__{\"ok\":true}")?.message)
      .toBe("Rust local bridge returned an invalid startup result.");
    expect(parseStartupFailure("__PORT__1")).toBeNull();
  });

  it("bounds the startup output scanned for a port", () => {
    expect(MAX_PORT_ANNOUNCEMENT_BUFFER_BYTES).toBe(64 * 1024);
  });
});

describe("request envelopes", () => {
  it("serializes a request, with the command only when there is one", () => {
    expect(JSON.parse(encodeRequest("r1", undefined, { text: "Hi" }, 1_000)))
      .toEqual({ requestId: "r1", payload: { text: "Hi" } });
    expect(JSON.parse(encodeRequest("w1", "warm", {}, 1_000)))
      .toEqual({ requestId: "w1", command: "warm", payload: {} });
  });

  it("measures the limit in UTF-8 bytes", () => {
    const body = encodeRequest("r1", undefined, { text: "é" }, 1_000);
    const bytes = Buffer.byteLength(body, "utf-8");
    expect(encodeRequest("r1", undefined, { text: "é" }, bytes)).toBe(body);
    expect(() => encodeRequest("r1", undefined, { text: "é" }, bytes - 1))
      .toThrow(`request exceeds the ${bytes - 1}-byte WebSocket text limit`);
  });

  it("serializes the cancel and shutdown commands", () => {
    expect(JSON.parse(encodeCancel("r1"))).toEqual({ command: "cancel", requestId: "r1" });
    expect(JSON.parse(SHUTDOWN_COMMAND)).toEqual({ command: "shutdown" });
  });
});

describe("parseBridgeMessage", () => {
  it("accepts any object with a string type", () => {
    expect(parseBridgeMessage("{\"type\":\"progress\",\"requestId\":\"r1\"}"))
      .toEqual({ type: "progress", requestId: "r1" });
  });

  it("reports unparseable JSON with the parser's reason", () => {
    expect(() => parseBridgeMessage("{")).toThrow(/^Failed parsing WebSocket bridge message: /);
  });

  it.each(["[]", "null", "{\"type\":3}", "{}"])("rejects %s as an invalid message", (text) => {
    expect(() => parseBridgeMessage(text)).toThrow("WebSocket bridge returned an invalid message.");
  });
});

describe("isTerminalResultFor", () => {
  it("matches only the result frame of the given request", () => {
    expect(isTerminalResultFor("{\"type\":\"result\",\"requestId\":\"r1\",\"ok\":false}", "r1")).toBe(true);
    expect(isTerminalResultFor("{\"type\":\"result\",\"requestId\":\"r2\"}", "r1")).toBe(false);
    expect(isTerminalResultFor("{\"type\":\"progress\",\"requestId\":\"r1\"}", "r1")).toBe(false);
    expect(isTerminalResultFor("not json", "r1")).toBe(false);
    expect(isTerminalResultFor(new ArrayBuffer(4), "r1")).toBe(false);
  });
});

describe("parseAudioChunkMetadata", () => {
  it("returns the chunk metadata stamped with the request id", () => {
    expect(parseAudioChunkMetadata({ ...CHUNK, textUnitIndex: 1, textUnitTotal: 3 }, "r1")).toEqual({
      requestId: "r1",
      index: 0,
      total: 2,
      sampleRate: 24_000,
      sampleCount: 480,
      silenceAfterSamples: 0,
      textUnitIndex: 1,
      textUnitTotal: 3,
    });
  });

  it.each(["index", "total", "sampleRate", "sampleCount", "silenceAfterSamples"])(
    "rejects a missing, fractional or negative %s",
    (field) => {
      for (const value of [undefined, 1.5, -1, "1"]) {
        expect(() => parseAudioChunkMetadata({ ...CHUNK, [field]: value }, "r1"))
          .toThrow(`invalid audio chunk \`${field}\``);
      }
    },
  );

  it("bounds the index by the declared total and the per-request chunk cap", () => {
    expect(() => parseAudioChunkMetadata({ ...CHUNK, index: 2 }, "r1")).toThrow("outside the declared total");
    expect(() => parseAudioChunkMetadata({ ...CHUNK, index: MAX_REQUEST_AUDIO_CHUNKS, total: 0 }, "r1"))
      .toThrow("too many audio chunks");
    expect(() => parseAudioChunkMetadata({ ...CHUNK, total: MAX_REQUEST_AUDIO_CHUNKS + 1 }, "r1"))
      .toThrow("too many audio chunks");
    expect(parseAudioChunkMetadata({ ...CHUNK, index: 7, total: 0 }, "r1").index).toBe(7);
  });

  it("bounds the sample rate, sample count and trailing silence", () => {
    expect(() => parseAudioChunkMetadata({ ...CHUNK, sampleRate: 7_999 }, "r1")).toThrow("invalid sample metadata");
    expect(() => parseAudioChunkMetadata({ ...CHUNK, sampleRate: 192_001 }, "r1")).toThrow("invalid sample metadata");
    expect(() => parseAudioChunkMetadata({ ...CHUNK, sampleCount: 0 }, "r1")).toThrow("invalid sample metadata");
    expect(() => parseAudioChunkMetadata({ ...CHUNK, sampleCount: MAX_AUDIO_CHUNK_SAMPLES + 1 }, "r1"))
      .toThrow("exceeding the maximum sample count");
    expect(parseAudioChunkMetadata({ ...CHUNK, sampleCount: MAX_AUDIO_CHUNK_SAMPLES }, "r1").sampleCount)
      .toBe(MAX_AUDIO_CHUNK_SAMPLES);
    expect(() => parseAudioChunkMetadata({ ...CHUNK, silenceAfterSamples: MAX_AUDIO_SILENCE_SAMPLES + 1 }, "r1"))
      .toThrow("excessive trailing silence");
  });

  it("refuses any declared encoding: audio is always Float32", () => {
    expect(() => parseAudioChunkMetadata({ ...CHUNK, encoding: "pcm16" }, "r1")).toThrow("unsupported encoding");
  });

  it("requires text-unit metadata to come as a valid pair", () => {
    expect(() => parseAudioChunkMetadata({ ...CHUNK, textUnitIndex: 0 }, "r1")).toThrow("incomplete text-unit metadata");
    expect(() => parseAudioChunkMetadata({ ...CHUNK, textUnitTotal: 1 }, "r1")).toThrow("incomplete text-unit metadata");
    for (const [textUnitIndex, textUnitTotal] of [
      [1, 1],
      [-1, 2],
      [0, 0],
      [0.5, 2],
      ["0", 2],
      [0, MAX_REQUEST_AUDIO_CHUNKS + 1],
    ]) {
      expect(() => parseAudioChunkMetadata({ ...CHUNK, textUnitIndex, textUnitTotal }, "r1"))
        .toThrow("invalid text-unit metadata");
    }
  });
});

describe("parseResultAudioMetadata", () => {
  it("returns the result's chunk count and sample rate", () => {
    expect(parseResultAudioMetadata({ result: { audioChunkCount: 3, sampleRate: 24_000 } }))
      .toEqual({ audioChunkCount: 3, sampleRate: 24_000 });
  });

  it("rejects a missing result object", () => {
    expect(() => parseResultAudioMetadata({ result: [] })).toThrow("without a result object");
  });

  it.each([0, -1, 1.5, "3", undefined])("rejects the audio chunk count %s", (audioChunkCount) => {
    expect(() => parseResultAudioMetadata({ result: { audioChunkCount, sampleRate: 24_000 } }))
      .toThrow("invalid audio chunk count");
  });

  it.each([7_999, 192_001, 24_000.5, "24000", undefined])("rejects the sample rate %s", (sampleRate) => {
    expect(() => parseResultAudioMetadata({ result: { audioChunkCount: 1, sampleRate } }))
      .toThrow("invalid sample rate");
  });
});

describe("parseUnitGapMetadata", () => {
  const GAP = { type: "unit_gap", requestId: "r1", sampleRate: 24_000, textUnitIndex: 1, textUnitTotal: 3, silenceSamples: 4_800 };

  it("reads a well-formed gap and stamps the request id it was checked against", () => {
    expect(parseUnitGapMetadata(GAP, "r1")).toEqual({
      requestId: "r1",
      sampleRate: 24_000,
      textUnitIndex: 1,
      textUnitTotal: 3,
      silenceSamples: 4_800,
    });
  });

  it.each([7_999, 192_001])("rejects the sample rate %s", (sampleRate) => {
    expect(() => parseUnitGapMetadata({ ...GAP, sampleRate }, "r1")).toThrow("invalid sample rate");
  });

  it.each([
    [{ textUnitTotal: 0 }],
    [{ textUnitIndex: 3 }],
    [{ textUnitTotal: MAX_REQUEST_AUDIO_CHUNKS + 1 }],
  ])("rejects out-of-range text-unit metadata %j", (overrides) => {
    expect(() => parseUnitGapMetadata({ ...GAP, ...overrides }, "r1")).toThrow("invalid text-unit metadata");
  });

  it.each([-1, 1.5, "4800", undefined])("rejects the field value %s", (silenceSamples) => {
    expect(() => parseUnitGapMetadata({ ...GAP, silenceSamples }, "r1")).toThrow("invalid unit gap `silenceSamples`");
  });

  it("rejects no silence and more silence than a chunk may declare", () => {
    expect(() => parseUnitGapMetadata({ ...GAP, silenceSamples: 0 }, "r1")).toThrow("invalid silence");
    expect(() => parseUnitGapMetadata({ ...GAP, silenceSamples: MAX_AUDIO_SILENCE_SAMPLES + 1 }, "r1"))
      .toThrow("invalid silence");
    expect(parseUnitGapMetadata({ ...GAP, silenceSamples: MAX_AUDIO_SILENCE_SAMPLES }, "r1").silenceSamples)
      .toBe(MAX_AUDIO_SILENCE_SAMPLES);
  });
});

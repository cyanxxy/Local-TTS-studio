import { describe, expect, it, vi } from "vitest";
import type { WorkerOutMessage } from "../../types";
import { createWorkerPort, errorMessage, generationMeta, transferablePcm } from "./protocol";

function createTarget() {
  const calls: Array<{ message: WorkerOutMessage; options?: StructuredSerializeOptions }> = [];
  const target = {
    postMessage: vi.fn((message: unknown, options?: StructuredSerializeOptions) => {
      calls.push({ message: message as WorkerOutMessage, options });
    }),
  };
  return { calls, target };
}

function audioChunk(audio: Float32Array): Extract<WorkerOutMessage, { type: "AUDIO_CHUNK" }> {
  return { type: "AUDIO_CHUNK", generationId: "g1", audio, samplingRate: 24_000, text: "Hi.", index: 1, total: 1 };
}

describe("transferablePcm", () => {
  it("keeps a Float32Array that owns its whole buffer", () => {
    const audio = new Float32Array([0.1, 0.2]);
    expect(transferablePcm(audio)).toBe(audio);
  });

  it("copies views so transferring never detaches memory the caller still uses", () => {
    const parent = new Float32Array([1, 2, 3, 4]);
    const view = parent.subarray(1, 3);
    const copy = transferablePcm(view);

    expect(copy).not.toBe(view);
    expect(Array.from(copy)).toEqual([2, 3]);
    expect(copy.byteOffset).toBe(0);
    expect(copy.buffer.byteLength).toBe(copy.byteLength);
  });

  it("copies PCM backed by a SharedArrayBuffer, which cannot be transferred", () => {
    const shared = new Float32Array(new SharedArrayBuffer(8));
    shared.set([0.5, -0.5]);
    const copy = transferablePcm(shared);

    expect(copy).not.toBe(shared);
    expect(copy.buffer).not.toBeInstanceOf(SharedArrayBuffer);
    expect(Array.from(copy)).toEqual([0.5, -0.5]);
  });
});

describe("createWorkerPort", () => {
  it("transfers AUDIO_CHUNK PCM and posts other messages without a transfer list", () => {
    const { calls, target } = createTarget();
    const port = createWorkerPort(target);
    const audio = new Float32Array([0.25, 0.5]);

    port.post({ type: "READY", backend: "wasm" });
    port.post(audioChunk(audio));

    expect(calls[0]).toEqual({ message: { type: "READY", backend: "wasm" }, options: undefined });
    expect(calls[1].message).toEqual(audioChunk(audio));
    expect(calls[1].options?.transfer).toEqual([audio.buffer]);
  });

  it("transfers a private copy when the chunk audio is a view", () => {
    const { calls, target } = createTarget();
    const parent = new Float32Array([1, 2, 3]);
    createWorkerPort(target).post(audioChunk(parent.subarray(1)));

    const posted = calls[0].message as Extract<WorkerOutMessage, { type: "AUDIO_CHUNK" }>;
    expect(Array.from(posted.audio)).toEqual([2, 3]);
    expect(calls[0].options?.transfer).toEqual([posted.audio.buffer]);
    expect(posted.audio.buffer).not.toBe(parent.buffer);
  });

  it("scopes errors: generate errors echo the generation id, load errors never do", () => {
    const { calls, target } = createTarget();
    const port = createWorkerPort(target);

    port.postError("generate", new Error("bad voice"), "g7");
    port.postError("generate", "plain failure");
    port.postError("load", new Error("download failed"), "ignored");

    expect(calls.map((call) => call.message)).toEqual([
      { type: "ERROR", message: "bad voice", scope: "generate", generationId: "g7" },
      { type: "ERROR", message: "plain failure", scope: "generate" },
      { type: "ERROR", message: "download failed", scope: "load" },
    ]);
  });
});

describe("message helpers", () => {
  it("formats errors and generation ids", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(42)).toBe("42");
    expect(generationMeta(undefined)).toEqual({});
    expect(generationMeta("g1")).toEqual({ generationId: "g1" });
  });
});

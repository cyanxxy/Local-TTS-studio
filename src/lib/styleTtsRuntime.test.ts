import * as ort from "onnxruntime-web";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChunkTooLongError,
  configureStyleTtsWasm,
  createStyleTtsSession,
  disposeOutputs,
  finiteWaveform,
  idsTensor,
  releaseStyleTtsSession,
  trimNearSilence,
  type StyleTtsSession,
} from "./styleTtsRuntime";
import { TRANSFORMERS_ONNX_WASM_ASSETS } from "./onnxWasmAssets";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("styleTtsRuntime sessions", () => {
  it("uses the app-level asyncify WASM assets and only threads when cross-origin isolated", () => {
    vi.stubGlobal("crossOriginIsolated", false);
    configureStyleTtsWasm();
    expect(ort.env.wasm.wasmPaths).toBe(TRANSFORMERS_ONNX_WASM_ASSETS.asyncify);
    expect(ort.env.wasm.numThreads).toBe(1);

    vi.stubGlobal("crossOriginIsolated", true);
    configureStyleTtsWasm();
    expect(ort.env.wasm.numThreads).toBe(4);
  });

  it("creates a session on the requested backend from the model bytes", async () => {
    const session = {} as ort.InferenceSession;
    const create = vi.spyOn(ort.InferenceSession, "create").mockResolvedValue(session);
    const model = new Uint8Array([1, 2, 3]).buffer;

    await expect(createStyleTtsSession(model, "webgpu")).resolves.toBe(session);

    const [bytes, options] = create.mock.calls[0] as unknown as [Uint8Array, ort.InferenceSession.SessionOptions];
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(options).toEqual({ executionProviders: ["webgpu"], graphOptimizationLevel: "all" });
  });

  it("releases sessions without throwing, including a missing one", async () => {
    const failing = { release: vi.fn(async () => { throw new Error("already released"); }) } as unknown as StyleTtsSession;

    await expect(releaseStyleTtsSession(failing)).resolves.toBeUndefined();
    await expect(releaseStyleTtsSession(null)).resolves.toBeUndefined();
    expect(failing.release).toHaveBeenCalledOnce();
  });
});

describe("styleTtsRuntime tensors", () => {
  it("builds int64 [1, T] input ids", () => {
    const tensor = idsTensor([0, 50, 0]);

    expect(tensor.type).toBe("int64");
    expect(tensor.dims).toEqual([1, 3]);
    expect(Array.from(tensor.data as BigInt64Array)).toEqual([0n, 50n, 0n]);
  });

  it("disposes each output once and tolerates outputs that are already gone", () => {
    const shared = { dispose: vi.fn() };
    const gone = { dispose: vi.fn(() => { throw new Error("released"); }) };

    disposeOutputs({ a: shared, b: shared, c: gone } as unknown as ort.InferenceSession.ReturnType);

    expect(shared.dispose).toHaveBeenCalledOnce();
    expect(gone.dispose).toHaveBeenCalledOnce();
  });

  it("returns a finite float32 waveform and rejects missing or non-finite output", () => {
    const samples = Float32Array.of(0, 0.5, -0.5);

    expect(finiteWaveform(new ort.Tensor("float32", samples, [3]))).toBe(samples);
    expect(() => finiteWaveform(undefined)).toThrow("no float32 waveform");
    expect(() => finiteWaveform(new ort.Tensor("int32", Int32Array.of(1), [1]))).toThrow("no float32 waveform");
    expect(() => finiteWaveform(new ort.Tensor("float32", Float32Array.of(0, Number.NaN), [2]))).toThrow("non-finite waveform");
  });

  it("names the token count in ChunkTooLongError", () => {
    const error = new ChunkTooLongError(600);

    expect(error.name).toBe("ChunkTooLongError");
    expect(error.tokenCount).toBe(600);
    expect(error.message).toBe("The chunk needs 600 phoneme tokens; the model accepts at most 512.");
  });
});

describe("trimNearSilence", () => {
  it("cuts digital silence around speech to a 50 ms margin and returns a standalone copy", () => {
    // 100 samples/s: the margin is 5 samples.
    const samples = new Float32Array(100);
    samples.set([0.0005, 0.2, 0, -0.3, 0.002], 40);

    const trimmed = trimNearSilence(samples, 100);

    expect(trimmed.length).toBe(5 + 4 + 5);
    expect(Array.from(trimmed.subarray(5, 9))).toEqual(Array.from(samples.subarray(41, 45)));
    expect(trimmed.buffer).not.toBe(samples.buffer);
    expect(trimmed.byteLength).toBe(trimmed.buffer.byteLength);
  });

  it("keeps the margin inside the buffer and empties all-silent audio", () => {
    expect(trimNearSilence(Float32Array.of(0.5, 0, 0, 0.5), 100)).toEqual(Float32Array.of(0.5, 0, 0, 0.5));
    expect(trimNearSilence(new Float32Array(50), 100)).toEqual(new Float32Array(0));
  });
});

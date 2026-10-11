import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIC_CAPTURE_BATCH_FRAMES, MIC_CAPTURE_PROCESSOR_NAME } from "./micCaptureProtocol";

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

interface ProcessorInstance {
  port: FakePort;
  process(inputs: Float32Array[][]): boolean;
}

const registerProcessor = vi.fn();

beforeEach(() => {
  // The AudioWorkletGlobalScope pieces the processor relies on.
  vi.stubGlobal("AudioWorkletProcessor", class {
    port: FakePort = { onmessage: null, postMessage: vi.fn() };
  });
  vi.stubGlobal("registerProcessor", registerProcessor);
  vi.resetModules();
  registerProcessor.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createProcessor(): Promise<ProcessorInstance> {
  await import("./micCapture.worklet");
  expect(registerProcessor).toHaveBeenCalledWith(MIC_CAPTURE_PROCESSOR_NAME, expect.any(Function));
  const Processor = registerProcessor.mock.calls[0][1] as new () => ProcessorInstance;
  return new Processor();
}

function quantum(...channels: number[]): Float32Array[] {
  return channels.map((value) => new Float32Array(128).fill(value));
}

describe("mic capture worklet", () => {
  it("downmixes to mono and posts full batches as transferred buffers", async () => {
    const processor = await createProcessor();
    const quanta = MIC_CAPTURE_BATCH_FRAMES / 128;
    for (let index = 0; index < quanta; index += 1) expect(processor.process([quantum(0.2, 0.6)])).toBe(true);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    const [message, transfer] = processor.port.postMessage.mock.calls[0];
    expect(message.type).toBe("samples");
    expect(message.samples).toHaveLength(MIC_CAPTURE_BATCH_FRAMES);
    expect(message.samples[0]).toBeCloseTo(0.4);
    expect(transfer).toEqual([message.samples.buffer]);
  });

  it("tolerates missing inputs and flushes the partial batch once", async () => {
    const processor = await createProcessor();
    expect(processor.process([])).toBe(true);
    expect(processor.process([[]])).toBe(true);
    processor.process([quantum(0.5)]);
    processor.port.onmessage?.({ data: { type: "other" } });
    processor.port.onmessage?.({ data: null });
    expect(processor.port.postMessage).not.toHaveBeenCalled();

    processor.port.onmessage?.({ data: { type: "flush" } });
    expect(processor.port.postMessage.mock.calls.map(([message]) => message.type)).toEqual(["samples", "flushed"]);
    expect(processor.port.postMessage.mock.calls[0][0].samples).toHaveLength(128);
    // After a flush the processor lets itself be collected.
    expect(processor.process([quantum(0.5)])).toBe(false);

    const empty = await createProcessor();
    empty.port.onmessage?.({ data: { type: "flush" } });
    expect(empty.port.postMessage.mock.calls.map(([message]) => message.type)).toEqual(["flushed"]);
  });
});

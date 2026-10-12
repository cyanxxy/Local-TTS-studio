// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createAudio8BenchmarkAdapter, type Audio8BenchmarkClient } from "./audio8Benchmark";
import { AUDIO8_MODEL_ID, AUDIO8_MODEL_REVISION } from "./audio8Model";
import type { Audio8NativeResult } from "./audio8NativeClient";

function fakeClient(result: Audio8NativeResult = { sampleRate: 44_100, audio: new Float32Array(441).buffer }) {
  return {
    load: vi.fn(async () => ({ ready: true, sampleRate: 44_100 })),
    generate: vi.fn(async () => result),
    destroy: vi.fn(async () => undefined),
  } satisfies Audio8BenchmarkClient;
}

describe("createAudio8BenchmarkAdapter", () => {
  it("loads, synthesizes the reference take with the default voice, and disposes", async () => {
    const client = fakeClient();
    const adapter = createAudio8BenchmarkAdapter(client);
    const onFirstAudio = vi.fn();

    await adapter.load();
    const audio = await adapter.synthesize("Hello", onFirstAudio);
    await adapter.synthesize("Again", () => undefined);
    await adapter.dispose();

    expect(adapter.runtime).toBe("audio8");
    expect(adapter.model).toEqual({ id: AUDIO8_MODEL_ID, revision: AUDIO8_MODEL_REVISION });
    expect(client.load).toHaveBeenCalledWith("benchmark-load", expect.any(Function));
    expect(client.generate.mock.calls).toEqual([
      ["benchmark-1", "Hello", "clara", undefined, undefined],
      ["benchmark-2", "Again", "clara", undefined, undefined],
    ]);
    // A whole take is Audio8's first audio.
    expect(onFirstAudio).toHaveBeenCalledTimes(1);
    expect(audio).toEqual({ sampleRate: 44_100, samples: 441 });
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("asks for the requested voice and take", async () => {
    const client = fakeClient();
    const adapter = createAudio8BenchmarkAdapter(client, { voice: "iris", seed: "7", temperature: "0.6" });

    await adapter.synthesize("Hello", () => undefined);

    expect(client.generate).toHaveBeenCalledWith("benchmark-1", "Hello", "iris", undefined, { seed: 7, temperature: 0.6 });
  });

  it("refuses options the IPC boundary would refuse", () => {
    const client = fakeClient();

    expect(() => createAudio8BenchmarkAdapter(client, { voice: "nigel" })).toThrow("Unsupported Audio8 voice.");
    expect(() => createAudio8BenchmarkAdapter(client, { seed: "-1" }))
      .toThrow("Audio8 seed must be an integer from 0 to 4294967295.");
    expect(() => createAudio8BenchmarkAdapter(client, { seed: "lucky" })).toThrow("Audio8 benchmark seed must be a number.");
    expect(() => createAudio8BenchmarkAdapter(client, { temperature: " " }))
      .toThrow("Audio8 benchmark temperature must be a number.");
    expect(() => createAudio8BenchmarkAdapter(client, { temperature: "3" }))
      .toThrow("Audio8 temperature must be a number from 0.1 to 1.");
    expect(() => createAudio8BenchmarkAdapter(client, { speed: "2" })).toThrow("Audio8 benchmark does not accept speed.");
  });

  it("refuses a result without audio", async () => {
    const adapter = createAudio8BenchmarkAdapter(fakeClient({ sampleRate: 44_100 }));

    await expect(adapter.synthesize("Hello", () => undefined)).rejects.toThrow("Audio8 benchmark returned no audio buffer.");
  });
});

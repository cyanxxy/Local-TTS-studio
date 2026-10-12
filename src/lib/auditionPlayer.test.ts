import { describe, expect, it, vi } from "vitest";
import { createAuditionPlayer } from "./auditionPlayer";

function fakeContext() {
  const sources: Array<{ onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const context = {
    state: "running",
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createBuffer: vi.fn((_channels: number, length: number) => ({ copyToChannel: vi.fn(), length })),
    createBufferSource: vi.fn(() => {
      const node = { buffer: null, onended: null as (() => void) | null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      sources.push(node);
      return node;
    }),
  };
  return { context: context as unknown as AudioContext, sources, raw: context };
}

describe("createAuditionPlayer", () => {
  it("plays a buffer and reports the end once", async () => {
    const { context, sources } = fakeContext();
    const player = createAuditionPlayer(() => context);
    const onEnded = vi.fn();
    await player.play({ samples: new Float32Array(10), sampleRate: 24_000 }, onEnded);
    expect(sources[0].start).toHaveBeenCalledOnce();
    sources[0].onended?.();
    sources[0].onended?.();
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it("stops the previous audition when another starts", async () => {
    const { context, sources } = fakeContext();
    const player = createAuditionPlayer(() => context);
    const first = vi.fn();
    await player.play({ samples: new Float32Array(10), sampleRate: 24_000 }, first);
    await player.play({ samples: new Float32Array(10), sampleRate: 24_000 });
    expect(sources[0].stop).toHaveBeenCalled();
    expect(first).toHaveBeenCalledOnce();
  });

  it("finishes immediately for empty audio and closes the context on dispose", async () => {
    const { context, raw } = fakeContext();
    const player = createAuditionPlayer(() => context);
    const onEnded = vi.fn();
    await player.play({ samples: new Float32Array(0), sampleRate: 24_000 }, onEnded);
    expect(onEnded).toHaveBeenCalledOnce();
    await player.play({ samples: new Float32Array(4), sampleRate: 24_000 });
    player.dispose();
    expect(raw.close).toHaveBeenCalledOnce();
  });
});

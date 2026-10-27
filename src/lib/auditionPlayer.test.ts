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

  describe("while a suspended context resumes", () => {
    function suspendedContext() {
      const fake = fakeContext();
      fake.raw.state = "suspended";
      const resumes: Array<() => void> = [];
      fake.raw.resume = vi.fn(() => new Promise<undefined>((resolve) => {
        resumes.push(() => {
          fake.raw.state = "running";
          resolve(undefined);
        });
      }));
      return { ...fake, resumeAll: () => { for (const resume of resumes.splice(0)) resume(); } };
    }

    it("starts only the latest of two plays", async () => {
      const { context, sources, resumeAll } = suspendedContext();
      const player = createAuditionPlayer(() => context);
      const first = vi.fn();
      const firstPlay = player.play({ samples: new Float32Array(10), sampleRate: 24_000 }, first);
      const secondPlay = player.play({ samples: new Float32Array(10), sampleRate: 24_000 });
      resumeAll();
      await Promise.all([firstPlay, secondPlay]);

      expect(sources).toHaveLength(1);
      expect(sources[0].start).toHaveBeenCalledOnce();
      // The replaced audition still ends, once.
      expect(first).toHaveBeenCalledOnce();
    });

    it("does not start after a stop", async () => {
      const { context, sources, resumeAll } = suspendedContext();
      const player = createAuditionPlayer(() => context);
      const onEnded = vi.fn();
      const playing = player.play({ samples: new Float32Array(10), sampleRate: 24_000 }, onEnded);
      player.stop();
      resumeAll();
      await playing;

      expect(sources).toHaveLength(0);
      expect(onEnded).toHaveBeenCalledOnce();
    });

    it("does not touch the context after dispose", async () => {
      const { context, raw, resumeAll } = suspendedContext();
      const player = createAuditionPlayer(() => context);
      const playing = player.play({ samples: new Float32Array(10), sampleRate: 24_000 });
      player.dispose();
      resumeAll();

      await expect(playing).resolves.toBeUndefined();
      expect(raw.createBuffer).not.toHaveBeenCalled();
      expect(raw.close).toHaveBeenCalledOnce();
    });
  });
});

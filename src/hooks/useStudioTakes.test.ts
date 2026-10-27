import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createStudioHarness, segment } from "./studioSession.testkit";
import { useStudioTakes, WHOLE_SCRIPT_TARGET } from "./useStudioTakes";

vi.mock("../lib/auditionPlayer", () => ({
  createAuditionPlayer: () => ({ play: vi.fn(async () => undefined), stop: vi.fn(), dispose: vi.fn() }),
}));

async function* oneChunk(value: number) {
  yield { audio: new Float32Array(200).fill(value), samplingRate: 100, text: "", index: 1, total: 1, pauseAfterSec: 0.1, pauseKind: "sentence" as const };
}

function setup(initial: Parameters<typeof createStudioHarness>[0] = {}) {
  const harness = createStudioHarness({ engineId: "qwen3", ...initial });
  const hook = renderHook(() => useStudioTakes(harness.session()));
  return { harness, ...hook };
}

describe("useStudioTakes", () => {
  it("lists the whole script and every passage of the timeline as targets", () => {
    const { result } = setup({ segments: [segment(1, "First passage."), segment(2, "Second passage.")], totalDuration: 2 });
    expect(result.current.targets.map((target) => target.id)).toEqual([WHOLE_SCRIPT_TARGET, "segment-1", "segment-2"]);
    expect(result.current.seedControl).toBe(true);
    expect(result.current.unavailableReason).toBeNull();
  });

  it("renders seeded variations through synthesize without touching the player", async () => {
    const { result, harness } = setup({ segments: [segment(1, "First passage.")], totalDuration: 1 });
    harness.setSynthesize(() => oneChunk(0.3));

    await act(async () => {
      await result.current.renderVariations("segment-1", 3);
    });

    const seeds = harness.calls.synthesize.map((request) => request.seed);
    expect(seeds).toHaveLength(3);
    expect(new Set(seeds).size).toBe(3);
    expect(harness.calls.synthesize[0]).toMatchObject({ text: "First passage." });
    const stack = result.current.stacks["segment-1"];
    expect(stack.takes.map((take) => take.seed)).toEqual(seeds);
    expect(stack.takes[0].audio.pauseAfterSec).toBe(0.1);
    expect(result.current.rendering).toBeNull();
    expect(harness.calls.replaceSegment).not.toHaveBeenCalled();
    expect(harness.calls.restoreAudioCache).not.toHaveBeenCalled();
  });

  it("varies speed for engines without a seed", async () => {
    const { result, harness } = setup({ engineId: "kokoro" });
    harness.setSynthesize(() => oneChunk(0.3));
    expect(result.current.seedControl).toBe(false);

    await act(async () => {
      await result.current.renderVariations(WHOLE_SCRIPT_TARGET, 3);
    });

    expect(harness.calls.synthesize.map((request) => request.seed)).toEqual([undefined, undefined, undefined]);
    expect(new Set(harness.calls.synthesize.map((request) => request.tuning.speed)).size).toBe(3);
    expect(result.current.stacks[WHOLE_SCRIPT_TARGET].takes.map((take) => take.label)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Speed /)]),
    );
  });

  it("picks a take and replaces that passage in the timeline", async () => {
    const { result, harness } = setup({ segments: [segment(1, "First passage."), segment(2, "Second passage.")], totalDuration: 2 });
    harness.setSynthesize(() => oneChunk(0.4));
    await act(async () => {
      await result.current.renderVariations("segment-2", 2);
    });
    const take = result.current.stacks["segment-2"].takes[1];

    act(() => result.current.pickTake("segment-2", take.id));

    expect(harness.calls.replaceSegment).toHaveBeenCalledWith("segment-2", expect.objectContaining({
      audio: take.audio.samples,
      samplingRate: 100,
      text: "Second passage.",
      index: 2,
      total: 2,
      pauseAfterSec: 0.1,
    }));
    expect(result.current.stacks["segment-2"].activeTakeId).toBe(take.id);
    expect(result.current.applied["segment-2"]).toBe(take.id);
  });

  it("makes a picked whole-script take the player's audio", async () => {
    const { result, harness } = setup();
    harness.setSynthesize(() => oneChunk(0.4));
    await act(async () => {
      await result.current.renderVariations(WHOLE_SCRIPT_TARGET, 1);
    });
    const take = result.current.stacks[WHOLE_SCRIPT_TARGET].takes[0];

    act(() => result.current.pickTake(WHOLE_SCRIPT_TARGET, take.id));

    expect(harness.calls.cancelActiveGeneration).toHaveBeenCalled();
    expect(harness.calls.restoreAudioCache).toHaveBeenCalledWith(
      [expect.objectContaining({ samplingRate: 100, text: "Hello from the studio.", index: 1, total: 1 })],
      { synthesisComplete: true },
    );
    expect(harness.calls.setShow).toHaveBeenCalledWith(true);
  });

  it("stops on cancel and keeps takes already rendered", async () => {
    const { result, harness } = setup();
    let calls = 0;
    const gate = new Promise<void>(() => undefined);
    harness.setSynthesize((request) => {
      calls += 1;
      if (calls === 1) return oneChunk(0.2);
      return (async function* () {
        await Promise.race([
          gate,
          new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(request.signal?.reason))),
        ]);
        yield* oneChunk(0.2);
      })();
    });

    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.renderVariations(WHOLE_SCRIPT_TARGET, 3); });
    await waitFor(() => expect(result.current.stacks[WHOLE_SCRIPT_TARGET]?.takes).toHaveLength(1));
    act(() => result.current.cancel());
    await act(async () => { await pending; });

    expect(result.current.stacks[WHOLE_SCRIPT_TARGET].takes).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(result.current.rendering).toBeNull();
  });

  it("reports a failed render and a missing passage", async () => {
    const { result, harness } = setup();
    harness.setSynthesize(() => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("Qwen3 is busy.")) }) }));
    await act(async () => { await result.current.renderVariations(WHOLE_SCRIPT_TARGET, 2); });
    expect(result.current.error).toBe("Qwen3 is busy.");

    await act(async () => { await result.current.renderVariations("segment-9", 2); });
    expect(result.current.error).toMatch(/no text/);
  });

  it("drops stacks when the text changes", async () => {
    const { result, harness, rerender } = setup();
    harness.setSynthesize(() => oneChunk(0.2));
    await act(async () => { await result.current.renderVariations(WHOLE_SCRIPT_TARGET, 1); });
    expect(Object.keys(result.current.stacks)).toHaveLength(1);

    harness.state.text = "A different script.";
    rerender();
    expect(result.current.stacks).toEqual({});
  });

  it("drops stacks when the same text is generated again", async () => {
    const { result, harness, rerender } = setup();
    harness.setSynthesize(() => oneChunk(0.2));
    await act(async () => { await result.current.renderVariations(WHOLE_SCRIPT_TARGET, 1); });
    expect(Object.keys(result.current.stacks)).toHaveLength(1);

    harness.state.isGenerating = true;
    rerender();
    expect(result.current.stacks).toEqual({});
  });

  it("drops stacks when other audio replaces the player's, and does not put a take on the passage now under its id", async () => {
    const { result, harness, rerender } = setup({ segments: [segment(1, "Passage A."), segment(2, "Passage B.")], totalDuration: 2 });
    harness.setSynthesize(() => oneChunk(0.9));
    await act(async () => { await result.current.renderVariations("segment-2", 1); });
    const take = result.current.stacks["segment-2"].takes[0];

    // A history replay: the player is never empty on the way, and a player
    // that reuses ids puts "Older Y." under the id passage B had.
    harness.state.contentEpoch += 1;
    harness.state.segments = [segment(1, "Older X."), segment(2, "Older Y.")];
    rerender();

    expect(result.current.stacks).toEqual({});
    act(() => result.current.pickTake("segment-2", take.id));
    expect(harness.calls.replaceSegment).not.toHaveBeenCalled();
  });

  it("keeps the whole-script stack when its own take becomes the player's audio", async () => {
    const { result, harness, rerender } = setup();
    harness.setSynthesize(() => oneChunk(0.4));
    await act(async () => { await result.current.renderVariations(WHOLE_SCRIPT_TARGET, 2); });
    const take = result.current.stacks[WHOLE_SCRIPT_TARGET].takes[0];

    act(() => result.current.pickTake(WHOLE_SCRIPT_TARGET, take.id));
    rerender();

    expect(result.current.stacks[WHOLE_SCRIPT_TARGET].takes).toHaveLength(2);
    expect(result.current.applied[WHOLE_SCRIPT_TARGET]).toBe(take.id);
  });

  it("offers seeded takes for Audio8 now that it accepts a seed", () => {
    const { result } = setup({ engineId: "audio8" });
    expect(result.current.unavailableReason).toBeNull();
  });

  it("explains when an engine has neither seed nor speed control", async () => {
    const registry = await import("../models/registry");
    const realGetEngine = registry.getEngine;
    const audio8 = realGetEngine("audio8");
    const spy = vi.spyOn(registry, "getEngine").mockImplementation(((id: Parameters<typeof realGetEngine>[0]) => (
      id === "audio8"
        ? { ...audio8, capabilities: { ...audio8.capabilities, seed: false, speed: false } }
        : realGetEngine(id)
    )) as typeof realGetEngine);
    try {
      const { result } = setup({ engineId: "audio8" });
      expect(result.current.unavailableReason).toMatch(/no seed or speed/);
    } finally {
      spy.mockRestore();
    }
  });
});

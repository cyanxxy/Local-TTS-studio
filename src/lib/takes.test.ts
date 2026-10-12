import { describe, expect, it, vi } from "vitest";
import {
  addTake,
  compareTakes,
  createTakeStack,
  getActiveTake,
  measureTakeAudio,
  pinTake,
  planTakeVariations,
  planVariationSeeds,
  randomSeed,
  removeTake,
  renderTakeVariations,
  setActiveTake,
  type Take,
  type TakeAudio,
} from "./takes";

function take(id: string, overrides: Partial<Take> = {}): Take {
  return {
    id,
    seed: null,
    createdAt: 0,
    label: id,
    audio: { samples: new Float32Array(24000).fill(0.5), sampleRate: 24000 },
    ...overrides,
  };
}

describe("take stacks", () => {
  it("adds takes and activates the newest by default", () => {
    let stack = createTakeStack("segment-1");
    expect(getActiveTake(stack)).toBeNull();
    stack = addTake(stack, take("a"));
    stack = addTake(stack, take("b"));
    expect(stack.activeTakeId).toBe("b");
    stack = addTake(stack, take("c"), { activate: false });
    expect(stack.activeTakeId).toBe("b");
    expect(getActiveTake(stack)?.id).toBe("b");
    expect(() => addTake(stack, take("a"))).toThrow(/already/);
    // The first take always becomes active, even when not asked to.
    expect(addTake(createTakeStack("x"), take("a"), { activate: false }).activeTakeId).toBe("a");
  });

  it("evicts the oldest take that is not active, pinned or new", () => {
    let stack = createTakeStack("s", { maxTakes: 3 });
    stack = addTake(stack, take("a"));
    stack = pinTake(stack, "a", true);
    stack = addTake(stack, take("b"));
    stack = addTake(stack, take("c"));
    stack = setActiveTake(stack, "b");
    stack = addTake(stack, take("d"), { activate: false });
    expect(stack.takes.map((item) => item.id)).toEqual(["a", "b", "d"]);
    expect(stack.activeTakeId).toBe("b");
    // With nothing evictable the user's choices win over the bound.
    const full = addTake(addTake(createTakeStack("t", { maxTakes: 1 }), take("x")), take("y"));
    expect(full.takes.map((item) => item.id)).toEqual(["y"]);
    const pinnedFull = addTake(pinTake(addTake(createTakeStack("u", { maxTakes: 1 }), take("x")), "x", true), take("y"));
    expect(pinnedFull.takes.map((item) => item.id)).toEqual(["x", "y"]);
    expect(() => createTakeStack("v", { maxTakes: 0 })).toThrow(/at least one/);
  });

  it("switches, pins and removes takes", () => {
    let stack = createTakeStack("s");
    for (const id of ["a", "b", "c"]) stack = addTake(stack, take(id));
    expect(setActiveTake(stack, "c")).toBe(stack);
    stack = setActiveTake(stack, "b");
    expect(() => setActiveTake(stack, "zz")).toThrow(/not in this stack/);
    expect(() => pinTake(stack, "zz", true)).toThrow(/not in this stack/);
    stack = pinTake(stack, "a", true);
    expect(stack.takes[0].pinned).toBe(true);
    expect(pinTake(stack, "a", false).takes[0].pinned).toBe(false);

    // Removing the active take hands over to its newer neighbour...
    let removed = removeTake(stack, "b");
    expect(removed.activeTakeId).toBe("c");
    // ...or the older one when it was the newest.
    removed = removeTake(removed, "c");
    expect(removed.activeTakeId).toBe("a");
    removed = removeTake(removed, "a");
    expect(removed.activeTakeId).toBeNull();
    expect(removeTake(removed, "missing")).toBe(removed);
    expect(removeTake(stack, "a").activeTakeId).toBe("b");
  });
});

describe("variation planning", () => {
  it("plans consecutive unused seeds that wrap at the u32 limit", () => {
    expect(planVariationSeeds(10, 3)).toEqual([10, 11, 12]);
    expect(planVariationSeeds(10, 3, [11, null, 13])).toEqual([10, 12, 14]);
    expect(planVariationSeeds(0xffffffff, 2)).toEqual([0xffffffff, 0]);
    expect(() => planVariationSeeds(-1, 1)).toThrow(/Seeds/);
    expect(() => planVariationSeeds(1, 0)).toThrow(/between 1 and 8/);
    expect(() => planVariationSeeds(1, 9)).toThrow(/between 1 and 8/);
  });

  it("draws random seeds from crypto", () => {
    const seed = randomSeed();
    expect(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff).toBe(true);
    expect(randomSeed((array) => array.set([123]))).toBe(123);
  });

  it("labels seeded variations by seed", () => {
    expect(planTakeVariations({ count: 2, seedControl: true, baseSeed: 5, existing: [{ seed: 5 }] }))
      .toEqual([{ seed: 6, label: "Seed 6" }, { seed: 7, label: "Seed 7" }]);
    const random = planTakeVariations({ count: 1, seedControl: true });
    expect(random[0].seed).not.toBeNull();
  });

  it("fans speed variations around the base inside the stable range", () => {
    expect(planTakeVariations({ count: 4, seedControl: false, baseSpeed: 1 })).toEqual([
      { seed: null, label: "Speed 1.00×", overrides: { speed: 1 } },
      { seed: null, label: "Speed 1.04×", overrides: { speed: 1.04 } },
      { seed: null, label: "Speed 0.96×", overrides: { speed: 0.96 } },
      { seed: null, label: "Speed 1.08×", overrides: { speed: 1.08 } },
    ]);
    // Near the top of the range only slower variations remain.
    expect(planTakeVariations({ count: 3, seedControl: false, baseSpeed: 1.2 }).map((item) => item.overrides?.speed))
      .toEqual([1.15, 1.11, 1.07]);
    expect(planTakeVariations({ count: 2, seedControl: false, existing: [{ seed: null, overrides: { speed: 1 } }] })
      .map((item) => item.overrides?.speed)).toEqual([1.04, 0.96]);
    // The range runs out before the count is reached.
    expect(planTakeVariations({ count: 8, seedControl: false, speedStep: 0.2 })).toHaveLength(1);
    expect(() => planTakeVariations({ count: 1, seedControl: false, speedStep: 0 })).toThrow(/positive/);
  });
});

describe("renderTakeVariations", () => {
  it("renders in order and reports each take as it finishes", async () => {
    const onTake = vi.fn();
    let id = 0;
    const takes = await renderTakeVariations<string>({
      variations: planTakeVariations({ count: 2, seedControl: true, baseSeed: 1 }),
      render: async (variation) => `audio-${variation.seed}`,
      onTake,
      now: () => 42,
      createId: () => `take-${++id}`,
    });
    expect(takes).toEqual([
      { id: "take-1", seed: 1, createdAt: 42, label: "Seed 1", audio: "audio-1" },
      { id: "take-2", seed: 2, createdAt: 42, label: "Seed 2", audio: "audio-2" },
    ]);
    expect(onTake).toHaveBeenCalledTimes(2);
  });

  it("keeps overrides and stops when aborted", async () => {
    const controller = new AbortController();
    const onTake = vi.fn();
    const render = vi.fn(async () => {
      controller.abort();
      return "audio";
    });
    await expect(renderTakeVariations({
      variations: planTakeVariations({ count: 2, seedControl: false }),
      render,
      onTake,
      signal: controller.signal,
    })).rejects.toThrow();
    expect(render).toHaveBeenCalledTimes(1);
    expect(onTake).not.toHaveBeenCalled();

    const takes = await renderTakeVariations({
      variations: [{ seed: null, label: "Speed 1.04×", overrides: { speed: 1.04 } }],
      render: async () => "audio",
      onTake,
    });
    expect(takes[0]).toMatchObject({ overrides: { speed: 1.04 } });
    expect(takes[0].id).toMatch(/[0-9a-f-]{36}/);
  });
});

describe("take comparison", () => {
  it("measures duration and level", () => {
    expect(measureTakeAudio({ samples: new Float32Array([0.5, -0.5, Number.NaN, 0]), sampleRate: 4 }))
      .toEqual({ durationSec: 1, peakDbfs: -6, rmsDbfs: -9 });
    expect(measureTakeAudio({ samples: new Float32Array(0), sampleRate: 24000 }))
      .toEqual({ durationSec: 0, peakDbfs: -120, rmsDbfs: -120 });
  });

  it("compares every take to the active one", () => {
    let stack = createTakeStack<TakeAudio>("s");
    stack = addTake(stack, take("a", { seed: 1 }));
    stack = addTake(stack, take("b", { seed: 2, audio: { samples: new Float32Array(36000).fill(0.25), sampleRate: 24000 } }));
    stack = pinTake(stack, "a", true);
    const rows = compareTakes(stack, measureTakeAudio);
    expect(rows).toEqual([
      { takeId: "a", label: "a", seed: 1, isActive: false, pinned: true, durationSec: 1, peakDbfs: -6, rmsDbfs: -6, durationDeltaSec: -0.5, rmsDeltaDb: 6 },
      { takeId: "b", label: "b", seed: 2, isActive: true, pinned: false, durationSec: 1.5, peakDbfs: -12, rmsDbfs: -12, durationDeltaSec: 0, rmsDeltaDb: 0 },
    ]);
    const empty = removeTake(removeTake(stack, "b"), "a");
    expect(compareTakes(empty, measureTakeAudio)).toEqual([]);
    const noActive = { ...stack, activeTakeId: null };
    expect(compareTakes(noActive, measureTakeAudio).every((row) => row.durationDeltaSec === 0)).toBe(true);
  });
});

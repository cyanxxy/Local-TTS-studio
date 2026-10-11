// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProgressThrottle,
  PROGRESS_MIN_FRACTION,
  PROGRESS_MIN_INTERVAL_MS,
  type ProgressThrottleOptions,
} from "./progressThrottle";

interface Bytes {
  done: number;
  total?: number;
}

function harness(options: Partial<ProgressThrottleOptions<Bytes>> = {}) {
  let clock = 0;
  const emitted: Bytes[] = [];
  const throttle = createProgressThrottle<Bytes>((value) => emitted.push(value), {
    fraction: ({ done, total }) => (total ? done / total : undefined),
    now: () => clock,
    ...options,
  });
  return {
    throttle,
    emitted: () => emitted.map(({ done }) => done),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createProgressThrottle", () => {
  it("defaults to ten updates a second or every half percent", () => {
    expect(PROGRESS_MIN_INTERVAL_MS).toBe(100);
    expect(PROGRESS_MIN_FRACTION).toBe(0.005);
  });

  it("passes the first update and holds back a burst that barely moved", () => {
    const { throttle, emitted } = harness();

    for (let done = 1; done <= 40; done += 1) throttle.push({ done, total: 10_000 });

    // 40 bytes of 10,000 is 0.4%, all within one instant.
    expect(emitted()).toEqual([1]);
  });

  it("lets an update through once the interval has passed", () => {
    const { throttle, emitted, advance } = harness();

    throttle.push({ done: 1, total: 10_000 });
    advance(99);
    throttle.push({ done: 2, total: 10_000 });
    advance(1);
    throttle.push({ done: 3, total: 10_000 });

    expect(emitted()).toEqual([1, 3]);
  });

  it("lets an update through once progress moved half a percent, however soon", () => {
    const { throttle, emitted } = harness();

    throttle.push({ done: 100, total: 10_000 });
    throttle.push({ done: 149, total: 10_000 });
    throttle.push({ done: 151, total: 10_000 });

    expect(emitted()).toEqual([100, 151]);
  });

  it("always passes the start, the end, and boundaries", () => {
    const { throttle, emitted } = harness();

    throttle.push({ done: 5, total: 1_000 });
    throttle.push({ done: 0, total: 1_000 });
    throttle.push({ done: 6, total: 1_000 }, true);
    throttle.push({ done: 7, total: 1_000 });
    throttle.push({ done: 1_000, total: 1_000 });

    expect(emitted()).toEqual([5, 0, 6, 1_000]);
  });

  it("falls back to time alone while the total is unknown", () => {
    const { throttle, emitted, advance } = harness();

    throttle.push({ done: 1 });
    throttle.push({ done: 5_000 });
    advance(100);
    throttle.push({ done: 9_000 });

    expect(emitted()).toEqual([1, 9_000]);
  });

  it("delivers the newest held-back update on flush, and only once", () => {
    const { throttle, emitted } = harness();

    throttle.flush();
    throttle.push({ done: 1 });
    throttle.push({ done: 2 });
    throttle.push({ done: 3 });
    throttle.flush();
    throttle.flush();

    expect(emitted()).toEqual([1, 3]);
  });

  it("measures the next interval from a flushed update", () => {
    const { throttle, emitted, advance } = harness();

    throttle.push({ done: 1 });
    advance(60);
    throttle.push({ done: 2 });
    throttle.flush();
    advance(60);
    throttle.push({ done: 3 });

    expect(emitted()).toEqual([1, 2]);
  });

  it("honours custom thresholds", () => {
    const { throttle, emitted, advance } = harness({ minIntervalMs: 10, minFraction: 0.5 });

    throttle.push({ done: 10, total: 100 });
    throttle.push({ done: 40, total: 100 });
    advance(9);
    throttle.push({ done: 41, total: 100 });
    advance(1);
    throttle.push({ done: 42, total: 100 });
    throttle.push({ done: 70, total: 100 });
    throttle.push({ done: 93, total: 100 });

    expect(emitted()).toEqual([10, 42, 93]);
  });

  describe("during a stall", () => {
    /** Moves the injected clock and the trailing timer together. */
    function stalledHarness(options: Partial<ProgressThrottleOptions<Bytes>> = {}) {
      vi.useFakeTimers();
      const result = harness(options);
      return {
        ...result,
        advance: (ms: number) => {
          result.advance(ms);
          vi.advanceTimersByTime(ms);
        },
      };
    }

    it("delivers a held-back update once the interval has passed", () => {
      const { throttle, emitted, advance } = stalledHarness();

      throttle.push({ done: 1, total: 10_000 });
      advance(30);
      throttle.push({ done: 2, total: 10_000 });
      throttle.push({ done: 3, total: 10_000 });
      advance(69);
      expect(emitted()).toEqual([1]);

      advance(1);
      expect(emitted()).toEqual([1, 3]);
      // Nothing new is held, so nothing more arrives.
      advance(1_000);
      expect(emitted()).toEqual([1, 3]);
    });

    it("does not deliver twice when a later update goes through first", () => {
      const { throttle, emitted, advance } = stalledHarness();

      throttle.push({ done: 1, total: 10_000 });
      throttle.push({ done: 2, total: 10_000 });
      throttle.push({ done: 9_999, total: 10_000 }, true);
      advance(1_000);

      expect(emitted()).toEqual([1, 9_999]);
    });

    it("reports nothing after close, held, pushed or flushed", () => {
      const { throttle, emitted, advance } = stalledHarness();

      throttle.push({ done: 1, total: 10_000 });
      throttle.push({ done: 2, total: 10_000 });
      throttle.close();
      advance(1_000);
      throttle.push({ done: 10_000, total: 10_000 }, true);
      throttle.flush();
      throttle.close();

      expect(emitted()).toEqual([1]);
    });
  });

  it("reads the real clock by default", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const emitted: number[] = [];
    const throttle = createProgressThrottle<number>((value) => emitted.push(value), { fraction: () => undefined });

    throttle.push(1);
    throttle.push(2);
    now.mockReturnValue(1_100);
    throttle.push(3);

    expect(emitted).toEqual([1, 3]);
    now.mockRestore();
  });
});

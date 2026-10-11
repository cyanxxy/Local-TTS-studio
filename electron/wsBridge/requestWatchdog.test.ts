// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestWatchdog } from "./requestWatchdog";

function makeWatchdog() {
  const onIdle = vi.fn();
  const onStalled = vi.fn();
  const watchdog = new RequestWatchdog({ idleTimeoutMs: 1_000, progressTimeoutMs: 5_000, onIdle, onStalled });
  return { watchdog, onIdle, onStalled };
}

describe("RequestWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the idle deadline after a silence", () => {
    const { onIdle, onStalled } = makeWatchdog();

    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onStalled).not.toHaveBeenCalled();
  });

  it("lets process output defer only the idle deadline", () => {
    const { watchdog, onIdle, onStalled } = makeWatchdog();

    for (let elapsed = 0; elapsed < 4_900; elapsed += 700) {
      vi.advanceTimersByTime(700);
      watchdog.outputSeen();
    }
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(watchdog.stopped).toBe(true);

    // The stalled deadline retired the idle one too.
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("lets protocol frames defer both deadlines", () => {
    const { watchdog, onIdle, onStalled } = makeWatchdog();

    for (let elapsed = 0; elapsed < 20_000; elapsed += 900) {
      vi.advanceTimersByTime(900);
      watchdog.frameSeen();
    }
    expect(onIdle).not.toHaveBeenCalled();
    expect(onStalled).not.toHaveBeenCalled();
  });

  it("fires nothing after stop, and ignores activity once stopped", () => {
    const { watchdog, onIdle, onStalled } = makeWatchdog();

    watchdog.stop();
    watchdog.stop();
    watchdog.outputSeen();
    watchdog.frameSeen();
    vi.advanceTimersByTime(60_000);

    expect(onIdle).not.toHaveBeenCalled();
    expect(onStalled).not.toHaveBeenCalled();
  });

  it("never re-arms a deadline that already fired", () => {
    const { watchdog, onIdle } = makeWatchdog();

    vi.advanceTimersByTime(1_000);
    watchdog.frameSeen();
    watchdog.outputSeen();
    vi.advanceTimersByTime(10_000);

    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does not keep the process alive", () => {
    vi.useRealTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { watchdog } = makeWatchdog();
    const timers = setTimeoutSpy.mock.results.map((entry) => entry.value as NodeJS.Timeout);
    expect(timers).toHaveLength(2);
    for (const timer of timers) expect(timer.hasRef()).toBe(false);
    watchdog.stop();
    setTimeoutSpy.mockRestore();
  });
});

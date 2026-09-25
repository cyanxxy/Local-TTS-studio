import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleNextUiFrame } from "./uiScheduling";

describe("scheduleNextUiFrame", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses an animation frame while the page is visible", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    scheduleNextUiFrame(vi.fn());
    expect(raf).toHaveBeenCalledOnce();
  });

  it("falls back to a timer while the page is hidden, when frames never fire", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const callback = vi.fn();

    scheduleNextUiFrame(callback);
    vi.advanceTimersByTime(20);

    expect(raf).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledOnce();
  });
});

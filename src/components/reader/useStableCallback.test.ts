import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useStableCallback } from "./useStableCallback";

describe("useStableCallback", () => {
  it("keeps one identity while always calling the latest handler", () => {
    const first = vi.fn((value: number) => value + 1);
    const second = vi.fn((value: number) => value * 10);
    const { result, rerender } = renderHook(({ handler }) => useStableCallback(handler), {
      initialProps: { handler: first },
    });
    const stable = result.current;

    expect(stable(1)).toBe(2);
    rerender({ handler: second });

    expect(result.current).toBe(stable);
    expect(stable(2)).toBe(20);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(2);
  });
});

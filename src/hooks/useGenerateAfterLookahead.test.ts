import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGenerateAfterLookahead, type LookaheadControls } from "./useGenerateAfterLookahead";

function setup(initial: { busy: boolean; canGenerate: boolean }) {
  let busy = initial.busy;
  const controls = {
    current: {
      preempt: vi.fn(),
      isBusy: () => busy,
    } satisfies LookaheadControls,
  };
  const startGenerate = vi.fn();
  const view = renderHook((props: { canGenerate: boolean }) => (
    useGenerateAfterLookahead({ controls, canGenerate: props.canGenerate, startGenerate })
  ), { initialProps: { canGenerate: initial.canGenerate } });
  return { ...view, controls, startGenerate, release: () => { busy = false; } };
}

describe("useGenerateAfterLookahead", () => {
  it("generates at once when no background render holds the engine", () => {
    const { result, startGenerate, controls } = setup({ busy: false, canGenerate: true });
    result.current.requestGenerate();
    expect(startGenerate).toHaveBeenCalledTimes(1);
    expect(controls.current.preempt).not.toHaveBeenCalled();
  });

  it("yields the engine, then generates once it has freed up", () => {
    const { result, rerender, startGenerate, controls, release } = setup({ busy: true, canGenerate: false });
    result.current.requestGenerate();
    expect(controls.current.preempt).toHaveBeenCalledTimes(1);
    expect(startGenerate).not.toHaveBeenCalled();

    // The render winds down; the engine reports it can generate again.
    release();
    rerender({ canGenerate: true });
    expect(startGenerate).toHaveBeenCalledTimes(1);
    rerender({ canGenerate: false });
    rerender({ canGenerate: true });
    expect(startGenerate).toHaveBeenCalledTimes(1);
  });

  it("does not start while the render is still winding down", () => {
    const { result, rerender, startGenerate } = setup({ busy: true, canGenerate: false });
    result.current.requestGenerate();
    rerender({ canGenerate: true });
    expect(startGenerate).not.toHaveBeenCalled();
  });

  it("forgets a pending request that was cancelled", () => {
    const { result, rerender, startGenerate, release } = setup({ busy: true, canGenerate: false });
    result.current.requestGenerate();
    result.current.cancelPending();
    release();
    rerender({ canGenerate: true });
    expect(startGenerate).not.toHaveBeenCalled();
  });
});

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGenerateAfterLookahead, type LookaheadControls } from "./useGenerateAfterLookahead";

function setup(initial: { busy: boolean; canGenerate: boolean }) {
  let busy = initial.busy;
  let finishRender: () => void = () => undefined;
  const wound = new Promise<void>((resolve) => { finishRender = () => { busy = false; resolve(); }; });
  const controls = {
    current: {
      preempt: vi.fn(),
      isBusy: () => busy,
      settled: () => wound,
    } satisfies LookaheadControls,
  };
  const startGenerate = vi.fn();
  const view = renderHook((props: { canGenerate: boolean; scopeKey: string | null }) => (
    useGenerateAfterLookahead({ controls, canGenerate: props.canGenerate, startGenerate, scopeKey: props.scopeKey })
  ), { initialProps: { canGenerate: initial.canGenerate, scopeKey: "section-1" as string | null } });
  return { ...view, controls, startGenerate, finishRender };
}

describe("useGenerateAfterLookahead", () => {
  it("generates at once when no background render holds the engine", () => {
    const { result, startGenerate, controls } = setup({ busy: false, canGenerate: true });
    result.current.requestGenerate();
    expect(startGenerate).toHaveBeenCalledTimes(1);
    expect(controls.current.preempt).not.toHaveBeenCalled();
  });

  it("generates once the aborted render has wound down even if the engine was free all along", async () => {
    // A render still in its cache check or cooldown never enqueued anything,
    // so canGenerate does not change and nothing else re-renders.
    const { result, startGenerate, controls, finishRender } = setup({ busy: true, canGenerate: true });
    act(() => result.current.requestGenerate());
    expect(controls.current.preempt).toHaveBeenCalledTimes(1);
    expect(startGenerate).not.toHaveBeenCalled();

    await act(async () => {
      finishRender();
      await Promise.resolve();
    });
    expect(startGenerate).toHaveBeenCalledTimes(1);
  });

  it("waits for the engine to report it can generate after the render wound down", async () => {
    const { result, rerender, startGenerate, finishRender } = setup({ busy: true, canGenerate: false });
    act(() => result.current.requestGenerate());
    await act(async () => {
      finishRender();
      await Promise.resolve();
    });
    expect(startGenerate).not.toHaveBeenCalled();
    rerender({ canGenerate: true, scopeKey: "section-1" });
    expect(startGenerate).toHaveBeenCalledTimes(1);
    rerender({ canGenerate: false, scopeKey: "section-1" });
    rerender({ canGenerate: true, scopeKey: "section-1" });
    expect(startGenerate).toHaveBeenCalledTimes(1);
  });

  it("forgets a pending request that was cancelled or belonged to another section", async () => {
    const stopped = setup({ busy: true, canGenerate: true });
    act(() => stopped.result.current.requestGenerate());
    stopped.result.current.cancelPending();
    await act(async () => {
      stopped.finishRender();
      await Promise.resolve();
    });
    expect(stopped.startGenerate).not.toHaveBeenCalled();

    const moved = setup({ busy: true, canGenerate: false });
    act(() => moved.result.current.requestGenerate());
    moved.rerender({ canGenerate: false, scopeKey: "section-2" });
    await act(async () => {
      moved.finishRender();
      await Promise.resolve();
    });
    moved.rerender({ canGenerate: true, scopeKey: "section-2" });
    expect(moved.startGenerate).not.toHaveBeenCalled();
  });
});

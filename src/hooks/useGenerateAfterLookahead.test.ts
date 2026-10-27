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
  const view = renderHook((props: { canGenerate: boolean; scopeKey: string | null; isGenerating?: boolean }) => (
    useGenerateAfterLookahead({
      controls,
      canGenerate: props.canGenerate,
      isGenerating: props.isGenerating ?? false,
      startGenerate,
      scopeKey: props.scopeKey,
    })
  ), {
    initialProps: { canGenerate: initial.canGenerate, scopeKey: "section-1" } as {
      canGenerate: boolean;
      scopeKey: string | null;
      isGenerating?: boolean;
    },
  });
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
    act(() => stopped.result.current.cancelPending());
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

  it("says it is waiting from a request that preempted a render until its generation is under way", async () => {
    const { result, rerender, finishRender } = setup({ busy: true, canGenerate: false });
    expect(result.current.waiting).toBe(false);
    act(() => result.current.requestGenerate());
    expect(result.current.waiting).toBe(true);

    await act(async () => {
      finishRender();
      await Promise.resolve();
    });
    // Wound down, but the engine has not reported it can generate yet.
    expect(result.current.waiting).toBe(true);
    rerender({ canGenerate: true, scopeKey: "section-1" });
    expect(result.current.waiting).toBe(true);
    rerender({ canGenerate: false, scopeKey: "section-1", isGenerating: true });
    expect(result.current.waiting).toBe(false);
  });

  it("stops waiting when the request is cancelled or the section changes", () => {
    const stopped = setup({ busy: true, canGenerate: false });
    act(() => stopped.result.current.requestGenerate());
    act(() => stopped.result.current.cancelPending());
    expect(stopped.result.current.waiting).toBe(false);

    const moved = setup({ busy: true, canGenerate: false });
    act(() => moved.result.current.requestGenerate());
    moved.rerender({ canGenerate: false, scopeKey: "section-2" });
    expect(moved.result.current.waiting).toBe(false);
  });
});

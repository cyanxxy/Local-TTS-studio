import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAsyncChannel } from "../shared/asyncChannel";
import type { SynthesisChunk } from "../shared/engineRuntime";
import { useSynthesisQueue } from "./useSynthesisQueue";

function pendingTask() {
  const started = vi.fn();
  const task = () => {
    started();
    return createAsyncChannel<SynthesisChunk>();
  };
  return { task, started };
}

describe("useSynthesisQueue", () => {
  it("holds requests while the engine's own generation runs and reports when one runs", () => {
    const { result, rerender } = renderHook(({ busy }) => useSynthesisQueue(busy), { initialProps: { busy: true } });
    const { task, started } = pendingTask();

    act(() => {
      void result.current.queue.enqueue(task);
    });
    expect(started).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);

    rerender({ busy: false });
    expect(started).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(true);
  });

  it("holds at once on holdForeground, and lets go once the render shows nothing started", () => {
    const { result } = renderHook(() => useSynthesisQueue(false));
    const { task, started } = pendingTask();

    act(() => {
      result.current.holdForeground();
      void result.current.queue.enqueue(task);
      // Still inside the same event: the hold must already apply.
      expect(started).not.toHaveBeenCalled();
    });

    // The generation never started (foregroundBusy stayed false), so the
    // hold follows it back and the request runs.
    expect(started).toHaveBeenCalledOnce();
  });

  it("aborts pending requests on unmount", async () => {
    const { result, unmount } = renderHook(() => useSynthesisQueue(false));
    const iterator = result.current.queue.enqueue(() => createAsyncChannel<SynthesisChunk>())[Symbol.asyncIterator]();
    const next = iterator.next();

    unmount();

    await expect(next).rejects.toMatchObject({ name: "AbortError" });
  });
});

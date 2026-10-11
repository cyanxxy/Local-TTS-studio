import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Take } from "../lib/takes";
import { takesReducer, useTakes, type TakesState } from "./useTakes";

function take(id: string): Take<string> {
  return { id, seed: null, createdAt: 0, label: id, audio: id };
}

describe("takesReducer", () => {
  it("ignores actions for unknown targets and takes", () => {
    const empty: TakesState<string> = {};
    expect(takesReducer(empty, { type: "activate", targetId: "s", takeId: "a" })).toBe(empty);
    expect(takesReducer(empty, { type: "remove", targetId: "s", takeId: "a" })).toBe(empty);
    expect(takesReducer(empty, { type: "pin", targetId: "s", takeId: "a", pinned: true })).toBe(empty);
    expect(takesReducer(empty, { type: "clear", targetId: "s" })).toBe(empty);
    expect(takesReducer(empty, { type: "reset" })).toBe(empty);

    // Adding to a stack that was never opened, or was cleared, is ignored.
    expect(takesReducer(empty, { type: "add", targetId: "s", take: take("a") })).toBe(empty);
    const opened = takesReducer(empty, { type: "open", targetId: "s" });
    expect(takesReducer(opened, { type: "open", targetId: "s" })).toBe(opened);
    const one = takesReducer(opened, { type: "add", targetId: "s", take: take("a") });
    expect(takesReducer(one, { type: "add", targetId: "s", take: take("a") })).toBe(one);
    const cleared = takesReducer(one, { type: "clear", targetId: "s" });
    expect(takesReducer(cleared, { type: "add", targetId: "s", take: take("late") })).toBe(cleared);
    expect(cleared).toEqual({});
    expect(takesReducer(one, { type: "activate", targetId: "s", takeId: "a" })).toBe(one);
    expect(takesReducer(one, { type: "remove", targetId: "s", takeId: "zz" })).toBe(one);
  });

  it("creates stacks with the requested bound", () => {
    let state: TakesState<string> = takesReducer({}, { type: "open", targetId: "s", maxTakes: 2 });
    for (const id of ["a", "b", "c"]) state = takesReducer(state, { type: "add", targetId: "s", take: take(id) });
    expect(state.s.takes.map((item) => item.id)).toEqual(["b", "c"]);
  });
});

describe("useTakes", () => {
  it("manages stacks per target", () => {
    const { result } = renderHook(() => useTakes<string>({ maxTakes: 4 }));
    act(() => {
      result.current.addTake("seg-1", take("ignored"));
      result.current.openTakes("seg-1");
      result.current.openTakes("seg-2");
      result.current.addTake("seg-1", take("a"));
      result.current.addTake("seg-1", take("b"), { activate: false });
      result.current.addTake("seg-2", take("c"));
    });
    expect(result.current.stacks["seg-1"]).toMatchObject({ activeTakeId: "a", maxTakes: 4 });
    act(() => {
      result.current.setActiveTake("seg-1", "b");
      result.current.pinTake("seg-1", "a", true);
    });
    expect(result.current.stacks["seg-1"].activeTakeId).toBe("b");
    expect(result.current.stacks["seg-1"].takes[0].pinned).toBe(true);
    act(() => result.current.removeTake("seg-1", "b"));
    expect(result.current.stacks["seg-1"].activeTakeId).toBe("a");
    act(() => result.current.clearTakes("seg-1"));
    expect(result.current.stacks["seg-1"]).toBeUndefined();
    // A take that finishes rendering after the clear does not bring the stack back.
    act(() => result.current.addTake("seg-1", take("late")));
    expect(result.current.stacks["seg-1"]).toBeUndefined();
    expect(result.current.stacks["seg-2"]).toBeDefined();
    act(() => result.current.resetTakes());
    expect(result.current.stacks).toEqual({});
  });
});

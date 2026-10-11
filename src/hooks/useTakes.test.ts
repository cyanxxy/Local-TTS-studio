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

    const one = takesReducer(empty, { type: "add", targetId: "s", take: take("a") });
    expect(takesReducer(one, { type: "add", targetId: "s", take: take("a") })).toBe(one);
    expect(takesReducer(one, { type: "activate", targetId: "s", takeId: "a" })).toBe(one);
    expect(takesReducer(one, { type: "remove", targetId: "s", takeId: "zz" })).toBe(one);
  });

  it("creates stacks with the requested bound", () => {
    let state: TakesState<string> = {};
    for (const id of ["a", "b", "c"]) state = takesReducer(state, { type: "add", targetId: "s", take: take(id), maxTakes: 2 });
    expect(state.s.takes.map((item) => item.id)).toEqual(["b", "c"]);
  });
});

describe("useTakes", () => {
  it("manages stacks per target", () => {
    const { result } = renderHook(() => useTakes<string>({ maxTakes: 4 }));
    act(() => {
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
    expect(result.current.stacks["seg-2"]).toBeDefined();
    act(() => result.current.resetTakes());
    expect(result.current.stacks).toEqual({});
  });
});

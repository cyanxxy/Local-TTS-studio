import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppRouting } from "./useAppRouting";

describe("useAppRouting", () => {
  const initialUrl = "/";

  beforeEach(() => {
    window.history.replaceState(null, "", initialUrl);
  });

  afterEach(() => {
    window.history.replaceState(null, "", initialUrl);
  });

  it("canonicalizes unsupported desktop routes on web without dropping search or hash", () => {
    window.history.replaceState(null, "", "/neutts?profile=1#bench");

    const { result } = renderHook(() => useAppRouting(false));

    expect(result.current.activePage).toBe("studio");
    expect(window.location.pathname).toBe("/studio");
    expect(window.location.search).toBe("?profile=1");
    expect(window.location.hash).toBe("#bench");
  });

  it("preserves search and hash during in-app navigation", () => {
    window.history.replaceState(null, "", "/reader?profile=1#bench");

    const { result } = renderHook(() => useAppRouting(false));

    act(() => {
      result.current.navigateToPage("studio");
    });

    expect(result.current.activePage).toBe("studio");
    expect(window.location.pathname).toBe("/studio");
    expect(window.location.search).toBe("?profile=1");
    expect(window.location.hash).toBe("#bench");
  });

  it("uses a desktop route base without dropping search or hash", () => {
    window.history.replaceState(null, "", "/desktop/qwen3?profile=1#bench");

    const { result } = renderHook(() => useAppRouting(true, "/desktop"));

    expect(result.current.activePage).toBe("qwen3");

    act(() => {
      result.current.navigateToPage("reader");
    });

    expect(result.current.activePage).toBe("reader");
    expect(window.location.pathname).toBe("/desktop/reader");
    expect(window.location.search).toBe("?profile=1");
    expect(window.location.hash).toBe("#bench");
  });

  it("lets the page being left act before the browser's Back takes the app off it", () => {
    window.history.replaceState(null, "", "/studio");
    window.history.pushState(null, "", "/reader");
    let pageWhenLeaving: string | null = null;
    const onHistoryLeave = vi.fn(() => { pageWhenLeaving = result.current.activePage; });
    const { result } = renderHook(() => useAppRouting(false, "", onHistoryLeave));
    expect(result.current.activePage).toBe("reader");

    act(() => {
      window.history.replaceState(null, "", "/studio");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(onHistoryLeave).toHaveBeenCalledExactlyOnceWith("reader", "studio");
    // Still on the Reader when it ran.
    expect(pageWhenLeaving).toBe("reader");
    expect(result.current.activePage).toBe("studio");

    // In-app navigation is the caller's to prepare; a popstate that stays on
    // the same page leaves nothing.
    act(() => result.current.navigateToPage("reader"));
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onHistoryLeave).toHaveBeenCalledTimes(1);
  });
});

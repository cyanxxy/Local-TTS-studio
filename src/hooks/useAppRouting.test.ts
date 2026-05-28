import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    window.history.replaceState(null, "", "/desktop/kani?profile=1#bench");

    const { result } = renderHook(() => useAppRouting(true, "/desktop"));

    expect(result.current.activePage).toBe("kani");

    act(() => {
      result.current.navigateToPage("reader");
    });

    expect(result.current.activePage).toBe("reader");
    expect(window.location.pathname).toBe("/desktop/reader");
    expect(window.location.search).toBe("?profile=1");
    expect(window.location.hash).toBe("#bench");
  });
});

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSynthesisSession } from "./synthesisSessionContext";

describe("useSynthesisSession", () => {
  it("refuses to run outside its provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useSynthesisSession())).toThrow(/inside SynthesisSessionProvider/);
    vi.restoreAllMocks();
  });
});

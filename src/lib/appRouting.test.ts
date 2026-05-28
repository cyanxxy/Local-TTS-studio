import { describe, expect, it } from "vitest";
import { getCanonicalPagePath, getPageFromPath, getPagePath, PAGE_PATH } from "./appRouting";

describe("appRouting", () => {
  it("resolves supported paths to their pages", () => {
    expect(getPageFromPath("/studio", false)).toBe("studio");
    expect(getPageFromPath("/reader", false)).toBe("reader");
    expect(getPageFromPath("/neutts", true)).toBe("neutts");
    expect(getPageFromPath("/kani", true)).toBe("kani");
    expect(getPageFromPath("/qwen3", true)).toBe("qwen3");
  });

  it("falls back unsupported web-only desktop paths to studio", () => {
    expect(getPageFromPath("/neutts", false)).toBe("studio");
    expect(getPageFromPath("/kani", false)).toBe("studio");
    expect(getPageFromPath("/qwen3", false)).toBe("studio");
  });

  it("computes canonical paths for supported and unsupported routes", () => {
    expect(getCanonicalPagePath("/", false)).toBe(PAGE_PATH.studio);
    expect(getCanonicalPagePath("/reader/", false)).toBe(PAGE_PATH.reader);
    expect(getCanonicalPagePath("/studio/", false)).toBe(PAGE_PATH.studio);
    expect(getCanonicalPagePath("/neutts", false)).toBe(PAGE_PATH.studio);
    expect(getCanonicalPagePath("/kani", true)).toBe(PAGE_PATH.kani);
    expect(getCanonicalPagePath("/qwen3", true)).toBe(PAGE_PATH.qwen3);
    expect(getCanonicalPagePath("/unknown", true)).toBe(PAGE_PATH.studio);
  });

  it("scopes desktop routes under a base path", () => {
    expect(getPagePath("studio", "/desktop")).toBe("/desktop/studio");
    expect(getPagePath("kani", "/desktop")).toBe("/desktop/kani");
    expect(getPageFromPath("/desktop/reader", true, "/desktop")).toBe("reader");
    expect(getPageFromPath("/desktop/neutts", true, "/desktop")).toBe("neutts");
    expect(getPageFromPath("/kani", true, "/desktop")).toBe("studio");
    expect(getCanonicalPagePath("/desktop", true, "/desktop")).toBe("/desktop/studio");
    expect(getCanonicalPagePath("/desktop/qwen3/", true, "/desktop")).toBe("/desktop/qwen3");
    expect(getCanonicalPagePath("/desktop/unknown", true, "/desktop")).toBe("/desktop/studio");
  });
});

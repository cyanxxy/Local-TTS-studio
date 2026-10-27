import { describe, expect, it } from "vitest";
import { progressFillStyle } from "./progressFill";

describe("progressFillStyle", () => {
  it("slides a full-width fill by the part not yet done", () => {
    expect(progressFillStyle(0)).toEqual({ transform: "translateX(-100%)" });
    expect(progressFillStyle(37.5)).toEqual({ transform: "translateX(-62.5%)" });
    expect(progressFillStyle(100)).toEqual({ transform: "translateX(0%)" });
  });

  it("clamps out-of-range and non-finite progress", () => {
    expect(progressFillStyle(140)).toEqual({ transform: "translateX(0%)" });
    expect(progressFillStyle(-5)).toEqual({ transform: "translateX(-100%)" });
    expect(progressFillStyle(Number.NaN)).toEqual({ transform: "translateX(-100%)" });
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  errorMessage,
  GENERATION_CANCELLED_MESSAGE,
  generationCancelledError,
  isGenerationCancelled,
} from "./errors";

describe("main-process errors", () => {
  it("keeps the cancellation text the bridge and renderer agree on", () => {
    expect(GENERATION_CANCELLED_MESSAGE).toBe("Generation cancelled.");
    expect(generationCancelledError().message).toBe(GENERATION_CANCELLED_MESSAGE);
  });

  it("recognises only an exact cancellation as one", () => {
    expect(isGenerationCancelled(generationCancelledError())).toBe(true);
    expect(isGenerationCancelled(new Error("Generation cancelled. Native output: crash"))).toBe(false);
    expect(isGenerationCancelled(GENERATION_CANCELLED_MESSAGE)).toBe(false);
    expect(isGenerationCancelled(null)).toBe(false);
  });

  it("reads a message from errors and anything else", () => {
    expect(errorMessage(new TypeError("bad"))).toBe("bad");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

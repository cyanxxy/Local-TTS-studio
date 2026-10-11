// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  describeError,
  errorMessage,
  GENERATION_CANCELLED_MESSAGE,
  generationCancelledError,
  isGenerationCancelled,
  nativeFailureDiagnostics,
  NativeRuntimeError,
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

  it("carries diagnostics without changing how the error serialises over IPC", () => {
    const error = new NativeRuntimeError("Rust local bridge exited.", { stderr: "panic", exitCode: 101 });

    // Electron sends `${error}`; the renderer strips only an "Error: " prefix.
    expect(String(error)).toBe("Error: Rust local bridge exited.");
    expect(error).toBeInstanceOf(Error);
    expect(nativeFailureDiagnostics(error)).toEqual({ stderr: "panic", exitCode: 101 });
    expect(nativeFailureDiagnostics(new Error("plain"))).toBeUndefined();
  });
});

describe("describeError", () => {
  it("keeps the native diagnostics of a bridge failure instead of its stack", () => {
    const error = new NativeRuntimeError("Rust local bridge exited.", { stderr: "panic", exitCode: 101 });

    expect(describeError(error)).toEqual({
      message: "Rust local bridge exited.",
      native: { stderr: "panic", exitCode: 101 },
    });
  });

  it("keeps the stack of any other error and stringifies non-errors", () => {
    const error = new TypeError("Invalid request.");

    expect(describeError(error)).toEqual({ message: "Invalid request.", stack: error.stack });
    expect(describeError("plain")).toEqual({ message: "plain" });
    expect(describeError(42)).toEqual({ message: "42" });
  });
});

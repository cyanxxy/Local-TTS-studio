// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { DiagnosticsLogger } from "../diagnostics";
import { generationCancelledError, NativeRuntimeError } from "../errors";
import { createIpcDiagnostics } from "./ipcDiagnostics";

function fakeLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  return logger satisfies DiagnosticsLogger;
}

describe("createIpcDiagnostics", () => {
  it("logs each untrusted channel and origin pair once", () => {
    const log = fakeLogger();
    const diagnostics = createIpcDiagnostics(log);

    diagnostics.onUntrustedSender("local-tts:generate", "https://evil.test");
    diagnostics.onUntrustedSender("local-tts:generate", "https://evil.test");
    diagnostics.onUntrustedSender("audio8:load", "https://evil.test");

    expect(log.warn.mock.calls).toEqual([
      ["Rejected IPC from an untrusted sender", { channel: "local-tts:generate", senderOrigin: "https://evil.test" }],
      ["Rejected IPC from an untrusted sender", { channel: "audio8:load", senderOrigin: "https://evil.test" }],
    ]);
  });

  it("stops logging new untrusted senders after a fixed number of them", () => {
    const log = fakeLogger();
    const diagnostics = createIpcDiagnostics(log);

    for (let index = 0; index < 100; index += 1) {
      diagnostics.onUntrustedSender("audio8:load", `https://evil-${index}.test`);
    }

    expect(log.warn).toHaveBeenCalledTimes(64);
  });

  it("logs a throwing listener as an error with its stack", () => {
    const log = fakeLogger();
    const failure = new Error("listener bug");

    createIpcDiagnostics(log).onListenerError("reader-library:flush-complete", failure);

    expect(log.error).toHaveBeenCalledWith("IPC listener failed", {
      channel: "reader-library:flush-complete",
      error: { message: "listener bug", stack: failure.stack },
    });
  });

  it("logs a native runtime failure as an error with its diagnostics", () => {
    const log = fakeLogger();
    // The native output mentions a cancellation, but this is still a crash.
    const failure = new NativeRuntimeError("Rust local bridge exited.", { stderr: "step cancelled", exitCode: 134 });

    createIpcDiagnostics(log).onHandlerError("local-tts:generate", failure);

    expect(log.error).toHaveBeenCalledWith("IPC request failed", {
      channel: "local-tts:generate",
      error: { message: "Rust local bridge exited.", native: { stderr: "step cancelled", exitCode: 134 } },
    });
  });

  it.each([
    generationCancelledError(),
    new Error("Audio8 request cancelled."),
    new Error("Download canceled."),
  ])("records a deliberate stop at debug level only: $message", (failure) => {
    const log = fakeLogger();

    createIpcDiagnostics(log).onHandlerError("audio8:generate", failure);

    expect(log.debug).toHaveBeenCalledWith("IPC request cancelled", { channel: "audio8:generate" });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs any other failed request as a warning", () => {
    const log = fakeLogger();

    createIpcDiagnostics(log).onHandlerError("document:import-url", "Invalid document URL.");

    expect(log.warn).toHaveBeenCalledWith("IPC request failed", {
      channel: "document:import-url",
      error: { message: "Invalid document URL." },
    });
  });
});

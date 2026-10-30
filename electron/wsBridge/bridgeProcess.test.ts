// @vitest-environment node

import type { ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeProcess, OUTPUT_DRAIN_GRACE_MS, type BridgeOutputStream } from "./bridgeProcess";

const TOKEN = "a".repeat(64);

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: vi.fn() };
  killSignals: Array<string | undefined> = [];
  kill = (signal?: string) => {
    this.killSignals.push(signal);
    return true;
  };
}

function start(overrides: { connectTimeoutMs?: number; platform?: NodeJS.Platform } = {}) {
  const child = new FakeChild();
  const output: Array<[BridgeOutputStream, string]> = [];
  const onExit = vi.fn();
  const bridge = new BridgeProcess(child as unknown as ChildProcessWithoutNullStreams, {
    authToken: TOKEN,
    connectTimeoutMs: overrides.connectTimeoutMs ?? 5_000,
    killGraceMs: 2_000,
    platform: overrides.platform ?? "darwin",
    onOutput: (stream, chunk) => output.push([stream, chunk.toString("utf-8")]),
    onExit,
  });
  const print = (stream: "stdout" | "stderr", text: string) => child[stream].emit("data", Buffer.from(text, "utf-8"));
  return { child, bridge, output, onExit, print };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => "resolved", (error: unknown) => (error as Error).message);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BridgeProcess startup", () => {
  it("resolves the port announced on stdout, across chunk boundaries", async () => {
    const { bridge, output, print } = start();
    print("stdout", "loading\n__POR");
    print("stdout", "T__4242\n");

    await expect(bridge.announcedPort).resolves.toBe(4242);
    expect(output).toEqual([["stdout", "loading\n__POR"], ["stdout", "T__4242\n"]]);
  });

  it("rejects with the failure the bridge reports instead of a port", async () => {
    const { bridge, print } = start();
    print("stdout", "__RESULT__{\"ok\":false,\"error\":\"Missing model files.\"}\n");

    expect(await rejection(bridge.announcedPort)).toBe("Missing model files.");
  });

  it("rejects an invalid port", async () => {
    const { bridge, print } = start();
    print("stdout", "__PORT__99999\n");

    expect(await rejection(bridge.announcedPort)).toMatch(/invalid WebSocket port/);
  });

  it("bounds an unterminated startup line", async () => {
    const { bridge, print } = start();
    print("stdout", "x".repeat(64 * 1024 + 1));

    expect(await rejection(bridge.announcedPort)).toMatch(/startup output exceeded 65536 bytes/);
  });

  it("times out a process that never announces a port", async () => {
    vi.useFakeTimers();
    const { bridge } = start({ connectTimeoutMs: 1_000 });
    const outcome = rejection(bridge.announcedPort);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toBe("Timed out waiting for Rust local bridge WebSocket port.");
  });

  it("explains an exit before the announcement with the exit status", async () => {
    const { bridge, child, onExit } = start();
    child.emit("exit", null, "SIGABRT");
    child.emit("close", null, "SIGABRT");

    expect(await rejection(bridge.announcedPort)).toBe(
      "Rust local bridge exited before announcing its WebSocket port (signal SIGABRT).",
    );
    expect(bridge.hasExited()).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(2);
    await bridge.exited;
    await bridge.outputClosed;
  });

  it("reports a process that failed to spawn", async () => {
    const { bridge, child, onExit } = start();
    child.emit("error", new Error("ENOENT"));

    expect(await rejection(bridge.announcedPort)).toBe("Rust local bridge worker failed before startup: ENOENT");
    expect(onExit).toHaveBeenCalledTimes(1);
    await bridge.outputClosed;
  });

  it("ignores later lines once the port is known", async () => {
    const { bridge, print } = start();
    print("stdout", "__PORT__4242\n");
    print("stdout", "__RESULT__{\"ok\":false,\"error\":\"late\"}\n");

    await expect(bridge.announcedPort).resolves.toBe(4242);
  });
});

describe("BridgeProcess diagnostics", () => {
  it("keeps the first recorded exit status", () => {
    const { bridge, child } = start();
    expect(bridge.exitStatus()).toBe("code unknown");
    child.emit("exit", 3, null);
    child.emit("close", 0, null);

    expect(bridge.exitStatus()).toBe("code 3");
  });

  it("redacts the token from both tails", () => {
    const { bridge, print } = start();
    print("stdout", `stdout ${TOKEN}\n`);
    print("stderr", `stderr ${TOKEN}\n`);

    const diagnostics = bridge.diagnostics("chain");
    expect(diagnostics).toEqual({
      details: "chain",
      stdout: "stdout [redacted]\n",
      stderr: "stderr [redacted]\n",
      exitCode: null,
      signal: null,
    });
  });

  it("leaves empty tails and missing details out", () => {
    const { bridge, print } = start();
    print("stderr", "   \n");

    expect(bridge.diagnostics()).toEqual({ exitCode: null, signal: null });
  });

  it("adds the last stderr lines to a process failure only", () => {
    const { bridge, print } = start();
    print("stderr", "thread 'main' panicked\n");

    expect(bridge.processFailure("Stuck.").message).toBe("Stuck.\nNative output:\nthread 'main' panicked");
    const request = bridge.requestFailure("Bad request.", "Bad request.");
    expect(request.message).toBe("Bad request.");
    expect(request.diagnostics.details).toBeUndefined();
    expect(bridge.requestFailure("Bad request.", "caused by: x").diagnostics.details).toBe("caused by: x");
  });

  it("describes an exit with its status and the failure the bridge printed", () => {
    const { bridge, child, print } = start();
    expect(bridge.exitFailure("Rust local bridge exited").message).toBe("Rust local bridge exited.");

    print("stdout", "__RESULT__{\"ok\":false,\"error\":\"Out of memory.\"}\n");
    child.emit("exit", 1, null);

    expect(bridge.exitFailure("Rust local bridge exited").message)
      .toBe("Rust local bridge exited (code 1): Out of memory.");
  });
});

describe("BridgeProcess lifecycle", () => {
  it("escalates a kill to SIGKILL after the grace period", () => {
    vi.useFakeTimers();
    const { bridge, child } = start();
    bridge.hardKill();
    expect(child.killSignals).toEqual([undefined]);

    vi.advanceTimersByTime(2_000);
    expect(child.killSignals).toEqual([undefined, "SIGKILL"]);
  });

  it("asks a Windows bridge sent a shutdown through stdin and terminates it only after the grace period", () => {
    vi.useFakeTimers();
    const { bridge, child } = start({ platform: "win32" });
    bridge.hardKill({ shutdownSent: true });
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.killSignals).toEqual([]);

    vi.advanceTimersByTime(2_000);
    expect(child.killSignals).toEqual(["SIGKILL"]);
  });

  it("terminates any other Windows bridge at once", () => {
    vi.useFakeTimers();
    const { bridge, child } = start({ platform: "win32" });
    bridge.hardKill();
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(child.killSignals).toEqual([undefined]);
  });

  it("tolerates a kill that throws on an exited process", () => {
    vi.useFakeTimers();
    const { bridge, child } = start();
    child.kill = () => {
      throw new Error("ESRCH");
    };

    expect(() => {
      bridge.hardKill();
      vi.advanceTimersByTime(2_000);
    }).not.toThrow();
  });

  it("waits for the output to close, but no longer than the drain grace", async () => {
    vi.useFakeTimers();
    const { bridge, child } = start();
    let drained = false;
    void bridge.waitForOutput().then(() => {
      drained = true;
    });

    await vi.advanceTimersByTimeAsync(OUTPUT_DRAIN_GRACE_MS - 1);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe(true);

    let closed = false;
    void bridge.waitForOutput().then(() => {
      closed = true;
    });
    child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(true);
  });
});

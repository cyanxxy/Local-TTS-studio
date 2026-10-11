// @vitest-environment node

import type { ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeFailureDiagnostics } from "../errors";
import { BRIDGE_RESULT_PREFIX } from "../localTtsIpc";
import { createProbeRunner, type ProbeRunnerOptions } from "./probeRunner";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinWrites: string[] = [];
  stdinEnded = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: Array<string | undefined> = [];
  stdin = {
    write: (text: string) => {
      this.stdinWrites.push(text);
      return true;
    },
    end: () => {
      this.stdinEnded = true;
    },
  };

  kill = (signal?: string) => {
    this.kills.push(signal);
    return true;
  };

  emitStdout(data: string | Buffer) {
    this.stdout.emit("data", typeof data === "string" ? Buffer.from(data, "utf-8") : data);
  }

  emitStderr(text: string) {
    this.stderr.emit("data", Buffer.from(text, "utf-8"));
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

const PROBE_RESULT = { ready: true, message: "Ready.", runtime: "rust" };
const REQUEST = {
  requestId: "probe-1",
  model: "qwen3" as const,
  bridgeBinary: "/app/dist-rust/open-tts-local-bridge",
  cacheDir: "/cache/qwen3",
  env: { PATH: "/usr/bin" },
};

type DiagnosedError = Error & { diagnostics?: NativeFailureDiagnostics };

function setup(options: Partial<ProbeRunnerOptions> = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const runner = createProbeRunner({
    timeoutMs: 60_000,
    killGraceMs: 2_000,
    maxStdoutBytes: 1_000_000,
    maxStderrBytes: 1_000_000,
    spawn,
    ...options,
  });
  return { runner, spawn, children };
}

async function rejectionOf(run: Promise<unknown>): Promise<DiagnosedError> {
  try {
    await run;
  } catch (error) {
    return error as DiagnosedError;
  }
  throw new Error("Expected the probe to reject.");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createProbeRunner", () => {
  it("runs the one-shot probe action and resolves its parsed result", async () => {
    const { runner, spawn, children } = setup();
    const probe = runner.run(REQUEST);

    expect(spawn).toHaveBeenCalledWith(
      REQUEST.bridgeBinary,
      ["--action", "probe", "--model", "qwen3", "--cache-dir", REQUEST.cacheDir],
      { stdio: ["pipe", "pipe", "pipe"], env: REQUEST.env, cwd: REQUEST.cacheDir },
    );
    expect(children[0].stdinWrites).toEqual(["{}"]);
    expect(children[0].stdinEnded).toBe(true);

    // A multi-byte character split across chunks must survive decoding.
    const line = Buffer.from(`noise\n${BRIDGE_RESULT_PREFIX}${JSON.stringify({ ok: true, result: { ...PROBE_RESULT, message: "Prêt." } })}\n`);
    const split = line.indexOf("ê") + 1;
    children[0].emitStdout(line.subarray(0, split));
    children[0].emitStdout(line.subarray(split));
    children[0].finish(0);

    await expect(probe).resolves.toMatchObject({ ready: true, message: "Prêt." });
  });

  it("reports the failure the bridge printed, with the last stderr lines", async () => {
    const { runner, children } = setup();
    const probe = runner.run(REQUEST);

    children[0].emitStderr("\x1b[33mwarning\x1b[0m: cache directory is read-only\n");
    children[0].emitStdout(`${BRIDGE_RESULT_PREFIX}${JSON.stringify({
      ok: false,
      error: "Failed to create cache directory /cache/qwen3",
      details: "Failed to create cache directory /cache/qwen3\n\nCaused by:\n    Permission denied",
    })}\n`);
    children[0].finish(1);

    const error = await rejectionOf(probe);
    expect(error.message).toBe(
      "Failed to create cache directory /cache/qwen3\nNative output:\nwarning: cache directory is read-only",
    );
    expect(error.diagnostics).toEqual({
      stderr: "warning: cache directory is read-only\n",
      stdout: expect.stringContaining("Permission denied"),
      exitCode: 1,
      signal: null,
    });
  });

  it("never lets a crash read as a cancellation the renderer would hide", async () => {
    const { runner, children } = setup();
    const probe = runner.run(REQUEST);

    children[0].emitStdout(`${BRIDGE_RESULT_PREFIX}${JSON.stringify({ ok: false, error: "MLX stream cancelled" })}\n`);
    children[0].finish(134);

    const error = await rejectionOf(probe);
    expect(error.message).toBe("Rust local bridge exited with code 134.");
    expect(error.diagnostics?.stdout).toContain("MLX stream cancelled");
  });

  it.each([
    { name: "exit code", code: 101, signal: null, summary: "Rust local bridge exited with code 101." },
    { name: "signal", code: null, signal: "SIGSEGV" as const, summary: "Rust local bridge exited with signal SIGSEGV." },
  ])("falls back to the $name when the bridge reported nothing", async ({ code, signal, summary }) => {
    const { runner, children } = setup();
    const probe = runner.run(REQUEST);

    children[0].finish(code, signal);

    const error = await rejectionOf(probe);
    expect(error.message).toBe(summary);
    expect(error.diagnostics).toEqual({ exitCode: code, signal });
  });

  it("bounds the stderr it puts in a failure message", async () => {
    const { runner, children } = setup();
    const probe = runner.run(REQUEST);

    for (let line = 0; line < 40; line += 1) children[0].emitStderr(`line ${line}\n`);
    children[0].finish(2);

    const error = await rejectionOf(probe);
    expect(error.message.split("\n").slice(2)).toEqual(Array.from({ length: 12 }, (_, index) => `line ${28 + index}`));
  });

  it("bounds the stderr in a missing-result failure as well", async () => {
    const { runner, children } = setup();
    const probe = runner.run(REQUEST);

    children[0].emitStderr(`${"x".repeat(5_000)}\n`);
    children[0].finish(0);

    const error = await rejectionOf(probe);
    expect(error.message.startsWith("No bridge result returned. …")).toBe(true);
    expect(error.message.length).toBeLessThan(1_600);
  });

  it("reports a probe it stopped on purpose as cancelled", async () => {
    const { runner, children } = setup();
    const probe = runner.run(REQUEST);

    expect(runner.terminate("probe-1")).toBe(true);
    expect(children[0].kills).toEqual([undefined]);
    children[0].finish(null, "SIGTERM");

    await expect(probe).rejects.toThrow("Generation cancelled.");
    expect(runner.terminate("probe-1")).toBe(false);
  });

  it("escalates to SIGKILL when a stopped probe outlives the grace period", () => {
    vi.useFakeTimers();
    const { runner, children } = setup({ killGraceMs: 500 });
    void runner.run(REQUEST).catch(() => undefined);

    runner.terminate("probe-1");
    vi.advanceTimersByTime(500);

    expect(children[0].kills).toEqual([undefined, "SIGKILL"]);
  });

  it("refuses a second probe with the id of one still running", async () => {
    const { runner, spawn } = setup();
    void runner.run(REQUEST).catch(() => undefined);

    await expect(runner.run(REQUEST)).rejects.toThrow("A request with id probe-1 is already running.");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("stops a probe that outlives its deadline", async () => {
    vi.useFakeTimers();
    const { runner, children } = setup({ timeoutMs: 1_000 });
    const probe = runner.run(REQUEST);

    vi.advanceTimersByTime(1_000);

    await expect(probe).rejects.toThrow("Local bridge timed out after 1s.");
    expect(children[0].kills[0]).toBeUndefined();
    // The late exit of the stopped child changes nothing.
    children[0].finish(null, "SIGTERM");
  });

  it.each(["stdout", "stderr"] as const)("stops a probe whose %s exceeds its cap", async (stream) => {
    const { runner, children } = setup({ maxStdoutBytes: 8, maxStderrBytes: 8 });
    const probe = runner.run(REQUEST);

    if (stream === "stdout") children[0].emitStdout("123456789");
    else children[0].emitStderr("123456789");

    await expect(probe).rejects.toThrow(`Local bridge ${stream} exceeded 8 bytes.`);
    expect(children[0].kills).toEqual([undefined]);
    expect(runner.terminate("probe-1")).toBe(false);
  });

  it("reports a bridge binary that could not be started", async () => {
    const { runner, children } = setup();
    const probe = runner.run(REQUEST);

    children[0].emit("error", new Error("spawn EACCES"));

    await expect(probe).rejects.toThrow("Failed to run Rust local bridge: spawn EACCES");
  });

  it("stops every probe for the quit and returns when each has exited", async () => {
    const { runner, children } = setup();
    const first = runner.run({ ...REQUEST, requestId: "a" }).catch((error: Error) => error.message);
    const second = runner.run({ ...REQUEST, requestId: "b" }).catch((error: Error) => error.message);
    // One has already exited by the time the quit looks at it.
    children[1].exitCode = 0;

    const exits = runner.terminateAll();

    expect(exits).toHaveLength(2);
    expect(children.map((child) => child.kills)).toEqual([[undefined], [undefined]]);
    let firstExited = false;
    void exits[0].then(() => { firstExited = true; });
    await expect(exits[1]).resolves.toBeUndefined();
    expect(firstExited).toBe(false);

    children[0].finish(null, "SIGTERM");
    children[1].finish(0);
    await expect(exits[0]).resolves.toBeUndefined();
    await expect(first).resolves.toBe("Generation cancelled.");
    await expect(second).resolves.toBe("Generation cancelled.");
    expect(runner.terminate("a")).toBe(false);
  });
});

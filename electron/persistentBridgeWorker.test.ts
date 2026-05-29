// @vitest-environment node

import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PROGRESS_PREFIX, BRIDGE_RESULT_PREFIX } from "./localTtsIpc";
import {
  createPersistentBridgeWorkerPool,
  type PersistentWorkerSpawnConfig,
} from "./persistentBridgeWorker";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinWrites: string[] = [];
  killed = false;
  killSignals: Array<string | undefined> = [];
  stdin = {
    write: (data: string) => {
      this.stdinWrites.push(data);
      return true;
    },
    end: () => {},
  };

  kill = (signal?: string) => {
    this.killed = true;
    this.killSignals.push(signal);
    return true;
  };

  emitStdout(text: string) {
    this.stdout.emit("data", Buffer.from(text, "utf-8"));
  }

  emitStderr(text: string) {
    this.stderr.emit("data", Buffer.from(text, "utf-8"));
  }

  exit(code = 0) {
    this.emit("exit", code);
    this.emit("close", code);
  }
}

const SPAWN_CONFIG: PersistentWorkerSpawnConfig = {
  pythonBinary: "/usr/bin/python3",
  scriptPath: "/app/bridge.py",
  cacheDir: "/cache/qwen3",
  env: { PATH: "/usr/bin" },
};

function resultLine(payload: Record<string, unknown>): string {
  return `${BRIDGE_RESULT_PREFIX}${JSON.stringify({ ok: true, result: payload })}\n`;
}

function makePool(options: { idleEvictMs?: number } = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ReturnType<typeof spawn> & FakeChild;
  });
  const pool = createPersistentBridgeWorkerPool<"qwen3">({
    spawn: spawn as never,
    idleEvictMs: options.idleEvictMs ?? 60_000,
    killGraceMs: 2_000,
  });
  return { pool, spawn, children };
}

const RUN_DEFAULTS = {
  idleTimeoutMs: 30_000,
  maxStdoutBytes: 1_000_000,
  maxStderrBytes: 1_000_000,
  onProgressLine: () => {},
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createPersistentBridgeWorkerPool", () => {
  it("reuses a single worker across sequential requests", async () => {
    const { pool, spawn, children } = makePool();

    const first = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "one" },
      spawnConfig: SPAWN_CONFIG,
    });
    children[0].emitStdout(resultLine({ wavBase64: "AAA" }));
    expect((await first).stdout).toContain(BRIDGE_RESULT_PREFIX);

    const second = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r2",
      payload: { text: "two" },
      spawnConfig: SPAWN_CONFIG,
    });
    children[0].emitStdout(resultLine({ wavBase64: "BBB" }));
    expect((await second).stdout).toContain("BBB");

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);
  });

  it("frames each request as a newline-delimited JSON object with its requestId", async () => {
    const { pool, children } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "req-42",
      payload: { text: "hello" },
      spawnConfig: SPAWN_CONFIG,
    });
    children[0].emitStdout(resultLine({}));
    await run;

    expect(children[0].stdinWrites).toHaveLength(1);
    expect(children[0].stdinWrites[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(children[0].stdinWrites[0])).toEqual({
      requestId: "req-42",
      payload: { text: "hello" },
    });
  });

  it("routes progress lines and resolves on the result line", async () => {
    const { pool, children } = makePool();
    const progress: string[] = [];
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
      onProgressLine: (line) => progress.push(line),
    });

    children[0].emitStdout(`${BRIDGE_PROGRESS_PREFIX}{"phase":"inference","message":"working"}\n`);
    children[0].emitStdout(resultLine({ ok: 1 }));
    await run;

    expect(progress).toHaveLength(1);
    expect(progress[0]).toContain("inference");
  });

  it("handles a result split across multiple stdout chunks", async () => {
    const { pool, children } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });
    const line = resultLine({ wavBase64: "CHUNKED" });
    children[0].emitStdout(line.slice(0, 10));
    children[0].emitStdout(line.slice(10));
    expect((await run).stdout).toContain("CHUNKED");
  });

  it("rejects a second concurrent request for the same model", async () => {
    const { pool, children } = makePool();
    const first = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });

    await expect(
      pool.run("qwen3", {
        ...RUN_DEFAULTS,
        requestId: "r2",
        payload: {},
        spawnConfig: SPAWN_CONFIG,
      }),
    ).rejects.toThrow(/already running/);

    children[0].emitStdout(resultLine({}));
    await first;
  });

  it("cancels an in-flight request by killing its worker", async () => {
    const { pool, children } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });

    expect(pool.isRunning("r1")).toBe(true);
    expect(pool.cancel("r1")).toBe(true);
    expect(children[0].killed).toBe(true);

    children[0].exit(null as unknown as number);
    await expect(run).rejects.toThrow(/cancelled/i);
    expect(pool.cancel("r1")).toBe(false);
  });

  it("rejects when the worker exits before returning a result", async () => {
    const { pool, children } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });
    children[0].exit(1);
    await expect(run).rejects.toThrow(/exited before returning/);
  });

  it("kills the worker and rejects when stdout exceeds the byte cap", async () => {
    const { pool, children } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
      maxStdoutBytes: 16,
    });
    children[0].emitStdout("x".repeat(64));
    await expect(run).rejects.toThrow(/exceeded/);
    expect(children[0].killed).toBe(true);
  });

  it("fires the stall watchdog when no output arrives", async () => {
    vi.useFakeTimers();
    const { pool, children } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
      idleTimeoutMs: 5_000,
    });
    const assertion = expect(run).rejects.toThrow(/no output/);
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
    expect(children[0].killed).toBe(true);
  });

  it("re-arms the stall watchdog on streamed output", async () => {
    vi.useFakeTimers();
    const { pool, children } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
      idleTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    children[0].emitStdout(`${BRIDGE_PROGRESS_PREFIX}{"phase":"x","message":"y"}\n`);
    await vi.advanceTimersByTimeAsync(4_000);
    children[0].emitStdout(resultLine({ ok: 1 }));
    expect((await run).stdout).toContain(BRIDGE_RESULT_PREFIX);
  });

  it("evicts an idle worker and respawns on the next request", async () => {
    vi.useFakeTimers();
    const { pool, spawn, children } = makePool({ idleEvictMs: 10_000 });

    const first = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });
    children[0].emitStdout(resultLine({}));
    await first;

    await vi.advanceTimersByTimeAsync(10_001);
    expect(children[0].killed).toBe(true);

    const second = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r2",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });
    children[1].emitStdout(resultLine({}));
    await second;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("respawns when the spawn identity changes (e.g. python binary)", async () => {
    const { pool, spawn, children } = makePool();
    const first = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });
    children[0].emitStdout(resultLine({}));
    await first;

    const second = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r2",
      payload: {},
      spawnConfig: { ...SPAWN_CONFIG, pythonBinary: "/opt/other/python3" },
    });
    expect(children[0].killed).toBe(true);
    children[1].emitStdout(resultLine({}));
    await second;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("shutdownAll kills every worker and clears run state", async () => {
    const { pool, children } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });
    children[0].emitStdout(resultLine({}));
    await run;

    pool.shutdownAll();
    expect(children[0].killed).toBe(true);
    expect(pool.isRunning("r1")).toBe(false);
  });
});

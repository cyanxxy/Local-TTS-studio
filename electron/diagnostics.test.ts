// @vitest-environment node

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsLog,
  type DiagnosticsEntry,
  mirrorToConsole,
  type DiagnosticsLogOptions,
} from "./diagnostics";
import { NativeRuntimeError } from "./errors";

const FIXED_TIME = new Date("2026-10-10T12:00:00.000Z");

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "open-tts-diagnostics-"));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function createLog(options: Partial<DiagnosticsLogOptions> = {}) {
  return createDiagnosticsLog({
    directory: () => path.join(directory, "logs"),
    homeDirectory: "/Users/alice",
    caseInsensitivePaths: false,
    now: () => FIXED_TIME,
    ...options,
  });
}

async function readEntries(fileName = "main.log"): Promise<DiagnosticsEntry[]> {
  const text = await fs.readFile(path.join(directory, "logs", fileName), "utf-8");
  return text.trimEnd().split("\n").map((line) => JSON.parse(line) as DiagnosticsEntry);
}

async function exists(fileName: string): Promise<boolean> {
  return fs.stat(path.join(directory, "logs", fileName)).then(() => true, () => false);
}

describe("createDiagnosticsLog", () => {
  it("writes one JSON line per entry, creating the directory on first use", async () => {
    const log = createLog();
    const appLog = log.logger("app");

    appLog.info("Started", { version: "1.8.5" });
    appLog.child("window").error("Load failed");
    await log.flush();

    expect(await readEntries()).toEqual([
      { ts: "2026-10-10T12:00:00.000Z", level: "info", scope: "app", msg: "Started", data: { version: "1.8.5" } },
      { ts: "2026-10-10T12:00:00.000Z", level: "error", scope: "app:window", msg: "Load failed" },
    ]);
  });

  it("restricts a new log file to its owner", async () => {
    if (process.platform === "win32") return;
    const log = createLog();
    log.logger("app").info("Started");
    await log.flush();

    const { mode } = await fs.stat(path.join(directory, "logs", "main.log"));
    expect(mode & 0o777).toBe(0o600);
  });

  it("discards entries below the configured level", async () => {
    const log = createLog({ level: "warn" });
    const appLog = log.logger("app");

    appLog.debug("noise");
    appLog.info("routine");
    appLog.warn("odd");
    appLog.error("broken");
    await log.flush();

    expect((await readEntries()).map((entry) => entry.msg)).toEqual(["odd", "broken"]);
  });

  it("keeps debug entries when asked to", async () => {
    const log = createLog({ level: "debug" });
    log.logger("app").debug("detail");
    await log.flush();

    expect((await readEntries()).map((entry) => entry.level)).toEqual(["debug"]);
  });

  it("rotates before the current file outgrows its limit and keeps a bounded number of files", async () => {
    const log = createLog({ maxFileBytes: 300, maxEntryBytes: 200, maxFiles: 3 });
    const appLog = log.logger("app");

    for (let index = 0; index < 20; index += 1) appLog.info(`entry ${String(index).padStart(2, "0")}`);
    await log.flush();

    expect(await exists("main.3.log")).toBe(false);
    const files = ["main.2.log", "main.1.log", "main.log"];
    const written: string[] = [];
    for (const file of files) {
      const { size } = await fs.stat(path.join(directory, "logs", file));
      expect(size).toBeLessThanOrEqual(300);
      written.push(...(await readEntries(file)).map((entry) => entry.msg));
    }
    // Oldest first across the rotated copies, ending with the newest entry,
    // with nothing missing between the oldest kept entry and the newest.
    expect(written.at(-1)).toBe("entry 19");
    const first = Number(written[0].slice("entry ".length));
    expect(written).toEqual(Array.from({ length: 20 - first }, (_, offset) => `entry ${String(first + offset).padStart(2, "0")}`));
  });

  it("starts over in the same file when only one file may be kept", async () => {
    const log = createLog({ maxFileBytes: 300, maxEntryBytes: 200, maxFiles: 1 });
    const appLog = log.logger("app");

    for (let index = 0; index < 10; index += 1) appLog.info(`entry ${index}`);
    await log.flush();

    expect(await exists("main.1.log")).toBe(false);
    const entries = await readEntries();
    expect(entries.at(-1)?.msg).toBe("entry 9");
    expect(entries.length).toBeLessThan(10);
  });

  it("counts an existing file towards the limit after a restart", async () => {
    await fs.mkdir(path.join(directory, "logs"), { recursive: true });
    await fs.writeFile(path.join(directory, "logs", "main.log"), `${"x".repeat(250)}\n`);
    const log = createLog({ maxFileBytes: 300, maxEntryBytes: 200 });

    log.logger("app").info("after restart");
    await log.flush();

    expect(await fs.readFile(path.join(directory, "logs", "main.1.log"), "utf-8")).toBe(`${"x".repeat(250)}\n`);
    expect((await readEntries()).map((entry) => entry.msg)).toEqual(["after restart"]);
  });

  it("writes the home directory as ~, with either path separator", async () => {
    const log = createLog({ homeDirectory: "C:\\Users\\alice" });

    log.logger("local-tts").warn("Missing C:\\Users\\alice\\models", {
      path: "C:/Users/alice/AppData/Open TTS",
      nested: { paths: ["C:\\Users\\alice\\a"] },
    });
    await log.flush();

    expect(await readEntries()).toMatchObject([{
      msg: "Missing ~\\models",
      data: { path: "~/AppData/Open TTS", nested: { paths: ["~\\a"] } },
    }]);
  });

  it("matches the home directory in any case where paths ignore case", async () => {
    const log = createLog({ homeDirectory: "C:\\Users\\Alice", caseInsensitivePaths: true });

    log.logger("local-tts").warn("Missing c:\\users\\alice\\models", { path: "C:/USERS/ALICE/AppData" });
    await log.flush();

    expect(await readEntries()).toMatchObject([{ msg: "Missing ~\\models", data: { path: "~/AppData" } }]);
  });

  it("matches the home directory exactly where paths are case-sensitive", async () => {
    const log = createLog({ homeDirectory: "/home/alice" });

    log.logger("app").info("/home/alice/a and /home/Alice/b (a different user's folder)");
    await log.flush();

    expect((await readEntries())[0].msg).toBe("~/a and /home/Alice/b (a different user's folder)");
  });

  it("redacts a home directory that contains pattern characters literally", async () => {
    const log = createLog({ homeDirectory: "/Users/a.b+(c)" });

    log.logger("app").info("/Users/a.b+(c)/x and /Users/aXb+(c)/y");
    await log.flush();

    expect((await readEntries())[0].msg).toBe("~/x and /Users/aXb+(c)/y");
  });

  it("does not treat a root home directory as something to redact", async () => {
    const log = createLog({ homeDirectory: "/" });
    log.logger("app").info("/var/log stays readable");
    await log.flush();

    expect((await readEntries())[0].msg).toBe("/var/log stays readable");
  });

  it("shortens long strings by their middle, keeping more of the end", async () => {
    const log = createLog({ maxStringLength: 40 });

    log.logger("bridge").error("failed", { stderr: `${"a".repeat(30)}${"b".repeat(30)}${"z".repeat(30)}` });
    await log.flush();

    expect((await readEntries())[0].data).toEqual({
      stderr: `${"a".repeat(10)}…[50 characters omitted]…${"z".repeat(30)}`,
    });
  });

  it("writes an entry that is still too large without its data", async () => {
    const log = createLog({ maxEntryBytes: 300 });
    const data = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key${index}`, "v".repeat(30)]));

    log.logger("app").warn("Large", data);
    await log.flush();

    expect(await readEntries()).toEqual([{
      ts: "2026-10-10T12:00:00.000Z",
      level: "warn",
      scope: "app",
      msg: "Large",
      dataOmitted: true,
    }]);
  });

  it("serializes values JSON cannot, and bounds collections and nesting", async () => {
    const log = createLog();
    const plain = new Error("plain failure");
    const native = new NativeRuntimeError("bridge failed", { stderr: "panic", exitCode: 101 });

    log.logger("app").error("Shapes", {
      plain,
      native,
      when: new Date("2026-01-02T03:04:05.000Z"),
      invalidDate: new Date(Number.NaN),
      big: 10n,
      skipped: undefined,
      callback: () => undefined,
      map: new Map([["a", 1]]),
      list: Array.from({ length: 52 }, (_, index) => index),
      sparse: [undefined],
      deep: { a: { b: { c: { d: { e: 1 } } } } },
      deepError: { a: { b: { error: new Error("too deep") } } },
      wide: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, index])),
      bare: Object.create(null) as Record<string, unknown>,
    });
    await log.flush();

    const [entry] = await readEntries();
    const data = entry.data!;
    expect(data.plain).toEqual({ message: "plain failure", stack: expect.stringContaining("plain failure") });
    expect(data.native).toEqual({ message: "bridge failed", native: { stderr: "panic", exitCode: 101 } });
    expect(data.when).toBe("2026-01-02T03:04:05.000Z");
    expect(data.invalidDate).toBe("Invalid Date");
    expect(data.big).toBe("10");
    expect(data).not.toHaveProperty("skipped");
    expect(data).not.toHaveProperty("callback");
    expect(data.map).toBe("[object Map]");
    expect(data.list).toEqual([...Array.from({ length: 50 }, (_, index) => index), "[2 more]"]);
    expect(data.sparse).toEqual([null]);
    expect(data.deep).toEqual({ a: { b: { c: "[nested too deeply]" } } });
    expect(data.deepError).toEqual({ a: { b: { error: "too deep" } } });
    expect(Object.keys(data.wide as object)).toHaveLength(51);
    expect((data.wide as Record<string, unknown>)["…"]).toBe("1 more");
    expect(data.bare).toEqual({});
  });

  it("drops entries while the queue is full and records how many", async () => {
    const log = createLog({ maxPendingEntries: 2 });
    const appLog = log.logger("app");

    // The first entry is taken off the queue at once; two more fit behind it.
    for (let index = 1; index <= 6; index += 1) appLog.info(`entry ${index}`);
    await log.flush();

    expect((await readEntries()).map(({ msg, data }) => ({ msg, data }))).toEqual([
      { msg: "entry 1", data: undefined },
      { msg: "entry 2", data: undefined },
      { msg: "entry 3", data: undefined },
      { msg: "Dropped log entries while the queue was full", data: { count: 3 } },
    ]);
  });

  it("never throws at the caller and reports only the first write failure", async () => {
    const blocker = path.join(directory, "not-a-directory");
    await fs.writeFile(blocker, "");
    const onWriteError = vi.fn(() => {
      throw new Error("the reporter is broken too");
    });
    const log = createDiagnosticsLog({ directory: () => path.join(blocker, "logs"), onWriteError });

    expect(() => log.logger("app").error("first")).not.toThrow();
    log.logger("app").error("second");
    await log.flush();

    expect(onWriteError).toHaveBeenCalledTimes(1);
    expect(log.pending).toBe(false);
  });

  it("recreates the directory when it disappears", async () => {
    const log = createLog();
    const appLog = log.logger("app");
    appLog.info("before");
    await log.flush();
    await fs.rm(path.join(directory, "logs"), { recursive: true, force: true });

    // This write fails and is lost; the failure makes the next one start over.
    appLog.info("lost");
    await log.flush();
    appLog.info("after");
    await log.flush();

    expect((await readEntries()).map((entry) => entry.msg)).toEqual(["after"]);
  });

  it("mirrors every recorded entry and survives a throwing mirror", async () => {
    const mirrored: DiagnosticsEntry[] = [];
    const log = createLog({
      level: "info",
      mirror: (entry) => {
        mirrored.push(entry);
        throw new Error("console unavailable");
      },
    });

    log.logger("app").debug("filtered");
    log.logger("app").warn("kept", { detail: 1 });
    await log.flush();

    expect(mirrored).toEqual([
      { ts: "2026-10-10T12:00:00.000Z", level: "warn", scope: "app", msg: "kept", data: { detail: 1 } },
    ]);
    expect((await readEntries()).map((entry) => entry.msg)).toEqual(["kept"]);
  });

  it("swallows a failure to build an entry", () => {
    const log = createLog({
      now: () => {
        throw new Error("clock broken");
      },
    });

    expect(() => log.logger("app").error("unrecordable")).not.toThrow();
    expect(log.pending).toBe(false);
  });

  it("reports pending writes until the queue drains", async () => {
    const log = createLog();
    await expect(log.flush()).resolves.toBeUndefined();
    expect(log.pending).toBe(false);

    log.logger("app").info("queued");
    expect(log.pending).toBe(true);
    await log.flush();
    expect(log.pending).toBe(false);
  });

  it("rejects limits it cannot honour", () => {
    expect(() => createLog({ maxFiles: 0 })).toThrow("at least one file");
    expect(() => createLog({ maxFileBytes: 1_000, maxEntryBytes: 1_000 })).toThrow("fit in one log file");
  });
});

describe("mirrorToConsole", () => {
  const entry = (level: DiagnosticsEntry["level"], data?: Record<string, unknown>): DiagnosticsEntry => ({
    ts: FIXED_TIME.toISOString(), level, scope: "local-tts", msg: "Warm-up failed", ...(data ? { data } : {}),
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("echoes warnings and errors with their scope and data", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    mirrorToConsole(entry("warn", { model: "qwen3" }));
    mirrorToConsole(entry("error"));

    expect(warn).toHaveBeenCalledWith("[local-tts] Warm-up failed", { model: "qwen3" });
    expect(error).toHaveBeenCalledWith("[local-tts] Warm-up failed");
  });

  it("keeps routine entries off the console", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    mirrorToConsole(entry("info"));
    mirrorToConsole(entry("debug"));

    for (const spy of [log, info, debug, warn]) expect(spy).not.toHaveBeenCalled();
  });
});

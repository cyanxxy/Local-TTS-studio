import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describeError } from "./errors";

export type DiagnosticsLevel = "debug" | "info" | "warn" | "error";

/** One line of the log file. */
export interface DiagnosticsEntry {
  /** ISO 8601 timestamp. */
  ts: string;
  level: DiagnosticsLevel;
  /** The subsystem that wrote it, e.g. `local-tts` or `ipc`. */
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface DiagnosticsLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** A logger for a sub-area; scopes join with ":" (`local-tts:probe`). */
  child(scope: string): DiagnosticsLogger;
}

export interface DiagnosticsLog {
  logger(scope: string): DiagnosticsLogger;
  /** Resolves once every entry logged so far is on disk (or was dropped). */
  flush(): Promise<void>;
  /** True while entries are waiting to be written. */
  readonly pending: boolean;
}

export interface DiagnosticsLogOptions {
  /** Directory for the log files, resolved when the first entry is written. */
  directory: () => string;
  /** The current file; rotated copies are numbered before the extension (`main.1.log`). */
  fileName?: string;
  /** The current file is rotated before it would grow past this. */
  maxFileBytes?: number;
  /** Files kept, the current one included. */
  maxFiles?: number;
  /** Entries below this level are discarded. */
  level?: DiagnosticsLevel;
  /** Longer strings lose their middle. */
  maxStringLength?: number;
  /** An entry still larger than this once serialized is written without its data. */
  maxEntryBytes?: number;
  /** Entries arriving while this many wait to be written are dropped and counted. */
  maxPendingEntries?: number;
  /** Written as "~" wherever it appears, so a shared log does not name the user. */
  homeDirectory?: string;
  now?: () => Date;
  /** Also sees every entry that passes the level filter, e.g. to echo it to a console. */
  mirror?: (entry: DiagnosticsEntry) => void;
  /** Told about the first write failure; later ones are silent. */
  onWriteError?: (error: unknown) => void;
}

export const DIAGNOSTICS_LOG_FILE = "main.log";
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_STRING_LENGTH = 8 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_ENTRIES = 500;
const MAX_DEPTH = 4;
const MAX_ITEMS = 50;

const LEVEL_RANK: Record<DiagnosticsLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Echoes warnings and errors to the console, where a development run shows them. */
export function mirrorToConsole(entry: DiagnosticsEntry): void {
  if (entry.level !== "warn" && entry.level !== "error") return;
  const write = entry.level === "error" ? console.error : console.warn;
  write(`[${entry.scope}] ${entry.msg}`, ...(entry.data ? [entry.data] : []));
}

/**
 * A bounded, rotating JSON-lines log for the main process. Logging never
 * throws and never waits: entries are written in order by one background
 * queue, and a failing disk only costs the entries it could not take.
 */
export function createDiagnosticsLog({
  directory,
  fileName = DIAGNOSTICS_LOG_FILE,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  level: minimumLevel = "info",
  maxStringLength = DEFAULT_MAX_STRING_LENGTH,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
  maxPendingEntries = DEFAULT_MAX_PENDING_ENTRIES,
  homeDirectory = os.homedir(),
  now = () => new Date(),
  mirror,
  onWriteError,
}: DiagnosticsLogOptions): DiagnosticsLog {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error("The diagnostics log must keep at least one file.");
  }
  if (maxEntryBytes >= maxFileBytes) {
    throw new Error("A diagnostics log entry must fit in one log file.");
  }
  const { name: baseName, ext: extension } = path.parse(fileName);
  // A root or empty home would match every path separator.
  const home = homeDirectory.length > 1 ? homeDirectory : "";
  const homeForwardSlashes = home.replaceAll("\\", "/");

  const queue: string[] = [];
  let draining: Promise<void> | null = null;
  let dropped = 0;
  // Unknown until the first write stats the current file.
  let currentBytes: number | null = null;
  let reportedWriteError = false;

  function redact(text: string): string {
    if (!home) return text;
    const redacted = text.replaceAll(home, "~");
    return homeForwardSlashes === home ? redacted : redacted.replaceAll(homeForwardSlashes, "~");
  }

  function boundString(text: string): string {
    const redacted = redact(text);
    if (redacted.length <= maxStringLength) return redacted;
    // The end of native output is where a panic lands, so keep more of it.
    const head = Math.floor(maxStringLength / 4);
    const tail = maxStringLength - head;
    const omitted = redacted.length - head - tail;
    return `${redacted.slice(0, head)}…[${omitted} characters omitted]…${redacted.slice(redacted.length - tail)}`;
  }

  function boundValue(value: unknown, depth: number): unknown {
    if (typeof value === "string") return boundString(value);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
    if (value instanceof Error) return depth >= MAX_DEPTH ? boundString(value.message) : boundValue(describeError(value), depth);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    if (depth >= MAX_DEPTH) return "[nested too deeply]";
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((item) => boundValue(item, depth + 1) ?? null);
      if (value.length > MAX_ITEMS) items.push(`[${value.length - MAX_ITEMS} more]`);
      return items;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      return Object.prototype.toString.call(value);
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const bounded: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, MAX_ITEMS)) {
      const boundedItem = boundValue(item, depth + 1);
      if (boundedItem !== undefined) bounded[boundString(key)] = boundedItem;
    }
    if (entries.length > MAX_ITEMS) bounded["…"] = `${entries.length - MAX_ITEMS} more`;
    return bounded;
  }

  function serialize(entry: DiagnosticsEntry): string {
    const bounded: DiagnosticsEntry = {
      ts: entry.ts,
      level: entry.level,
      scope: boundString(entry.scope),
      msg: boundString(entry.msg),
      ...(entry.data ? { data: boundValue(entry.data, 0) as Record<string, unknown> } : {}),
    };
    const line = `${JSON.stringify(bounded)}\n`;
    if (Buffer.byteLength(line, "utf-8") <= maxEntryBytes) return line;
    const { ts, level, scope, msg } = bounded;
    return `${JSON.stringify({ ts, level, scope, msg, dataOmitted: true })}\n`;
  }

  function rotatedPath(dir: string, index: number): string {
    return path.join(dir, index === 0 ? fileName : `${baseName}.${index}${extension}`);
  }

  // main.log → main.1.log → … → main.{maxFiles - 1}.log; the oldest copy is
  // overwritten by the rename that would have aged it out.
  async function rotate(dir: string): Promise<void> {
    if (maxFiles === 1) {
      await fs.rm(rotatedPath(dir, 0), { force: true });
      return;
    }
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      try {
        await fs.rename(rotatedPath(dir, index - 1), rotatedPath(dir, index));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async function write(line: string): Promise<void> {
    const dir = directory();
    const file = rotatedPath(dir, 0);
    const bytes = Buffer.byteLength(line, "utf-8");
    try {
      if (currentBytes === null) {
        await fs.mkdir(dir, { recursive: true });
        currentBytes = await fs.stat(file).then((stats) => stats.size, () => 0);
      }
      if (currentBytes > 0 && currentBytes + bytes > maxFileBytes) {
        await rotate(dir);
        currentBytes = 0;
      }
      // Owner-only: the log names files and models the user worked with.
      await fs.appendFile(file, line, { encoding: "utf-8", mode: 0o600 });
      currentBytes += bytes;
    } catch (error) {
      // Re-measure next time; the directory may have been removed under us.
      currentBytes = null;
      if (!reportedWriteError) {
        reportedWriteError = true;
        try {
          onWriteError?.(error);
        } catch {
          // Reporting must not turn a lost log line into a main-process error.
        }
      }
    }
  }

  // Started only right after an entry was queued, so the first iteration always
  // awaits a write and `draining` is assigned before this can finish. Clearing
  // it in the same turn that finds the queue empty means an entry queued at any
  // later point starts a fresh drain instead of waiting for the next one.
  async function drain(): Promise<void> {
    try {
      for (;;) {
        const line = queue.shift();
        if (line === undefined) {
          if (dropped === 0) return;
          const count = dropped;
          dropped = 0;
          queue.push(serialize({
            ts: now().toISOString(),
            level: "warn",
            scope: "diagnostics",
            msg: "Dropped log entries while the queue was full",
            data: { count },
          }));
          continue;
        }
        await write(line);
      }
    } finally {
      draining = null;
    }
  }

  function record(scope: string, level: DiagnosticsLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[minimumLevel]) return;
    try {
      const entry: DiagnosticsEntry = { ts: now().toISOString(), level, scope, msg, ...(data ? { data } : {}) };
      try {
        mirror?.(entry);
      } catch {
        // The file is the record; a failing mirror must not cost it.
      }
      if (queue.length >= maxPendingEntries) {
        dropped += 1;
        return;
      }
      queue.push(serialize(entry));
      draining ??= drain();
    } catch {
      // Logging is diagnostics only and must never break its caller.
    }
  }

  function logger(scope: string): DiagnosticsLogger {
    return {
      debug: (msg, data) => record(scope, "debug", msg, data),
      info: (msg, data) => record(scope, "info", msg, data),
      warn: (msg, data) => record(scope, "warn", msg, data),
      error: (msg, data) => record(scope, "error", msg, data),
      child: (childScope) => logger(`${scope}:${childScope}`),
    };
  }

  return {
    logger,
    flush: () => draining ?? Promise.resolve(),
    get pending() {
      return draining !== null;
    },
  };
}

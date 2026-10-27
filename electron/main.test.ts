import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dialog } from "electron";
import { AUDIO8_MAX_TEXT_CHARACTERS, AUDIO8_MODEL_REVISION } from "./audio8Model";
import type { DiagnosticsLevel, DiagnosticsLogger } from "./diagnostics";
import { getDefaultQwen3Profile } from "./qwen3Profiles";
import type { CreateWebSocketBridgeWorkerPoolOptions } from "./webSocketBridgeWorker";

interface FakeWindow {
  webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
}

interface LoggedEntry {
  scope: string;
  level: DiagnosticsLevel;
  msg: string;
  data?: Record<string, unknown>;
}

interface FakeAudio8Client {
  modelDir: string;
  closed: boolean;
  inFlight: Set<string>;
  load: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  ipcListeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  invokeHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  windows: [] as unknown[],
  userDataPath: "/tmp",
  quit: vi.fn(),
  saveAudio: vi.fn(),
  getAudio: vi.fn(),
  closeWorker: vi.fn(() => Promise.resolve()),
  workerError: null as Error | null,
  unhandledRejections: [] as unknown[],
  audio8Clients: [] as unknown[],
  audio8Destroy: null as Promise<void> | null,
  audio8AfterLoad: null as (() => void) | null,
  audio8Hold: null as Promise<void> | null,
  localWsRun: vi.fn(),
  localWsCancel: vi.fn<(requestId: string) => boolean>(() => false),
  localWsShutdown: vi.fn(async () => undefined),
  localWsShutdownAll: vi.fn(async () => undefined),
  localWsRefreshIdleEviction: vi.fn(),
  qwenDownload: vi.fn(),
  qwenResolve: vi.fn(),
  qwenInspect: vi.fn(),
  poolOptions: null as CreateWebSocketBridgeWorkerPoolOptions<"neutts" | "qwen3"> | null,
  logEntries: [] as LoggedEntry[],
  logPending: false,
  logFlush: null as Promise<void> | null,
  windowError: null as Error | null,
  singleInstanceLock: true,
  exit: vi.fn(),
  windowOpened: null as (() => void) | null,
  ready: null as Promise<void> | null,
  ownerWindow: null as unknown,
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => mocks.ready ?? Promise.resolve(),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      mocks.appListeners.set(channel, listener);
    },
    getPath: () => mocks.userDataPath,
    getAppPath: () => "/tmp",
    getVersion: () => "0.0.0-test",
    requestSingleInstanceLock: () => mocks.singleInstanceLock,
    exit: mocks.exit,
    quit: mocks.quit,
  },
  BrowserWindow: class {
    static fromWebContents = () => mocks.ownerWindow;
    static getAllWindows = () => mocks.windows;
    constructor() {
      if (mocks.windowError) throw mocks.windowError;
      mocks.windowOpened?.();
    }

    once = vi.fn();
    loadURL = () => Promise.resolve();
  },
  nativeTheme: { shouldUseDarkColors: false },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.invokeHandlers.set(channel, handler);
    },
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      mocks.ipcListeners.set(channel, listener);
    },
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
    },
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("./readerLibraryWorkerClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("./readerLibraryWorkerClient")>(),
  ReaderLibraryWorkerClient: vi.fn(function ReaderLibraryWorkerClient() {
    if (mocks.workerError) throw mocks.workerError;
    return { saveAudio: mocks.saveAudio, getAudio: mocks.getAudio, close: mocks.closeWorker };
  }),
}));

vi.mock("./webSocketBridgeWorker", () => ({
  createWebSocketBridgeWorkerPool: (options: CreateWebSocketBridgeWorkerPoolOptions<"neutts" | "qwen3">) => {
    mocks.poolOptions = options;
    return {
      run: mocks.localWsRun,
      cancel: mocks.localWsCancel,
      shutdown: mocks.localWsShutdown,
      shutdownAll: mocks.localWsShutdownAll,
      refreshIdleEviction: mocks.localWsRefreshIdleEviction,
    };
  },
}));

// The real log writes under userData/logs. These tests check what main asks
// it to record; electron/diagnostics.test.ts covers the file itself.
vi.mock("./diagnostics", async (importOriginal) => {
  const record = (scope: string, level: DiagnosticsLevel) => (msg: string, data?: Record<string, unknown>) => {
    mocks.logEntries.push({ scope, level, msg, ...(data ? { data } : {}) });
  };
  const logger = (scope: string): DiagnosticsLogger => ({
    debug: record(scope, "debug"),
    info: record(scope, "info"),
    warn: record(scope, "warn"),
    error: record(scope, "error"),
    child: (child) => logger(`${scope}:${child}`),
  });
  return {
    ...await importOriginal<typeof import("./diagnostics")>(),
    createDiagnosticsLog: () => ({
      logger,
      flush: () => mocks.logFlush ?? Promise.resolve(),
      get pending() {
        return mocks.logPending;
      },
    }),
  };
});

vi.mock("./qwen3ModelDownload", async (importOriginal) => ({
  ...await importOriginal<typeof import("./qwen3ModelDownload")>(),
  downloadQwen3Model: mocks.qwenDownload,
  adoptLegacyQwen3ModelDir: mocks.qwenResolve,
  inspectQwen3ModelDir: mocks.qwenInspect,
}));

// Stubbed against the client's behavioural contract only — construct with a
// model dir, `load`/`generate` resolve a result, `destroy` rejects what is
// pending and then settles. `audio8NativeWorker.ts` and `audio8NativeClient.ts`
// are being rewritten in parallel, and none of these assertions should care.
vi.mock("./audio8NativeClient", () => ({
  Audio8NativeClient: vi.fn(function Audio8NativeClient(modelDir: string) {
    // `destroy()` retires the instance for good, so a main process that kept
    // the reference across a clear would wedge every later request. Modelled
    // here so the tests notice if that reference is ever not dropped.
    //
    // Requests are tracked while in flight and dropped the moment they settle,
    // mirroring the client's own pending map — that set is what makes `cancel`
    // able to answer truthfully, so a stub that ignored it could not tell a
    // live request from a finished one.
    const settle = <T>(requestId: string, result: T, isLoad = false): Promise<T> => {
      if (client.closed) return Promise.reject(new Error("Audio8 native worker is shutting down."));
      client.inFlight.add(requestId);
      return (mocks.audio8Hold ?? Promise.resolve()).then(() => {
        if (!client.inFlight.delete(requestId)) throw new Error("Audio8 request cancelled.");
        if (isLoad) {
          // Fires once the result is delivered but before the handler's `await`
          // resumes — the only window where a quit can latch between a load
          // succeeding and its follow-up work being scheduled.
          const afterLoad = mocks.audio8AfterLoad;
          mocks.audio8AfterLoad = null;
          afterLoad?.();
        }
        return result;
      });
    };
    const client = {
      modelDir,
      closed: false,
      inFlight: new Set<string>(),
      load: vi.fn((requestId: string) => settle(requestId, { ready: true, sampleRate: 44_100 }, true)),
      generate: vi.fn((requestId: string) => settle(requestId, {
        sampleRate: 44_100,
        elapsedSec: 0.5,
        audio: new ArrayBuffer(8),
      })),
      cancel: vi.fn((requestId: string) => {
        if (client.closed || !client.inFlight.delete(requestId)) return false;
        return true;
      }),
      // Held open by `mocks.audio8Destroy` to park a clear-cache between the
      // worker teardown and the unlink, which is the window the gate closes.
      destroy: vi.fn(() => {
        client.closed = true;
        client.inFlight.clear();
        return mocks.audio8Destroy ?? Promise.resolve();
      }),
    };
    mocks.audio8Clients.push(client);
    return client;
  }),
}));

function captureRejection(reason: unknown): void {
  mocks.unhandledRejections.push(reason);
}

function createPort() {
  return { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), on: vi.fn(), once: vi.fn() };
}

function createWindow(): FakeWindow {
  return { webContents: { isDestroyed: () => false, send: vi.fn() } };
}

function createEvent(port: ReturnType<typeof createPort> | undefined, url = "app://-/studio") {
  return {
    ports: port ? [port] : [],
    senderFrame: { url },
    sender: {
      id: 1, getURL: () => url, isDestroyed: () => false, send: vi.fn(),
      on: vi.fn(), once: vi.fn(), removeListener: vi.fn(),
    },
  };
}

function emitStream(channel: string, event: unknown, request: unknown): void {
  const listener = mocks.ipcListeners.get(channel);
  if (!listener) throw new Error(`No listener registered for ${channel}`);
  listener(event, request);
}

const STREAM_CHANNELS = [
  {
    channel: "reader-library:save-audio-stream",
    invalidError: "Invalid Reader audio stream request.",
    request: { metadata: {}, chunkCount: 1 },
  },
  {
    channel: "reader-library:get-audio-stream",
    invalidError: "Invalid Reader audio lookup request.",
    request: { documentId: "doc-1", sectionId: "section-1" },
  },
] as const;

describe("Reader library audio stream IPC", () => {
  beforeAll(async () => {
    process.on("unhandledRejection", captureRejection);
    // main.ts is bundled to CommonJS for Electron; the ESM test transform has
    // no `__dirname`, and the preload/worker paths are only ever joined here.
    (globalThis as { __dirname?: string }).__dirname = "/tmp";
    await import("./main");
  });

  afterAll(() => {
    process.off("unhandledRejection", captureRejection);
  });

  beforeEach(() => {
    mocks.saveAudio.mockClear();
    mocks.getAudio.mockClear();
    mocks.workerError = null;
  });

  it.each(STREAM_CHANNELS)("closes $channel ports from untrusted senders silently", ({ channel, request }) => {
    const port = createPort();
    emitStream(channel, createEvent(port, "https://example.com"), request);

    expect(port.close).toHaveBeenCalledTimes(1);
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(mocks.saveAudio).not.toHaveBeenCalled();
    expect(mocks.getAudio).not.toHaveBeenCalled();
  });

  it.each(STREAM_CHANNELS)("rejects $channel ports for malformed requests", ({ channel, invalidError }) => {
    const port = createPort();
    emitStream(channel, createEvent(port), "not-a-record");

    expect(port.postMessage).toHaveBeenCalledWith({ type: "result", ok: false, error: invalidError });
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it.each(STREAM_CHANNELS)("rejects $channel ports when the worker fails to start", ({ channel, request }) => {
    mocks.workerError = new Error("Worker boot failed.");
    const port = createPort();
    emitStream(channel, createEvent(port), request);

    expect(port.postMessage).toHaveBeenCalledWith({
      type: "result",
      ok: false,
      error: "Worker boot failed.",
    });
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it.each(STREAM_CHANNELS)("forwards a valid $channel request to the worker", ({ channel, request }) => {
    const port = createPort();
    emitStream(channel, createEvent(port), request);

    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.close).not.toHaveBeenCalled();
    const forwarded = channel === "reader-library:save-audio-stream" ? mocks.saveAudio : mocks.getAudio;
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(forwarded.mock.calls[0][0]).toBe(port);
  });

  // Runs first of the teardown tests: quitting latches the shutdown flag for
  // the rest of the module.
  it("holds the quit for the reader library worker without leaving its rejection unhandled", async () => {
    // `close()` fails every in-flight request up front, so it can now reject
    // where it used to only ever resolve. The rejection has to be built inside
    // the call: the quit closes the worker a tick after `before-quit` (it waits
    // for the renderer flush first), and a promise rejected before then would
    // be reported unhandled no matter how the shutdown chain handles it.
    mocks.closeWorker.mockImplementationOnce(
      () => Promise.reject(new Error("Reader library worker is shutting down.")),
    );
    const quitEvent = { preventDefault: vi.fn() };

    // Holding the quit arms a multi-second timer; fake it so no real timer
    // outlives the run.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      mocks.appListeners.get("before-quit")?.(quitEvent);
      // One macrotask turn is enough for Node to report an unhandled rejection.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.unhandledRejections).toEqual([]);
  });

  it.each(STREAM_CHANNELS)("rejects $channel ports once the app is quitting", ({ channel, request }) => {
    const port = createPort();
    emitStream(channel, createEvent(port), request);

    expect(port.postMessage).toHaveBeenCalledWith({
      type: "result",
      ok: false,
      error: "Reader library is shutting down.",
    });
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(mocks.saveAudio).not.toHaveBeenCalled();
    expect(mocks.getAudio).not.toHaveBeenCalled();
  });
});

describe("Reader library quit-time flush", () => {
  // `before-quit` latches a one-shot shutdown flag, so each case needs its own
  // module instance rather than a shared one.
  beforeEach(async () => {
    vi.resetModules();
    mocks.ipcListeners.clear();
    mocks.appListeners.clear();
    mocks.closeWorker.mockClear();
    mocks.quit.mockClear();
    mocks.saveAudio.mockClear();
    mocks.workerError = null;
    mocks.windows = [];
    (globalThis as { __dirname?: string }).__dirname = "/tmp";
    await import("./main");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Starts the worker the way a renderer would, so the quit has one to close. */
  function startReaderLibraryWorker(): void {
    emitStream(
      "reader-library:save-audio-stream",
      createEvent(createPort()),
      { metadata: {}, chunkCount: 1 },
    );
    expect(mocks.saveAudio).toHaveBeenCalledTimes(1);
    mocks.saveAudio.mockClear();
  }

  function quit(): { preventDefault: ReturnType<typeof vi.fn> } {
    const quitEvent = { preventDefault: vi.fn() };
    mocks.appListeners.get("before-quit")?.(quitEvent);
    return quitEvent;
  }

  it("starts the SQLite worker beside the main bundle with the library in userData", async () => {
    startReaderLibraryWorker();
    const { ReaderLibraryWorkerClient } = await import("./readerLibraryWorkerClient");

    // The test runner gives main.ts its own source directory as __dirname.
    expect(vi.mocked(ReaderLibraryWorkerClient)).toHaveBeenLastCalledWith(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "readerLibraryWorker.js"),
      path.join(mocks.userDataPath, "reader-library.sqlite3"),
      expect.any(Function),
    );
  });

  it("keeps the worker open until every renderer acknowledges the flush", async () => {
    const window = createWindow();
    mocks.windows = [window];
    startReaderLibraryWorker();

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const quitEvent = quit();
    await new Promise((resolve) => setImmediate(resolve));

    expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1);
    const [channel, payload] = window.webContents.send.mock.calls[0] as [string, { token: string }];
    expect(channel).toBe("reader-library:flush");
    expect(mocks.closeWorker).not.toHaveBeenCalled();

    // The whole point of the handshake: writes the renderer issues during the
    // flush window still reach the worker instead of being rejected.
    const port = createPort();
    emitStream("reader-library:save-audio-stream", createEvent(port), { metadata: {}, chunkCount: 1 });
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(mocks.saveAudio).toHaveBeenCalledTimes(1);

    mocks.ipcListeners.get("reader-library:flush-complete")?.(createEvent(undefined), payload);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
  });

  it("still quits when a renderer never acknowledges the flush", async () => {
    const window = createWindow();
    mocks.windows = [window];
    startReaderLibraryWorker();

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    quit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.closeWorker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_600);
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });

  it("does not cut short a worker close that runs past the flush timeout", async () => {
    const window = createWindow();
    mocks.windows = [window];
    startReaderLibraryWorker();
    // The worker takes nearly its full 2 s close budget to write out what the
    // flush queued, after a renderer that never acknowledged the flush.
    mocks.closeWorker.mockImplementationOnce(() => new Promise<void>((resolve) => { setTimeout(resolve, 1_900); }));

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    quit();
    await vi.advanceTimersByTimeAsync(1_500 + 1_800);
    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    expect(mocks.quit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });

  it("holds a second quit while the flush is still outstanding", async () => {
    mocks.windows = [createWindow()];
    startReaderLibraryWorker();

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    expect(quit().preventDefault).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(quit().preventDefault).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_300);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });

  it("rejects Reader library work once the flush window has closed", async () => {
    mocks.windows = [];
    startReaderLibraryWorker();

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    quit();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.closeWorker).toHaveBeenCalledTimes(1);
    const port = createPort();
    emitStream("reader-library:get-audio-stream", createEvent(port), { documentId: "d", sectionId: "s" });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "result",
      ok: false,
      error: "Reader library is shutting down.",
    });
  });
});

describe("document IPC", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    mocks.ipcListeners.clear();
    mocks.invokeHandlers.clear();
    mocks.appListeners.clear();
    mocks.windows = [];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "open-tts-main-documents-"));
    (globalThis as { __dirname?: string }).__dirname = "/tmp";
    await import("./main");
  });

  afterEach(async () => {
    vi.mocked(dialog.showOpenDialog).mockReset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Imports an EPUB through the dialog and returns the staged transfer. */
  async function stageEpub(bytes: Uint8Array): Promise<{ epubTransferId: string; epubByteLength: number }> {
    const filePath = path.join(tempDir, "book.epub");
    await fs.writeFile(filePath, bytes);
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [filePath] });
    const result = await mocks.invokeHandlers.get("document:import")!(createEvent(undefined)) as {
      fileName: string;
      epubTransferId: string;
      epubByteLength: number;
    };
    expect(result).toMatchObject({ canceled: false, fileName: "book.epub", epubByteLength: bytes.byteLength });
    expect(result).not.toHaveProperty("epubBytes");
    return result;
  }

  async function waitForPortClose(port: ReturnType<typeof createPort>): Promise<void> {
    for (let turn = 0; turn < 100 && port.close.mock.calls.length === 0; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it("streams a staged EPUB to the importing renderer once, then forgets it", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { epubTransferId } = await stageEpub(bytes);

    const port = createPort();
    emitStream("document:read-epub", createEvent(port), { transferId: epubTransferId });
    await waitForPortClose(port);

    expect(port.postMessage.mock.calls).toEqual([
      [{ offset: 0, chunk: bytes }],
      [{ done: true }],
    ]);

    // A second read of the same transfer finds nothing to send.
    const replay = createPort();
    emitStream("document:read-epub", createEvent(replay), { transferId: epubTransferId });
    expect(replay.postMessage).toHaveBeenCalledWith({ error: "The EPUB transfer expired. Import the file again." });
    expect(replay.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a transfer staged for a different renderer", async () => {
    const { epubTransferId } = await stageEpub(new Uint8Array([9]));
    const port = createPort();
    const otherRenderer = createEvent(port);
    otherRenderer.sender.id = 2;

    emitStream("document:read-epub", otherRenderer, { transferId: epubTransferId });

    expect(port.postMessage).toHaveBeenCalledWith({ error: "The EPUB transfer expired. Import the file again." });
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it("closes an untrusted sender's port silently instead of throwing in the main process", async () => {
    const { epubTransferId } = await stageEpub(new Uint8Array([7]));
    const port = createPort();

    expect(() => emitStream(
      "document:read-epub",
      createEvent(port, "https://example.com"),
      { transferId: epubTransferId },
    )).not.toThrow();

    expect(port.close).toHaveBeenCalledTimes(1);
    expect(port.postMessage).not.toHaveBeenCalled();
    // The untrusted read did not consume the transfer.
    const trusted = createPort();
    emitStream("document:read-epub", createEvent(trusted), { transferId: epubTransferId });
    await waitForPortClose(trusted);
    expect(trusted.postMessage).toHaveBeenLastCalledWith({ done: true });
  });

  it("answers a malformed read request on the port instead of leaving it open", () => {
    const port = createPort();

    emitStream("document:read-epub", createEvent(port), { transferId: 42 });

    expect(port.postMessage).toHaveBeenCalledWith({
      error: "The EPUB transfer request was invalid. Import the file again.",
    });
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it("returns plain-text imports inline without staging a transfer", async () => {
    const filePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(filePath, "Hello from a text file.");
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [filePath] });

    await expect(mocks.invokeHandlers.get("document:import")!(createEvent(undefined))).resolves.toEqual({
      canceled: false,
      fileName: "notes.txt",
      text: "Hello from a text file.",
      pageCount: undefined,
    });
  });

  it.each([
    { name: "a non-string URL", request: { url: 42 } },
    { name: "an over-long URL", request: { url: `https://example.com/${"a".repeat(2048)}` } },
    { name: "a missing request", request: undefined },
  ])("rejects a URL import with $name", ({ request }) => {
    expect(() => mocks.invokeHandlers.get("document:import-url")!(createEvent(undefined), request))
      .toThrow("Invalid document URL.");
  });
});

const STALE_REVISION = "0000000000000000000000000000000000000000";
const AUDIO8_CHANNELS = [
  { channel: "audio8:load", request: { requestId: "trusted-load" } },
  { channel: "audio8:generate", request: { requestId: "trusted-gen", text: "hello", voice: "clara" } },
  { channel: "audio8:cancel", request: { requestId: "trusted-cancel" } },
  { channel: "audio8:cache-info", request: undefined },
  { channel: "audio8:clear-cache", request: undefined },
] as const;

function invokeAudio8(channel: string, request?: unknown, url = "app://-/studio"): unknown {
  const handler = mocks.invokeHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(createEvent(undefined, url), request);
}

/** Normalises the handlers that validate synchronously against the async ones. */
async function audio8Rejection(channel: string, request?: unknown, url?: string): Promise<Error> {
  try {
    await invokeAudio8(channel, request, url);
  } catch (err) {
    return err as Error;
  }
  throw new Error(`${channel} resolved but should have been rejected`);
}

function audio8Clients(): FakeAudio8Client[] {
  return mocks.audio8Clients as FakeAudio8Client[];
}

function audio8RevisionDir(revision: string): string {
  return path.join(mocks.userDataPath, "local-model-cache", "audio8", revision);
}

async function writeAudio8Revision(revision: string): Promise<string> {
  const dir = audio8RevisionDir(revision);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "slow_ar_int4.onnx"), Buffer.alloc(64));
  return dir;
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Real timers only — the prune is fire-and-forget filesystem work. */
async function waitForPrune(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!await directoryExists(dir)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${dir} to be pruned`);
}

/**
 * The barrier joins filesystem work on the libuv threadpool, so the bound has
 * to be wall-clock time, not a turn count: a pending `setImmediate` keeps the
 * poll phase from blocking, letting a turn-counted loop exhaust itself in
 * microseconds while a loaded runner is still mid-`rm`. `setImmediate` and
 * `Date.now` are never faked here, so this still drives a suite running on
 * fake `setTimeout`.
 */
async function waitForQuit(): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (mocks.quit.mock.calls.length > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for app.quit()");
}

/**
 * Gives the shutdown chain room to settle wrongly. Asserting "not quit yet" on
 * the same turn as `before-quit` proves nothing — every member of the barrier
 * resolves a microtask later — so the wait has to outlast the version that
 * forgot to join the cache tasks at all.
 */
async function drainTurns(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("Audio8 IPC", () => {
  // `before-quit` latches a one-shot flag and the cache gate is module state, so
  // every case gets its own module instance.
  beforeEach(async () => {
    vi.resetModules();
    mocks.ipcListeners.clear();
    mocks.invokeHandlers.clear();
    mocks.appListeners.clear();
    mocks.quit.mockClear();
    mocks.workerError = null;
    mocks.windows = [];
    mocks.audio8Clients = [];
    mocks.audio8Destroy = null;
    mocks.audio8AfterLoad = null;
    mocks.audio8Hold = null;
    mocks.unhandledRejections.length = 0;
    mocks.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "open-tts-main-audio8-"));
    (globalThis as { __dirname?: string }).__dirname = "/tmp";
    await import("./main");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(mocks.userDataPath, { recursive: true, force: true });
    mocks.userDataPath = "/tmp";
  });

  describe("validation boundary", () => {
    it.each(AUDIO8_CHANNELS)("rejects $channel from an untrusted sender", async ({ channel, request }) => {
      const error = await audio8Rejection(channel, request, "https://example.com");

      expect(error.message).toBe("Rejected IPC from untrusted sender.");
      // Nothing may have happened behind the guard: no worker started, and the
      // cache directory neither read nor removed.
      expect(audio8Clients()).toHaveLength(0);
    });

    it.each([
      { name: "an unknown voice", request: { requestId: "r", text: "hi", voice: "morgan" }, error: "Unsupported Audio8 voice." },
      { name: "a missing voice", request: { requestId: "r", text: "hi" }, error: "Unsupported Audio8 voice." },
      { name: "empty text", request: { requestId: "r", text: "", voice: "clara" }, error: "Invalid Audio8 synthesis text." },
      { name: "whitespace-only text", request: { requestId: "r", text: "   \n ", voice: "clara" }, error: "Invalid Audio8 synthesis text." },
    ])("rejects a generate with $name", async ({ request, error }) => {
      expect((await audio8Rejection("audio8:generate", request)).message).toBe(error);
      expect(audio8Clients()).toHaveLength(0);
    });

    it("rejects a generate one scalar over the character cap but accepts the cap itself", async () => {
      const atCap = "a".repeat(AUDIO8_MAX_TEXT_CHARACTERS);
      const overCap = `${atCap}a`;

      expect((await audio8Rejection("audio8:generate", { requestId: "over", text: overCap, voice: "clara" })).message)
        .toBe("Invalid Audio8 synthesis text.");
      await expect(invokeAudio8("audio8:generate", { requestId: "at", text: atCap, voice: "clara" }))
        .resolves.toMatchObject({ sampleRate: 44_100 });
    });

    it("counts the cap in unicode scalars, not UTF-16 units", async () => {
      // Astral emoji are two code units each; a naive `.length` check would
      // reject this at half the advertised limit.
      const text = "🎧".repeat(AUDIO8_MAX_TEXT_CHARACTERS);

      await expect(invokeAudio8("audio8:generate", { requestId: "emoji", text, voice: "clara" }))
        .resolves.toMatchObject({ sampleRate: 44_100 });
    });

    it.each(["audio8:load", "audio8:generate", "audio8:cancel"])(
      "rejects %s for a malformed requestId",
      async (channel) => {
        const base = { text: "hi", voice: "clara" };
        expect((await audio8Rejection(channel, { ...base, requestId: "has spaces" })).message)
          .toBe("Invalid Audio8 request id.");
        expect((await audio8Rejection(channel, { ...base, requestId: "a".repeat(129) })).message)
          .toBe("Invalid Audio8 request id.");
        expect((await audio8Rejection(channel, { ...base, requestId: "" })).message)
          .toBe("Invalid Audio8 request id.");
        expect(audio8Clients()).toHaveLength(0);
      },
    );

    it("reports a cancel as undelivered before any worker exists", () => {
      expect(invokeAudio8("audio8:cancel", { requestId: "never-ran" })).toEqual({ cancelled: false });
      expect(audio8Clients()).toHaveLength(0);
    });

    it("reports a cancel as delivered while the request is still in flight", async () => {
      let release!: () => void;
      mocks.audio8Hold = new Promise<void>((resolve) => { release = () => resolve(); });
      const generated = (invokeAudio8("audio8:generate", { requestId: "g1", text: "hi", voice: "clara" }) as Promise<unknown>)
        .then(() => "finished", () => "stopped");
      await drainTurns();

      expect(invokeAudio8("audio8:cancel", { requestId: "g1" })).toEqual({ cancelled: true });
      expect(audio8Clients()[0].cancel).toHaveBeenCalledWith("g1");

      release();
      await expect(generated).resolves.toBe("stopped");
    });

    it.each([
      { name: "crashes", event: "render-process-gone", via: "on" },
      { name: "reloads", event: "did-navigate", via: "on" },
      { name: "closes", event: "destroyed", via: "once" },
    ] as const)("cancels the in-flight generation of a window that $name", async ({ event: lifecycleEvent, via }) => {
      let release!: () => void;
      mocks.audio8Hold = new Promise<void>((resolve) => { release = () => resolve(); });
      const event = createEvent(undefined);
      const generated = (mocks.invokeHandlers.get("audio8:generate")!(
        event,
        { requestId: "g1", text: "hi", voice: "clara" },
      ) as Promise<unknown>).then(() => "finished", () => "stopped");
      await drainTurns();

      const listener = event.sender[via].mock.calls.find(([name]) => name === lifecycleEvent)?.[1] as () => void;
      listener();

      // Nothing else can stop it: the renderer that owned the id is gone, and the
      // worker would otherwise keep generating ahead of the new page's requests.
      expect(audio8Clients()[0].cancel).toHaveBeenCalledWith("g1");
      release();
      await expect(generated).resolves.toBe("stopped");
    });

    it("drops a request still waiting out a clear once its window is gone", async () => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });
      let releaseClear!: () => void;
      mocks.audio8Destroy = new Promise<void>((resolve) => { releaseClear = () => resolve(); });
      const cleared = invokeAudio8("audio8:clear-cache") as Promise<unknown>;
      const event = createEvent(undefined);
      const generated = mocks.invokeHandlers.get("audio8:generate")!(
        event,
        { requestId: "g1", text: "hi", voice: "clara" },
      ) as Promise<unknown>;
      await drainTurns();

      const crashed = event.sender.on.mock.calls.find(([name]) => name === "render-process-gone")?.[1] as () => void;
      crashed();
      releaseClear();
      await cleared;

      await expect(generated).rejects.toThrow("Audio8 synthesis cancelled.");
      expect(audio8Clients()).toHaveLength(1);
    });

    it.each([
      { name: "has already finished", requestId: "load-1" },
      { name: "was never issued", requestId: "no-such-request" },
    ])("reports a cancel as undelivered for a request that $name", async ({ requestId }) => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });

      // The client answers from its own pending map, so a settled or unknown id
      // is `false` even though a worker is very much alive.
      expect(invokeAudio8("audio8:cancel", { requestId })).toEqual({ cancelled: false });
      expect(audio8Clients()[0].cancel).toHaveBeenCalledWith(requestId);
    });

    it("forwards the accepted voice through untouched", async () => {
      await invokeAudio8("audio8:generate", { requestId: "g1", text: " hi ", voice: "sophie" });

      // No overrides: the worker samples the reference take.
      expect(audio8Clients()[0].generate).toHaveBeenCalledWith("g1", " hi ", "sophie", expect.any(Function), undefined);
    });

    it("forwards a requested take's seed and temperature, and refuses out-of-range ones", async () => {
      await invokeAudio8("audio8:generate", { requestId: "g1", text: "hi", voice: "clara", seed: 7, temperature: 0.6 });

      expect(audio8Clients()[0].generate)
        .toHaveBeenCalledWith("g1", "hi", "clara", expect.any(Function), { seed: 7, temperature: 0.6 });
      expect((await audio8Rejection("audio8:generate", { requestId: "g2", text: "hi", voice: "clara", seed: 2 ** 32 })).message)
        .toBe("Audio8 seed must be an integer from 0 to 4294967295.");
      expect((await audio8Rejection("audio8:generate", { requestId: "g3", text: "hi", voice: "clara", temperature: 5 })).message)
        .toBe("Audio8 temperature must be a number from 0.1 to 1.");
      expect(audio8Clients()[0].generate).toHaveBeenCalledTimes(1);
    });

    it("drops progress safely when the requesting window closes during send", async () => {
      let release!: () => void;
      mocks.audio8Hold = new Promise<void>((resolve) => { release = resolve; });
      const event = createEvent(undefined);
      event.sender.send.mockImplementation(() => {
        throw new Error("Object has been destroyed");
      });
      const handler = mocks.invokeHandlers.get("audio8:load")!;
      const loaded = handler(event, { requestId: "load-progress" }) as Promise<unknown>;
      await drainTurns();
      const progress = audio8Clients()[0].load.mock.calls[0][1] as (percent: number) => void;

      expect(() => progress(50)).not.toThrow();
      expect(event.sender.send).toHaveBeenCalledWith("audio8:progress", {
        requestId: "load-progress",
        percent: 50,
      });

      release();
      await loaded;
    });
  });

  describe("cache reporting", () => {
    it("reports every revision under the namespace, not just the current one", async () => {
      await writeAudio8Revision(AUDIO8_MODEL_REVISION);
      await writeAudio8Revision(STALE_REVISION);

      await expect(invokeAudio8("audio8:cache-info")).resolves.toEqual({
        path: path.join(mocks.userDataPath, "local-model-cache", "audio8"),
        exists: true,
        sizeBytes: 128,
      });
    });

    it("stops the worker before unlinking the graphs it has mapped", async () => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });
      const current = await writeAudio8Revision(AUDIO8_MODEL_REVISION);
      let release!: () => void;
      mocks.audio8Destroy = new Promise<void>((resolve) => { release = () => resolve(); });

      const cleared = invokeAudio8("audio8:clear-cache") as Promise<unknown>;
      await drainTurns();

      // Ordering is the assertion: while the teardown is still pending the tree
      // must be untouched. Unlinking first would pull ONNX weights out from
      // under a live session — deferred on POSIX, outright refused on Windows.
      expect(audio8Clients()[0].destroy).toHaveBeenCalledTimes(1);
      expect(await directoryExists(current)).toBe(true);

      release();
      await expect(cleared).resolves.toEqual({
        path: path.join(mocks.userDataPath, "local-model-cache", "audio8"),
        cleared: true,
      });
      expect(await directoryExists(current)).toBe(false);
    });
  });

  describe("clear-cache serialisation", () => {
    /** Parks a clear between the worker teardown and the unlink. */
    function beginHeldClear(): { cleared: Promise<unknown>; release: () => void } {
      let release!: () => void;
      mocks.audio8Destroy = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      return { cleared: invokeAudio8("audio8:clear-cache") as Promise<unknown>, release };
    }

    it("makes a load wait for an in-flight clear instead of racing its rm", async () => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });
      expect(audio8Clients()).toHaveLength(1);

      const { cleared, release } = beginHeldClear();
      let loadSettled = false;
      const reload = (invokeAudio8("audio8:load", { requestId: "load-2" }) as Promise<unknown>)
        .finally(() => { loadSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));

      // Without the gate this load has already built a second client, whose
      // worker starts downloading into the directory the `rm` is about to take.
      expect(loadSettled).toBe(false);
      expect(audio8Clients()).toHaveLength(1);

      release();
      await cleared;
      await reload;
      expect(audio8Clients()).toHaveLength(2);
    });

    it("makes a generate wait too, since it lazily fetches voice profiles", async () => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });

      const { cleared, release } = beginHeldClear();
      let generateSettled = false;
      const generated = (invokeAudio8("audio8:generate", { requestId: "g1", text: "hi", voice: "clara" }) as Promise<unknown>)
        .finally(() => { generateSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));

      expect(generateSettled).toBe(false);
      expect(audio8Clients()).toHaveLength(1);

      release();
      await cleared;
      await generated;
      expect(audio8Clients()).toHaveLength(2);
    });

    it("serializes clears issued by separate windows", async () => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });
      const current = await writeAudio8Revision(AUDIO8_MODEL_REVISION);
      let release!: () => void;
      mocks.audio8Destroy = new Promise<void>((resolve) => { release = resolve; });

      const first = invokeAudio8("audio8:clear-cache") as Promise<unknown>;
      const second = invokeAudio8("audio8:clear-cache") as Promise<unknown>;
      let secondSettled = false;
      void second.finally(() => { secondSettled = true; });
      await drainTurns();

      expect(audio8Clients()[0].destroy).toHaveBeenCalledTimes(1);
      expect(secondSettled).toBe(false);
      expect(await directoryExists(current)).toBe(true);

      release();
      await Promise.all([first, second]);
      expect(await directoryExists(current)).toBe(false);
    });

    it("retires the destroyed client instead of reusing it after a clear", async () => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });
      await invokeAudio8("audio8:clear-cache");
      expect(audio8Clients()[0].closed).toBe(true);

      await expect(invokeAudio8("audio8:load", { requestId: "load-2" }))
        .resolves.toMatchObject({ sampleRate: 44_100 });
      expect(audio8Clients()).toHaveLength(2);
      expect(audio8Clients()[1].modelDir)
        .toBe(path.join(mocks.userDataPath, "local-model-cache", "audio8", AUDIO8_MODEL_REVISION));
    });

    it("reopens the gate after a failed clear so synthesis is not wedged", async () => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });
      mocks.audio8Destroy = Promise.reject(new Error("terminate failed"));

      await expect(invokeAudio8("audio8:clear-cache")).rejects.toThrow("terminate failed");
      await expect(invokeAudio8("audio8:load", { requestId: "load-2" }))
        .resolves.toMatchObject({ sampleRate: 44_100 });
    });
  });

  describe("stale revision prune", () => {
    it("reclaims superseded revisions after a successful load", async () => {
      const stale = await writeAudio8Revision(STALE_REVISION);
      const current = await writeAudio8Revision(AUDIO8_MODEL_REVISION);

      await invokeAudio8("audio8:load", { requestId: "load-1" });
      await waitForPrune(stale);

      expect(await directoryExists(current)).toBe(true);
    });

    it("schedules no prune when the quit latches as the load lands", async () => {
      const stale = await writeAudio8Revision(STALE_REVISION);
      // The spawn guard cannot catch this one: the load was already accepted and
      // has succeeded. Scheduling here would start an `rm` after the barrier
      // took its snapshot, so nothing would hold the quit for it.
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      mocks.audio8AfterLoad = () => {
        mocks.appListeners.get("before-quit")?.({ preventDefault: vi.fn() });
      };

      await expect(invokeAudio8("audio8:load", { requestId: "load-1" }))
        .resolves.toMatchObject({ sampleRate: 44_100 });
      vi.useRealTimers();
      // Generous next to the sub-10ms prune the previous case measures.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(await directoryExists(stale)).toBe(true);
    });
  });

  describe("quit barrier", () => {
    function quit(): { preventDefault: ReturnType<typeof vi.fn> } {
      const quitEvent = { preventDefault: vi.fn() };
      mocks.appListeners.get("before-quit")?.(quitEvent);
      return quitEvent;
    }

    it.each([
      { channel: "audio8:load", request: { requestId: "late-load" } },
      { channel: "audio8:generate", request: { requestId: "late-gen", text: "hi", voice: "clara" } },
    ])("refuses a $channel that arrives after the quit has latched", async ({ channel, request }) => {
      const stale = await writeAudio8Revision(STALE_REVISION);
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      quit();
      vi.useRealTimers();

      // Same refusal `local-tts:*` gives, so the renderer needs no new case.
      expect((await audio8Rejection(channel, request)).message)
        .toBe("The local runtime is shutting down.");
      expect(audio8Clients()).toHaveLength(0);
      // Asserted rather than inferred from the rejection: the refusal only
      // implies no prune while the guard sits above the scheduling. Moving it
      // below would keep this rejection and start an `rm` the barrier has
      // already stopped waiting for.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await directoryExists(stale)).toBe(true);
    });

    it("refuses to respawn a worker the quit already retired", async () => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });
      expect(audio8Clients()).toHaveLength(1);

      vi.useFakeTimers({ toFake: ["setTimeout"] });
      quit();
      vi.useRealTimers();
      await waitForQuit();

      // `before-quit` destroys and drops the client, so an unguarded handler
      // would build a second one while the barrier awaits the first's teardown.
      expect(audio8Clients()[0].destroy).toHaveBeenCalledTimes(1);
      expect((await audio8Rejection("audio8:load", { requestId: "load-2" })).message)
        .toBe("The local runtime is shutting down.");
      expect(audio8Clients()).toHaveLength(1);
    });

    it("still reports and clears the cache while quitting", async () => {
      await writeAudio8Revision(STALE_REVISION);
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      quit();
      vi.useRealTimers();

      // Reclaiming disk is not new work for the runtime, and a clear invoked
      // from a renderer that is already closing still has to complete.
      await expect(invokeAudio8("audio8:cache-info")).resolves.toMatchObject({ exists: true });
      await expect(invokeAudio8("audio8:clear-cache")).resolves.toMatchObject({ cleared: true });
      expect(invokeAudio8("audio8:cancel", { requestId: "late-cancel" })).toEqual({ cancelled: false });
    });

    it("returns immediately when no Audio8 work is outstanding", () => {
      expect(quit().preventDefault).not.toHaveBeenCalled();
      expect(mocks.quit).not.toHaveBeenCalled();
    });

    it("holds the quit for an in-flight clear and quits once its rm lands", async () => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });
      await writeAudio8Revision(AUDIO8_MODEL_REVISION);
      let release!: () => void;
      mocks.audio8Destroy = new Promise<void>((resolve) => { release = () => resolve(); });
      const cleared = invokeAudio8("audio8:clear-cache") as Promise<unknown>;

      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const quitEvent = quit();
      // The clear is the only thing outstanding: no bridge pool, no probe
      // children, no reader worker, and the Audio8 client is already retired.
      expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1);
      await drainTurns();
      // Still held: quitting here would exit the process mid-`rm`.
      expect(mocks.quit).not.toHaveBeenCalled();
      expect(await directoryExists(audio8RevisionDir(AUDIO8_MODEL_REVISION))).toBe(true);

      release();
      await cleared;
      await waitForQuit();

      expect(mocks.quit).toHaveBeenCalledTimes(1);
      expect(await directoryExists(audio8RevisionDir(AUDIO8_MODEL_REVISION))).toBe(false);
    });

    it("still quits when the clear it is holding for fails", async () => {
      await invokeAudio8("audio8:load", { requestId: "load-1" });
      let reject!: (error: Error) => void;
      mocks.audio8Destroy = new Promise<void>((_resolve, fail) => { reject = fail; });
      const cleared = invokeAudio8("audio8:clear-cache") as Promise<unknown>;
      // The renderer owns this rejection; the barrier must not also trip on it.
      const settled = cleared.catch(() => "rejected");

      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const quitEvent = quit();
      expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1);
      await drainTurns();
      expect(mocks.quit).not.toHaveBeenCalled();

      reject(new Error("terminate failed"));
      await expect(settled).resolves.toBe("rejected");
      await waitForQuit();

      expect(mocks.quit).toHaveBeenCalledTimes(1);
      expect(mocks.unhandledRejections).toEqual([]);
    });
  });
});

describe("local model cache lifecycle IPC", () => {
  // These IPC cases exercise a supported Qwen runtime even when CI itself runs
  // on Linux, where the product deliberately exposes no Qwen model profiles.
  const qwenProfile = getDefaultQwen3Profile("darwin", "arm64");
  const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const hostArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  const generateRequest = {
    model: "neutts", requestId: "local-generate", payload: {
      text: "hello", referenceText: "hello", referenceCodesBase64: "AAAA",
    },
  };

  function invoke(channel: string, request: unknown): Promise<unknown> {
    return Promise.resolve(mocks.invokeHandlers.get(channel)!(createEvent(undefined), request));
  }

  beforeEach(async () => {
    Object.defineProperty(process, "platform", { ...hostPlatform, value: "darwin" });
    Object.defineProperty(process, "arch", { ...hostArch, value: "arm64" });
    vi.resetModules();
    mocks.invokeHandlers.clear();
    mocks.appListeners.clear();
    mocks.windows = [];
    mocks.quit.mockClear();
    mocks.audio8Clients = [];
    mocks.localWsCancel.mockReset().mockReturnValue(false);
    mocks.localWsShutdown.mockReset().mockResolvedValue(undefined);
    mocks.localWsShutdownAll.mockReset().mockResolvedValue(undefined);
    mocks.localWsRefreshIdleEviction.mockReset();
    mocks.localWsRun.mockReset().mockImplementation(async (_model, request: { command?: string }) => ({
      response: { ok: true, result: request.command === "warm" ? { warmed: true } : {
        sampleRate: 24_000, modelRepo: "model", durationSec: 1, elapsedSec: 1,
        audioTransport: "websocket-binary", audioChunkCount: 1, phaseTimingsSec: {},
      } },
    }));
    mocks.qwenResolve.mockReset().mockImplementation(async (_profile, directory: string) => directory);
    mocks.qwenInspect.mockReset().mockResolvedValue({ readiness: "missing" });
    mocks.qwenDownload.mockReset().mockResolvedValue({ readiness: "verified" });
    mocks.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "open-tts-main-local-"));
    (globalThis as { __dirname?: string }).__dirname = "/tmp";
    await import("./main");
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", hostPlatform);
    Object.defineProperty(process, "arch", hostArch);
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(mocks.userDataPath, { recursive: true, force: true });
    mocks.userDataPath = "/tmp";
  });

  function holdDeletion(model = "neutts") {
    const cachePath = path.join(mocks.userDataPath, "local-model-cache", model);
    const originalRm = fs.rm.bind(fs);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const removed = vi.fn();
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === cachePath) {
        removed();
        await held;
      }
      return originalRm(target, options);
    });
    return { release, removed, cachePath };
  }

  it.each([
    { channel: "local-tts:generate", request: generateRequest },
    { channel: "local-tts:warm", request: { model: "neutts" } },
  ])("holds $channel until cache deletion finishes", async ({ channel, request }) => {
    const deletion = holdDeletion();
    const clear = invoke("local-tts:clear-cache", { model: "neutts" });
    await drainTurns();
    expect(deletion.removed).toHaveBeenCalledOnce();
    const operation = invoke(channel, request);
    await drainTurns();
    expect(mocks.localWsRun).not.toHaveBeenCalled();
    deletion.release();
    await Promise.all([clear, operation]);
    expect(mocks.localWsRun).toHaveBeenCalledOnce();
  });

  it("cancels and joins generation before shutting down and deleting its model", async () => {
    let rejectGeneration!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    mocks.localWsRun.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectGeneration = reject;
      markStarted();
    }));
    mocks.localWsCancel.mockReturnValue(true);
    const generated = invoke("local-tts:generate", generateRequest).catch(() => "cancelled");
    await started;
    const deletion = holdDeletion();
    const clear = invoke("local-tts:clear-cache", { model: "neutts" });
    await drainTurns();
    expect(mocks.localWsCancel).toHaveBeenCalledWith("local-generate");
    expect(mocks.localWsShutdown).not.toHaveBeenCalled();
    expect(deletion.removed).not.toHaveBeenCalled();
    rejectGeneration(new Error("Generation cancelled."));
    await expect(generated).resolves.toBe("cancelled");
    await drainTurns();
    expect(mocks.localWsShutdown).toHaveBeenCalledWith("neutts");
    expect(deletion.removed).toHaveBeenCalledOnce();
    deletion.release();
    await clear;
  });

  it("aborts and joins a Qwen download, then admits a fresh download after clearing", async () => {
    let rejectDownload!: (error: Error) => void;
    let downloadSignal!: AbortSignal;
    mocks.qwenDownload.mockImplementationOnce((_profile, _dir, _progress, _request, _xet, signal: AbortSignal) => {
      downloadSignal = signal;
      return new Promise((_resolve, reject) => { rejectDownload = reject; });
    });
    const request = { modelRepo: qwenProfile.repo };
    const first = invoke("local-tts:download-qwen3-model", request).catch(() => "cancelled");
    await drainTurns();
    const deletion = holdDeletion("qwen3");
    const clear = invoke("local-tts:clear-cache", { model: "qwen3" });
    const retry = invoke("local-tts:download-qwen3-model", request);
    await drainTurns();
    expect(downloadSignal.aborted).toBe(true);
    expect(deletion.removed).not.toHaveBeenCalled();
    expect(mocks.qwenDownload).toHaveBeenCalledOnce();
    rejectDownload(new Error("Download cancelled."));
    await expect(first).resolves.toBe("cancelled");
    await drainTurns();
    expect(deletion.removed).toHaveBeenCalledOnce();
    expect(mocks.qwenDownload).toHaveBeenCalledOnce();
    deletion.release();
    await Promise.all([clear, retry]);
    expect(mocks.qwenDownload).toHaveBeenCalledTimes(2);
    expect((mocks.qwenDownload.mock.calls[1][5] as AbortSignal).aborted).toBe(false);
  });

  it("joins every setup branch before deletion when a sibling inspection fails", async () => {
    let releaseAdoption!: (directory: string) => void;
    mocks.qwenResolve.mockImplementationOnce(async () => { throw new Error("inspection failed"); });
    mocks.qwenResolve.mockImplementationOnce(() => new Promise<string>((resolve) => { releaseAdoption = resolve; }));
    const setup = invoke("local-tts:qwen3-setup", { modelRepo: qwenProfile.repo }).catch(() => "failed");
    await drainTurns();
    const deletion = holdDeletion("qwen3");
    const clear = invoke("local-tts:clear-cache", { model: "qwen3" });
    await drainTurns();
    expect(deletion.removed).not.toHaveBeenCalled();
    releaseAdoption("/finished-adoption");
    await expect(setup).resolves.toBe("failed");
    await drainTurns();
    expect(deletion.removed).toHaveBeenCalledOnce();
    deletion.release();
    await clear;
  });

  /** Holds the next pool run open until the returned controls settle it. */
  function holdNextRun() {
    let resolveRun!: (value: unknown) => void;
    let rejectRun!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    mocks.localWsRun.mockImplementationOnce(() => new Promise((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
      markStarted();
    }));
    return {
      started,
      resolve: (value: unknown) => resolveRun(value),
      reject: (error: Error) => rejectRun(error),
    };
  }

  const GENERATE_RESPONSE = {
    response: { ok: true, result: {
      sampleRate: 24_000, modelRepo: "model", durationSec: 1, elapsedSec: 1,
      audioTransport: "websocket-binary", audioChunkCount: 1, phaseTimingsSec: {},
    } },
  };

  it("routes a cancel from the owning renderer to the worker pool", async () => {
    const run = holdNextRun();
    mocks.localWsCancel.mockReturnValue(true);
    const generated = invoke("local-tts:generate", generateRequest).catch((error: Error) => error.message);
    await run.started;

    await expect(invoke("local-tts:cancel", { model: "neutts", requestId: "local-generate" }))
      .resolves.toEqual({ cancelled: true });
    expect(mocks.localWsCancel).toHaveBeenCalledWith("local-generate");

    run.reject(new Error("Generation cancelled."));
    await expect(generated).resolves.toBe("Generation cancelled.");
    // Settled requests are forgotten, so a late cancel is undelivered.
    await expect(invoke("local-tts:cancel", { model: "neutts", requestId: "local-generate" }))
      .resolves.toEqual({ cancelled: false });
  });

  it("refuses a cancel from a renderer or model that does not own the request", async () => {
    const run = holdNextRun();
    const generated = invoke("local-tts:generate", generateRequest);
    await run.started;
    const otherRenderer = createEvent(undefined);
    otherRenderer.sender.id = 2;

    await expect(Promise.resolve(mocks.invokeHandlers.get("local-tts:cancel")!(
      otherRenderer,
      { model: "neutts", requestId: "local-generate" },
    ))).rejects.toThrow("Cancellation request does not own the active local-runtime request.");
    await expect(invoke("local-tts:cancel", { model: "qwen3", requestId: "local-generate" }))
      .rejects.toThrow("does not own");
    expect(mocks.localWsCancel).not.toHaveBeenCalled();

    run.resolve(GENERATE_RESPONSE);
    await expect(generated).resolves.toMatchObject({ audioChunkCount: 1 });
  });

  it("refuses a second request that reuses a running request id", async () => {
    const run = holdNextRun();
    const generated = invoke("local-tts:generate", generateRequest);
    await run.started;

    await expect(invoke("local-tts:generate", generateRequest))
      .rejects.toThrow("A request with id local-generate is already running.");

    run.resolve(GENERATE_RESPONSE);
    await generated;
  });

  it("cancels a renderer's running generation when its web contents are destroyed", async () => {
    const run = holdNextRun();
    mocks.localWsCancel.mockReturnValue(true);
    const event = createEvent(undefined);
    const generated = Promise.resolve(mocks.invokeHandlers.get("local-tts:generate")!(event, generateRequest))
      .catch((error: Error) => error.message);
    await run.started;

    const destroyed = event.sender.once.mock.calls.find(([name]) => name === "destroyed")?.[1] as () => void;
    destroyed();

    expect(mocks.localWsCancel).toHaveBeenCalledWith("local-generate");
    run.reject(new Error("Generation cancelled."));
    await expect(generated).resolves.toBe("Generation cancelled.");
  });

  it("makes a generate wait for an in-flight warm-up of the same model instead of failing", async () => {
    const warmRun = holdNextRun();
    const warmed = invoke("local-tts:warm", { model: "neutts" });
    await warmRun.started;

    const generated = invoke("local-tts:generate", generateRequest);
    await drainTurns();
    // The warm-up is doing the model load the generation needs.
    expect(mocks.localWsRun).toHaveBeenCalledTimes(1);
    expect(mocks.localWsCancel).not.toHaveBeenCalled();

    warmRun.resolve({ response: { ok: true, result: { warmed: true } } });
    await expect(warmed).resolves.toEqual({ warmed: true });
    await expect(generated).resolves.toMatchObject({ audioChunkCount: 1 });
    expect(mocks.localWsRun).toHaveBeenCalledTimes(2);
    expect(mocks.localWsRun.mock.calls[1][1]).toMatchObject({ requestId: "local-generate" });
  });

  it("cancels an in-flight warm-up for a different model target before generating", async () => {
    const warmRun = holdNextRun();
    const warmed = invoke("local-tts:warm", { model: "neutts" });
    await warmRun.started;
    const warmRequestId = (mocks.localWsRun.mock.calls[0][1] as { requestId: string }).requestId;
    mocks.localWsCancel.mockImplementation((requestId: string) => {
      if (requestId === warmRequestId) warmRun.reject(new Error("Generation cancelled."));
      return requestId === warmRequestId;
    });

    const generated = invoke("local-tts:generate", {
      ...generateRequest,
      payload: { ...generateRequest.payload, modelRepo: "neuphonic/neutts-air-q4-gguf" },
    });

    await expect(warmed).resolves.toEqual({ warmed: false, message: "Generation cancelled." });
    await expect(generated).resolves.toMatchObject({ audioChunkCount: 1 });
    expect(mocks.localWsCancel).toHaveBeenCalledWith(warmRequestId);
  });

  it("reports a second warm-up of the same target as already warming", async () => {
    const warmRun = holdNextRun();
    const first = invoke("local-tts:warm", { model: "neutts" });
    await warmRun.started;

    await expect(invoke("local-tts:warm", { model: "neutts" }))
      .resolves.toEqual({ warmed: false, message: "This model is already warming." });

    warmRun.resolve({ response: { ok: true, result: { warmed: true } } });
    await first;
  });

  it("holds quit for deletion and never starts the generation queued behind it", async () => {
    const deletion = holdDeletion();
    const clear = invoke("local-tts:clear-cache", { model: "neutts" });
    const queued = invoke("local-tts:generate", generateRequest).catch((error: Error) => error.message);
    await drainTurns();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const event = { preventDefault: vi.fn() };
    mocks.appListeners.get("before-quit")!(event);
    await drainTurns();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.quit).not.toHaveBeenCalled();
    deletion.release();
    await clear;
    await expect(queued).resolves.toContain("shutting down");
    await waitForQuit();
    expect(mocks.localWsRun).not.toHaveBeenCalled();
  });

  async function writeModelDir(directory: string): Promise<void> {
    for (const file of qwenProfile.requiredFiles) {
      const target = path.join(directory, ...file.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file === "config.json" ? JSON.stringify({ tts_model_type: "custom_voice" }) : "x");
    }
  }

  describe("audio stream", () => {
    const audioChunk = {
      requestId: "local-generate",
      index: 0,
      total: 1,
      sampleRate: 24_000,
      sampleCount: 2,
      silenceAfterSamples: 0,
      audio: new ArrayBuffer(8),
    };

    function generateWithEvent(event: ReturnType<typeof createEvent>): Promise<unknown> {
      return Promise.resolve(mocks.invokeHandlers.get("local-tts:generate")!(event, generateRequest));
    }

    it("sends every chunk and then the end marker on one channel before replying", async () => {
      const event = createEvent(undefined);
      const order: string[] = [];
      event.sender.send.mockImplementation((channel: string, payload: { type: string }) => {
        order.push(`${channel} ${payload.type}`);
      });
      mocks.localWsRun.mockImplementationOnce(async (_model, options: { onAudioChunk: (chunk: unknown) => void }) => {
        options.onAudioChunk(audioChunk);
        options.onAudioChunk({ ...audioChunk, index: 1, total: 2 });
        return { response: { ok: true, result: {
          sampleRate: 24_000, modelRepo: "model", durationSec: 1, elapsedSec: 1,
          audioTransport: "websocket-binary", audioChunkCount: 2, phaseTimingsSec: {},
        } } };
      });

      await generateWithEvent(event).then(() => order.push("reply"));

      expect(order).toEqual([
        "local-tts:audio-stream chunk",
        "local-tts:audio-stream chunk",
        "local-tts:audio-stream end",
        "reply",
      ]);
      expect(event.sender.send).toHaveBeenNthCalledWith(1, "local-tts:audio-stream", {
        type: "chunk", model: "neutts", ...audioChunk,
      });
      expect(event.sender.send).toHaveBeenLastCalledWith("local-tts:audio-stream", {
        type: "end", model: "neutts", requestId: "local-generate",
      });
    });

    it("forwards a unit gap on the same ordered channel between the chunks", async () => {
      const event = createEvent(undefined);
      const gap = {
        requestId: "local-generate",
        afterChunkIndex: 0,
        sampleRate: 24_000,
        silenceSamples: 4_800,
        textUnitIndex: 0,
        textUnitTotal: 2,
      };
      mocks.localWsRun.mockImplementationOnce(async (_model, options: {
        onAudioChunk: (chunk: unknown) => void;
        onAudioGap: (gap: unknown) => void;
      }) => {
        options.onAudioChunk(audioChunk);
        options.onAudioGap(gap);
        options.onAudioChunk({ ...audioChunk, index: 1, total: 2 });
        return { response: { ok: true, result: {
          sampleRate: 24_000, modelRepo: "model", durationSec: 1, elapsedSec: 1,
          audioTransport: "websocket-binary", audioChunkCount: 2, phaseTimingsSec: {},
        } } };
      });

      await generateWithEvent(event);

      expect(event.sender.send.mock.calls.map(([, payload]) => (payload as { type: string }).type))
        .toEqual(["chunk", "gap", "chunk", "end"]);
      expect(event.sender.send).toHaveBeenNthCalledWith(2, "local-tts:audio-stream", {
        type: "gap", model: "neutts", ...gap,
      });
    });

    it("ends the stream of a generation that fails", async () => {
      const event = createEvent(undefined);
      mocks.localWsRun.mockRejectedValueOnce(new Error("Rust local bridge exited before returning a result."));

      await expect(generateWithEvent(event)).rejects.toThrow("exited before returning a result");
      expect(event.sender.send).toHaveBeenCalledWith("local-tts:audio-stream", {
        type: "end", model: "neutts", requestId: "local-generate",
      });
    });

    it("sends nothing to a window that has closed", async () => {
      const event = createEvent(undefined);
      event.sender.isDestroyed = () => true;
      mocks.localWsRun.mockImplementationOnce(async (_model, options: { onAudioChunk: (chunk: unknown) => void }) => {
        options.onAudioChunk(audioChunk);
        return { response: { ok: true, result: {
          sampleRate: 24_000, modelRepo: "model", durationSec: 1, elapsedSec: 1,
          audioTransport: "websocket-binary", audioChunkCount: 1, phaseTimingsSec: {},
        } } };
      });

      await generateWithEvent(event);
      expect(event.sender.send).not.toHaveBeenCalled();
    });
  });

  describe("keep-warm leases", () => {
    const MINUTE = 60 * 1000;

    function lease(modelPath: string, leaseId = "lease-1") {
      return { leaseId, model: "qwen3", modelRepo: qwenProfile.repo, modelPath };
    }

    /** Warms `modelPath` and returns what the pool was told the worker now holds. */
    async function warmQwen(modelPath: string): Promise<string> {
      await writeModelDir(modelPath);
      await expect(invoke("local-tts:warm", { model: "qwen3", mode: qwenProfile.mode, modelRepo: qwenProfile.repo, modelPath }))
        .resolves.toEqual({ warmed: true });
      const options = mocks.localWsRun.mock.lastCall![1] as { residencyKey?: string };
      expect(options.residencyKey).toEqual(expect.any(String));
      return options.residencyKey!;
    }

    function idleEvictMs(model: "neutts" | "qwen3", residencyKey: string | null): number {
      const option = mocks.poolOptions!.idleEvictMs;
      return typeof option === "function" ? option(model, residencyKey) : option;
    }

    it("tells the pool a generation leaves the same model loaded as a warm-up of it", async () => {
      const modelPath = path.join(mocks.userDataPath, "manual-qwen3");
      const warmed = await warmQwen(modelPath);

      await invoke("local-tts:generate", {
        model: "qwen3",
        requestId: "qwen-generate",
        payload: { text: "hello", mode: qwenProfile.mode, modelRepo: qwenProfile.repo, modelPath },
      });

      expect((mocks.localWsRun.mock.lastCall![1] as { residencyKey?: string }).residencyKey).toBe(warmed);
    });

    it("keeps a leased Qwen3 model resident for the keep-warm window, and only that model", async () => {
      const modelPath = path.join(mocks.userDataPath, "manual-qwen3");
      const otherPath = path.join(mocks.userDataPath, "other-qwen3");
      const residency = await warmQwen(modelPath);
      const other = await warmQwen(otherPath);
      expect(idleEvictMs("qwen3", residency)).toBe(MINUTE);

      await expect(invoke("local-tts:keep-warm", lease(modelPath))).resolves.toBeUndefined();

      // The idle worker is re-timed at once.
      expect(mocks.localWsRefreshIdleEviction).toHaveBeenCalledWith("qwen3");
      expect(idleEvictMs("qwen3", residency)).toBe(30 * MINUTE);
      expect(idleEvictMs("qwen3", other)).toBe(MINUTE);
      expect(idleEvictMs("qwen3", null)).toBe(MINUTE);
      expect(idleEvictMs("neutts", null)).toBe(5 * MINUTE);
    });

    it("returns to the usual idle window once the lease is released", async () => {
      const modelPath = path.join(mocks.userDataPath, "manual-qwen3");
      const residency = await warmQwen(modelPath);
      await invoke("local-tts:keep-warm", lease(modelPath));
      mocks.localWsRefreshIdleEviction.mockClear();

      await expect(invoke("local-tts:release-keep-warm", { leaseId: "lease-1" })).resolves.toEqual({ released: true });

      expect(mocks.localWsRefreshIdleEviction).toHaveBeenCalledWith("qwen3");
      expect(idleEvictMs("qwen3", residency)).toBe(MINUTE);
      await expect(invoke("local-tts:release-keep-warm", { leaseId: "lease-1" })).resolves.toEqual({ released: false });
    });

    it("does not let another window release a lease", async () => {
      const modelPath = path.join(mocks.userDataPath, "manual-qwen3");
      const residency = await warmQwen(modelPath);
      await invoke("local-tts:keep-warm", lease(modelPath));
      const otherWindow = createEvent(undefined);
      otherWindow.sender.id = 2;

      await expect(Promise.resolve(mocks.invokeHandlers.get("local-tts:release-keep-warm")!(otherWindow, { leaseId: "lease-1" })))
        .resolves.toEqual({ released: false });
      expect(idleEvictMs("qwen3", residency)).toBe(30 * MINUTE);
    });

    it("drops the leases of a window that goes away", async () => {
      const modelPath = path.join(mocks.userDataPath, "manual-qwen3");
      const residency = await warmQwen(modelPath);
      const event = createEvent(undefined);
      await mocks.invokeHandlers.get("local-tts:keep-warm")!(event, lease(modelPath));

      const crashed = event.sender.on.mock.calls.find(([name]) => name === "render-process-gone")?.[1] as () => void;
      crashed();

      expect(idleEvictMs("qwen3", residency)).toBe(MINUTE);
    });

    it("refuses a lease it cannot validate", async () => {
      await expect(invoke("local-tts:keep-warm", { ...lease("/models/qwen3"), model: "neutts" }))
        .rejects.toThrow("Only Qwen3-TTS models can be kept warm.");
      await expect(invoke("local-tts:keep-warm", { ...lease("/models/qwen3"), leaseId: "" }))
        .rejects.toThrow("`leaseId` is required.");
    });

    it("tells every open window when a resident model goes away", async () => {
      await invoke("local-tts:generate", generateRequest);
      const open = createWindow();
      const closed = createWindow();
      closed.webContents.isDestroyed = () => true;
      mocks.windows = [open, closed];

      mocks.poolOptions!.onWorkerExit!("qwen3", { reason: "idle" });

      expect(open.webContents.send).toHaveBeenCalledWith("local-tts:model-evicted", { model: "qwen3", reason: "idle" });
      expect(closed.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe("Qwen3 model folder picker", () => {
    afterEach(() => {
      mocks.ownerWindow = null;
    });

    it("opens as a sheet of the window that asked for it", async () => {
      const owner = { id: "requesting-window" };
      mocks.ownerWindow = owner;
      vi.mocked(dialog.showOpenDialog).mockReset().mockResolvedValue({ canceled: true, filePaths: [] });

      await expect(invoke("local-tts:choose-qwen3-model-dir", { modelRepo: qwenProfile.repo }))
        .resolves.toEqual({ path: null });

      expect(dialog.showOpenDialog).toHaveBeenCalledWith(owner, expect.objectContaining({
        properties: ["openDirectory"],
      }));
    });

    it("refuses to open once the quit has started", async () => {
      vi.mocked(dialog.showOpenDialog).mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
      mocks.appListeners.get("before-quit")!({ preventDefault: vi.fn() });

      await expect(invoke("local-tts:choose-qwen3-model-dir", { modelRepo: qwenProfile.repo }))
        .rejects.toThrow("The local runtime is shutting down.");
      expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    });
  });

  describe("Qwen3 model folder checks", () => {
    // Consecutive sections of one read, as the Reader sends them, so the
    // generation cooldown does not refuse the second request.
    function qwenGenerate(modelPath: string, sectionIndex: number) {
      return {
        model: "qwen3",
        requestId: `qwen-${sectionIndex}`,
        payload: { text: "hello", mode: qwenProfile.mode, modelRepo: qwenProfile.repo, modelPath },
        continuation: { jobId: "qwen-read", sectionIndex, sectionCount: 8 },
      };
    }

    /** Counts reads of the folder's config.json, which every structural check parses. */
    function countConfigReads(modelPath: string) {
      const originalReadFile = fs.readFile.bind(fs);
      const reads = vi.fn();
      vi.spyOn(fs, "readFile").mockImplementation(((target: Parameters<typeof fs.readFile>[0], options: Parameters<typeof fs.readFile>[1]) => {
        if (target === path.join(modelPath, "config.json")) reads();
        return originalReadFile(target, options);
      }) as typeof fs.readFile);
      return reads;
    }

    it("checks a model folder once for back-to-back generations", async () => {
      const modelPath = path.join(mocks.userDataPath, "manual-qwen3");
      await writeModelDir(modelPath);
      const reads = countConfigReads(modelPath);

      await invoke("local-tts:generate", qwenGenerate(modelPath, 0));
      await invoke("local-tts:generate", qwenGenerate(modelPath, 1));
      await expect(invoke("local-tts:warm", { model: "qwen3", mode: qwenProfile.mode, modelRepo: qwenProfile.repo, modelPath }))
        .resolves.toEqual({ warmed: true });

      expect(reads).toHaveBeenCalledTimes(1);
      expect(mocks.localWsRun).toHaveBeenCalledTimes(3);
    });

    it("checks an incomplete folder again on every request, so fixing it works at once", async () => {
      const modelPath = path.join(mocks.userDataPath, "manual-qwen3");
      const missing = "The selected Qwen3 model directory is missing required files";

      await expect(invoke("local-tts:generate", qwenGenerate(modelPath, 0))).rejects.toThrow(missing);
      await writeModelDir(modelPath);
      await expect(invoke("local-tts:generate", qwenGenerate(modelPath, 1)))
        .resolves.toMatchObject({ audioChunkCount: 1 });
      expect(mocks.localWsRun).toHaveBeenCalledTimes(1);
    });

    it.each([
      { action: "clearing the Qwen3 cache", run: () => invoke("local-tts:clear-cache", { model: "qwen3" }) },
      { action: "a model download", run: () => invoke("local-tts:download-qwen3-model", { modelRepo: qwenProfile.repo }) },
      {
        action: "a failed model download",
        run: () => {
          mocks.qwenDownload.mockRejectedValueOnce(new Error("Download failed."));
          return invoke("local-tts:download-qwen3-model", { modelRepo: qwenProfile.repo }).catch(() => undefined);
        },
      },
      { action: "a setup refresh", run: () => invoke("local-tts:qwen3-setup", { modelRepo: qwenProfile.repo }) },
    ])("checks the folder again after $action", async ({ run }) => {
      const modelPath = path.join(mocks.userDataPath, "manual-qwen3");
      await writeModelDir(modelPath);
      const reads = countConfigReads(modelPath);

      await invoke("local-tts:generate", qwenGenerate(modelPath, 0));
      await run();
      await invoke("local-tts:generate", qwenGenerate(modelPath, 1));

      expect(reads).toHaveBeenCalledTimes(2);
    });

    it("refuses a folder deleted by clearing the cache instead of trusting the earlier pass", async () => {
      const modelPath = path.join(mocks.userDataPath, "local-model-cache", "qwen3", "managed");
      await writeModelDir(modelPath);
      await invoke("local-tts:generate", qwenGenerate(modelPath, 0));

      await invoke("local-tts:clear-cache", { model: "qwen3" });

      await expect(invoke("local-tts:generate", qwenGenerate(modelPath, 1)))
        .rejects.toThrow("The selected Qwen3 model directory is missing required files");
      expect(mocks.localWsRun).toHaveBeenCalledTimes(1);
    });
  });
});

describe("main-process diagnostics", () => {
  const generateRequest = {
    model: "neutts", requestId: "local-generate", payload: {
      text: "hello", referenceText: "hello", referenceCodesBase64: "AAAA",
    },
  };
  const generateResponse = {
    response: { ok: true, result: {
      sampleRate: 24_000, modelRepo: "model", durationSec: 1, elapsedSec: 1,
      audioTransport: "websocket-binary", audioChunkCount: 1, phaseTimingsSec: {},
    } },
  };

  function invoke(channel: string, request: unknown, url?: string): Promise<unknown> {
    return Promise.resolve().then(() => mocks.invokeHandlers.get(channel)!(createEvent(undefined, url), request));
  }

  function logged(scope: string): LoggedEntry[] {
    return mocks.logEntries.filter((entry) => entry.scope === scope);
  }

  async function importMain(): Promise<void> {
    vi.resetModules();
    mocks.invokeHandlers.clear();
    mocks.ipcListeners.clear();
    mocks.appListeners.clear();
    mocks.logEntries = [];
    (globalThis as { __dirname?: string }).__dirname = "/tmp";
    await import("./main");
  }

  beforeEach(async () => {
    mocks.windows = [];
    mocks.quit.mockClear();
    mocks.closeWorker.mockClear();
    mocks.workerError = null;
    mocks.logPending = false;
    mocks.logFlush = null;
    mocks.localWsRun.mockReset().mockResolvedValue(generateResponse);
    mocks.localWsCancel.mockReset().mockReturnValue(false);
    mocks.localWsShutdownAll.mockReset().mockResolvedValue(undefined);
    mocks.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "open-tts-main-diagnostics-"));
    await importMain();
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mocks.windowError = null;
    await fs.rm(mocks.userDataPath, { recursive: true, force: true });
    mocks.userDataPath = "/tmp";
  });

  it("records the start of the session with the runtime it runs on", () => {
    expect(mocks.logEntries[0]).toEqual({
      scope: "app",
      level: "info",
      msg: "Started",
      data: {
        version: "0.0.0-test",
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        packaged: false,
      },
    });
  });

  it("logs a failed generation with the bridge's native diagnostics", async () => {
    // The module instance main loaded after resetModules, so `instanceof` holds.
    const { NativeRuntimeError } = await import("./errors");
    const failure = new NativeRuntimeError(
      "Rust local bridge exited before returning a result (code 101).",
      { stderr: "thread 'main' panicked", exitCode: 101, signal: null },
    );
    mocks.localWsRun.mockRejectedValueOnce(failure);

    await expect(invoke("local-tts:generate", generateRequest)).rejects.toBe(failure);

    expect(logged("ipc")).toEqual([{
      scope: "ipc",
      level: "error",
      msg: "IPC request failed",
      data: {
        channel: "local-tts:generate",
        error: { message: failure.message, native: { stderr: "thread 'main' panicked", exitCode: 101, signal: null } },
      },
    }]);
  });

  it("records a deliberate stop at debug level only", async () => {
    mocks.localWsRun.mockRejectedValueOnce(new Error("Generation cancelled."));

    await expect(invoke("local-tts:generate", generateRequest)).rejects.toThrow("Generation cancelled.");

    expect(logged("ipc")).toEqual([
      { scope: "ipc", level: "debug", msg: "IPC request cancelled", data: { channel: "local-tts:generate" } },
    ]);
  });

  it("logs an untrusted sender once per channel", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(invoke("audio8:cache-info", undefined, "https://evil.test/page"))
        .rejects.toThrow("Rejected IPC from untrusted sender.");
    }

    expect(logged("ipc")).toEqual([{
      scope: "ipc",
      level: "warn",
      msg: "Rejected IPC from an untrusted sender",
      data: { channel: "audio8:cache-info", senderOrigin: "https://evil.test" },
    }]);
  });

  it("logs a failed warm-up, which the renderer only sees as warmed: false, but not a cancelled one", async () => {
    mocks.localWsRun.mockRejectedValueOnce(new Error("Model load failed."));
    await expect(invoke("local-tts:warm", { model: "neutts" }))
      .resolves.toEqual({ warmed: false, message: "Model load failed." });
    mocks.localWsRun.mockRejectedValueOnce(new Error("Generation cancelled."));
    await expect(invoke("local-tts:warm", { model: "neutts" }))
      .resolves.toEqual({ warmed: false, message: "Generation cancelled." });

    expect(logged("local-tts")).toEqual([{
      scope: "local-tts",
      level: "warn",
      msg: "Warm-up failed",
      data: { model: "neutts", error: { message: "Model load failed.", stack: expect.stringContaining("Model load failed.") } },
    }]);
  });

  it("logs the first malformed progress frame of a request and keeps generating", async () => {
    mocks.localWsRun.mockImplementationOnce(async (_model, options: { onProgress: (payload: unknown) => void }) => {
      options.onProgress({ type: "progress" });
      options.onProgress({ type: "progress", phase: 7 });
      return generateResponse;
    });

    await expect(invoke("local-tts:generate", generateRequest)).resolves.toMatchObject({ audioChunkCount: 1 });

    expect(logged("local-tts")).toEqual([{
      scope: "local-tts",
      level: "warn",
      msg: "Ignored a malformed bridge progress frame",
      data: { model: "neutts", requestId: "local-generate", error: expect.any(String) },
    }]);
  });

  it("logs a throwing bridge stream consumer", async () => {
    // The pool is built on the first request.
    await invoke("local-tts:generate", generateRequest);
    const failure = new Error("renderer send failed");

    mocks.poolOptions!.onListenerError!(failure, { requestId: "local-generate", listener: "audioChunk" });

    expect(logged("local-tts")).toEqual([{
      scope: "local-tts",
      level: "error",
      msg: "A bridge stream consumer failed",
      data: { requestId: "local-generate", listener: "audioChunk", error: { message: failure.message, stack: failure.stack } },
    }]);
  });

  it("logs renderer and child process crashes, and a clean child exit as routine", () => {
    mocks.appListeners.get("render-process-gone")!({}, {}, { reason: "oom", exitCode: 9 });
    mocks.appListeners.get("child-process-gone")!({}, { type: "GPU", reason: "crashed", exitCode: 5, name: "GPU" });
    mocks.appListeners.get("child-process-gone")!({}, {
      type: "Utility", reason: "clean-exit", exitCode: 0, serviceName: "network.mojom.NetworkService",
    });

    expect(logged("app").slice(1)).toEqual([
      { scope: "app", level: "error", msg: "A renderer process is gone", data: { reason: "oom", exitCode: 9 } },
      {
        scope: "app",
        level: "error",
        msg: "A child process is gone",
        data: { type: "GPU", reason: "crashed", exitCode: 5, name: "GPU" },
      },
      {
        scope: "app",
        level: "info",
        msg: "A child process exited",
        data: { type: "Utility", reason: "clean-exit", exitCode: 0, serviceName: "network.mojom.NetworkService" },
      },
    ]);
  });

  it("logs a startup that failed before the IPC handlers were registered", async () => {
    mocks.windowError = new Error("Window creation failed.");
    await importMain();
    await drainTurns();

    expect(logged("app")).toContainEqual({
      scope: "app",
      level: "error",
      msg: "Startup failed",
      data: { error: { message: "Window creation failed.", stack: expect.any(String) } },
    });
    expect(mocks.invokeHandlers.size).toBe(0);
  });

  it("logs a shutdown step that fails and still quits", async () => {
    emitStream("reader-library:save-audio-stream", createEvent(createPort()), { metadata: {}, chunkCount: 1 });
    mocks.closeWorker.mockImplementationOnce(() => Promise.reject(new Error("Reader library worker is shutting down.")));

    mocks.appListeners.get("before-quit")!({ preventDefault: vi.fn() });
    await waitForQuit();

    expect(logged("shutdown")).toEqual([{
      scope: "shutdown",
      level: "error",
      msg: "A shutdown step failed",
      data: {
        participant: "reader-library",
        error: { message: "Reader library worker is shutting down.", stack: expect.any(String) },
      },
    }]);
  });

  it("holds the quit for pending log writes and quits once they land", async () => {
    let finishFlush!: () => void;
    mocks.logPending = true;
    mocks.logFlush = new Promise<void>((resolve) => { finishFlush = resolve; });
    const quitEvent = { preventDefault: vi.fn() };

    mocks.appListeners.get("before-quit")!(quitEvent);

    // Nothing else is outstanding; the unwritten entries alone hold the quit.
    expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1);
    await drainTurns();
    expect(mocks.quit).not.toHaveBeenCalled();
    finishFlush();
    await waitForQuit();
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });

  it("does not let a stuck log write keep the app from quitting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    mocks.logPending = true;
    mocks.logFlush = new Promise<void>(() => {});

    mocks.appListeners.get("before-quit")!({ preventDefault: vi.fn() });
    // The barrier gives up first (at the Reader library's 3.5 s budget plus
    // 500 ms), then the final flush gets its own short wait.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mocks.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);

    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });
});

describe("single-instance lock", () => {
  async function importMain(): Promise<void> {
    vi.resetModules();
    mocks.invokeHandlers.clear();
    mocks.ipcListeners.clear();
    mocks.appListeners.clear();
    mocks.logEntries = [];
    (globalThis as { __dirname?: string }).__dirname = "/tmp";
    await import("./main");
    await drainTurns();
  }

  beforeEach(() => {
    mocks.windows = [];
    mocks.exit.mockClear();
    mocks.quit.mockClear();
    // The diagnostics suite's last case leaves a log write that never lands,
    // which would hold every quit here for the barrier's whole budget.
    mocks.logPending = false;
    mocks.logFlush = null;
  });

  afterEach(() => {
    mocks.singleInstanceLock = true;
    mocks.windowOpened = null;
    mocks.ready = null;
  });

  it("exits a second launch before it logs, registers IPC or opens a window", async () => {
    mocks.singleInstanceLock = false;

    await importMain();

    expect(mocks.exit).toHaveBeenCalledWith(0);
    expect(mocks.invokeHandlers.size).toBe(0);
    expect(mocks.ipcListeners.size).toBe(0);
    expect(mocks.appListeners.size).toBe(0);
    expect(mocks.logEntries).toEqual([]);
  });

  it("brings the running window forward when the app is launched again", async () => {
    await importMain();
    const window = { isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    mocks.windows = [window as unknown as FakeWindow];

    mocks.appListeners.get("second-instance")!();

    expect(mocks.exit).not.toHaveBeenCalled();
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("opens no window for a relaunch or a dock click once the quit has started", async () => {
    await importMain();
    const opened = vi.fn();
    mocks.windowOpened = opened;
    // A log write that lands at once: the barrier holds, then quits again.
    mocks.logPending = true;
    mocks.appListeners.get("before-quit")!({ preventDefault: vi.fn() });

    mocks.appListeners.get("second-instance")!();
    mocks.appListeners.get("activate")!();

    expect(opened).not.toHaveBeenCalled();
    await waitForQuit();
  });

  it("does not try to open a window for a dock click or relaunch before the app is ready", async () => {
    let becomeReady!: () => void;
    mocks.ready = new Promise<void>((resolve) => { becomeReady = resolve; });
    const opened = vi.fn();
    mocks.windowOpened = opened;
    await importMain();

    // Creating a BrowserWindow now would throw in the main process. Nothing is
    // listening yet, so nothing is lost: the first window comes with `ready`.
    expect(mocks.appListeners.has("activate")).toBe(false);
    expect(mocks.appListeners.has("second-instance")).toBe(false);

    becomeReady();
    await drainTurns();
    expect(opened).toHaveBeenCalledTimes(1);
    mocks.appListeners.get("activate")!();
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it("reopens a window on a dock click when none is left", async () => {
    await importMain();
    const opened = vi.fn();
    mocks.windowOpened = opened;

    mocks.appListeners.get("activate")!();

    expect(opened).toHaveBeenCalledTimes(1);
  });
});

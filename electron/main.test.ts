import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIO8_MAX_TEXT_CHARACTERS, AUDIO8_MODEL_REVISION } from "./audio8Model";

interface FakeWindow {
  webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
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
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => Promise.resolve(),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      mocks.appListeners.set(channel, listener);
    },
    getPath: () => mocks.userDataPath,
    getAppPath: () => "/tmp",
    quit: mocks.quit,
  },
  BrowserWindow: class {
    static fromWebContents = () => null;
    static getAllWindows = () => mocks.windows;
    loadURL = () => Promise.resolve();
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.invokeHandlers.set(channel, handler);
    },
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      mocks.ipcListeners.set(channel, listener);
    },
  },
  Menu: { setApplicationMenu: vi.fn() },
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

vi.mock("./readerLibraryWorkerClient", () => ({
  ReaderLibraryWorkerClient: vi.fn(() => {
    if (mocks.workerError) throw mocks.workerError;
    return { saveAudio: mocks.saveAudio, getAudio: mocks.getAudio, close: mocks.closeWorker };
  }),
}));

// Stubbed against the client's behavioural contract only — construct with a
// model dir, `load`/`generate` resolve a result, `destroy` rejects what is
// pending and then settles. `audio8NativeWorker.ts` and `audio8NativeClient.ts`
// are being rewritten in parallel, and none of these assertions should care.
vi.mock("./audio8NativeClient", () => ({
  Audio8NativeClient: vi.fn((modelDir: string) => {
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
    sender: { id: 1, getURL: () => url, isDestroyed: () => false, send: vi.fn() },
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
 * The barrier joins filesystem work, so it needs however many event-loop turns
 * that I/O takes rather than a fixed number. `setImmediate` is never faked here,
 * so this still drives a suite running on fake `setTimeout`.
 */
async function waitForQuit(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

      expect(audio8Clients()[0].generate).toHaveBeenCalledWith("g1", " hi ", "sophie", expect.any(Function));
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

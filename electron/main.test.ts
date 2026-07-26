import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeWindow {
  webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
}

const mocks = vi.hoisted(() => ({
  ipcListeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  windows: [] as unknown[],
  quit: vi.fn(),
  saveAudio: vi.fn(),
  getAudio: vi.fn(),
  closeWorker: vi.fn(() => Promise.resolve()),
  workerError: null as Error | null,
  unhandledRejections: [] as unknown[],
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => Promise.resolve(),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      mocks.appListeners.set(channel, listener);
    },
    getPath: () => "/tmp",
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
    handle: vi.fn(),
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
    sender: { id: 1, getURL: () => url },
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

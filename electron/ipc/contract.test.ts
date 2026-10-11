// @vitest-environment node

import { MessagePort as NodeMessagePort } from "worker_threads";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  IPC_INVOKE_CHANNELS,
  IPC_MESSAGE_CHANNELS,
  IPC_PORT_CHANNELS,
  RENDERER_EVENT_CHANNELS,
} from "./channels";
import type { DiagnosticsLogger } from "../diagnostics";
import { UNTRUSTED_SENDER_MESSAGE } from "./trusted";

type Listener = (event: unknown, payload?: unknown) => unknown;

const ipc = vi.hoisted(() => ({
  mainHandlers: new Map<string, Listener>(),
  mainListeners: new Map<string, Listener>(),
  invoked: new Set<string>(),
  sent: new Set<string>(),
  posted: new Set<string>(),
  subscribed: new Map<string, Set<Listener>>(),
  exposed: {} as Record<string, unknown>,
}));

// One `electron` stub serves both sides: main registers through `ipcMain`,
// preload talks through `ipcRenderer` and `contextBridge`.
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    getPath: () => "/tmp",
    getAppPath: () => "/tmp",
    getVersion: () => "0.0.0-test",
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
  },
  BrowserWindow: class {
    static fromWebContents = () => null;
    static getAllWindows = () => [];
    loadURL = () => Promise.resolve();
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: Listener) => ipc.mainHandlers.set(channel, handler),
    on: (channel: string, listener: Listener) => ipc.mainListeners.set(channel, listener),
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
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => Object.assign(ipc.exposed, api),
  },
  ipcRenderer: {
    invoke: (channel: string, request?: { requestId?: string }) => {
      ipc.invoked.add(channel);
      // Main ends every generation's audio stream before it replies.
      if (channel === "local-tts:generate") {
        for (const listener of ipc.subscribed.get("local-tts:audio-stream") ?? []) {
          listener({}, { type: "end", requestId: request?.requestId });
        }
      }
      // Reaching `document:read-epub` needs an import that staged an EPUB.
      return Promise.resolve(channel === "document:import"
        ? { canceled: false, fileName: "book.epub", text: "", epubTransferId: "transfer", epubByteLength: 0 }
        : undefined);
    },
    send: (channel: string) => {
      ipc.sent.add(channel);
    },
    postMessage: (channel: string, _message: unknown, transfer: NodeMessagePort[] = []) => {
      ipc.posted.add(channel);
      // Answer the stream so the preload promise settles instead of waiting
      // out its timeout: EPUB reads complete empty, Reader streams fail fast.
      const [port] = transfer;
      port?.postMessage(channel === "document:read-epub"
        ? { done: true }
        : { type: "result", ok: false, error: "contract" });
    },
    on: (channel: string, listener: Listener) => {
      const listeners = ipc.subscribed.get(channel) ?? new Set<Listener>();
      listeners.add(listener);
      ipc.subscribed.set(channel, listeners);
    },
    off: vi.fn(),
  },
}));

// Main logs as it starts and as requests fail; none of that belongs on disk here.
vi.mock("../diagnostics", async (importOriginal) => {
  const logger = (): DiagnosticsLogger => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: logger,
  });
  return {
    ...await importOriginal<typeof import("../diagnostics")>(),
    createDiagnosticsLog: () => ({ logger, flush: () => Promise.resolve(), pending: false }),
  };
});

const sorted = (values: Iterable<string>) => [...values].sort();

/** Calls every function the preload exposes, recursing into namespaces. */
async function exercise(api: Record<string, unknown>): Promise<void> {
  const request = { requestId: "contract", model: "qwen3", modelRepo: "repo", chunks: [] };
  for (const [name, value] of Object.entries(api)) {
    if (typeof value === "function") {
      const argument = name.startsWith("subscribe") ? () => undefined : request;
      await Promise.resolve()
        .then(() => (value as (...args: unknown[]) => unknown)(argument, "section"))
        .catch(() => undefined);
    } else if (value && typeof value === "object") {
      await exercise(value as Record<string, unknown>);
    }
  }
}

function untrustedEvent(port?: { close: () => void; postMessage: () => void }) {
  return {
    senderFrame: { url: "https://example.com/" },
    sender: { id: 1, getURL: () => "https://example.com/" },
    ports: port ? [port] : [],
  };
}

describe("IPC contract", () => {
  beforeAll(async () => {
    (globalThis as { __dirname?: string }).__dirname = "/tmp";
    await import("../main");
    await import("../preload");
    await exercise(ipc.exposed);
    // The flush acknowledgement is the one message main only ever receives
    // in reply to its own `reader-library:flush` request.
    for (const listener of ipc.subscribed.get("reader-library:flush") ?? []) listener({}, { token: "flush" });
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  });

  it("registers exactly the contract's channels in main", () => {
    expect(sorted(ipc.mainHandlers.keys())).toEqual(sorted(IPC_INVOKE_CHANNELS));
    expect(sorted(ipc.mainListeners.keys())).toEqual(sorted([...IPC_MESSAGE_CHANNELS, ...IPC_PORT_CHANNELS]));
  });

  it("uses exactly the contract's channels from preload", () => {
    expect(sorted(ipc.invoked)).toEqual(sorted(IPC_INVOKE_CHANNELS));
    expect(sorted(ipc.sent)).toEqual(sorted(IPC_MESSAGE_CHANNELS));
    expect(sorted(ipc.posted)).toEqual(sorted(IPC_PORT_CHANNELS));
    expect(sorted(ipc.subscribed.keys())).toEqual(sorted(RENDERER_EVENT_CHANNELS));
  });

  it.each(IPC_INVOKE_CHANNELS)("rejects %s from an untrusted sender before running it", (channel) => {
    expect(() => ipc.mainHandlers.get(channel)!(untrustedEvent(), {})).toThrow(UNTRUSTED_SENDER_MESSAGE);
  });

  it.each([...IPC_MESSAGE_CHANNELS, ...IPC_PORT_CHANNELS])(
    "drops %s from an untrusted sender without answering",
    (channel) => {
      const port = { close: vi.fn(), postMessage: vi.fn() };
      expect(() => ipc.mainListeners.get(channel)!(untrustedEvent(port), { token: "flush", transferId: "transfer" }))
        .not.toThrow();
      expect(port.postMessage).not.toHaveBeenCalled();
      if ((IPC_PORT_CHANNELS as readonly string[]).includes(channel)) expect(port.close).toHaveBeenCalledTimes(1);
    },
  );
});

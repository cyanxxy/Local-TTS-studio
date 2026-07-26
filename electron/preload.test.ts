// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import "./preload";

// Mirrors the stream limits in preload.ts, which cannot export them: the
// preload bundle is built in isolation by esbuild.
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

interface StreamPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (value: unknown, transfer?: unknown[]) => void;
  close: () => void;
}

interface ReaderLibraryBridge {
  getAudio: (documentId: string, sectionId: string) => Promise<unknown>;
  subscribeFlushRequests: (listener: () => Promise<void> | void) => () => void;
}

interface LocalTtsBridge {
  generate: (request: { model: "qwen3"; requestId: string; payload: Record<string, unknown> }) => Promise<unknown>;
  subscribeAudioChunk: (listener: (payload: unknown) => void) => () => void;
}

type IpcListener = (event: unknown, payload: unknown) => void;

const { exposed, ipcInvoke, ipcPostMessage, ipcSend, ipcListeners } = vi.hoisted(() => ({
  exposed: {} as { readerLibrary?: ReaderLibraryBridge; localTts?: LocalTtsBridge },
  ipcInvoke: vi.fn(),
  ipcPostMessage: vi.fn(),
  ipcSend: vi.fn(),
  ipcListeners: new Map<string, Set<IpcListener>>(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      Object.assign(exposed, api);
    },
  },
  ipcRenderer: {
    invoke: ipcInvoke,
    postMessage: ipcPostMessage,
    send: ipcSend,
    on: (channel: string, listener: IpcListener) => {
      const listeners = ipcListeners.get(channel) ?? new Set<IpcListener>();
      listeners.add(listener);
      ipcListeners.set(channel, listeners);
    },
    off: (channel: string, listener: IpcListener) => {
      const listeners = ipcListeners.get(channel);
      listeners?.delete(listener);
      if (listeners?.size === 0) ipcListeners.delete(channel);
    },
  },
}));

const openPorts: StreamPort[] = [];

/** Starts a read and hands back the port the main process would have received. */
function openAudioStream(): { result: Promise<unknown>; port: StreamPort } {
  ipcPostMessage.mockClear();
  const result = exposed.readerLibrary!.getAudio("doc", "section-1");
  const [channel, , transfer] = ipcPostMessage.mock.calls[0] as [string, unknown, StreamPort[]];
  expect(channel).toBe("reader-library:get-audio-stream");
  const port = transfer[0];
  openPorts.push(port);
  return { result, port };
}

function sendHeader(port: StreamPort, chunkCount: number): void {
  port.postMessage({
    type: "header",
    audio: { cacheKey: JSON.stringify(["doc", "section-1"]), documentId: "doc", sectionId: "section-1" },
    chunkCount,
  });
}

/** Answers every `next` request with a chunk whose audio `createAudio` sizes. */
function serveChunks(port: StreamPort, createAudio: (order: number) => ArrayBuffer): void {
  port.onmessage = (event) => {
    const message = event.data as { type?: unknown; order?: unknown };
    if (message.type !== "next") return;
    const order = Number(message.order);
    const audio = createAudio(order);
    port.postMessage({
      type: "chunk",
      order,
      chunk: { audio, samplingRate: 24_000, text: "Spoken text.", index: order, total: 3 },
    }, [audio]);
  };
}

/**
 * Reduces a read to a short token so a failed assertion never formats the
 * megabytes of audio a missing size guard would have accumulated.
 */
function settle(result: Promise<unknown>): Promise<string> {
  return result.then(() => "resolved", (cause: unknown) => (cause as Error).message);
}

function emitIpc(channel: string, payload: unknown): void {
  const listeners = ipcListeners.get(channel);
  if (!listeners) throw new Error(`No IPC listeners registered for ${channel}.`);
  for (const listener of listeners) listener({}, payload);
}

describe("preload reader audio stream", () => {
  afterEach(() => {
    while (openPorts.length > 0) openPorts.pop()!.close();
  });

  it("assembles a multi-chunk read in order", async () => {
    const { result, port } = openAudioStream();
    serveChunks(port, (order) => new Float32Array([order, -0.25]).buffer);
    sendHeader(port, 3);

    const audio = await result as { documentId: string; chunks: Array<{ audio: ArrayBuffer; index: number }> };
    expect(audio.documentId).toBe("doc");
    expect(audio.chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(audio.chunks.map((chunk) => new Float32Array(chunk.audio)[0])).toEqual([0, 1, 2]);
  });

  it("rejects a chunk larger than the per-chunk stream limit", async () => {
    const { result, port } = openAudioStream();
    serveChunks(port, () => new ArrayBuffer(MAX_CHUNK_BYTES + 1));
    sendHeader(port, 1);

    expect(await settle(result)).toMatch(/chunk 0 exceeds the stream size limit/i);
  });

  it("rejects a read whose chunks exceed the total stream limit", async () => {
    const chunkCount = MAX_ENTRY_BYTES / MAX_CHUNK_BYTES + 1;
    const { result, port } = openAudioStream();
    // Every chunk sits exactly on the per-chunk limit, so only the running
    // total can reject this read.
    serveChunks(port, () => new ArrayBuffer(MAX_CHUNK_BYTES));
    sendHeader(port, chunkCount);

    expect(await settle(result)).toMatch(/Cached Reader audio exceeds the stream size limit/i);
  });
});

describe("preload reader flush handshake", () => {
  function emitFlush(token: unknown): void {
    emitIpc("reader-library:flush", { token });
  }

  afterEach(() => {
    ipcSend.mockClear();
  });

  it("acknowledges only after the flush listener settles", async () => {
    let release = () => {};
    const unsubscribe = exposed.readerLibrary!.subscribeFlushRequests(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    emitFlush("flush-1");
    await Promise.resolve();
    expect(ipcSend).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => {
      expect(ipcSend).toHaveBeenCalledWith("reader-library:flush-complete", { token: "flush-1" });
    });
    unsubscribe();
  });

  it("acknowledges a failed flush so the quit is never stranded", async () => {
    const unsubscribe = exposed.readerLibrary!.subscribeFlushRequests(
      () => Promise.reject(new Error("The write failed.")),
    );

    emitFlush("flush-2");
    await vi.waitFor(() => {
      expect(ipcSend).toHaveBeenCalledWith("reader-library:flush-complete", { token: "flush-2" });
    });
    unsubscribe();
  });

  it("ignores a flush request without a token", async () => {
    const listener = vi.fn();
    const unsubscribe = exposed.readerLibrary!.subscribeFlushRequests(listener);

    emitFlush(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(ipcSend).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("preload local TTS audio delivery", () => {
  afterEach(() => {
    ipcInvoke.mockReset();
    vi.useRealTimers();
  });

  it("does not resolve generation until renderer listeners receive every declared audio chunk", async () => {
    let resolveGenerate!: (value: unknown) => void;
    ipcInvoke.mockReturnValue(new Promise((resolve) => { resolveGenerate = resolve; }));
    const deliveryOrder: string[] = [];
    const unsubscribe = exposed.localTts!.subscribeAudioChunk(() => {
      deliveryOrder.push("audio-listener");
    });
    const generation = exposed.localTts!.generate({
      model: "qwen3",
      requestId: "qwen-race",
      payload: { text: "hello" },
    }).then((result) => {
      deliveryOrder.push("generate-resolved");
      return result;
    });

    resolveGenerate({ audioChunkCount: 2, sampleRate: 24_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(deliveryOrder).toEqual([]);

    emitIpc("local-tts:audio-chunk", { requestId: "qwen-race", index: 0 });
    await Promise.resolve();
    expect(deliveryOrder).toEqual(["audio-listener"]);

    emitIpc("local-tts:audio-chunk", { requestId: "qwen-race", index: 1 });
    await expect(generation).resolves.toMatchObject({ audioChunkCount: 2 });
    expect(deliveryOrder).toEqual([
      "audio-listener",
      "audio-listener",
      "generate-resolved",
    ]);
    unsubscribe();
  });

  it("times out instead of reporting success when Electron drops an audio chunk", async () => {
    vi.useFakeTimers();
    ipcInvoke.mockResolvedValue({ audioChunkCount: 2, sampleRate: 24_000 });
    const generation = exposed.localTts!.generate({
      model: "qwen3",
      requestId: "qwen-missing",
      payload: { text: "hello" },
    });

    emitIpc("local-tts:audio-chunk", { requestId: "qwen-missing", index: 0 });
    const rejected = expect(generation).rejects.toThrow(/receiving 1 of 2 chunks/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  });
});

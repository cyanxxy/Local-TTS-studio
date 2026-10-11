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
  saveAudio: (audio: unknown) => Promise<void>;
  getAudio: (documentId: string, sectionId: string) => Promise<unknown>;
  subscribeFlushRequests: (listener: () => Promise<void> | void) => () => void;
}

interface LocalTtsBridge {
  generate: (
    request: { model: "qwen3"; requestId: string; payload: Record<string, unknown> },
    options?: { onAudioChunk?: (payload: unknown) => void },
  ) => Promise<unknown>;
  cancel: (request: { model: "qwen3"; requestId: string }) => Promise<unknown>;
  subscribeAudioChunk: (listener: (payload: unknown) => void) => () => void;
  keepWarm: (request: { model: "qwen3"; modelRepo: string; modelPath: string }) => () => void;
  subscribeModelEvicted: (listener: (payload: unknown) => void) => () => void;
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

  it("transfers one persistence copy without detaching the renderer source", async () => {
    ipcPostMessage.mockClear();
    const source = new Float32Array([0.25, -0.5]).buffer;
    const result = exposed.readerLibrary!.saveAudio({
      cacheKey: "cache",
      documentId: "doc",
      chapterId: "chapter",
      sectionId: "section-1",
      signature: "signature",
      byteLength: source.byteLength,
      currentTime: 0,
      playbackRate: 1,
      totalDuration: 1,
      updatedAt: 1,
      chunks: [{
        audio: source,
        samplingRate: 24_000,
        text: "Spoken text.",
        index: 0,
        total: 1,
      }],
    });
    const [channel, , transfer] = ipcPostMessage.mock.calls[0] as [string, unknown, StreamPort[]];
    expect(channel).toBe("reader-library:save-audio-stream");
    const port = transfer[0];
    openPorts.push(port);

    const received: number[][] = [];
    port.onmessage = (event) => {
      const message = event.data as {
        type?: unknown;
        order?: number;
        chunk?: { audio?: ArrayBuffer };
      };
      if (message.type === "chunk" && message.chunk?.audio) {
        received.push([...new Float32Array(message.chunk.audio)]);
        port.postMessage({ type: "accepted", order: message.order });
      } else if (message.type === "end") {
        port.postMessage({ type: "result", ok: true });
      }
    };
    port.postMessage({ type: "ready" });

    await result;
    expect(received).toEqual([[0.25, -0.5]]);
    expect(source.byteLength).toBe(Float32Array.BYTES_PER_ELEMENT * 2);
    expect([...new Float32Array(source)]).toEqual([0.25, -0.5]);
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
  const generate: LocalTtsBridge["generate"] = (request, options) => exposed.localTts!.generate(request, options);

  function chunk(requestId: string, index: number) {
    return { type: "chunk", requestId, model: "qwen3", index, total: 0, audio: new ArrayBuffer(8) };
  }

  function endStream(requestId: string) {
    emitIpc("local-tts:audio-stream", { type: "end", requestId, model: "qwen3" });
  }

  /** A generate whose invoke reply the test releases by hand. */
  function pendingReply(): (value: unknown) => void {
    let resolveGenerate!: (value: unknown) => void;
    ipcInvoke.mockImplementationOnce(() => new Promise((resolve) => { resolveGenerate = resolve; }));
    return (value) => resolveGenerate(value);
  }

  afterEach(() => {
    ipcInvoke.mockReset();
  });

  it("resolves only once the end marker shows every chunk was delivered, even when the reply overtakes them", async () => {
    const reply = pendingReply();
    const deliveryOrder: string[] = [];
    const unsubscribe = exposed.localTts!.subscribeAudioChunk((payload) => {
      deliveryOrder.push(`chunk ${(payload as { index: number }).index}`);
    });
    const generation = generate({ model: "qwen3", requestId: "qwen-race", payload: { text: "hello" } })
      .then((result) => {
        deliveryOrder.push("generate-resolved");
        return result;
      });

    reply({ audioChunkCount: 2, sampleRate: 24_000 });
    await vi.waitFor(() => expect(ipcInvoke).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
    expect(deliveryOrder).toEqual([]);

    emitIpc("local-tts:audio-stream", chunk("qwen-race", 0));
    emitIpc("local-tts:audio-stream", chunk("qwen-race", 1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(deliveryOrder).toEqual(["chunk 0", "chunk 1"]);

    endStream("qwen-race");
    await expect(generation).resolves.toMatchObject({ audioChunkCount: 2 });
    expect(deliveryOrder).toEqual(["chunk 0", "chunk 1", "generate-resolved"]);
    unsubscribe();
  });

  it("hands a subscriber the chunk without the stream's message type", async () => {
    const received: unknown[] = [];
    const unsubscribe = exposed.localTts!.subscribeAudioChunk((payload) => received.push(payload));
    const reply = pendingReply();
    const generation = generate({ model: "qwen3", requestId: "shape", payload: {} });

    const message = chunk("shape", 0);
    emitIpc("local-tts:audio-stream", message);
    endStream("shape");
    reply({});
    await generation;

    const { type, ...expected } = message;
    expect(type).toBe("chunk");
    expect(received).toEqual([expected]);
    unsubscribe();
  });

  it("delivers a request's chunks only to its own listener when it has one", async () => {
    const subscriber = vi.fn();
    const unsubscribe = exposed.localTts!.subscribeAudioChunk(subscriber);
    const ownA = vi.fn();
    const ownB = vi.fn();
    const replyA = pendingReply();
    const replyB = pendingReply();
    const generationA = generate({ model: "qwen3", requestId: "a", payload: {} }, { onAudioChunk: ownA });
    const generationB = generate({ model: "qwen3", requestId: "b", payload: {} }, { onAudioChunk: ownB });

    emitIpc("local-tts:audio-stream", chunk("a", 0));
    emitIpc("local-tts:audio-stream", chunk("b", 0));
    emitIpc("local-tts:audio-stream", chunk("b", 1));
    endStream("a");
    endStream("b");
    replyA({});
    replyB({});
    await Promise.all([generationA, generationB]);

    expect(ownA.mock.calls.map(([payload]) => (payload as { requestId: string }).requestId)).toEqual(["a"]);
    expect(ownB.mock.calls.map(([payload]) => (payload as { index: number }).index)).toEqual([0, 1]);
    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("drops chunks of requests this window is not running", () => {
    const subscriber = vi.fn();
    const unsubscribe = exposed.localTts!.subscribeAudioChunk(subscriber);

    emitIpc("local-tts:audio-stream", chunk("unknown", 0));
    emitIpc("local-tts:audio-stream", { type: "chunk" });
    emitIpc("local-tts:audio-stream", null);

    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops delivering a request's chunks the moment it is cancelled", async () => {
    const own = vi.fn();
    const reply = pendingReply();
    const generation = generate({ model: "qwen3", requestId: "stop-me", payload: {} }, { onAudioChunk: own });
    emitIpc("local-tts:audio-stream", chunk("stop-me", 0));

    ipcInvoke.mockResolvedValueOnce({ cancelled: true });
    await exposed.localTts!.cancel({ model: "qwen3", requestId: "stop-me" });
    emitIpc("local-tts:audio-stream", chunk("stop-me", 1));

    expect(own).toHaveBeenCalledTimes(1);
    expect(ipcInvoke).toHaveBeenLastCalledWith("local-tts:cancel", { model: "qwen3", requestId: "stop-me" });
    reply(Promise.reject(new Error("Generation cancelled.")));
    await expect(generation).rejects.toThrow("Generation cancelled.");
  });

  it("still forwards a cancel for a request it is not streaming", async () => {
    ipcInvoke.mockResolvedValueOnce({ cancelled: false });
    await expect(exposed.localTts!.cancel({ model: "qwen3", requestId: "elsewhere" }))
      .resolves.toEqual({ cancelled: false });
  });

  it("rejects at once when the generation fails, without waiting for an end marker", async () => {
    ipcInvoke.mockRejectedValueOnce(new Error("The selected Qwen3 model directory is missing required files."));

    await expect(generate({ model: "qwen3", requestId: "broken", payload: {} }))
      .rejects.toThrow("missing required files");
    // The id is free again.
    const reply = pendingReply();
    const retry = generate({ model: "qwen3", requestId: "broken", payload: {} });
    endStream("broken");
    reply({ ok: true });
    await expect(retry).resolves.toEqual({ ok: true });
  });

  it("refuses a second generation with an id that is still streaming", async () => {
    const reply = pendingReply();
    const first = generate({ model: "qwen3", requestId: "twice", payload: {} });

    await expect(generate({ model: "qwen3", requestId: "twice", payload: {} })).rejects.toThrow(/already active/);
    endStream("twice");
    reply({});
    await first;
  });

  it("passes a request without a string id straight to main", async () => {
    ipcInvoke.mockRejectedValueOnce(new Error("`requestId` is required."));

    await expect(generate({ model: "qwen3", requestId: 7 as unknown as string, payload: {} }))
      .rejects.toThrow("`requestId` is required.");
  });

  it("keeps delivering to other listeners when one throws, and reports the failure", async () => {
    const thrown: unknown[] = [];
    const onUncaught = (error: unknown) => thrown.push(error);
    process.on("uncaughtException", onUncaught);
    const failing = exposed.localTts!.subscribeAudioChunk(() => {
      throw new Error("listener bug");
    });
    const healthy = vi.fn();
    const unsubscribe = exposed.localTts!.subscribeAudioChunk(healthy);
    const reply = pendingReply();
    const generation = generate({ model: "qwen3", requestId: "throws", payload: {} });

    emitIpc("local-tts:audio-stream", chunk("throws", 0));
    endStream("throws");
    reply({});
    await generation;
    await new Promise((resolve) => setImmediate(resolve));
    process.off("uncaughtException", onUncaught);

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(thrown).toEqual([new Error("listener bug")]);
    failing();
    unsubscribe();
  });
});

describe("preload local TTS keep-warm leases", () => {
  const request = { model: "qwen3", modelRepo: "repo", modelPath: "/models/qwen3" } as const;

  afterEach(() => {
    ipcInvoke.mockReset();
    vi.restoreAllMocks();
  });

  function invokedChannels(): string[] {
    return ipcInvoke.mock.calls.map(([channel]) => channel as string);
  }

  it("takes out a lease under a fresh id and releases that same lease once", async () => {
    ipcInvoke.mockResolvedValue(undefined);

    const release = exposed.localTts!.keepWarm(request);
    const other = exposed.localTts!.keepWarm(request);
    const [[, first], [, second]] = ipcInvoke.mock.calls as [string, { leaseId: string }][];
    expect(first).toEqual({ ...request, leaseId: expect.stringMatching(/^lease-[0-9a-f-]+$/) });
    expect(second.leaseId).not.toBe(first.leaseId);

    release();
    release();
    await vi.waitFor(() => expect(invokedChannels()).toContain("local-tts:release-keep-warm"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(ipcInvoke.mock.calls.filter(([channel]) => channel === "local-tts:release-keep-warm"))
      .toEqual([["local-tts:release-keep-warm", { leaseId: first.leaseId }]]);
    other();
  });

  it("sends a release that overtakes its acquisition only after it", async () => {
    let acquire!: () => void;
    ipcInvoke.mockImplementationOnce(() => new Promise<void>((resolve) => { acquire = resolve; }));
    ipcInvoke.mockResolvedValue({ released: true });

    const release = exposed.localTts!.keepWarm(request);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(invokedChannels()).toEqual(["local-tts:keep-warm"]);

    acquire();
    await vi.waitFor(() => expect(invokedChannels()).toEqual(["local-tts:keep-warm", "local-tts:release-keep-warm"]));
  });

  it("releases nothing for a lease main refused, and warns instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ipcInvoke.mockRejectedValueOnce(new Error("Only Qwen3-TTS models can be kept warm."));

    const release = exposed.localTts!.keepWarm(request);
    release();
    await new Promise((resolve) => setImmediate(resolve));

    expect(invokedChannels()).toEqual(["local-tts:keep-warm"]);
    expect(warn).toHaveBeenCalledWith("Could not keep the local model warm:", expect.any(Error));
  });

  it("warns when a release fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ipcInvoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("shutting down"));

    exposed.localTts!.keepWarm(request)();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      "Could not release a local model keep-warm lease:",
      expect.any(Error),
    ));
  });

  it("hands eviction events to a subscriber until it unsubscribes", () => {
    const listener = vi.fn();
    const unsubscribe = exposed.localTts!.subscribeModelEvicted(listener);

    emitIpc("local-tts:model-evicted", { model: "qwen3", reason: "idle" });
    unsubscribe();

    expect(listener.mock.calls).toEqual([[{ model: "qwen3", reason: "idle" }]]);
    expect(ipcListeners.has("local-tts:model-evicted")).toBe(false);
  });
});

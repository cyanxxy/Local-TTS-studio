import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { EpubTransferAssembler, parseEpubTransferDescriptor } from "./epubTransfer";

type LocalModel = "neutts" | "qwen3";

interface LocalBridgeRequest {
  model: LocalModel;
  requestId: string;
  payload?: Record<string, unknown>;
  continuation?: {
    jobId: string;
    sectionIndex: number;
    sectionCount: number;
  };
}

interface CacheRequest {
  model: LocalModel;
}

interface CancelRequest extends CacheRequest {
  requestId: string;
}

const READER_AUDIO_STREAM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_READER_AUDIO_CHUNKS = 16_384;
const MAX_READER_AUDIO_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_READER_AUDIO_ENTRY_BYTES = 256 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AudioChunkListener = (event: unknown) => void;

interface GenerateOptions {
  /**
   * Receives this request's audio chunks, and only this request's. Without
   * it, the chunks go to every `subscribeAudioChunk` listener instead.
   */
  onAudioChunk?: AudioChunkListener;
}

interface LocalTtsAudioStream {
  onAudioChunk: AudioChunkListener | null;
  // Set by `cancel`: chunks still in flight are dropped from then on.
  stopped: boolean;
  end: () => void;
}

// The generations this window has running, by request id.
const localTtsAudioStreams = new Map<string, LocalTtsAudioStream>();
const audioChunkSubscribers = new Set<AudioChunkListener>();

// A listener bug must neither stop delivery to the others nor disappear: it
// surfaces as an uncaught error in the renderer's console instead.
function callListener(listener: AudioChunkListener, event: unknown): void {
  try {
    listener(event);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

// Main sends each chunk of a generation and then an end marker on this one
// channel, and Electron keeps a channel's messages in order. Seeing the end
// marker therefore means every chunk of that request has been handed out,
// however the invoke reply races the stream.
ipcRenderer.on("local-tts:audio-stream", (_event: IpcRendererEvent, message: unknown) => {
  if (!isRecord(message) || typeof message.requestId !== "string") return;
  const stream = localTtsAudioStreams.get(message.requestId);
  if (!stream) return;
  const { type, ...chunk } = message;
  if (type === "end") {
    stream.end();
    return;
  }
  if (type !== "chunk" || stream.stopped) return;
  if (stream.onAudioChunk) {
    callListener(stream.onAudioChunk, chunk);
    return;
  }
  for (const listener of [...audioChunkSubscribers]) callListener(listener, chunk);
});

async function generateLocalTts(request: LocalBridgeRequest, options?: GenerateOptions): Promise<unknown> {
  const requestId = isRecord(request) ? request.requestId : undefined;
  // Main rejects a request without a usable id before streaming anything.
  if (typeof requestId !== "string") return ipcRenderer.invoke("local-tts:generate", request);
  if (localTtsAudioStreams.has(requestId)) {
    throw new Error(`A local TTS request with id ${requestId} is already active.`);
  }
  const onAudioChunk = options?.onAudioChunk;
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  localTtsAudioStreams.set(requestId, {
    onAudioChunk: typeof onAudioChunk === "function" ? onAudioChunk : null,
    stopped: false,
    end,
  });
  try {
    const result: unknown = await ipcRenderer.invoke("local-tts:generate", request);
    // Main sends the end marker before it replies, so it is on its way.
    await ended;
    return result;
  } finally {
    localTtsAudioStreams.delete(requestId);
  }
}

function cancelLocalTts(request: CancelRequest): Promise<unknown> {
  // Stop delivery here at once: chunks already queued behind the cancel must
  // not reach a renderer that has moved on.
  const requestId = isRecord(request) ? request.requestId : undefined;
  const stream = typeof requestId === "string" ? localTtsAudioStreams.get(requestId) : undefined;
  if (stream) stream.stopped = true;
  return ipcRenderer.invoke("local-tts:cancel", request);
}

function saveReaderAudio(value: unknown): Promise<void> {
  if (!isRecord(value) || !Array.isArray(value.chunks) || value.chunks.length > MAX_READER_AUDIO_CHUNKS) {
    return Promise.reject(new TypeError("Cached Reader audio has an invalid chunk list."));
  }
  let totalBytes = 0;
  for (const [order, chunk] of value.chunks.entries()) {
    if (!isRecord(chunk) || !(chunk.audio instanceof ArrayBuffer)) {
      return Promise.reject(new TypeError(`Reader audio chunk ${order} must contain binary audio data.`));
    }
    if (chunk.audio.byteLength > MAX_READER_AUDIO_CHUNK_BYTES) {
      return Promise.reject(new TypeError(`Reader audio chunk ${order} exceeds the stream size limit.`));
    }
    totalBytes += chunk.audio.byteLength;
    if (totalBytes > MAX_READER_AUDIO_ENTRY_BYTES) {
      return Promise.reject(new TypeError("Cached Reader audio exceeds the stream size limit."));
    }
  }

  const { chunks, ...metadata } = value;
  return new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    let nextOrder = 0;

    const finish = (cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cause) {
        try {
          channel.port1.postMessage({ type: "cancel" });
        } catch {
          // The remote port may already have closed after reporting the error.
        }
      }
      channel.port1.close();
      if (cause) reject(cause instanceof Error ? cause : new Error(String(cause)));
      else resolve();
    };

    const sendNext = () => {
      if (nextOrder >= chunks.length) {
        channel.port1.postMessage({ type: "end" });
        return;
      }
      const chunk = chunks[nextOrder] as Record<string, unknown> & { audio: ArrayBuffer };
      const { audio: sourceAudio, ...chunkMetadata } = chunk;
      // Keep the renderer/player's immutable source buffer intact, but transfer
      // the one persistence copy through both MessagePort hops instead of
      // cloning that copy again.
      const audio = sourceAudio.slice(0);
      channel.port1.postMessage({
        type: "chunk",
        order: nextOrder,
        chunk: { ...chunkMetadata, audio },
      }, [audio]);
    };

    const timeout = setTimeout(() => {
      finish(new Error("Saving cached Reader audio timed out."));
    }, READER_AUDIO_STREAM_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!isRecord(message)) return;
      if (message.type === "result") {
        if (message.ok === true) finish();
        else finish(new Error(typeof message.error === "string" ? message.error : "Saving cached Reader audio failed."));
        return;
      }
      if (message.type === "ready") {
        sendNext();
        return;
      }
      if (message.type === "accepted" && message.order === nextOrder) {
        nextOrder += 1;
        sendNext();
      }
    };
    channel.port1.onmessageerror = () => finish(new Error("Cached Reader audio transfer failed."));
    channel.port1.start();
    try {
      ipcRenderer.postMessage("reader-library:save-audio-stream", {
        metadata,
        chunkCount: chunks.length,
      }, [channel.port2]);
    } catch (cause) {
      finish(cause);
    }
  });
}

function getReaderAudio(documentId: string, sectionId: string): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    let metadata: Record<string, unknown> | null = null;
    let chunkCount = 0;
    let totalBytes = 0;
    const chunks: unknown[] = [];

    const finish = (value?: unknown, cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cause) {
        try {
          channel.port1.postMessage({ type: "cancel" });
        } catch {
          // The remote port may already have closed after reporting the error.
        }
      }
      channel.port1.close();
      if (cause) reject(cause instanceof Error ? cause : new Error(String(cause)));
      else resolve(value ?? null);
    };

    const requestNext = () => {
      channel.port1.postMessage({ type: "next", order: chunks.length });
    };

    const timeout = setTimeout(() => {
      finish(undefined, new Error("Loading cached Reader audio timed out."));
    }, READER_AUDIO_STREAM_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!isRecord(message)) return;
      if (message.type === "result" && message.ok !== true) {
        finish(undefined, new Error(
          typeof message.error === "string" ? message.error : "Loading cached Reader audio failed.",
        ));
        return;
      }
      if (message.type === "header") {
        if (message.audio === null) {
          finish(null);
          return;
        }
        if (
          !isRecord(message.audio)
          || !Number.isInteger(message.chunkCount)
          || Number(message.chunkCount) < 0
          || Number(message.chunkCount) > MAX_READER_AUDIO_CHUNKS
        ) {
          finish(undefined, new Error("Cached Reader audio header is invalid."));
          return;
        }
        metadata = message.audio;
        chunkCount = Number(message.chunkCount);
        if (chunkCount === 0) finish({ ...metadata, chunks: [] });
        else requestNext();
        return;
      }
      if (
        message.type === "chunk"
        && message.order === chunks.length
        && isRecord(message.chunk)
        && message.chunk.audio instanceof ArrayBuffer
      ) {
        const audio = message.chunk.audio;
        if (audio.byteLength > MAX_READER_AUDIO_CHUNK_BYTES) {
          finish(undefined, new Error(`Reader audio chunk ${chunks.length} exceeds the stream size limit.`));
          return;
        }
        totalBytes += audio.byteLength;
        if (totalBytes > MAX_READER_AUDIO_ENTRY_BYTES) {
          finish(undefined, new Error("Cached Reader audio exceeds the stream size limit."));
          return;
        }
        chunks.push(message.chunk);
        if (chunks.length === chunkCount) finish({ ...metadata, chunks });
        else requestNext();
      }
    };
    channel.port1.onmessageerror = () => finish(undefined, new Error("Cached Reader audio transfer failed."));
    channel.port1.start();
    try {
      ipcRenderer.postMessage("reader-library:get-audio-stream", { documentId, sectionId }, [channel.port2]);
    } catch (cause) {
      finish(undefined, cause);
    }
  });
}

type RawDocumentImportResult =
  | { canceled: true }
  | {
      canceled: false;
      fileName: string;
      text: string;
      pageCount?: number;
      epubTransferId?: string;
      epubByteLength?: number;
    };

async function importDocument() {
  const result = await ipcRenderer.invoke("document:import") as RawDocumentImportResult;
  if (result.canceled) return result;
  const transfer = parseEpubTransferDescriptor(result.epubTransferId, result.epubByteLength);
  if (!transfer) return result;

  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const channel = new MessageChannel();
    const assembler = new EpubTransferAssembler(transfer.byteLength);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.port1.close();
      if (error) reject(error);
      else resolve(assembler.output);
    };
    const timeout = setTimeout(() => {
      finish(new Error("The EPUB transfer timed out. Import the file again."));
    }, 60_000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      try {
        if (assembler.accept(event.data)) finish();
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      }
    };
    channel.port1.start();
    try {
      ipcRenderer.postMessage("document:read-epub", { transferId: transfer.transferId }, [channel.port2]);
    } catch (cause) {
      finish(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });

  return {
    canceled: false as const,
    fileName: result.fileName,
    text: result.text,
    pageCount: result.pageCount,
    epubBytes: bytes,
  };
}

contextBridge.exposeInMainWorld("electron", {
  isElectron: true,
  platform: process.platform,
  arch: process.arch,
  readerLibrary: {
    listDocuments: () => ipcRenderer.invoke("reader-library:list-documents"),
    getDocument: (id: string) => ipcRenderer.invoke("reader-library:get-document", { id }),
    saveDocument: (document: unknown) => ipcRenderer.invoke("reader-library:save-document", { document }),
    deleteDocument: (id: string) => ipcRenderer.invoke("reader-library:delete-document", { id }),
    getActiveDocumentId: () => ipcRenderer.invoke("reader-library:get-active-document-id"),
    setActiveDocumentId: (id: string) => ipcRenderer.invoke("reader-library:set-active-document-id", { id }),
    saveAudio: saveReaderAudio,
    getAudio: getReaderAudio,
    deleteAudio: (documentId: string, sectionId?: string) => (
      ipcRenderer.invoke("reader-library:delete-audio", { documentId, sectionId })
    ),
    subscribeFlushRequests: (listener: () => Promise<void> | void) => {
      const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
        const token = isRecord(payload) ? payload.token : undefined;
        if (typeof token !== "string") return;
        // The quit is held until this acknowledgement, so answer even when the
        // flush itself fails; a lost write must not also strand the shutdown.
        const acknowledge = () => ipcRenderer.send("reader-library:flush-complete", { token });
        void Promise.resolve().then(listener).then(acknowledge, acknowledge);
      };
      ipcRenderer.on("reader-library:flush", wrapped);
      return () => {
        ipcRenderer.off("reader-library:flush", wrapped);
      };
    },
  },
  documents: {
    importDocument,
    importUrl: (url: string) => ipcRenderer.invoke("document:import-url", { url }),
  },
  localTts: {
    probe: (request: LocalBridgeRequest) => ipcRenderer.invoke("local-tts:probe", request),
    generate: generateLocalTts,
    warm: (request: { model: LocalModel; mode?: string; modelPath?: string; modelRepo?: string }) => (
      ipcRenderer.invoke("local-tts:warm", request)
    ),
    cancel: cancelLocalTts,
    getCacheInfo: (request: CacheRequest) => ipcRenderer.invoke("local-tts:cache-info", request),
    clearCache: (request: CacheRequest) => ipcRenderer.invoke("local-tts:clear-cache", request),
    getQwen3Setup: (request?: { modelRepo?: string }) => ipcRenderer.invoke("local-tts:qwen3-setup", request),
    downloadQwen3Model: (request: { modelRepo: string }) => (
      ipcRenderer.invoke("local-tts:download-qwen3-model", request)
    ),
    chooseQwen3ModelDir: (request: { modelRepo: string }) => (
      ipcRenderer.invoke("local-tts:choose-qwen3-model-dir", request)
    ),
    subscribeQwen3DownloadProgress: (listener: (event: unknown) => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("local-tts:qwen3-download-progress", wrapped);
      return () => {
        ipcRenderer.off("local-tts:qwen3-download-progress", wrapped);
      };
    },
    subscribeProgress: (listener: (event: unknown) => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("local-tts:progress", wrapped);
      return () => {
        ipcRenderer.off("local-tts:progress", wrapped);
      };
    },
    // Chunks of requests started without their own `onAudioChunk` listener.
    subscribeAudioChunk: (listener: AudioChunkListener) => {
      audioChunkSubscribers.add(listener);
      return () => {
        audioChunkSubscribers.delete(listener);
      };
    },
  },
  audio8: {
    load: (request: { requestId: string }) => ipcRenderer.invoke("audio8:load", request),
    generate: (request: { requestId: string; text: string; voice: string }) => (
      ipcRenderer.invoke("audio8:generate", request)
    ),
    cancel: (request: { requestId: string }) => ipcRenderer.invoke("audio8:cancel", request),
    getCacheInfo: () => ipcRenderer.invoke("audio8:cache-info"),
    clearCache: () => ipcRenderer.invoke("audio8:clear-cache"),
    subscribeProgress: (listener: (event: unknown) => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("audio8:progress", wrapped);
      return () => {
        ipcRenderer.off("audio8:progress", wrapped);
      };
    },
  },
});

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
  documents: {
    importDocument,
    importUrl: (url: string) => ipcRenderer.invoke("document:import-url", { url }),
  },
  localTts: {
    probe: (request: LocalBridgeRequest) => ipcRenderer.invoke("local-tts:probe", request),
    generate: (request: LocalBridgeRequest) => ipcRenderer.invoke("local-tts:generate", request),
    warm: (request: { model: LocalModel; mode?: string; modelPath?: string; modelRepo?: string }) => (
      ipcRenderer.invoke("local-tts:warm", request)
    ),
    cancel: (request: CancelRequest) => ipcRenderer.invoke("local-tts:cancel", request),
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
    subscribeAudioChunk: (listener: (event: unknown) => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("local-tts:audio-chunk", wrapped);
      return () => {
        ipcRenderer.off("local-tts:audio-chunk", wrapped);
      };
    },
  },
});

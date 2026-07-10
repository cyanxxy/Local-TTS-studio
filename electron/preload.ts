import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type LocalModel = "neutts" | "qwen3";

interface LocalBridgeRequest {
  model: LocalModel;
  requestId?: string;
  payload?: Record<string, unknown>;
}

interface CacheRequest {
  model: LocalModel;
}

interface CancelRequest extends CacheRequest {
  requestId: string;
}

contextBridge.exposeInMainWorld("electron", {
  isElectron: true,
  platform: process.platform,
  documents: {
    importDocument: () => ipcRenderer.invoke("document:import"),
  },
  localTts: {
    probe: (request: LocalBridgeRequest) => ipcRenderer.invoke("local-tts:probe", request),
    generate: (request: LocalBridgeRequest) => ipcRenderer.invoke("local-tts:generate", request),
    warm: (request: { model: LocalModel; mode?: string; modelPath?: string }) => (
      ipcRenderer.invoke("local-tts:warm", request)
    ),
    cancel: (request: CancelRequest) => ipcRenderer.invoke("local-tts:cancel", request),
    getCacheInfo: (request: CacheRequest) => ipcRenderer.invoke("local-tts:cache-info", request),
    clearCache: (request: CacheRequest) => ipcRenderer.invoke("local-tts:clear-cache", request),
    getQwen3Setup: (request?: { modelRepo?: string }) => ipcRenderer.invoke("local-tts:qwen3-setup", request),
    downloadQwen3Model: (request: { modelRepo: string }) => (
      ipcRenderer.invoke("local-tts:download-qwen3-model", request)
    ),
    chooseQwen3ModelDir: () => ipcRenderer.invoke("local-tts:choose-qwen3-model-dir"),
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

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
  localTts: {
    probe: (request: LocalBridgeRequest) => ipcRenderer.invoke("local-tts:probe", request),
    generate: (request: LocalBridgeRequest) => ipcRenderer.invoke("local-tts:generate", request),
    cancel: (request: CancelRequest) => ipcRenderer.invoke("local-tts:cancel", request),
    getCacheInfo: (request: CacheRequest) => ipcRenderer.invoke("local-tts:cache-info", request),
    clearCache: (request: CacheRequest) => ipcRenderer.invoke("local-tts:clear-cache", request),
    getQwen3MlxSetup: () => ipcRenderer.invoke("local-tts:qwen3-mlx-setup"),
    downloadQwen3MlxModel: (request: { modelRepo: string }) => (
      ipcRenderer.invoke("local-tts:download-qwen3-mlx-model", request)
    ),
    chooseQwen3MlxModelDir: () => ipcRenderer.invoke("local-tts:choose-qwen3-mlx-model-dir"),
    subscribeQwen3MlxDownloadProgress: (listener: (event: unknown) => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("local-tts:qwen3-mlx-download-progress", wrapped);
      return () => {
        ipcRenderer.off("local-tts:qwen3-mlx-download-progress", wrapped);
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

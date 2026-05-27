import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type LocalModel = "neutts" | "kani" | "qwen3";

interface LocalBridgeRequest {
  model: LocalModel;
  requestId?: string;
  pythonBinary?: string;
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
    subscribeProgress: (listener: (event: unknown) => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("local-tts:progress", wrapped);
      return () => {
        ipcRenderer.off("local-tts:progress", wrapped);
      };
    },
  },
});

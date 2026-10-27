import { BrowserWindow } from "electron";
import type { ShutdownParticipant } from "../appShutdown";
import { createLocalTtsRuntime, type LocalTtsRuntimeOptions } from "../localTts/localTtsRuntime";
import type { TrustedIpc } from "./trusted";

/**
 * Registers the `local-tts:*` channels for the Rust runtimes and returns their
 * part in the quit barrier.
 */
export function registerLocalTtsIpc(ipc: TrustedIpc, options: LocalTtsRuntimeOptions): ShutdownParticipant {
  const runtime = createLocalTtsRuntime({
    ...options,
    // Every window may be showing a model as warm, not only the one whose
    // request loaded it.
    onModelEvicted: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) window.webContents.send("local-tts:model-evicted", event);
      }
    },
  });

  ipc.handle("local-tts:probe", (event, request) => runtime.probe(request, event));
  ipc.handle("local-tts:generate", (event, request) => runtime.generate(request, event));
  ipc.handle("local-tts:warm", (event, request) => runtime.warm(request, event));
  ipc.handle("local-tts:keep-warm", (event, request) => runtime.keepWarm(request, event));
  ipc.handle("local-tts:release-keep-warm", (event, request) => runtime.releaseKeepWarm(request, event));
  ipc.handle("local-tts:cancel", (event, request) => runtime.cancel(request, event));
  ipc.handle("local-tts:cache-info", (_event, request) => runtime.cacheInfo(request));
  ipc.handle("local-tts:clear-cache", (_event, request) => runtime.clearCache(request));
  ipc.handle("local-tts:qwen3-setup", (_event, request) => runtime.qwen3Setup(request));
  ipc.handle("local-tts:download-qwen3-model", (event, request) => runtime.downloadQwen3Model(request, event));
  ipc.handle("local-tts:choose-qwen3-model-dir", (event, request) => runtime.chooseQwen3ModelDir(request, event));

  return runtime.shutdown;
}

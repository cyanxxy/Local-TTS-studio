/**
 * The renderer → main IPC surface. main.ts registers each channel through the
 * trusted helper in ./trusted.ts and preload.ts exposes each one;
 * ./contract.test.ts holds both sides to these lists, so a channel added on
 * one side only fails the suite instead of failing at runtime.
 */

/** Request/response channels (`ipcRenderer.invoke` → `ipcMain.handle`). */
export const IPC_INVOKE_CHANNELS = [
  "reader-library:list-documents",
  "reader-library:get-document",
  "reader-library:save-document",
  "reader-library:save-progress",
  "reader-library:delete-document",
  "reader-library:get-active-document-id",
  "reader-library:set-active-document-id",
  "reader-library:get-audio-signature",
  "reader-library:delete-audio",
  "document:import",
  "document:import-url",
  "local-tts:probe",
  "local-tts:generate",
  "local-tts:warm",
  "local-tts:keep-warm",
  "local-tts:release-keep-warm",
  "local-tts:cancel",
  "local-tts:cache-info",
  "local-tts:clear-cache",
  "local-tts:qwen3-setup",
  "local-tts:download-qwen3-model",
  "local-tts:choose-qwen3-model-dir",
  "audio8:load",
  "audio8:generate",
  "audio8:cancel",
  "audio8:cache-info",
  "audio8:clear-cache",
] as const;

/** Fire-and-forget messages (`ipcRenderer.send` → `ipcMain.on`). */
export const IPC_MESSAGE_CHANNELS = [
  "reader-library:flush-complete",
  "app:set-theme-source",
] as const;

/** Messages that transfer a MessagePort (`ipcRenderer.postMessage` → `ipcMain.on`). */
export const IPC_PORT_CHANNELS = [
  "reader-library:save-audio-stream",
  "reader-library:get-audio-stream",
  "document:read-epub",
] as const;

/** Events main pushes to renderers (`webContents.send` → `ipcRenderer.on`). */
export const RENDERER_EVENT_CHANNELS = [
  "reader-library:flush",
  "local-tts:progress",
  // Audio chunks of a generation, then its end marker, in one ordered stream.
  "local-tts:audio-stream",
  // A resident worker went away, and the model it had loaded with it.
  "local-tts:model-evicted",
  "local-tts:qwen3-download-progress",
  "audio8:progress",
] as const;

export type IpcInvokeChannel = typeof IPC_INVOKE_CHANNELS[number];
export type IpcMessageChannel = typeof IPC_MESSAGE_CHANNELS[number];
export type IpcPortChannel = typeof IPC_PORT_CHANNELS[number];
export type RendererEventChannel = typeof RENDERER_EVENT_CHANNELS[number];

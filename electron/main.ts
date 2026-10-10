import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { createShutdownCoordinator } from "./appShutdown";
import { createMainWindow, registerAppScheme, registerSessionSecurity } from "./appWindow";
import { configureApplicationMenu } from "./applicationMenu";
import { registerAudio8Ipc } from "./ipc/registerAudio8Ipc";
import { registerDocumentIpc } from "./ipc/registerDocumentIpc";
import { registerLocalTtsIpc } from "./ipc/registerLocalTtsIpc";
import { registerReaderLibraryIpc } from "./ipc/registerReaderLibraryIpc";
import { createTrustedIpc } from "./ipc/trusted";
import { RUST_CANCEL_KILL_AFTER_MS } from "./localTts/localTtsRuntime";

// The composition root: process-wide switches, the window, one registration
// per IPC feature and the quit barrier that joins them. Feature behaviour
// lives in the modules imported above.

const isDev = !app.isPackaged;
// The preload, the worker scripts and (in production) the renderer build are
// all resolved relative to the compiled main bundle.
const windowOptions = { isDev, appDirectory: __dirname };
const userDataPath = () => app.getPath("userData");

registerAppScheme();

// WebGPU powers all browser-native inference. Chromium still gates it behind this
// switch on Linux and on some blocklisted GPUs; Linux additionally needs Vulkan,
// which Electron does not enable on its own.
app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "Vulkan");
}

// Participants start in registration order. The Reader flush goes first and is
// bounded by its own shorter timeout, which this outer one caps; the extra
// 500 ms lets a SIGTERM-ignoring bridge child reach its SIGKILL escalation.
const shutdown = createShutdownCoordinator({
  timeoutMs: RUST_CANCEL_KILL_AFTER_MS + 500,
  quit: () => app.quit(),
});

app.whenReady().then(() => {
  configureApplicationMenu(process.platform, !isDev);
  registerSessionSecurity(windowOptions);
  createMainWindow(windowOptions);

  const ipc = createTrustedIpc(ipcMain, { allowDevServer: isDev });
  shutdown.register(registerReaderLibraryIpc(ipc, {
    workerPath: path.join(__dirname, "readerLibraryWorker.js"),
    databasePath: () => path.join(userDataPath(), "reader-library.sqlite3"),
  }));
  shutdown.register(registerDocumentIpc(ipc, {
    parseWorkerPath: path.join(__dirname, "documentParseWorker.js"),
  }));
  shutdown.register(registerLocalTtsIpc(ipc, {
    isDev,
    userDataPath,
    appPath: () => app.getAppPath(),
    resourcesPath: () => process.resourcesPath,
  }));
  shutdown.register(registerAudio8Ipc(ipc, { userDataPath }));
});

app.on("before-quit", (event) => shutdown.handleBeforeQuit(event));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // Re-create window on macOS dock click
    createMainWindow(windowOptions);
  }
});

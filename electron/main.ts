import { app, BrowserWindow, ipcMain } from "electron";
import os from "os";
import path from "path";
import { createShutdownCoordinator } from "./appShutdown";
import { createMainWindow, registerAppScheme, registerSessionSecurity, revealMainWindow } from "./appWindow";
import { configureApplicationMenu } from "./applicationMenu";
import { createDiagnosticsLog, mirrorToConsole } from "./diagnostics";
import { describeError } from "./errors";
import { createIpcDiagnostics } from "./ipc/ipcDiagnostics";
import { registerAudio8Ipc } from "./ipc/registerAudio8Ipc";
import { registerDocumentIpc } from "./ipc/registerDocumentIpc";
import { registerLocalTtsIpc } from "./ipc/registerLocalTtsIpc";
import { registerReaderLibraryIpc } from "./ipc/registerReaderLibraryIpc";
import { createTrustedIpc } from "./ipc/trusted";
import { RUST_CANCEL_KILL_AFTER_MS } from "./localTts/localTtsRuntime";

// The composition root: the single-instance lock, process-wide switches, the
// window, the diagnostics log, one registration per IPC feature and the quit
// barrier that joins them. Feature behaviour lives in the modules imported
// above.

// How long the final quit waits for the diagnostics log to reach the disk.
const DIAGNOSTICS_FLUSH_TIMEOUT_MS = 500;

const isDev = !app.isPackaged;
// The preload, the worker scripts and (in production) the renderer build are
// all resolved relative to the compiled main bundle.
const windowOptions = { isDev, appDirectory: __dirname };
const userDataPath = () => app.getPath("userData");

// A second copy would share userData with this one (the Reader library
// database, the model caches and the diagnostics log), so it hands its launch
// to the running app and exits before touching any of it.
if (app.requestSingleInstanceLock()) {
  start();
} else {
  app.exit(0);
}

function start(): void {
  const diagnostics = createDiagnosticsLog({
    directory: () => path.join(userDataPath(), "logs"),
    level: isDev ? "debug" : "info",
    mirror: mirrorToConsole,
    onWriteError: (error) => console.error("Could not write the diagnostics log:", error),
  });
  const appLog = diagnostics.logger("app");
  appLog.info("Started", {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    packaged: app.isPackaged,
  });

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
    // What the participants logged while the barrier held gets a bounded chance
    // to reach the disk before the process exits.
    quit: () => {
      void Promise.race([
        diagnostics.flush(),
        new Promise<void>((resolve) => { setTimeout(resolve, DIAGNOSTICS_FLUSH_TIMEOUT_MS); }),
      ]).then(() => app.quit());
    },
    onParticipantError: (name, error) => {
      diagnostics.logger("shutdown").error("A shutdown step failed", { participant: name, error: describeError(error) });
    },
  });

  app.whenReady().then(() => {
    configureApplicationMenu(process.platform, !isDev);
    registerSessionSecurity(windowOptions);
    createMainWindow(windowOptions);

    const ipc = createTrustedIpc(ipcMain, {
      allowDevServer: isDev,
      ...createIpcDiagnostics(diagnostics.logger("ipc")),
    });
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
      logger: diagnostics.logger("local-tts"),
    }));
    shutdown.register(registerAudio8Ipc(ipc, { userDataPath }));
    // Last, so the flush also covers what the participants above log as they stop.
    shutdown.register({
      name: "diagnostics",
      beginShutdown: () => (diagnostics.pending ? diagnostics.flush() : null),
    });
  }).catch((error: unknown) => {
    appLog.error("Startup failed", { error: describeError(error) });
  });

  app.on("before-quit", (event) => shutdown.handleBeforeQuit(event));

  // A crashed renderer or GPU process otherwise leaves no trace in the main
  // process, and WebGPU inference is what most often takes one down.
  app.on("render-process-gone", (_event, _contents, details) => {
    appLog.error("A renderer process is gone", { reason: details.reason, exitCode: details.exitCode });
  });
  app.on("child-process-gone", (_event, details) => {
    const entry = {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      ...(details.name ? { name: details.name } : {}),
      ...(details.serviceName ? { serviceName: details.serviceName } : {}),
    };
    if (details.reason === "clean-exit") appLog.info("A child process exited", entry);
    else appLog.error("A child process is gone", entry);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Neither opens a window once the quit has started: its renderer would only
  // meet IPC handlers that refuse new work.
  app.on("activate", () => {
    if (!shutdown.shuttingDown && BrowserWindow.getAllWindows().length === 0) {
      // Re-create window on macOS dock click
      createMainWindow(windowOptions);
    }
  });

  // Another launch while this copy runs: show the running window instead.
  app.on("second-instance", () => {
    if (!shutdown.shuttingDown) revealMainWindow(windowOptions);
  });
}

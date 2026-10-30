import { app, BrowserWindow, ipcMain } from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import { createShutdownCoordinator } from "./appShutdown";
import { createMainWindow, registerAppScheme, registerSessionSecurity, revealMainWindow } from "./appWindow";
import { configureApplicationMenu } from "./applicationMenu";
import { createDiagnosticsLog, mirrorToConsole } from "./diagnostics";
import { describeError } from "./errors";
import { createIpcDiagnostics } from "./ipc/ipcDiagnostics";
import { registerAppearanceIpc } from "./ipc/registerAppearanceIpc";
import { registerAudio8Ipc } from "./ipc/registerAudio8Ipc";
import { registerDocumentIpc } from "./ipc/registerDocumentIpc";
import { registerLocalTtsIpc } from "./ipc/registerLocalTtsIpc";
import { READER_LIBRARY_QUIT_BUDGET_MS, registerReaderLibraryIpc } from "./ipc/registerReaderLibraryIpc";
import { createTrustedIpc } from "./ipc/trusted";
import { RUST_CANCEL_KILL_AFTER_MS } from "./localTts/localTtsRuntime";
import { windowsLocalUserDataPath } from "./userDataLocation";

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

// Both before anything reads userData, the single-instance lock included.
if (process.platform === "win32") {
  const localUserData = windowsLocalUserDataPath(app.getPath("userData"), process.env, fs.existsSync);
  if (localUserData) app.setPath("userData", localUserData);
  // Matches the AppUserModelID the installer's shortcuts carry (electron-builder
  // derives it from `build.appId`), so taskbar pinning and grouping and the
  // media controls attribute the window to Open TTS.
  app.setAppUserModelId("com.opentts.desktop");
}

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

  // Participants start in registration order and then run side by side, each
  // bounded by its own timeout: the Reader flush and worker close, and a
  // SIGTERM-ignoring bridge child's SIGKILL escalation. The outer cap covers the
  // longer of the two, plus 500 ms for that last step to land, so it only ever
  // cuts short a participant whose own bound failed. The documents participant
  // carries a longer bound of its own on Windows (registerDocumentIpc).
  const shutdown = createShutdownCoordinator({
    timeoutMs: Math.max(READER_LIBRARY_QUIT_BUDGET_MS, RUST_CANCEL_KILL_AFTER_MS) + 500,
    // What the participants logged while the barrier held gets a bounded chance
    // to reach the disk before the process exits. The barrier still holds
    // meanwhile, so a second Cmd+Q cannot skip it.
    finish: () => Promise.race([
      diagnostics.flush(),
      new Promise<void>((resolve) => { setTimeout(resolve, DIAGNOSTICS_FLUSH_TIMEOUT_MS); }),
    ]),
    quit: () => app.quit(),
    onParticipantError: (name, error) => {
      diagnostics.logger("shutdown").error("A shutdown step failed", { participant: name, error: describeError(error) });
    },
  });

  app.whenReady().then(() => {
    // Both can open a window, and a BrowserWindow cannot be created before
    // `ready`; macOS can emit `activate` that early (a dock click during
    // launch). Neither is needed sooner: the first window is created below,
    // and registering them first lets a dock click retry if that one failed.
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
    registerAppearanceIpc(ipc);
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
}

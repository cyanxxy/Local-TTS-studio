import { app, BrowserWindow, session } from "electron";

const RESULT_PREFIX = "INFERENCE_SPEED_RESULT_JSON:";
const ERROR_PREFIX = "INFERENCE_SPEED_ERROR_JSON:";

function getArgValue(name, fallback = undefined) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const targetUrl = getArgValue("--target");
const timeoutMs = Number(getArgValue("--timeout-ms", "900000"));

if (!targetUrl) {
  console.error(`${ERROR_PREFIX}${JSON.stringify({ message: "Missing --target URL." })}`);
  process.exit(2);
}

app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "Vulkan");
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["http://127.0.0.1:*/*", "http://localhost:*/*"] },
    (details, callback) => {
      callback({
        cancel: false,
        responseHeaders: {
          ...(details.responseHeaders ?? {}),
          "Cross-Origin-Opener-Policy": ["same-origin"],
          "Cross-Origin-Embedder-Policy": ["require-corp"],
        },
      });
    },
  );

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  let completed = false;
  const finish = (code) => {
    if (completed) return;
    completed = true;
    app.exit(code);
  };

  const timeout = setTimeout(() => {
    console.error(`${ERROR_PREFIX}${JSON.stringify({ message: `Benchmark timed out after ${timeoutMs}ms.` })}`);
    finish(1);
  }, timeoutMs);

  win.webContents.on("console-message", (_event, _level, message) => {
    if (message.startsWith(RESULT_PREFIX)) {
      clearTimeout(timeout);
      console.log(message);
      finish(0);
      return;
    }

    if (message.startsWith(ERROR_PREFIX)) {
      clearTimeout(timeout);
      console.error(message);
      finish(1);
      return;
    }

    console.log(`[renderer] ${message}`);
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    clearTimeout(timeout);
    console.error(`${ERROR_PREFIX}${JSON.stringify({
      message: "Benchmark page failed to load.",
      errorCode,
      errorDescription,
      validatedUrl,
    })}`);
    finish(1);
  });

  await win.loadURL(targetUrl);
});

app.on("window-all-closed", () => {
  app.quit();
});

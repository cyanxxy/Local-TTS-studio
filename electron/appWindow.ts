import { app, BrowserWindow, net, protocol, session, shell } from "electron";
import path from "path";
import { pathToFileURL } from "url";
import { ELECTRON_APP_SCHEME, getElectronAppUrl, resolveElectronAppPath } from "./appProtocol";
import {
  buildContentSecurityPolicy,
  DEV_SERVER_URL,
  isAllowedAppUrl,
  isSafeExternalUrl,
  shouldGrantPermission,
} from "./security";

export interface AppWindowOptions {
  isDev: boolean;
  /**
   * Directory of the compiled main bundle (`dist-electron`). The preload script
   * and the production renderer build are resolved against it.
   */
  appDirectory: string;
}

/** Must run before `app` is ready: Chromium reads scheme privileges at startup. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ELECTRON_APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function createMainWindow({ isDev, appDirectory }: AppWindowOptions): BrowserWindow {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    title: "Open TTS",
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    // Transparent on macOS so the native vibrancy material shows through and
    // the translucent UI panels read as real Liquid Glass over the desktop.
    backgroundColor: isMac ? "#00000000" : "#f5f5f7",
    ...(isMac
      ? {
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
          titleBarStyle: "hiddenInset" as const,
        }
      : {}),
    webPreferences: {
      preload: path.join(appDirectory, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The playback clock, chunk scheduler, end-of-stream detection and Reader
      // auto-advance all run off requestAnimationFrame. Chromium throttles rAF
      // and timers hard once the window is hidden or occluded, which is exactly
      // what a listener does with a text-to-speech reader — so opt out.
      backgroundThrottling: false,
    },
  });

  const target = isDev ? `${DEV_SERVER_URL}/desktop/studio` : getElectronAppUrl("/studio");
  // loadURL rejects on a navigation abort (e.g. the window is closed mid-load);
  // attach a handler so it is logged rather than surfacing as an unhandled
  // rejection on the main process.
  win.loadURL(target).catch((err) => {
    console.error(`Failed to load ${target}:`, err);
  });
  return win;
}

/**
 * Brings the app to the front for another launch: restores and focuses the
 * existing window, or opens one when every window has been closed (macOS keeps
 * the app running without any).
 */
export function revealMainWindow(options: AppWindowOptions): void {
  const [window] = BrowserWindow.getAllWindows();
  if (!window) {
    createMainWindow(options);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * Wires the session-wide security policy: the production `app://` protocol,
 * response headers (COOP/COEP and the CSP), navigation and window-open
 * handling, and the deny-by-default permission gates.
 */
export function registerSessionSecurity({ isDev, appDirectory }: AppWindowOptions): void {
  registerProductionAppProtocol(isDev, appDirectory);
  registerRendererSecurityHeaders(isDev);
  registerNavigationSecurityHandlers(isDev);
  registerPermissionHandlers(isDev);
}

function registerRendererSecurityHeaders(isDev: boolean): void {
  session.defaultSession.webRequest.onHeadersReceived(
    {
      urls: [`${ELECTRON_APP_SCHEME}://*/*`, `${DEV_SERVER_URL}/*`],
    },
    (details, callback) => {
      const isHtmlDocument = details.resourceType === "mainFrame";
      const responseHeaders = {
        ...(details.responseHeaders ?? {}),
        "Cross-Origin-Opener-Policy": ["same-origin"],
        "Cross-Origin-Embedder-Policy": ["require-corp"],
        ...(isHtmlDocument
          ? { "Content-Security-Policy": [buildContentSecurityPolicy(isDev)] }
          : {}),
      };

      callback({ cancel: false, responseHeaders });
    },
  );
}

function registerProductionAppProtocol(isDev: boolean, appDirectory: string): void {
  if (isDev) return;

  const distDir = path.join(appDirectory, "../dist");
  protocol.handle(ELECTRON_APP_SCHEME, (request) => {
    try {
      const resolvedPath = resolveElectronAppPath(distDir, request.url);
      return net.fetch(pathToFileURL(resolvedPath).toString());
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
  });
}

function registerNavigationSecurityHandlers(isDev: boolean): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, navigationUrl) => {
      if (isAllowedAppUrl(navigationUrl, { allowDevServer: isDev })) return;

      event.preventDefault();
      if (isSafeExternalUrl(navigationUrl)) {
        void shell.openExternal(navigationUrl);
      }
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url);
      }

      return { action: "deny" };
    });

    // The app never uses <webview>, so block attachment outright (security
    // checklist item 12: a webview can be created by page script even when
    // the embedder itself never renders one).
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });
}

function registerPermissionHandlers(isDev: boolean): void {
  // Deny every permission across all three gates: the async request flow, the
  // synchronous check flow (navigator.permissions.query, capability checks),
  // and device selection (WebUSB/Serial/HID). The Electron security checklist
  // requires wiring all of them, not just the request handler, so synchronous
  // checks don't fall through to permissive built-in defaults.
  // Only microphone capture from the app's own pages is granted (see
  // shouldGrantPermission); the dev server counts as the app in dev only.
  const trust = { allowDevServer: isDev };
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const request = details as { requestingUrl?: string; mediaTypes?: string[] } | undefined;
    callback(
      shouldGrantPermission(
        { permission, requestingUrl: request?.requestingUrl, mediaTypes: request?.mediaTypes ?? [] },
        trust,
      ),
    );
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const check = details as { requestingUrl?: string; mediaType?: string } | undefined;
    return shouldGrantPermission(
      { permission, requestingUrl: check?.requestingUrl ?? requestingOrigin, mediaType: check?.mediaType },
      trust,
    );
  });
  session.defaultSession.setDevicePermissionHandler(() => false);
}

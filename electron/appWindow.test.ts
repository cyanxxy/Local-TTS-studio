// @vitest-environment node

import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMainWindow, registerAppScheme, registerSessionSecurity, revealMainWindow } from "./appWindow";

type Listener = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => ({
  windowOptions: [] as Array<Record<string, unknown>>,
  loadedUrls: [] as string[],
  loadResult: Promise.resolve() as Promise<void>,
  appListeners: new Map<string, Listener>(),
  protocolHandlers: new Map<string, (request: { url: string }) => unknown>(),
  headerListener: null as null | ((details: Record<string, unknown>, callback: (response: unknown) => void) => void),
  permissionRequest: null as null | ((webContents: unknown, permission: string, callback: (granted: boolean) => void, details?: unknown) => void),
  permissionCheck: null as null | ((...args: unknown[]) => boolean),
  devicePermission: null as null | (() => boolean),
  openExternal: vi.fn(),
  netFetch: vi.fn((url: string) => ({ fetched: url })),
  registerSchemes: vi.fn(),
  openWindows: [] as unknown[],
  createdWindows: [] as Array<{ listeners: Map<string, Listener>; show: ReturnType<typeof vi.fn> }>,
  destroyed: false,
  shouldUseDarkColors: false,
}));

vi.mock("electron", () => ({
  app: {
    on: (channel: string, listener: Listener) => {
      mocks.appListeners.set(channel, listener);
    },
  },
  BrowserWindow: class {
    static getAllWindows = () => mocks.openWindows;

    readonly listeners = new Map<string, Listener>();
    readonly show = vi.fn();

    constructor(options: Record<string, unknown>) {
      mocks.windowOptions.push(options);
      mocks.createdWindows.push(this);
    }

    once(channel: string, listener: Listener) {
      this.listeners.set(channel, listener);
    }

    isDestroyed() {
      return mocks.destroyed;
    }

    isVisible() {
      return this.show.mock.calls.length > 0;
    }

    loadURL(url: string) {
      mocks.loadedUrls.push(url);
      return mocks.loadResult;
    }
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return mocks.shouldUseDarkColors;
    },
  },
  net: { fetch: mocks.netFetch },
  protocol: {
    registerSchemesAsPrivileged: mocks.registerSchemes,
    handle: (scheme: string, handler: (request: { url: string }) => unknown) => {
      mocks.protocolHandlers.set(scheme, handler);
    },
  },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: (_filter: unknown, listener: typeof mocks.headerListener) => {
          mocks.headerListener = listener;
        },
      },
      setPermissionRequestHandler: (handler: typeof mocks.permissionRequest) => {
        mocks.permissionRequest = handler;
      },
      setPermissionCheckHandler: (handler: typeof mocks.permissionCheck) => {
        mocks.permissionCheck = handler;
      },
      setDevicePermissionHandler: (handler: typeof mocks.devicePermission) => {
        mocks.devicePermission = handler;
      },
    },
  },
  shell: { openExternal: mocks.openExternal },
}));

const APP_DIRECTORY = path.join(path.sep, "opt", "open-tts", "dist-electron");

class FakeWebContents {
  readonly listeners = new Map<string, Listener>();
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;

  on(channel: string, listener: Listener) {
    this.listeners.set(channel, listener);
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
    this.windowOpenHandler = handler;
  }
}

function attachWebContents(): FakeWebContents {
  const contents = new FakeWebContents();
  mocks.appListeners.get("web-contents-created")?.({}, contents);
  return contents;
}

beforeEach(() => {
  mocks.windowOptions.length = 0;
  mocks.loadedUrls.length = 0;
  mocks.loadResult = Promise.resolve();
  mocks.appListeners.clear();
  mocks.protocolHandlers.clear();
  mocks.headerListener = null;
  mocks.openExternal.mockClear();
  mocks.netFetch.mockClear();
  mocks.registerSchemes.mockClear();
  mocks.openWindows = [];
  mocks.createdWindows.length = 0;
  mocks.destroyed = false;
  mocks.shouldUseDarkColors = false;
});

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

function fakeOpenWindow(minimized: boolean) {
  return {
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe("main window", () => {
  it("isolates the renderer and resolves the preload next to the main bundle", () => {
    createMainWindow({ isDev: false, appDirectory: APP_DIRECTORY });

    expect(mocks.windowOptions[0].webPreferences).toEqual({
      preload: path.join(APP_DIRECTORY, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    });
    expect(mocks.loadedUrls).toEqual(["app://-/desktop/studio"]);
  });

  it("loads the dev server route in development", () => {
    createMainWindow({ isDev: true, appDirectory: APP_DIRECTORY });

    expect(mocks.loadedUrls).toEqual(["http://localhost:5173/desktop/studio"]);
  });

  it("logs a failed renderer load instead of leaving the rejection unhandled", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.loadResult = Promise.reject(new Error("ERR_ABORTED"));

    createMainWindow({ isDev: false, appDirectory: APP_DIRECTORY });
    await new Promise((resolve) => setImmediate(resolve));

    expect(error).toHaveBeenCalledWith("Failed to load app://-/desktop/studio:", expect.any(Error));
    // Still shown: a hidden window could be neither seen nor closed.
    expect(mocks.createdWindows[0].show).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("keeps the window hidden until the page has painted", () => {
    createMainWindow({ isDev: false, appDirectory: APP_DIRECTORY });
    const [window] = mocks.createdWindows;

    expect(mocks.windowOptions[0].show).toBe(false);
    expect(window.show).not.toHaveBeenCalled();
    window.listeners.get("ready-to-show")!();
    expect(window.show).toHaveBeenCalledTimes(1);
  });

  it.each([
    { platform: "win32", dark: true, color: "#101114" },
    { platform: "linux", dark: true, color: "#101114" },
    { platform: "win32", dark: false, color: "#f5f5f7" },
    { platform: "darwin", dark: true, color: "#00000000" },
  ] as const)("paints a $platform window ($color) for dark mode $dark before the page does", ({ platform, dark, color }) => {
    mocks.shouldUseDarkColors = dark;

    withPlatform(platform, () => createMainWindow({ isDev: false, appDirectory: APP_DIRECTORY }));

    // macOS stays transparent for the vibrancy material.
    expect(mocks.windowOptions[0].backgroundColor).toBe(color);
  });

  it("restores and focuses the open window for another launch", () => {
    const window = fakeOpenWindow(true);
    mocks.openWindows = [window];

    revealMainWindow({ isDev: false, appDirectory: APP_DIRECTORY });

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(mocks.windowOptions).toHaveLength(0);
  });

  it("focuses a visible window without restoring it", () => {
    const window = fakeOpenWindow(false);
    mocks.openWindows = [window];

    revealMainWindow({ isDev: false, appDirectory: APP_DIRECTORY });

    expect(window.restore).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("opens a window for another launch when none is left", () => {
    revealMainWindow({ isDev: false, appDirectory: APP_DIRECTORY });

    expect(mocks.windowOptions).toHaveLength(1);
    expect(mocks.loadedUrls).toEqual(["app://-/desktop/studio"]);
  });

  it("registers the app scheme as a privileged standard scheme", () => {
    registerAppScheme();

    expect(mocks.registerSchemes).toHaveBeenCalledWith([{
      scheme: "app",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    }]);
  });
});

describe("session security", () => {
  it("serves the production renderer from the dist directory beside the main bundle", () => {
    registerSessionSecurity({ isDev: false, appDirectory: APP_DIRECTORY });
    const handler = mocks.protocolHandlers.get("app")!;

    expect(handler({ url: "app://-/desktop/studio" })).toEqual({
      fetched: expect.stringContaining("/opt/open-tts/dist/"),
    });
    // Any host other than the app's own is refused rather than resolved.
    const forbidden = handler({ url: "app://evil.example/desktop/studio" }) as Response;
    expect(forbidden.status).toBe(403);
  });

  it("leaves the app protocol to the dev server in development", () => {
    registerSessionSecurity({ isDev: true, appDirectory: APP_DIRECTORY });

    expect(mocks.protocolHandlers.size).toBe(0);
  });

  it("adds cross-origin isolation to every response and the CSP to documents only", () => {
    registerSessionSecurity({ isDev: false, appDirectory: APP_DIRECTORY });
    const respond = vi.fn();

    mocks.headerListener!({ resourceType: "mainFrame", responseHeaders: { "X-Test": ["1"] } }, respond);
    mocks.headerListener!({ resourceType: "script" }, respond);

    const [[document], [script]] = respond.mock.calls as Array<[{ responseHeaders: Record<string, string[]> }]>;
    expect(document.responseHeaders).toMatchObject({
      "X-Test": ["1"],
      "Cross-Origin-Opener-Policy": ["same-origin"],
      "Cross-Origin-Embedder-Policy": ["require-corp"],
    });
    expect(document.responseHeaders["Content-Security-Policy"][0]).toContain("default-src 'self'");
    expect(script.responseHeaders).not.toHaveProperty("Content-Security-Policy");
  });

  it("keeps navigation inside the app and only opens allow-listed external links", () => {
    registerSessionSecurity({ isDev: false, appDirectory: APP_DIRECTORY });
    const contents = attachWebContents();
    const navigate = contents.listeners.get("will-navigate")!;

    // Electron 45 passes the URL on the event; the positional one is deprecated.
    const navigation = (url: string) => ({ url, preventDefault: vi.fn() });
    const internal = navigation("app://-/reader");
    navigate(internal);
    expect(internal.preventDefault).not.toHaveBeenCalled();

    const external = navigation("https://github.com/cyanxxy/Local-TTS-studio");
    navigate(external);
    expect(external.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).toHaveBeenCalledWith("https://github.com/cyanxxy/Local-TTS-studio");

    const hostile = navigation("https://example.com/phish");
    navigate(hostile);
    expect(hostile.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);

    // The dev server is not an app origin once packaged.
    const devServer = navigation("http://localhost:5173/desktop/studio");
    navigate(devServer);
    expect(devServer.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("denies every new window and blocks webview attachment", () => {
    registerSessionSecurity({ isDev: false, appDirectory: APP_DIRECTORY });
    const contents = attachWebContents();

    expect(contents.windowOpenHandler!({ url: "https://huggingface.co/x" })).toEqual({ action: "deny" });
    expect(mocks.openExternal).toHaveBeenCalledWith("https://huggingface.co/x");
    expect(contents.windowOpenHandler!({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);

    const attach = { preventDefault: vi.fn() };
    contents.listeners.get("will-attach-webview")!(attach);
    expect(attach.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("grants only audio-only microphone requests from trusted app URLs", () => {
    registerSessionSecurity({ isDev: false, appDirectory: APP_DIRECTORY });
    const ask = (permission: string, details: unknown) => {
      const callback = vi.fn();
      mocks.permissionRequest!({}, permission, callback, details);
      return callback.mock.calls[0][0];
    };
    const app = "app://-/studio";

    expect(ask("media", { requestingUrl: app, mediaTypes: ["audio"] })).toBe(true);
    expect(ask("media", { requestingUrl: app, mediaTypes: ["video"] })).toBe(false);
    expect(ask("media", { requestingUrl: app, mediaTypes: ["audio", "video"] })).toBe(false);
    expect(ask("media", { requestingUrl: app })).toBe(false);
    expect(ask("media", { requestingUrl: "https://evil.example/", mediaTypes: ["audio"] })).toBe(false);
    expect(ask("media", { requestingUrl: "http://localhost:5173/", mediaTypes: ["audio"] })).toBe(false);
    expect(ask("geolocation", { requestingUrl: app })).toBe(false);
    expect(ask("notifications", { requestingUrl: app, mediaTypes: ["audio"] })).toBe(false);
  });

  it("answers permission checks with the same audio-only policy and denies devices", () => {
    registerSessionSecurity({ isDev: false, appDirectory: APP_DIRECTORY });
    const check = (permission: string, origin: string, details: unknown) =>
      (mocks.permissionCheck as unknown as (...args: unknown[]) => boolean)({}, permission, origin, details);

    expect(check("media", "app://-", { requestingUrl: "app://-/", mediaType: "audio" })).toBe(true);
    expect(check("media", "app://-", { requestingUrl: "app://-/", mediaType: "video" })).toBe(false);
    expect(check("media", "app://-", { requestingUrl: "app://-/", mediaType: "unknown" })).toBe(false);
    expect(check("media", "https://evil.example", { requestingUrl: "https://evil.example/", mediaType: "audio" })).toBe(false);
    expect(check("clipboard-read", "app://-", { requestingUrl: "app://-/" })).toBe(false);
    expect(mocks.devicePermission!()).toBe(false);
  });

  it("trusts the dev server for microphone capture only in dev", () => {
    registerSessionSecurity({ isDev: true, appDirectory: APP_DIRECTORY });
    const callback = vi.fn();
    mocks.permissionRequest!({}, "media", callback, { requestingUrl: "http://localhost:5173/", mediaTypes: ["audio"] });
    expect(callback).toHaveBeenCalledWith(true);
  });
});

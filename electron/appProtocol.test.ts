// @vitest-environment node

import path from "path";
import { describe, expect, it } from "vitest";
import { getElectronAppUrl, resolveElectronAppPath } from "./appProtocol";

const DIST_DIR = path.join("/tmp", "open-tts-dist");

describe("appProtocol", () => {
  it("builds production app URLs with clean routes", () => {
    expect(getElectronAppUrl()).toBe("app://-/desktop/studio");
    expect(getElectronAppUrl("/reader")).toBe("app://-/desktop/reader");
    expect(getElectronAppUrl("qwen3")).toBe("app://-/desktop/qwen3");
    expect(getElectronAppUrl("/desktop/qwen3")).toBe("app://-/desktop/qwen3");
  });

  it("falls back web route requests to index.html", () => {
    expect(resolveElectronAppPath(DIST_DIR, "app://-/")).toBe(path.join(DIST_DIR, "index.html"));
    expect(resolveElectronAppPath(DIST_DIR, "app://-/studio")).toBe(path.join(DIST_DIR, "index.html"));
    expect(resolveElectronAppPath(DIST_DIR, "app://-/reader?profile=1")).toBe(path.join(DIST_DIR, "index.html"));
    expect(resolveElectronAppPath(DIST_DIR, "app://-/neutts")).toBe(path.join(DIST_DIR, "index.html"));
  });

  it("falls back desktop route requests to desktop.html", () => {
    expect(resolveElectronAppPath(DIST_DIR, "app://-/desktop")).toBe(path.join(DIST_DIR, "desktop.html"));
    expect(resolveElectronAppPath(DIST_DIR, "app://-/desktop/studio")).toBe(path.join(DIST_DIR, "desktop.html"));
    expect(resolveElectronAppPath(DIST_DIR, "app://-/desktop/neutts?profile=1")).toBe(
      path.join(DIST_DIR, "desktop.html"),
    );
  });

  it("serves built asset files from dist", () => {
    expect(resolveElectronAppPath(DIST_DIR, "app://-/assets/index.js")).toBe(
      path.join(DIST_DIR, "assets", "index.js"),
    );
    expect(resolveElectronAppPath(DIST_DIR, "app://-/assets/model.wasm")).toBe(
      path.join(DIST_DIR, "assets", "model.wasm"),
    );
  });

  it("rejects app protocol requests for unexpected hosts", () => {
    expect(() => resolveElectronAppPath(DIST_DIR, "app://evil/studio")).toThrow("Unsupported app protocol");
    expect(() => resolveElectronAppPath(DIST_DIR, "https://example.com/studio")).toThrow("Unsupported app protocol");
  });
});

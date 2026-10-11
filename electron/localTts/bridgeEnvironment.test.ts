// @vitest-environment node

import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRustBridgeEnv, createBridgeEnvironment, shouldForwardRustBridgeEnv } from "./bridgeEnvironment";

const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", hostPlatform);
});

describe("bridge environment forwarding", () => {
  it.each(["PATH", "HOME", "LANG", "TMPDIR", "SystemRoot", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "CUDA_VISIBLE_DEVICES",
    "TTS_HOME", "OPEN_TTS_NEUCODEC_ENCODER"])("forwards %s", (key) => {
    expect(shouldForwardRustBridgeEnv(key)).toBe(true);
  });

  it.each(["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "OPEN_TTS_WS_AUTH_TOKEN",
    "AWS_SECRET_ACCESS_KEY", "path"])("withholds %s", (key) => {
    expect(shouldForwardRustBridgeEnv(key)).toBe(false);
  });

  it("forwards only the allow-list and pins the Hugging Face caches inside the model cache", () => {
    const cacheDir = path.join(path.sep, "cache", "qwen3");
    const env = buildRustBridgeEnv(cacheDir, {
      PATH: "/usr/bin",
      HF_HOME: "/elsewhere",
      NODE_OPTIONS: "--inspect",
      UNSET: undefined,
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HF_HOME: path.join(cacheDir, "huggingface"),
      HF_HUB_CACHE: path.join(cacheDir, "huggingface", "hub"),
      HUGGINGFACE_HUB_CACHE: path.join(cacheDir, "huggingface", "hub"),
    });
  });
});

describe("createBridgeEnvironment", () => {
  const options = {
    userDataPath: () => path.join(path.sep, "user"),
    appPath: () => path.join(path.sep, "repo"),
    resourcesPath: () => path.join(path.sep, "bundle", "Resources"),
  };

  it("keeps one cache directory per local model under userData", () => {
    const environment = createBridgeEnvironment({ ...options, isDev: false });

    expect(environment.cacheDir("qwen3")).toBe(path.join(path.sep, "user", "local-model-cache", "qwen3"));
    expect(environment.cacheDir("neutts")).toBe(path.join(path.sep, "user", "local-model-cache", "neutts"));
  });

  it("runs the packaged binaries from the resources directory", () => {
    Object.defineProperty(process, "platform", { ...hostPlatform, value: "darwin" });
    const environment = createBridgeEnvironment({ ...options, isDev: false });

    expect(environment.bridgeBinaryPath())
      .toBe(path.join(path.sep, "bundle", "Resources", "dist-rust", "open-tts-local-bridge"));
    expect(environment.hfXetDownloaderBinaryPath())
      .toBe(path.join(path.sep, "bundle", "Resources", "dist-rust", "open-tts-hf-xet-downloader"));
  });

  it("runs development builds from the app checkout with Windows executable names", () => {
    Object.defineProperty(process, "platform", { ...hostPlatform, value: "win32" });
    const environment = createBridgeEnvironment({ ...options, isDev: true });

    expect(environment.bridgeBinaryPath()).toBe(path.join(path.sep, "repo", "dist-rust", "open-tts-local-bridge.exe"));
    expect(environment.hfXetDownloaderBinaryPath())
      .toBe(path.join(path.sep, "repo", "dist-rust", "open-tts-hf-xet-downloader.exe"));
  });
});

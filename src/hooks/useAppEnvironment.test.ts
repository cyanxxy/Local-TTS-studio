import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  getWebGPUStatus: vi.fn(),
  getLocalBrowserSupport: vi.fn(),
}));

vi.mock("../lib/webgpu", () => ({ getWebGPUStatus: mock.getWebGPUStatus }));
vi.mock("../lib/browserSupport", () => ({ getLocalBrowserSupport: mock.getLocalBrowserSupport }));

import { useAppEnvironment } from "./useAppEnvironment";

const supported = { isSupported: true, message: null, supportedModels: ["kokoro"], unsupportedModelMessages: {} };

function setElectron(value: unknown) {
  Object.defineProperty(window, "electron", { value, configurable: true, writable: true });
}

describe("useAppEnvironment", () => {
  beforeEach(() => {
    mock.getWebGPUStatus.mockResolvedValue({ available: true, message: null });
    mock.getLocalBrowserSupport.mockReturnValue(supported);
    setElectron(undefined);
  });
  afterEach(() => {
    setElectron(undefined);
    document.documentElement.classList.remove("is-electron", "is-mac");
    vi.clearAllMocks();
  });

  it("needs both the opted-in entry point and a live preload bridge for desktop runtimes", () => {
    expect(renderHook(() => useAppEnvironment(true)).result.current).toMatchObject({
      isElectronRuntime: false,
      desktopRuntimesAvailable: false,
    });

    setElectron({ isElectron: true });
    expect(renderHook(() => useAppEnvironment(false)).result.current).toMatchObject({
      isElectronRuntime: true,
      desktopRuntimesAvailable: false,
    });
    expect(renderHook(() => useAppEnvironment(true)).result.current).toMatchObject({
      isElectronRuntime: true,
      desktopRuntimesAvailable: true,
    });
    expect(mock.getLocalBrowserSupport).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it("marks the document for the Electron shell", () => {
    setElectron({ isElectron: true });
    renderHook(() => useAppEnvironment(true));
    expect(document.documentElement.classList.contains("is-electron")).toBe(true);
  });

  it("probes WebGPU once local inference is supported", async () => {
    const { result } = renderHook(() => useAppEnvironment(false));
    expect(result.current.webgpuStatus).toBeNull();
    await waitFor(() => expect(result.current.webgpuStatus).toEqual({ available: true, message: null }));
  });

  it("never probes WebGPU where local inference is unsupported", async () => {
    mock.getLocalBrowserSupport.mockReturnValue({ ...supported, isSupported: false });
    const { result } = renderHook(() => useAppEnvironment(false));
    await Promise.resolve();
    expect(mock.getWebGPUStatus).not.toHaveBeenCalled();
    expect(result.current.webgpuStatus).toBeNull();
  });

  it("ignores a probe that finishes after the app is gone", async () => {
    let resolve!: (status: unknown) => void;
    mock.getWebGPUStatus.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useAppEnvironment(false));
    unmount();
    resolve({ available: false, message: "late" });
    await Promise.resolve();
    expect(result.current.webgpuStatus).toBeNull();
  });

  it("profiles model loads only for ?profile=1 in a development build", () => {
    expect(renderHook(() => useAppEnvironment(false)).result.current.debugProfiling).toBe(false);
    window.history.replaceState(null, "", "/?profile=1");
    try {
      expect(renderHook(() => useAppEnvironment(false)).result.current.debugProfiling).toBe(import.meta.env.DEV);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});

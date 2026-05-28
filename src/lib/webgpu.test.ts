import { afterEach, describe, expect, it, vi } from "vitest";

const originalNavigator = globalThis.navigator;

function setNavigator(value: unknown) {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
  });
}

describe("webgpu", () => {
  afterEach(() => {
    vi.resetModules();
    setNavigator(originalNavigator);
  });

  it("treats fallback adapters as unavailable acceleration", async () => {
    const requestDevice = vi.fn(async () => ({
      destroy: vi.fn(),
      lost: new Promise(() => undefined),
    }));
    setNavigator({
      gpu: {
        requestAdapter: vi.fn(async () => ({
          info: { isFallbackAdapter: true },
          requestDevice,
        })),
      },
    });

    const module = await import("./webgpu");
    const status = await module.getWebGPUStatus();

    expect(status).toEqual({
      available: false,
      reason: "fallback-adapter",
      message: "A software WebGPU adapter was detected, so the app will run on CPU instead.",
    });
    expect(requestDevice).not.toHaveBeenCalled();
    await expect(module.canInitializeWebGPU()).resolves.toBe(false);
  });

  it("rejects devices that are lost during initialization", async () => {
    const destroy = vi.fn();
    setNavigator({
      gpu: {
        requestAdapter: vi.fn(async () => ({
          info: { isFallbackAdapter: false },
          requestDevice: vi.fn(async () => ({
            destroy,
            lost: Promise.resolve({ reason: "unknown", message: "Lost on startup" }),
          })),
        })),
      },
    });

    const module = await import("./webgpu");
    const status = await module.getWebGPUStatus();

    expect(status).toEqual({
      available: false,
      reason: "device-lost",
      message: "The WebGPU device was lost during initialization.",
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("accepts hardware adapters with a healthy device", async () => {
    const destroy = vi.fn();
    setNavigator({
      gpu: {
        requestAdapter: vi.fn(async () => ({
          info: { isFallbackAdapter: false },
          requestDevice: vi.fn(async () => ({
            destroy,
            lost: new Promise(() => undefined),
          })),
        })),
      },
    });

    const module = await import("./webgpu");
    const status = await module.getWebGPUStatus();

    expect(status).toEqual({
      available: true,
      reason: null,
      message: null,
    });
    expect(destroy).toHaveBeenCalledOnce();
    await expect(module.canInitializeWebGPU()).resolves.toBe(true);
  });
});

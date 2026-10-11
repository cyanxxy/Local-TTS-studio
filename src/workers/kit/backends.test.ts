import { afterEach, describe, expect, it, vi } from "vitest";
import type { InferenceBackend } from "../../types";
import {
  BackendIndependentLoadError,
  loadWithBackendFallback,
  withLoadWatchdog,
  type LoadWatchdog,
} from "./backends";

interface FakeModel {
  backend: InferenceBackend;
}

function fallbackOptions(overrides: Partial<Parameters<typeof loadWithBackendFallback<FakeModel>>[0]> = {}) {
  return {
    backends: ["webgpu", "wasm"] as const,
    load: vi.fn(async (backend: InferenceBackend) => ({ backend })),
    dispose: vi.fn(async () => undefined),
    onFallback: vi.fn(),
    failureMessage: "Failed to load the fake model",
    probeWebGPU: vi.fn(async () => true),
    ...overrides,
  };
}

describe("loadWithBackendFallback", () => {
  it("returns the first backend that loads and warms up", async () => {
    const options = fallbackOptions({ warmUp: vi.fn(async () => undefined) });

    await expect(loadWithBackendFallback(options)).resolves.toEqual({
      instance: { backend: "webgpu" },
      backend: "webgpu",
    });
    expect(options.load).toHaveBeenCalledOnce();
    expect(options.onFallback).not.toHaveBeenCalled();
  });

  it("skips WebGPU without a fallback reset when the device probe fails", async () => {
    const options = fallbackOptions({ probeWebGPU: vi.fn(async () => false) });

    await expect(loadWithBackendFallback(options)).resolves.toMatchObject({ backend: "wasm" });
    expect(options.load).toHaveBeenCalledExactlyOnceWith("wasm");
    // Nothing was loaded, so there is no progress to reset.
    expect(options.onFallback).not.toHaveBeenCalled();
  });

  it("reports an unavailable or broken WebGPU device when it was the only backend", async () => {
    await expect(loadWithBackendFallback(fallbackOptions({
      backends: ["webgpu"],
      probeWebGPU: vi.fn(async () => false),
    }))).rejects.toThrow("WebGPU device initialization failed.");
    await expect(loadWithBackendFallback(fallbackOptions({
      backends: ["webgpu"],
      probeWebGPU: vi.fn(async () => {
        throw new Error("adapter request crashed");
      }),
    }))).rejects.toThrow("WebGPU device initialization failed.");
  });

  it("disposes an instance whose warm-up failed and falls back", async () => {
    const warmUp = vi.fn(async (_instance: FakeModel, backend: InferenceBackend) => {
      if (backend === "webgpu") throw new Error("shader compilation failed");
    });
    const options = fallbackOptions({ warmUp });

    await expect(loadWithBackendFallback(options)).resolves.toMatchObject({ backend: "wasm" });
    expect(options.dispose).toHaveBeenCalledExactlyOnceWith({ backend: "webgpu" });
    expect(warmUp).toHaveBeenCalledTimes(2);
  });

  it("keeps the original failure when disposing a broken instance also fails", async () => {
    const options = fallbackOptions({
      backends: ["wasm"],
      warmUp: vi.fn(async () => {
        throw new Error("warm-up failed");
      }),
      dispose: vi.fn(async () => {
        throw new Error("dispose failed");
      }),
    });

    await expect(loadWithBackendFallback(options)).rejects.toThrow("warm-up failed");
    expect(options.onFallback).not.toHaveBeenCalled();
  });

  it("stops at backend-independent failures and rethrows the original error", async () => {
    const original = new Error("vocoder.onnx failed integrity verification.");
    const options = fallbackOptions({
      load: vi.fn(async () => {
        throw new BackendIndependentLoadError(original);
      }),
    });

    await expect(loadWithBackendFallback(options)).rejects.toBe(original);
    expect(options.load).toHaveBeenCalledOnce();
    expect(options.onFallback).not.toHaveBeenCalled();
  });

  it("throws the last error, or the failure message when no Error was thrown", async () => {
    const lastError = new Error("wasm failed");
    await expect(loadWithBackendFallback(fallbackOptions({
      load: vi.fn(async (backend: InferenceBackend) => {
        throw backend === "wasm" ? lastError : new Error("webgpu failed");
      }),
    }))).rejects.toBe(lastError);

    await expect(loadWithBackendFallback(fallbackOptions({
      load: vi.fn(async () => {
        throw "string failure";
      }),
    }))).rejects.toThrow("string failure");

    await expect(loadWithBackendFallback(fallbackOptions({ backends: [] })))
      .rejects.toThrow("Failed to load the fake model");
  });
});

describe("withLoadWatchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const options = (disposeLate = vi.fn(async () => undefined)) => ({
    label: "Fake load",
    inactivityMs: 60_000,
    settlingMs: 120_000,
    disposeLate,
  });

  it("never times out a slow download that keeps reporting progress", async () => {
    vi.useFakeTimers();
    const load = deferred<string>();
    let watchdog!: LoadWatchdog;
    const result = withLoadWatchdog((signal) => {
      watchdog = signal;
      return load.promise;
    }, options());

    for (let minute = 0; minute < 10; minute += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      watchdog.touch();
    }
    load.resolve("model");

    await expect(result).resolves.toBe("model");
  });

  it("rejects a load that makes no progress within the inactivity budget", async () => {
    vi.useFakeTimers();
    const load = deferred<string>();
    const result = withLoadWatchdog(() => load.promise, options());
    const rejection = expect(result).rejects.toThrow("Fake load made no progress for 60s.");

    await vi.advanceTimersByTimeAsync(60_001);
    await rejection;
  });

  it("gives session creation the settling budget once downloads finish", async () => {
    vi.useFakeTimers();
    const load = deferred<string>();
    let watchdog!: LoadWatchdog;
    const result = withLoadWatchdog((signal) => {
      watchdog = signal;
      return load.promise;
    }, options());
    const rejection = expect(result).rejects.toThrow("Fake load did not finish within 120s of downloading.");

    watchdog.settle();
    await vi.advanceTimersByTimeAsync(90_000);
    watchdog.settle();
    await vi.advanceTimersByTimeAsync(120_001);
    await rejection;
  });

  it("disposes a value that arrives after the watchdog fired", async () => {
    vi.useFakeTimers();
    const disposeLate = vi.fn(async () => undefined);
    const load = deferred<string>();
    const result = withLoadWatchdog(() => load.promise, options(disposeLate));
    const rejection = expect(result).rejects.toThrow("made no progress");

    await vi.advanceTimersByTimeAsync(60_001);
    await rejection;
    load.resolve("late model");
    await vi.advanceTimersByTimeAsync(0);

    expect(disposeLate).toHaveBeenCalledExactlyOnceWith("late model");
  });

  it("leaves no timer behind for progress reported after the load settled", async () => {
    vi.useFakeTimers();
    let watchdog!: LoadWatchdog;
    const result = withLoadWatchdog((signal) => {
      watchdog = signal;
      return Promise.resolve("model");
    }, options());
    await expect(result).resolves.toBe("model");

    // Transformers.js can still emit events (such as "ready") afterwards.
    watchdog.touch();
    watchdog.settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes through load failures and synchronous start errors", async () => {
    const load = deferred<string>();
    const failed = withLoadWatchdog(() => load.promise, options());
    load.reject(new Error("download failed"));
    await expect(failed).rejects.toThrow("download failed");

    await expect(withLoadWatchdog(() => {
      throw new Error("bad configuration");
    }, options())).rejects.toThrow("bad configuration");
  });
});

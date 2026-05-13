interface NavigatorWithGpu extends Navigator {
  gpu?: {
    requestAdapter: () => Promise<{
      info?: { isFallbackAdapter?: boolean };
      isFallbackAdapter?: boolean;
      requestDevice: () => Promise<{
        destroy?: () => void;
        lost?: Promise<{ reason?: string; message?: string }>;
      }>;
    } | null>;
  };
}

export type WebGPUStatusReason =
  | "unsupported"
  | "no-adapter"
  | "fallback-adapter"
  | "request-device-failed"
  | "device-lost";

export interface WebGPUStatus {
  available: boolean;
  reason: WebGPUStatusReason | null;
  message: string | null;
}

let cachedResult: Promise<WebGPUStatus> | null = null;

function getFallbackAdapterFlag(adapter: {
  info?: { isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean;
}): boolean {
  if (typeof adapter.isFallbackAdapter === "boolean") {
    return adapter.isFallbackAdapter;
  }

  return adapter.info?.isFallbackAdapter === true;
}

async function isDeviceLostImmediately(device: {
  lost?: Promise<{ reason?: string; message?: string }>;
}): Promise<boolean> {
  if (!device.lost) return false;

  const lossState = await Promise.race([
    device.lost.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), 0);
    }),
  ]);

  return lossState;
}

export async function getWebGPUStatus(): Promise<WebGPUStatus> {
  if (cachedResult !== null) return cachedResult;

  cachedResult = (async () => {
    if (typeof navigator === "undefined") {
      return {
        available: false,
        reason: "unsupported",
        message: "WebGPU is unavailable in this context.",
      } satisfies WebGPUStatus;
    }

    const gpu = (navigator as NavigatorWithGpu).gpu;
    if (!gpu) {
      return {
        available: false,
        reason: "unsupported",
        message: "WebGPU is not exposed on this navigator.",
      } satisfies WebGPUStatus;
    }

    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        return {
          available: false,
          reason: "no-adapter",
          message: "No WebGPU adapter is available.",
        } satisfies WebGPUStatus;
      }

      if (getFallbackAdapterFlag(adapter)) {
        return {
          available: false,
          reason: "fallback-adapter",
          message: "A software WebGPU adapter was detected, so the app will use WASM instead.",
        } satisfies WebGPUStatus;
      }

      const device = await adapter.requestDevice();
      try {
        const lostImmediately = await isDeviceLostImmediately(device);
        if (lostImmediately) {
          return {
            available: false,
            reason: "device-lost",
            message: "The WebGPU device was lost during initialization.",
          } satisfies WebGPUStatus;
        }
      } finally {
        if (typeof device.destroy === "function") {
          device.destroy();
        }
      }

      return {
        available: true,
        reason: null,
        message: null,
      } satisfies WebGPUStatus;
    } catch (error) {
      return {
        available: false,
        reason: "request-device-failed",
        message: error instanceof Error
          ? error.message
          : "WebGPU device initialization failed.",
      } satisfies WebGPUStatus;
    }
  })();

  return cachedResult;
}

export async function canInitializeWebGPU(): Promise<boolean> {
  const status = await getWebGPUStatus();
  return status.available;
}

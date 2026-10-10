/** Backend selection and load watchdogs shared by the browser TTS workers. */
import { canInitializeWebGPU } from "../../lib/webgpu";
import type { InferenceBackend } from "../../types";
import { errorMessage } from "./protocol";

/** Upper bound for multi-threaded WASM inference in every worker. */
export const MAX_WASM_THREADS = 4;

/**
 * A load failure that does not depend on the backend, such as a failed or
 * corrupt download. Retrying on another backend cannot help, so
 * loadWithBackendFallback stops and rethrows the original error.
 */
export class BackendIndependentLoadError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "BackendIndependentLoadError";
  }
}

export interface BackendFallbackOptions<T> {
  /** Backends in preference order. A WebGPU attempt starts only when the device probe succeeds. */
  backends: readonly InferenceBackend[];
  load(backend: InferenceBackend): Promise<T>;
  /** Runs a first inference (WebGPU compiles its shaders here); a failure falls back like a load failure. */
  warmUp?(instance: T, backend: InferenceBackend): Promise<void>;
  /** Releases an instance whose warm-up failed. Errors are ignored. */
  dispose(instance: T): Promise<void>;
  /** Called after a failed attempt, before the next backend is tried. */
  onFallback?(backend: InferenceBackend, error: unknown): void;
  /** Message for the error thrown when every attempt failed without an Error. */
  failureMessage: string;
  probeWebGPU?: () => Promise<boolean>;
}

export interface LoadedBackend<T> {
  instance: T;
  backend: InferenceBackend;
}

export async function loadWithBackendFallback<T>({
  backends,
  load,
  warmUp,
  dispose,
  onFallback,
  failureMessage,
  probeWebGPU = canInitializeWebGPU,
}: BackendFallbackOptions<T>): Promise<LoadedBackend<T>> {
  let lastError: unknown = null;
  for (const [index, backend] of backends.entries()) {
    let loaded: { instance: T } | null = null;
    try {
      if (backend === "webgpu" && !(await probeWebGPU())) {
        throw new Error("WebGPU device initialization failed.");
      }
      loaded = { instance: await load(backend) };
      await warmUp?.(loaded.instance, backend);
      return { instance: loaded.instance, backend };
    } catch (error) {
      if (loaded) {
        try {
          await dispose(loaded.instance);
        } catch {
          // Keep the original failure; the next attempt starts from scratch.
        }
      }
      if (error instanceof BackendIndependentLoadError) throw error.cause;
      lastError = error;
      if (index < backends.length - 1) onFallback?.(backend, error);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(lastError ? String(lastError) : failureMessage);
}

export interface LoadWatchdog {
  /** Activity: restarts the inactivity budget. */
  touch(): void;
  /**
   * Downloads finished. What remains (session creation) reports no
   * progress, so the settling budget applies until the load resolves or
   * activity resumes.
   */
  settle(): void;
}

export interface LoadWatchdogOptions<T> {
  /** Names the load in timeout messages. */
  label: string;
  /** Longest silence between progress events before the load is abandoned. */
  inactivityMs: number;
  /** Longest wait after settle() for the load to resolve. */
  settlingMs: number;
  /** Releases a value that arrives after the watchdog fired. */
  disposeLate(value: T): Promise<void>;
}

/**
 * Runs a load that reports progress, failing it only when it stalls. Unlike
 * a fixed deadline, a slow but steady download never times out; a load that
 * goes quiet for `inactivityMs`, or that does not resolve within
 * `settlingMs` after its downloads finished, rejects. A value that arrives
 * after that is disposed, since a fallback attempt has replaced it.
 */
export function withLoadWatchdog<T>(
  start: (watchdog: LoadWatchdog) => Promise<T>,
  { label, inactivityMs, settlingMs, disposeLate }: LoadWatchdogOptions<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (budgetMs: number, describe: (seconds: number) => string): void => {
      if (expired) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        expired = true;
        reject(new Error(`${label} ${describe(budgetMs / 1000)}.`));
      }, budgetMs);
    };
    const watchdog: LoadWatchdog = {
      touch: () => arm(inactivityMs, (seconds) => `made no progress for ${seconds}s`),
      settle: () => arm(settlingMs, (seconds) => `did not finish within ${seconds}s of downloading`),
    };

    watchdog.touch();
    let pending: Promise<T>;
    try {
      pending = start(watchdog);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        clearTimeout(timer);
        if (!expired) {
          resolve(value);
          return;
        }
        void disposeLate(value).catch(() => undefined);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (!expired) reject(error);
      },
    );
  });
}

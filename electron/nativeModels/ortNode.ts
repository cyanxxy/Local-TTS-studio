/**
 * `onnxruntime-node` set-up every native model worker shares.
 *
 * Import this only from worker threads: it loads the native ONNX Runtime addon.
 */

import * as ort from "onnxruntime-node";

/**
 * onnxruntime-common selects its FP16 backing array lazily, the first time an
 * `ort.Tensor` is constructed. Node 24 introduced a native `Float16Array`, so
 * ORT 1.27 now selects that instead of the Uint16Array representation its Node
 * binding has historically used. The native addon accepts the new array type,
 * but node-addon-api 6 reports its byte length as zero. Every non-empty FP16
 * input consequently fails with e.g. `not enough space: expected 524288, got
 * 0`.
 *
 * Prime ORT's process-local type mapping while Float16Array is hidden. The map
 * then keeps using Uint16Array, whose bits are identical and which the native
 * binding handles correctly. Restore the global immediately so the worker does
 * not change JavaScript semantics for a tokenizer or any other code. Running it
 * again is harmless: the mapping is already primed.
 *
 * `scope` is a seam for tests; production always passes the real global.
 */
export function initialiseOrtFloat16Compatibility(label: string, scope: object = globalThis): void {
  const scopeWithFloat16 = scope as { Float16Array?: unknown };
  if (typeof scopeWithFloat16.Float16Array !== "function") return;
  const descriptor = Object.getOwnPropertyDescriptor(scope, "Float16Array");
  if (!descriptor?.configurable) {
    throw new Error(`${label} cannot initialise ONNX Runtime FP16 compatibility.`);
  }
  try {
    Object.defineProperty(scope, "Float16Array", { ...descriptor, value: undefined });
    const probe = new ort.Tensor("float16", new Uint16Array(1), [1]);
    probe.dispose();
  } finally {
    Object.defineProperty(scope, "Float16Array", descriptor);
  }
}

/**
 * Runs once at the top of a native model worker, before any tensor exists:
 * applies the FP16 compatibility shim and quiets ORT, which otherwise logs one
 * info line per session and per optimisation pass into the packaged app's
 * stderr on every load.
 */
export function prepareOrtNodeWorker(label: string): void {
  initialiseOrtFloat16Compatibility(label);
  ort.env.logLevel = "error";
}

/** CPU session options shared by every native model; only the thread count varies. */
export function createCpuSessionOptions(intraOpNumThreads: number): ort.InferenceSession.SessionOptions {
  return {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads,
    interOpNumThreads: 2,
  };
}

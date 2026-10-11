/**
 * The message protocol between a native model's worker thread and the main
 * process that owns it.
 *
 * Every request carries a caller-chosen id and every answer names the request
 * it belongs to, so progress and results reach only the caller that asked.
 * `load` and `cancel` mean the same thing for every model; any other request
 * type is the model's own, such as Audio8's `generate`.
 */

import path from "path";

/** What the main process hands a native model worker when it starts one. */
export interface NativeModelWorkerData {
  /** The revision directory the worker downloads into and loads from. */
  modelDir: string;
}

/** Asks the worker to make its runtime resident. */
export interface NativeModelLoadRequest {
  type: "load";
  requestId: string;
}

/** Asks the worker to abandon the request with this id. */
export interface NativeModelCancelRequest {
  type: "cancel";
  requestId: string;
}

/** A request of the model's own, answered with a result like a load is. */
export interface NativeModelRequest {
  type: string;
  requestId: string;
}

export type NativeModelWorkerRequest<TModelRequest extends NativeModelRequest> =
  | NativeModelLoadRequest
  | NativeModelCancelRequest
  | TModelRequest;

export type NativeModelWorkerResponse<TResult> =
  | { type: "progress"; requestId: string; percent: number }
  | { type: "result"; requestId: string; result: TResult }
  | { type: "error"; requestId: string; error: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows a message from a worker. Null for anything that is not a well-formed
 * answer, including a result `isResult` does not recognise, so a confused
 * worker can never settle a request with a value of the wrong shape.
 */
export function parseNativeModelWorkerResponse<TResult>(
  value: unknown,
  isResult: (result: Record<string, unknown>) => boolean,
  fallbackError: string,
): NativeModelWorkerResponse<TResult> | null {
  if (!isRecord(value) || typeof value.requestId !== "string") return null;
  if (value.type === "progress" && typeof value.percent === "number") {
    return { type: "progress", requestId: value.requestId, percent: value.percent };
  }
  if (value.type === "result" && isRecord(value.result) && isResult(value.result)) {
    return { type: "result", requestId: value.requestId, result: value.result as TResult };
  }
  if (value.type === "error") {
    return {
      type: "error",
      requestId: value.requestId,
      error: typeof value.error === "string" && value.error ? value.error : fallbackError,
    };
  }
  return null;
}

/**
 * The model directory a worker was started with. Null when the module was
 * imported rather than started as a worker, which is how a worker's pure
 * helpers are unit tested.
 */
export function readWorkerModelDir(workerData: unknown): string | null {
  return isRecord(workerData) && typeof workerData.modelDir === "string"
    ? path.resolve(workerData.modelDir)
    : null;
}

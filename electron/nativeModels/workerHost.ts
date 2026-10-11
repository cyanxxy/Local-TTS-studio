/**
 * The request loop every native model worker runs.
 *
 * A model supplies how to build its runtime and how to answer its own request
 * types; the host owns everything around that: the one shared load however
 * many windows ask for it, a cancel for every request id, model requests run
 * one at a time, and an answer for every request it accepts, so the client in
 * the main process is never left waiting on one that was dropped.
 */

import type { NativeModelDescriptor } from "./descriptor";
import { SerialTaskQueue, SharedTask, type SharedTaskContext } from "./sharedTask";
import { isRecord, type NativeModelWorkerResponse } from "./workerProtocol";

/**
 * The parent port, narrowed to what the host uses so a worker's request
 * handling can be driven from a test without a real worker thread.
 */
export interface NativeModelWorkerPort<TResult> {
  on(event: "message", listener: (value: unknown) => void): unknown;
  postMessage(value: NativeModelWorkerResponse<TResult>, transfer?: readonly ArrayBuffer[]): void;
}

export interface NativeModelRequestContext<TRuntime> {
  requestId: string;
  /** Aborted when this request is cancelled. */
  signal: AbortSignal;
  /**
   * The resident runtime, joining or starting the shared load when there is
   * none yet. Load progress is reported under this request's id.
   */
  loadRuntime: () => Promise<TRuntime>;
  /** Reports this request's own progress, in percent. */
  report: (percent: number) => void;
}

export interface NativeModelReply<TResult> {
  result: TResult;
  /** Buffers moved to the main process rather than copied, such as rendered audio. */
  transfer?: ArrayBuffer[];
}

export type NativeModelRequestHandler<TRuntime, TResult> = (
  request: Readonly<Record<string, unknown>>,
  context: NativeModelRequestContext<TRuntime>,
) => Promise<NativeModelReply<TResult>>;

export interface NativeModelWorkerDefinition<TRuntime, TResult> {
  descriptor: Pick<NativeModelDescriptor, "label">;
  /** Builds the runtime: downloads, verification and inference sessions. Runs once per worker. */
  load: (context: SharedTaskContext<number>) => Promise<TRuntime>;
  /** The error a load abandoned by every caller rejects with. */
  loadCancelledError: () => Error;
  /** What a `load` request answers once the runtime is resident. */
  describeLoaded: (runtime: TRuntime) => TResult;
  /**
   * The model's own request types, keyed by `type`. They run one at a time in
   * arrival order: an inference session is a single CPU-bound pipeline, and two
   * generations interleaved would only halve each other's speed. A handler is
   * responsible for honouring its signal, including when its turn comes after
   * it was already cancelled.
   */
  handlers: Readonly<Record<string, NativeModelRequestHandler<TRuntime, TResult>>>;
}

const RESERVED_REQUEST_TYPES = new Set(["load", "cancel"]);

export function startNativeModelWorker<TRuntime, TResult>(
  port: NativeModelWorkerPort<TResult>,
  definition: NativeModelWorkerDefinition<TRuntime, TResult>,
): void {
  const { label } = definition.descriptor;
  for (const type of Object.keys(definition.handlers)) {
    if (RESERVED_REQUEST_TYPES.has(type)) throw new Error(`${label} cannot redefine the "${type}" request.`);
  }
  // One load, however many windows and StrictMode double-effects ask for it.
  const loading = new SharedTask<TRuntime, number>(definition.loadCancelledError);
  const queue = new SerialTaskQueue();
  const inFlight = new Map<string, AbortController>();
  let runtime: TRuntime | null = null;

  const post = (message: NativeModelWorkerResponse<TResult>, transfer: readonly ArrayBuffer[] = []): void => {
    port.postMessage(message, transfer);
  };

  const load = (requestId: string, signal: AbortSignal): Promise<TRuntime> => {
    if (runtime !== null) return Promise.resolve(runtime);
    return loading.run(async (context) => {
      const loaded = await definition.load(context);
      runtime = loaded;
      return loaded;
    }, {
      onProgress: (percent) => post({ type: "progress", requestId, percent }),
      signal,
    });
  };

  const answer = async (
    request: Readonly<Record<string, unknown>> & { requestId: string },
    signal: AbortSignal,
  ): Promise<NativeModelReply<TResult>> => {
    const { requestId, type } = request;
    if (type === "load") return { result: definition.describeLoaded(await load(requestId, signal)) };
    const handler = typeof type === "string" && Object.hasOwn(definition.handlers, type)
      ? definition.handlers[type]
      : undefined;
    if (!handler) throw new Error(`Unsupported ${label} request "${String(type)}".`);
    return queue.run(() => handler(request, {
      requestId,
      signal,
      loadRuntime: () => load(requestId, signal),
      report: (percent) => post({ type: "progress", requestId, percent }),
    }));
  };

  port.on("message", (value: unknown) => {
    if (!isRecord(value) || typeof value.requestId !== "string") return;
    const requestId = value.requestId;
    if (value.type === "cancel") {
      // Unknown ids are dropped rather than remembered: a cancel that lands
      // after its request finished used to sit in a set that only ever grew.
      inFlight.get(requestId)?.abort();
      return;
    }
    const controller = new AbortController();
    inFlight.set(requestId, controller);
    void (async () => {
      try {
        const { result, transfer } = await answer({ ...value, requestId }, controller.signal);
        post({ type: "result", requestId, result }, transfer);
      } catch (error) {
        post({
          type: "error",
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inFlight.delete(requestId);
      }
    })();
  });
}

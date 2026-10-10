/**
 * The message loop every browser TTS worker shares. A worker supplies only
 * its model's `load` and `generate`; this module applies the protocol rules
 * documented on WorkerInMessage (src/types.ts):
 *
 * - LOAD requests run one at a time, in order. A forced reload supersedes
 *   every generation sent before it as soon as it arrives, so generations
 *   sent after it are never cut short by it.
 * - Each GENERATE runs as a generation task (see generation.ts): it
 *   supersedes the previous generation and waits for it to settle before
 *   touching the model. Errors are posted with scope "generate" only while
 *   the generation is still current.
 * - CANCEL invalidates every generation, posts CANCELLED, and closes the
 *   worker.
 */
import type { WorkerInMessage } from "../../types";
import { createGenerationController, type GenerationController, type GenerationTicket } from "./generation";
import { createWorkerPort, type WorkerPort } from "./protocol";

export type LoadMessage = Extract<WorkerInMessage, { type: "LOAD" }>;
export type GenerateMessage = Extract<WorkerInMessage, { type: "GENERATE" }>;

export interface SerialQueue {
  /** Runs `task` after every previously enqueued task has settled. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(task);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

export interface WorkerModelHandlers {
  /**
   * Loads the model and posts LOAD_PROGRESS and READY. Throws to report a
   * load error. A forced reload must drop the resident model before its
   * first await, so a GENERATE that arrives meanwhile fails instead of
   * running on it, and must await `generations.idle()` before releasing it.
   */
  load(message: LoadMessage): Promise<void>;
  /**
   * Runs one generation. Throws to report a generate error. Must check
   * `ticket.isCurrent()` after every await and post nothing once it is false.
   */
  generate(message: GenerateMessage, ticket: GenerationTicket): Promise<void>;
}

export interface WorkerRuntime {
  readonly port: WorkerPort;
  readonly generations: GenerationController;
  handleMessage(message: WorkerInMessage): void;
}

export interface WorkerRuntimeOptions {
  port?: WorkerPort;
  generations?: GenerationController;
  /** Ends the worker after a hard cancel. Defaults to `self.close()`. */
  close?: () => void;
}

export function createWorkerRuntime(
  handlers: WorkerModelHandlers,
  {
    port = createWorkerPort(),
    generations = createGenerationController(),
    close = () => self.close(),
  }: WorkerRuntimeOptions = {},
): WorkerRuntime {
  const loads = createSerialQueue();

  const handleMessage = (message: WorkerInMessage): void => {
    switch (message.type) {
      case "LOAD":
        // Here rather than in the queued load, which may start later: only
        // generations sent before the reload are superseded by it.
        if (message.forceReload) generations.invalidate();
        void loads.run(() => handlers.load(message)).catch((error: unknown) => {
          port.postError("load", error);
        });
        break;
      case "GENERATE":
        void generations.run(message.generationId, async (ticket) => {
          try {
            await handlers.generate(message, ticket);
          } catch (error) {
            if (ticket.isCurrent()) port.postError("generate", error, message.generationId);
          }
        });
        break;
      case "CANCEL":
        generations.invalidate();
        port.post({ type: "CANCELLED" });
        close();
        break;
    }
  };

  return { port, generations, handleMessage };
}

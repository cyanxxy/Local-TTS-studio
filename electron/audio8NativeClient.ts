/**
 * Main-process half of the Audio8 native runtime.
 *
 * The worker ownership, request routing, inactivity deadline and teardown
 * contract are the shared `NativeModelWorkerClient`; this module only names
 * Audio8's result shape and its `generate` request.
 */

import type { Audio8SamplingOptions } from "./audio8Ipc";
import { AUDIO8_DESCRIPTOR } from "./audio8Model";
import {
  NATIVE_MODEL_REQUEST_INACTIVITY_TIMEOUT_MS,
  NativeModelWorkerClient,
  type NativeModelWorkerFactory,
  type NativeModelWorkerLike,
} from "./nativeModels/workerClient";
import type { NativeModelWorkerRequest, NativeModelWorkerResponse } from "./nativeModels/workerProtocol";

export interface Audio8NativeResult {
  ready?: boolean;
  sampleRate: number;
  elapsedSec?: number;
  audio?: ArrayBuffer;
}

export type Audio8GenerateWorkerRequest =
  { type: "generate"; requestId: string; text: string; voice: string } & Audio8SamplingOptions;

export type Audio8WorkerRequest = NativeModelWorkerRequest<Audio8GenerateWorkerRequest>;
export type Audio8WorkerResponse = NativeModelWorkerResponse<Audio8NativeResult>;
export type Audio8WorkerLike = NativeModelWorkerLike<Audio8GenerateWorkerRequest>;
export type Audio8WorkerFactory = NativeModelWorkerFactory<Audio8GenerateWorkerRequest>;

export const AUDIO8_REQUEST_INACTIVITY_TIMEOUT_MS = NATIVE_MODEL_REQUEST_INACTIVITY_TIMEOUT_MS;

function isAudio8Result(result: Record<string, unknown>): boolean {
  return typeof result.sampleRate === "number";
}

export class Audio8NativeClient extends NativeModelWorkerClient<Audio8GenerateWorkerRequest, Audio8NativeResult> {
  constructor(
    modelDir: string,
    createWorker?: Audio8WorkerFactory,
    inactivityTimeoutMs: number = AUDIO8_REQUEST_INACTIVITY_TIMEOUT_MS,
  ) {
    super({ descriptor: AUDIO8_DESCRIPTOR, modelDir, isResult: isAudio8Result, createWorker, inactivityTimeoutMs });
  }

  /**
   * `sampling` asks for a different take; leaving it out reproduces the
   * reference take exactly, and the worker validates it again either way.
   */
  generate(
    requestId: string,
    text: string,
    voice: string,
    onProgress?: (percent: number) => void,
    sampling?: Audio8SamplingOptions,
  ): Promise<Audio8NativeResult> {
    return this.request({ type: "generate", requestId, text, voice, ...sampling }, onProgress);
  }
}

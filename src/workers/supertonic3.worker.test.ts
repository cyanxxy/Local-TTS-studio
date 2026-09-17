import { afterEach, expect, it, vi } from "vitest";
import type { WorkerInMessage, WorkerOutMessage } from "../types";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("includes sentence and final pauses in emitted PCM", async () => {
  vi.resetModules();
  const messages: WorkerOutMessage[] = [];
  const worker = { onmessage: null as ((event: MessageEvent<WorkerInMessage>) => void) | null, postMessage: (message: WorkerOutMessage) => messages.push(message) };
  vi.stubGlobal("self", worker);
  vi.stubGlobal("caches", undefined);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: new Headers(), body: null, arrayBuffer: async () => new TextEncoder().encode("{}").buffer })));
  vi.doMock("../lib/pinnedModelFetch", () => ({ verifyPinnedAssetIntegrity: async () => true }));
  vi.doMock("../lib/webgpu", () => ({ canInitializeWebGPU: async () => false }));
  vi.doMock("../lib/supertonic3Runtime", () => ({
    createSupertonic3RuntimeStreaming: async () => ({ sampleRate: 10, synthesize: async () => new Float32Array([0.5, 0.5]), dispose: async () => undefined }),
    createSupertonic3Style: () => ({ ttl: { dispose() {} }, dp: { dispose() {} } }),
  }));
  vi.doMock("../lib/chunking", () => ({ chunkWithConstraintsDetailed: () => [
    { text: "One.", start: 0, end: 4, pauseKind: "sentence", pauseAfterSec: 0.2 },
    { text: "Two.", start: 5, end: 9, pauseKind: "none", pauseAfterSec: 0 },
  ] }));
  await import("./supertonic3.worker");
  const dispatch = (data: WorkerInMessage) => worker.onmessage?.({ data } as MessageEvent<WorkerInMessage>);
  dispatch({ type: "LOAD" });
  await vi.waitFor(() => expect(messages.some((message) => message.type === "READY")).toBe(true));
  dispatch({ type: "GENERATE", text: "One. Two.", voice: "M1", speed: 1, quality: 5, pauseOverridesSec: { sentence: 0.3 }, finalPauseSec: 0.5 });
  await vi.waitFor(() => expect(messages.some((message) => message.type === "GENERATION_COMPLETE")).toBe(true));
  const chunks = messages.filter((message) => message.type === "AUDIO_CHUNK");
  expect(Array.from(chunks[0].audio)).toEqual([0.5, 0.5, 0, 0, 0]);
  expect(Array.from(chunks[1].audio)).toEqual([0.5, 0.5, 0, 0, 0, 0, 0]);
});

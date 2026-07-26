// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface WorkerHarness {
  posted: Array<Record<string, unknown>>;
  send: (message: unknown) => void;
}

function createDocument(id: string, now: number) {
  return {
    id,
    title: `Document ${id}`,
    text: `Text for ${id}`,
    updatedAt: now,
    lastOpenedAt: now,
  };
}

function audioMetadata(documentId: string, sectionId: string, updatedAt: number) {
  return {
    cacheKey: JSON.stringify([documentId, sectionId]),
    documentId,
    chapterId: "chapter-1",
    sectionId,
    signature: `signature-${updatedAt}`,
    byteLength: 8,
    currentTime: 0,
    playbackRate: 1,
    totalDuration: 1,
    updatedAt,
  };
}

function audioChunk(index: number, total: number) {
  return {
    audio: new Float32Array([index, -0.25]).buffer,
    samplingRate: 24_000,
    text: `Chunk ${index}.`,
    index,
    total,
  };
}

describe("readerLibraryWorker", () => {
  let directory: string;
  let databasePath: string;
  let worker: WorkerHarness | null = null;

  // The module reads `parentPort`/`workerData` and opens the database when it is
  // imported, so every test gets a fresh module registry and a stub port that
  // records what the worker would have posted back to the main process.
  async function startWorker(): Promise<WorkerHarness> {
    const posted: Array<Record<string, unknown>> = [];
    let handler: ((message: unknown) => void) | undefined;
    const port = {
      on(event: string, listener: (message: unknown) => void): void {
        if (event === "message") handler = listener;
      },
      postMessage(message: Record<string, unknown>): void {
        posted.push(message);
      },
      close(): void {},
    };
    vi.resetModules();
    vi.doMock("node:worker_threads", () => ({ parentPort: port, workerData: { databasePath } }));
    await import("./readerLibraryWorker");
    worker = { posted, send: (message: unknown) => handler?.(message) };
    return worker;
  }

  function saveAudio(
    requestId: string,
    metadata: Record<string, unknown>,
    chunkCount: number,
    beforeLastChunk?: () => void,
  ): void {
    const active = worker;
    if (!active) throw new Error("The worker harness is not running.");
    active.send({ type: "save-audio-start", requestId, metadata, chunkCount });
    for (let order = 0; order < chunkCount; order += 1) {
      if (order === chunkCount - 1) beforeLastChunk?.();
      active.send({ type: "save-audio-chunk", requestId, order, chunk: audioChunk(order, chunkCount) });
    }
    active.send({ type: "save-audio-end", requestId });
  }

  function messageFor(requestId: string, type: string): Record<string, unknown> | undefined {
    return worker?.posted.find((message) => message.requestId === requestId && message.type === type);
  }

  function readAudio(documentId: string, sectionId: string, requestId: string): unknown {
    worker?.send({ type: "get-audio-start", requestId, documentId, sectionId });
    return messageFor(requestId, "get-audio-header")?.audio ?? null;
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "open-tts-reader-worker-"));
    databasePath = path.join(directory, "reader-library.sqlite3");
  });

  afterEach(async () => {
    worker?.send({ type: "shutdown" });
    worker = null;
    vi.doUnmock("node:worker_threads");
    vi.resetModules();
    await rm(directory, { recursive: true, force: true });
  });

  it("drops a streamed audio save that a document delete overtook", async () => {
    const active = await startWorker();
    active.send({
      type: "request",
      requestId: "save-document",
      operation: "saveDocument",
      args: [createDocument("doc-1", 100)],
    });

    saveAudio("save-1", audioMetadata("doc-1", "section-1", 200), 2, () => {
      active.send({ type: "request", requestId: "delete", operation: "deleteDocument", args: ["doc-1"] });
    });

    // The delete is the newer intent, so the save is dropped but still succeeds.
    expect(messageFor("save-1", "save-audio-result")).toMatchObject({ ok: true });
    expect(active.posted.some((message) => message.ok === false)).toBe(false);
    expect(readAudio("doc-1", "section-1", "read-1")).toBeNull();
  });

  it("drops only the deleted section's in-flight save", async () => {
    const active = await startWorker();

    active.send({
      type: "save-audio-start",
      requestId: "save-kept",
      metadata: audioMetadata("doc-1", "section-2", 200),
      chunkCount: 1,
    });
    saveAudio("save-dropped", audioMetadata("doc-1", "section-1", 200), 1, () => {
      active.send({
        type: "request",
        requestId: "delete",
        operation: "deleteAudio",
        args: ["doc-1", "section-1"],
      });
    });
    active.send({ type: "save-audio-chunk", requestId: "save-kept", order: 0, chunk: audioChunk(0, 1) });
    active.send({ type: "save-audio-end", requestId: "save-kept" });

    expect(readAudio("doc-1", "section-1", "read-dropped")).toBeNull();
    expect(readAudio("doc-1", "section-2", "read-kept")).toMatchObject({ signature: "signature-200" });
  });

  it("drops every in-flight save for a document when the delete omits the section", async () => {
    const active = await startWorker();

    active.send({
      type: "save-audio-start",
      requestId: "save-other-document",
      metadata: audioMetadata("doc-2", "section-1", 200),
      chunkCount: 1,
    });
    active.send({
      type: "save-audio-start",
      requestId: "save-second-section",
      metadata: audioMetadata("doc-1", "section-2", 200),
      chunkCount: 1,
    });
    saveAudio("save-first-section", audioMetadata("doc-1", "section-1", 200), 1, () => {
      active.send({ type: "request", requestId: "delete", operation: "deleteAudio", args: ["doc-1", undefined] });
    });
    for (const requestId of ["save-second-section", "save-other-document"]) {
      active.send({ type: "save-audio-chunk", requestId, order: 0, chunk: audioChunk(0, 1) });
      active.send({ type: "save-audio-end", requestId });
    }

    expect(readAudio("doc-1", "section-1", "read-first")).toBeNull();
    expect(readAudio("doc-1", "section-2", "read-second")).toBeNull();
    expect(readAudio("doc-2", "section-1", "read-other")).toMatchObject({ signature: "signature-200" });
  });

  it("keeps enforcing chunk order after a delete invalidates the stream", async () => {
    const active = await startWorker();

    active.send({
      type: "save-audio-start",
      requestId: "save-1",
      metadata: audioMetadata("doc-1", "section-1", 200),
      chunkCount: 2,
    });
    active.send({ type: "save-audio-chunk", requestId: "save-1", order: 0, chunk: audioChunk(0, 2) });
    active.send({ type: "request", requestId: "delete", operation: "deleteAudio", args: ["doc-1", "section-1"] });
    active.send({ type: "save-audio-chunk", requestId: "save-1", order: 0, chunk: audioChunk(0, 2) });

    expect(messageFor("save-1", "result")).toMatchObject({
      ok: false,
      error: expect.stringContaining("out of order"),
    });
  });

  it("keeps an in-flight save that no delete targeted", async () => {
    const active = await startWorker();

    saveAudio("save-1", audioMetadata("doc-1", "section-1", 200), 2, () => {
      active.send({ type: "request", requestId: "delete", operation: "deleteAudio", args: ["doc-1", "section-2"] });
    });

    expect(readAudio("doc-1", "section-1", "read-1")).toMatchObject({ signature: "signature-200" });
  });

  it("ignores delete requests whose ids cannot remove rows", async () => {
    const active = await startWorker();

    saveAudio("save-1", audioMetadata("doc-1", "section-1", 200), 2, () => {
      active.send({ type: "request", requestId: "delete", operation: "deleteAudio", args: ["doc-1", 42] });
    });

    expect(messageFor("delete", "result")).toMatchObject({ ok: false });
    expect(readAudio("doc-1", "section-1", "read-1")).toMatchObject({ signature: "signature-200" });
  });
});

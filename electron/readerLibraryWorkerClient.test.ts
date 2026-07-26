// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MessagePortMain } from "electron";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReaderLibraryWorkerClient } from "./readerLibraryWorkerClient";

class TestMessagePort extends EventEmitter {
  peer: TestMessagePort | null = null;
  closed = false;
  readonly sent: Array<{ value: unknown; transfer: unknown[] | undefined }> = [];

  postMessage(value: unknown, transfer?: unknown[]): void {
    const peer = this.peer;
    if (!peer) throw new Error("Test message port is disconnected.");
    // Electron only transfers ports over a MessagePortMain and throws on anything
    // else, including the ArrayBuffers a worker_threads port would have accepted.
    transfer?.forEach((entry, index) => {
      if (!(entry instanceof TestMessagePort)) {
        throw new Error(`Port at index ${index} is not a valid port`);
      }
    });
    this.sent.push({ value, transfer });
    const cloned = structuredClone(value);
    queueMicrotask(() => peer.emit("message", { data: cloned }));
  }

  start(): void {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      this.peer.emit("close");
    }
  }
}

function createPortPair(): [TestMessagePort, TestMessagePort] {
  const first = new TestMessagePort();
  const second = new TestMessagePort();
  first.peer = second;
  second.peer = first;
  return [first, second];
}

function waitForPortResult(
  port: TestMessagePort,
  chunks: number[][] = [[0.25, -0.5]],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sendChunk = (order: number): void => {
      port.postMessage({
        type: "chunk",
        order,
        chunk: {
          audio: new Float32Array(chunks[order]).buffer,
          samplingRate: 24_000,
          text: "Worker audio.",
          index: order,
          total: chunks.length,
        },
      });
    };
    port.on("message", ({ data }: { data: unknown }) => {
      if (!data || typeof data !== "object") return;
      const message = data as Record<string, unknown>;
      if (message.type === "ready") {
        sendChunk(0);
      } else if (message.type === "accepted") {
        const next = Number(message.order) + 1;
        if (next < chunks.length) sendChunk(next);
        else port.postMessage({ type: "end" });
      } else if (message.type === "result") {
        if (message.ok === true) resolve();
        else reject(new Error(String(message.error)));
      }
    });
  });
}

interface CachedAudioRead {
  header: Record<string, unknown> | null;
  chunks: Array<Record<string, unknown>>;
}

function readCachedAudio(
  client: ReaderLibraryWorkerClient,
  documentId: string,
  sectionId: string,
): { mainPort: TestMessagePort; audio: Promise<CachedAudioRead> } {
  const [mainPort, rendererPort] = createPortPair();
  const audio = new Promise<CachedAudioRead>((resolve, reject) => {
    const read: CachedAudioRead = { header: null, chunks: [] };
    // A dropped chunk otherwise leaves the renderer waiting the way the desktop app
    // does, so bound the wait rather than letting the test time out with no reason.
    const timeout = setTimeout(() => {
      reject(new Error("Cached Reader audio never reached the renderer port."));
    }, 2_000);
    const settle = (finish: () => void): void => {
      clearTimeout(timeout);
      finish();
    };
    rendererPort.on("message", ({ data }: { data: unknown }) => {
      if (!data || typeof data !== "object") return;
      const message = data as Record<string, unknown>;
      if (message.type === "result" && message.ok !== true) {
        settle(() => reject(new Error(String(message.error))));
      } else if (message.type === "header") {
        read.header = message.audio as Record<string, unknown> | null;
        if (read.header === null || message.chunkCount === 0) settle(() => resolve(read));
        else rendererPort.postMessage({ type: "next", order: 0 });
      } else if (message.type === "chunk") {
        read.chunks.push(message.chunk as Record<string, unknown>);
        if (message.done === true) settle(() => resolve(read));
        else rendererPort.postMessage({ type: "next", order: read.chunks.length });
      }
    });
  });
  client.getAudio(mainPort as unknown as MessagePortMain, documentId, sectionId);
  return { mainPort, audio };
}

function waitForPortError(port: TestMessagePort): Promise<string> {
  return new Promise((resolve) => {
    port.on("message", ({ data }: { data: unknown }) => {
      if (!data || typeof data !== "object") return;
      const message = data as Record<string, unknown>;
      if (message.type === "result" && message.ok !== true) resolve(String(message.error));
    });
  });
}

function sentOfType(
  port: TestMessagePort,
  type: string,
): { value: unknown; transfer: unknown[] | undefined } | undefined {
  return port.sent.find((entry) => {
    const value = entry.value;
    return typeof value === "object"
      && value !== null
      && (value as Record<string, unknown>).type === type;
  });
}

describe("ReaderLibraryWorkerClient", () => {
  let directory: string;
  let workerPath: string;
  let client: ReaderLibraryWorkerClient;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "open-tts-reader-worker-"));
    workerPath = path.join(directory, "readerLibraryWorker.cjs");
    await build({
      entryPoints: [path.resolve("electron/readerLibraryWorker.ts")],
      bundle: true,
      format: "cjs",
      platform: "node",
      outfile: workerPath,
    });
    client = new ReaderLibraryWorkerClient(
      workerPath,
      path.join(directory, "reader-library.sqlite3"),
      () => undefined,
    );
  });

  afterEach(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("runs document operations and streams audio outside the caller thread", async () => {
    const document = {
      id: "worker-document",
      title: "Worker document",
      text: "Audio stored through the worker.",
      updatedAt: 100,
      lastOpenedAt: 100,
    };
    await client.request("saveDocument", [document]);
    expect(await client.request("getDocument", [document.id])).toMatchObject(document);

    const [saveMainPort, saveRendererPort] = createPortPair();
    const saved = waitForPortResult(saveRendererPort);
    client.saveAudio(saveMainPort as unknown as MessagePortMain, {
      cacheKey: JSON.stringify([document.id, "section-1"]),
      documentId: document.id,
      chapterId: "chapter-1",
      sectionId: "section-1",
      signature: "worker-signature",
      byteLength: 8,
      currentTime: 0,
      playbackRate: 1,
      totalDuration: 1,
      updatedAt: 200,
    }, 1);
    await saved;

    const { mainPort: getMainPort, audio: restored } = readCachedAudio(
      client,
      document.id,
      "section-1",
    );

    const audio = await restored;
    expect(audio.header?.signature).toBe("worker-signature");
    const chunk = audio.chunks[0] as { audio: ArrayBuffer };
    expect([...new Float32Array(chunk.audio)]).toEqual([0.25, -0.5]);
    expect(sentOfType(getMainPort, "header")?.transfer).toBeUndefined();
  });

  it("copies cached audio chunks to the renderer instead of transferring them", async () => {
    // Electron rejects a non-port transfer list, and the throw lands inside the
    // worker's message handler, so a transferred chunk crashes the main process.
    const document = {
      id: "transfer-document",
      title: "Transfer document",
      text: "Audio replayed from the cache.",
      updatedAt: 300,
      lastOpenedAt: 300,
    };
    await client.request("saveDocument", [document]);

    const [saveMainPort, saveRendererPort] = createPortPair();
    const saved = waitForPortResult(saveRendererPort, [[0.5, -0.25], [0.125, 1]]);
    client.saveAudio(saveMainPort as unknown as MessagePortMain, {
      cacheKey: JSON.stringify([document.id, "section-1"]),
      documentId: document.id,
      chapterId: "chapter-1",
      sectionId: "section-1",
      signature: "transfer-signature",
      byteLength: 16,
      currentTime: 0,
      playbackRate: 1,
      totalDuration: 2,
      updatedAt: 300,
    }, 2);
    await saved;

    const { mainPort, audio } = readCachedAudio(client, document.id, "section-1");
    const read = await audio;

    const samples = (read.chunks as Array<{ audio: ArrayBuffer }>).map(
      (chunk) => [...new Float32Array(chunk.audio)],
    );
    expect(samples).toEqual([[0.5, -0.25], [0.125, 1]]);
    for (const entry of mainPort.sent) {
      expect(entry.transfer).toBeUndefined();
    }
  });

  it("fails in-flight work when the client closes", async () => {
    const [saveMainPort, saveRendererPort] = createPortPair();
    const [getMainPort, getRendererPort] = createPortPair();
    const saveFailed = waitForPortError(saveRendererPort);
    const getFailed = waitForPortError(getRendererPort);
    const pending = client.request("listDocuments");
    client.saveAudio(saveMainPort as unknown as MessagePortMain, {
      cacheKey: JSON.stringify(["closing-document", "section-1"]),
      documentId: "closing-document",
      sectionId: "section-1",
    }, 1);
    client.getAudio(
      getMainPort as unknown as MessagePortMain,
      "closing-document",
      "section-1",
    );

    const closed = client.close();
    await expect(pending).rejects.toThrow("Reader library worker is shutting down.");
    expect(await saveFailed).toBe("Reader library worker is shutting down.");
    expect(await getFailed).toBe("Reader library worker is shutting down.");
    expect(saveMainPort.closed).toBe(true);
    expect(getMainPort.closed).toBe(true);
    await closed;

    await expect(client.request("listDocuments")).rejects.toThrow(
      "Reader library worker is shutting down.",
    );
  });

  it("refuses new work between the worker's error and exit events", async () => {
    // An empty database path makes the worker throw while it starts up.
    const crashed = new ReaderLibraryWorkerClient(workerPath, "", () => undefined);
    const pending = crashed.request("listDocuments");
    await expect(pending).rejects.toThrow(/database path/);

    // The "error" handler rejected that promise, so this continuation runs before
    // "exit" can fire: only the crash flag marks the worker unusable right now.
    const [saveMainPort, saveRendererPort] = createPortPair();
    const [getMainPort, getRendererPort] = createPortPair();
    const saveFailed = waitForPortError(saveRendererPort);
    const getFailed = waitForPortError(getRendererPort);
    const refused = crashed.request("listDocuments");
    crashed.saveAudio(saveMainPort as unknown as MessagePortMain, {
      cacheKey: JSON.stringify(["crashed-document", "section-1"]),
      documentId: "crashed-document",
      sectionId: "section-1",
    }, 1);
    crashed.getAudio(
      getMainPort as unknown as MessagePortMain,
      "crashed-document",
      "section-1",
    );

    await expect(refused).rejects.toThrow("Reader library worker is unavailable.");
    expect(await saveFailed).toBe("Reader library worker is unavailable.");
    expect(await getFailed).toBe("Reader library worker is unavailable.");
    expect(saveMainPort.closed).toBe(true);
    expect(getMainPort.closed).toBe(true);
    await crashed.close();
  });

  it("refuses new work once the worker has exited on its own", async () => {
    let markExited = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const crashed = new ReaderLibraryWorkerClient(workerPath, "", () => markExited());
    await exited;

    // Nothing is left to fail these streams later, so an unguarded call would hang
    // until the preload stream timeout rather than reject.
    const [saveMainPort, saveRendererPort] = createPortPair();
    const [getMainPort, getRendererPort] = createPortPair();
    const saveFailed = waitForPortError(saveRendererPort);
    const getFailed = waitForPortError(getRendererPort);
    crashed.saveAudio(saveMainPort as unknown as MessagePortMain, {
      cacheKey: JSON.stringify(["exited-document", "section-1"]),
      documentId: "exited-document",
      sectionId: "section-1",
    }, 1);
    crashed.getAudio(
      getMainPort as unknown as MessagePortMain,
      "exited-document",
      "section-1",
    );

    expect(await saveFailed).toBe("Reader library worker is unavailable.");
    expect(await getFailed).toBe("Reader library worker is unavailable.");
    await expect(crashed.request("listDocuments")).rejects.toThrow(
      "Reader library worker is unavailable.",
    );
    await crashed.close();
  });
});

// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderLibraryDatabase } from "./readerLibraryDatabase";

interface TestDocument {
  id: string;
  title: string;
  text: string;
  updatedAt: number;
  lastOpenedAt: number;
}

function createDocument(id: string, now: number): TestDocument {
  return {
    id,
    title: `Document ${id}`,
    text: `Text for ${id}`,
    updatedAt: now,
    lastOpenedAt: now,
  };
}

function createAudio(documentId: string, sectionId: string, updatedAt: number) {
  const samples = new Float32Array([updatedAt / 10, -0.25]);
  return {
    cacheKey: JSON.stringify([documentId, sectionId]),
    documentId,
    chapterId: "chapter-1",
    sectionId,
    signature: `signature-${updatedAt}`,
    chunks: [{
      audio: samples.buffer,
      samplingRate: 24_000,
      text: "Spoken text.",
      index: 0,
      total: 1,
      textStart: 0,
      textEnd: 12,
      pauseAfterSec: 0.2,
      pauseKind: "sentence" as const,
    }],
    byteLength: samples.byteLength,
    currentTime: 0.5,
    playbackRate: 1.25,
    totalDuration: 1,
    updatedAt,
  };
}

describe("ReaderLibraryDatabase", () => {
  let directory: string;
  let database: ReaderLibraryDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "open-tts-reader-library-"));
    database = new ReaderLibraryDatabase(path.join(directory, "reader-library.sqlite3"));
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("persists sorted documents and active state", () => {
    database.saveDocument(createDocument("older", 100));
    database.saveDocument(createDocument("newer", 200));
    database.setActiveDocumentId("older");

    expect(database.listDocuments().map((document) => document.id)).toEqual(["newer", "older"]);
    expect(database.getDocument("older")?.text).toBe("Text for older");
    expect(database.getActiveDocumentId()).toBe("older");
  });

  it("does not let stale document writes overwrite a newer snapshot", () => {
    database.saveDocument({ ...createDocument("ordered", 200), text: "Newest text" });
    database.saveDocument({ ...createDocument("ordered", 100), text: "Stale text" });

    expect(database.getDocument("ordered")?.text).toBe("Newest text");
  });

  it("lets an equal-timestamp document write win, matching the IndexedDB backend", () => {
    database.saveDocument({ ...createDocument("ordered", 200), text: "First text" });
    database.saveDocument({ ...createDocument("ordered", 200), text: "Equal-timestamp text" });

    expect(database.getDocument("ordered")?.text).toBe("Equal-timestamp text");
  });

  it("orders whole-document snapshots by progress updates and merges open recency", () => {
    const document = createDocument("progress", 100);
    database.saveDocument({
      ...document,
      progress: { textOffset: 20, updatedAt: 300 },
    });
    database.close();
    const raw = new DatabaseSync(path.join(directory, "reader-library.sqlite3"));
    raw.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").run(100, document.id);
    raw.close();
    database = new ReaderLibraryDatabase(path.join(directory, "reader-library.sqlite3"));
    database.saveDocument({
      ...document,
      lastOpenedAt: 400,
      progress: { textOffset: 5, updatedAt: 200 },
    });

    expect(database.getDocument("progress")).toMatchObject({
      lastOpenedAt: 400,
      progress: { textOffset: 20, updatedAt: 300 },
    });
  });

  it("closes its connection when schema initialization fails", () => {
    const newerPath = path.join(directory, "newer.sqlite3");
    const newer = new DatabaseSync(newerPath);
    newer.exec("PRAGMA user_version = 2");
    newer.close();

    expect(() => new ReaderLibraryDatabase(newerPath)).toThrow(/newer than supported/i);

    const reopened = new DatabaseSync(newerPath);
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    reopened.close();
  });

  it("can replace a damaged stored JSON record with a newer snapshot", () => {
    const databasePath = path.join(directory, "reader-library.sqlite3");
    database.saveDocument(createDocument("repairable", 100));
    database.close();
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE documents SET record_json = ? WHERE id = ?").run("{", "repairable");
    raw.close();
    database = new ReaderLibraryDatabase(databasePath);

    database.saveDocument({ ...createDocument("repairable", 200), text: "Repaired text" });

    expect(database.getDocument("repairable")?.text).toBe("Repaired text");
  });

  it("round-trips binary audio, rejects stale cache writes, and cascades document deletion", () => {
    database.saveDocument(createDocument("audio-doc", 100));
    database.saveAudio(createAudio("audio-doc", "section-1", 200));
    database.saveAudio(createAudio("audio-doc", "section-1", 100));

    const restored = database.getAudio("audio-doc", "section-1");
    expect(restored?.signature).toBe("signature-200");
    expect(restored?.playbackRate).toBe(1.25);
    expect([...new Float32Array(restored!.chunks[0].audio)]).toEqual([
      expect.closeTo(20),
      expect.closeTo(-0.25),
    ]);

    database.deleteDocument("audio-doc");
    expect(database.getDocument("audio-doc")).toBeNull();
    expect(database.getAudio("audio-doc", "section-1")).toBeNull();
    expect(database.getActiveDocumentId()).toBeNull();
  });

  it("lets an equal-timestamp audio write win, matching the IndexedDB backend", () => {
    database.saveAudio(createAudio("audio-doc", "section-1", 200));
    database.saveAudio({
      ...createAudio("audio-doc", "section-1", 200),
      signature: "equal-timestamp-latest",
    });

    expect(database.getAudio("audio-doc", "section-1")?.signature).toBe("equal-timestamp-latest");
  });

  it("reports the original failure when a transaction cannot roll back", async () => {
    class RollbackFailureDatabase {
      exec(sql: string): void {
        if (sql === "ROLLBACK") throw new Error("cannot rollback - no transaction is active");
      }

      prepare(sql: string) {
        if (sql.includes("user_version")) {
          return { get: () => ({ user_version: 1 }), run: () => undefined, all: () => [] };
        }
        const fail = () => {
          throw new Error("disk I/O error");
        };
        return { get: fail, run: fail, all: fail };
      }

      close(): void {}
    }

    vi.resetModules();
    vi.doMock("node:sqlite", () => ({ DatabaseSync: RollbackFailureDatabase }));
    try {
      const { ReaderLibraryDatabase: IsolatedDatabase } = await import("./readerLibraryDatabase");
      const isolated = new IsolatedDatabase(path.join(directory, "unused.sqlite3"));

      expect(() => isolated.saveAudio(createAudio("audio-doc", "section-1", 200))).toThrow(/disk I\/O error/);
    } finally {
      vi.doUnmock("node:sqlite");
      vi.resetModules();
    }
  });

  it("prunes the least-recently-written audio at the shared entry limit", () => {
    for (let index = 0; index < 97; index += 1) {
      database.saveAudio(createAudio("quota-doc", `section-${index}`, index));
    }

    expect(database.getAudio("quota-doc", "section-0")).toBeNull();
    expect(database.getAudio("quota-doc", "section-96")?.signature).toBe("signature-96");
  });

  it("validates renderer-controlled document and audio payloads", () => {
    expect(() => database.saveDocument({ id: "missing-fields" })).toThrow(/title/i);
    expect(() => database.getDocument("")).toThrow(/non-empty string/i);
    expect(() => database.saveAudio({
      ...createAudio("doc", "section", 1),
      chunks: [{ audio: "not binary" }],
    })).toThrow(/binary audio data/i);
  });
});

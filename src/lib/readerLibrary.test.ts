import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildReaderSections,
  createReaderAudioCacheKey,
  createReaderDocument,
  type CachedReaderAudio,
  type ReaderDocumentRecord,
} from "./readerDocument";
import {
  clearReaderLibraryForTests,
  deleteReaderDocument,
  getActiveReaderDocumentId,
  getCachedReaderAudio,
  getReaderDocument,
  listReaderDocuments,
  openReaderLibrary,
  saveCachedReaderAudio,
  saveReaderDocument,
  setActiveReaderDocumentId,
} from "./readerLibrary";

async function seedVersionOneDatabase(document: ReaderDocumentRecord): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("open-tts-reader-library", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      const documents = database.createObjectStore("documents", { keyPath: "id" });
      documents.createIndex("lastOpenedAt", "lastOpenedAt");
      documents.createIndex("updatedAt", "updatedAt");
      database.createObjectStore("audio", { keyPath: "documentId" });
      database.createObjectStore("settings", { keyPath: "key" });
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to create v1 Reader database."));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["documents", "audio"], "readwrite");
      transaction.objectStore("documents").put(document);
      transaction.objectStore("audio").put({
        documentId: document.id,
        chunks: [new Uint8Array(1024).buffer],
        updatedAt: 100,
      });
      transaction.onerror = () => reject(transaction.error ?? new Error("Failed to seed v1 Reader database."));
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
    };
  });
}

async function putRawDocument(record: unknown): Promise<void> {
  const database = await openReaderLibrary();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("documents", "readwrite");
    transaction.objectStore("documents").put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Failed to write raw document."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Raw document write was aborted."));
  });
  database.close();
}

async function openBlockingVersionTwoDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("open-tts-reader-library", 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      const documents = database.createObjectStore("documents", { keyPath: "id" });
      documents.createIndex("lastOpenedAt", "lastOpenedAt");
      documents.createIndex("updatedAt", "updatedAt");
      database.createObjectStore("audio", { keyPath: "documentId" });
      const audio = database.createObjectStore("chapter-audio", { keyPath: "cacheKey" });
      audio.createIndex("documentId", "documentId");
      audio.createIndex("updatedAt", "updatedAt");
      const metadata = database.createObjectStore("chapter-audio-meta", { keyPath: "cacheKey" });
      metadata.createIndex("documentId", "documentId");
      metadata.createIndex("updatedAt", "updatedAt");
      database.createObjectStore("settings", { keyPath: "key" });
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open blocking v2 database."));
    request.onsuccess = () => resolve(request.result);
  });
}

describe("readerLibrary", () => {
  beforeEach(async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    await clearReaderLibraryForTests();
  });

  it("stores and sorts independent document records by recency", async () => {
    const older = createReaderDocument({ id: "older", text: "Older text", now: 100 });
    const newer = createReaderDocument({ id: "newer", text: "Newer text", now: 200 });
    await saveReaderDocument(older);
    await saveReaderDocument(newer);
    expect((await listReaderDocuments()).map((document) => document.id)).toEqual(["newer", "older"]);
    expect((await getReaderDocument("older"))?.text).toBe("Older text");
  });

  it("persists the active document independently", async () => {
    await setActiveReaderDocumentId("doc-2");
    expect(await getActiveReaderDocumentId()).toBe("doc-2");
  });

  it("upgrades a v1 library without rewriting or losing the book", async () => {
    const original = createReaderDocument({
      id: "legacy-v1",
      title: "Preserved book",
      text: "Legacy book text. ".repeat(900),
      now: 100,
    });
    const legacy = {
      ...original,
      progress: {
        positionSec: 4,
        totalDurationSec: 20,
        textOffset: 9_000,
        chapterId: original.chapters[0].id,
        percent: 50,
        updatedAt: 150,
      },
    } as unknown as ReaderDocumentRecord;
    await seedVersionOneDatabase(legacy);

    const database = await openReaderLibrary();
    expect([...database.objectStoreNames]).toEqual(expect.arrayContaining([
      "documents",
      "chapter-audio",
      "chapter-audio-meta",
      "settings",
    ]));
    expect(database.objectStoreNames.contains("audio")).toBe(false);
    database.close();

    const [migrated] = await listReaderDocuments();
    expect(migrated.id).toBe(original.id);
    expect(migrated.title).toBe("Preserved book");
    expect(migrated.text).toBe(original.text);
    expect(migrated.progress.sectionId).toBeTruthy();
  });

  it("round-trips cached PCM audio and deletes it with the document", async () => {
    const document = createReaderDocument({ id: "audio-doc", text: "Audio text" });
    await saveReaderDocument(document);
    const section = buildReaderSections(document.text, document.chapters)[0];
    const cache: CachedReaderAudio = {
      cacheKey: createReaderAudioCacheKey(document.id, section.id),
      documentId: document.id,
      chapterId: section.chapterId,
      sectionId: section.id,
      signature: "signature",
      chunks: [{
        audio: new Float32Array([0.1, -0.2]).buffer,
        samplingRate: 24_000,
        text: "Audio text",
        index: 0,
        total: 1,
      }],
      byteLength: 8,
      currentTime: 0.5,
      playbackRate: 1.25,
      totalDuration: 1,
      updatedAt: 300,
    };
    await saveCachedReaderAudio(cache);
    const restored = await getCachedReaderAudio(document.id, section.id);
    expect(restored?.playbackRate).toBe(1.25);
    expect(restored).not.toBeNull();
    expect([...new Float32Array(restored!.chunks[0].audio)]).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(-0.2),
    ]);
    await deleteReaderDocument(document.id);
    expect(await getReaderDocument(document.id)).toBeNull();
    expect(await getCachedReaderAudio(document.id, section.id)).toBeNull();
  });

  it("keeps independently generated sections for the same book", async () => {
    const text = `${"First chapter paragraph. ".repeat(500)}\n\n${"Later paragraph. ".repeat(500)}`;
    const document = createReaderDocument({ id: "sectioned-audio", text });
    const sections = buildReaderSections(document.text, document.chapters);
    expect(sections.length).toBeGreaterThan(1);

    for (const [index, section] of sections.slice(0, 2).entries()) {
      const audio = new Float32Array([index + 0.1]).buffer;
      await saveCachedReaderAudio({
        cacheKey: createReaderAudioCacheKey(document.id, section.id),
        documentId: document.id,
        chapterId: section.chapterId,
        sectionId: section.id,
        signature: `signature-${index}`,
        chunks: [{ audio, samplingRate: 24_000, text: "section", index: 0, total: 1 }],
        byteLength: audio.byteLength,
        currentTime: 0,
        playbackRate: 1,
        totalDuration: 1,
        updatedAt: 300 + index,
      });
    }

    expect((await getCachedReaderAudio(document.id, sections[0].id))?.signature).toBe("signature-0");
    expect((await getCachedReaderAudio(document.id, sections[1].id))?.signature).toBe("signature-1");
  });

  it("does not let an older debounced audio snapshot replace a final flush", async () => {
    const document = createReaderDocument({ id: "ordered-audio", text: "Ordered audio." });
    const section = buildReaderSections(document.text, document.chapters)[0];
    const makeCache = (signature: string, updatedAt: number): CachedReaderAudio => ({
      cacheKey: createReaderAudioCacheKey(document.id, section.id),
      documentId: document.id,
      chapterId: section.chapterId,
      sectionId: section.id,
      signature,
      chunks: [{
        audio: new Float32Array([updatedAt]).buffer,
        samplingRate: 24_000,
        text: document.text,
        index: 0,
        total: 1,
      }],
      byteLength: 4,
      currentTime: 0,
      playbackRate: 1,
      totalDuration: 1,
      updatedAt,
    });

    await saveCachedReaderAudio(makeCache("final", 200));
    await saveCachedReaderAudio(makeCache("stale", 100));

    expect((await getCachedReaderAudio(document.id, section.id))?.signature).toBe("final");
  });

  it("skips a corrupt document record without hiding healthy books", async () => {
    const healthy = createReaderDocument({ id: "healthy", text: "Healthy book text." });
    await saveReaderDocument(healthy);
    await putRawDocument({ id: "corrupt", title: "Broken", text: null });

    expect((await listReaderDocuments()).map((document) => document.id)).toEqual(["healthy"]);
    expect(await getReaderDocument("corrupt")).toBeNull();
  });

  it("rejects a blocked upgrade instead of leaving Reader loading forever", async () => {
    const blocker = await openBlockingVersionTwoDatabase();
    await expect(openReaderLibrary()).rejects.toThrow(/blocked by another open tab/i);
    blocker.close();
  });

  it("prunes the least-recently-written persistent audio entry at the entry limit", async () => {
    const document = createReaderDocument({ id: "quota-audio", text: "Quota test." });
    for (let index = 0; index < 97; index += 1) {
      const audio = new Float32Array([index]).buffer;
      await saveCachedReaderAudio({
        cacheKey: createReaderAudioCacheKey(document.id, `section-${index}`),
        documentId: document.id,
        chapterId: "chapter-1",
        sectionId: `section-${index}`,
        signature: `signature-${index}`,
        chunks: [{ audio, samplingRate: 24_000, text: "section", index: 0, total: 1 }],
        byteLength: audio.byteLength,
        currentTime: 0,
        playbackRate: 1,
        totalDuration: 1,
        updatedAt: index,
      });
    }

    expect(await getCachedReaderAudio(document.id, "section-0")).toBeNull();
    expect((await getCachedReaderAudio(document.id, "section-96"))?.signature).toBe("signature-96");
  });
});

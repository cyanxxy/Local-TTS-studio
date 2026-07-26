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
  getActiveReaderDocumentId,
  getCachedReaderAudio,
  isReaderLibrarySupported,
  isReaderLibraryShutdownError,
  listReaderDocuments,
  openReaderLibrary,
  saveCachedReaderAudio,
  saveReaderDocument,
  setActiveReaderDocumentId,
} from "./readerLibrary";

type DesktopBridge = NonNullable<NonNullable<Window["electron"]>["readerLibrary"]>;

// Mirrors the private marker in readerLibrary.ts; asserting on the literal
// pins the key, because renaming it would silently re-run a shipped import.
const IMPORT_MARKER_KEY = "open-tts-reader-import-v1";

function installDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  const documents = new Map<string, ReaderDocumentRecord>();
  let activeDocumentId: string | null = null;
  const bridge: DesktopBridge = {
    listDocuments: vi.fn(async () => [...documents.values()]),
    getDocument: vi.fn(async (id) => documents.get(id) ?? null),
    saveDocument: vi.fn(async (document) => {
      const record = document as ReaderDocumentRecord;
      documents.set(record.id, record);
    }),
    deleteDocument: vi.fn(async (id) => {
      documents.delete(id);
    }),
    getActiveDocumentId: vi.fn(async () => activeDocumentId),
    setActiveDocumentId: vi.fn(async (id) => {
      activeDocumentId = id;
    }),
    saveAudio: vi.fn(async () => undefined),
    getAudio: vi.fn(async () => null),
    deleteAudio: vi.fn(async () => undefined),
    ...overrides,
  };
  window.electron = { isElectron: true, readerLibrary: bridge };
  return bridge;
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
      request.result.createObjectStore("documents", { keyPath: "id" });
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open blocking v2 database."));
    request.onsuccess = () => resolve(request.result);
  });
}

describe("desktop Reader library adapter", () => {
  beforeEach(async () => {
    delete window.electron;
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    await clearReaderLibraryForTests();
  });

  it("reads documents and active state directly from the SQLite bridge", async () => {
    const document = createReaderDocument({ id: "sqlite-book", text: "Local SQLite book.", now: 100 });
    const bridge = installDesktopBridge({
      listDocuments: vi.fn(async () => [document]),
      getActiveDocumentId: vi.fn(async () => document.id),
    });

    expect((await listReaderDocuments()).map((entry) => entry.id)).toEqual([document.id]);
    expect(await getActiveReaderDocumentId()).toBe(document.id);
    expect(bridge.listDocuments).toHaveBeenCalledOnce();
  });

  it("uses SQLite even when IndexedDB is unavailable", async () => {
    const document = createReaderDocument({ id: "sqlite-book", text: "SQLite-backed book.", now: 200 });
    vi.stubGlobal("indexedDB", undefined);
    const bridge = installDesktopBridge({
      listDocuments: vi.fn(async () => [document]),
    });

    expect(isReaderLibrarySupported()).toBe(true);
    expect((await listReaderDocuments())[0].id).toBe(document.id);
    expect(bridge.listDocuments).toHaveBeenCalledOnce();
    // Nothing to import from, so the legacy scan must not be attempted at all.
    expect(bridge.saveDocument).not.toHaveBeenCalled();
    expect(localStorage.getItem(IMPORT_MARKER_KEY)).toBeNull();
  });

  it("routes generated audio through the desktop bridge with a canonical cache key", async () => {
    const document = createReaderDocument({ id: "audio-book", text: "Audio-backed book.", now: 300 });
    const section = buildReaderSections(document.text, document.chapters)[0];
    const audio: CachedReaderAudio = {
      cacheKey: "stale-key",
      documentId: document.id,
      chapterId: section.chapterId,
      sectionId: section.id,
      signature: "signature",
      chunks: [{
        audio: new Float32Array([0.1, -0.2]).buffer,
        samplingRate: 24_000,
        text: document.text,
        index: 0,
        total: 1,
      }],
      byteLength: 0,
      currentTime: 0,
      playbackRate: 1,
      totalDuration: 1,
      updatedAt: 300,
    };
    const bridge = installDesktopBridge({
      getAudio: vi.fn(async () => audio),
    });

    await saveCachedReaderAudio(audio);
    expect(bridge.saveAudio).toHaveBeenCalledWith(expect.objectContaining({
      cacheKey: createReaderAudioCacheKey(document.id, section.id),
      byteLength: 8,
    }));
    expect(await getCachedReaderAudio(document.id, section.id)).toBe(audio);
  });

  it("treats a malformed bridge audio payload as a cache miss", async () => {
    const valid: CachedReaderAudio = {
      cacheKey: createReaderAudioCacheKey("malformed-book", "section-1"),
      documentId: "malformed-book",
      chapterId: "chapter-1",
      sectionId: "section-1",
      signature: "signature",
      chunks: [{
        audio: new Float32Array([0.5]).buffer,
        samplingRate: 24_000,
        text: "Section text.",
        index: 0,
        total: 1,
      }],
      byteLength: 4,
      currentTime: 0,
      playbackRate: 1,
      totalDuration: 1,
      updatedAt: 400,
    };
    const payloads: unknown[] = [
      null,
      "not-an-object",
      { ...valid, chunks: undefined },
      { ...valid, chunks: {} },
      { ...valid, chunks: [{ ...valid.chunks[0], audio: new Uint8Array([1, 2, 3, 4]) }] },
      { ...valid, chunks: [{ ...valid.chunks[0], samplingRate: "24000" }] },
      { ...valid, chunks: [{ ...valid.chunks[0], index: Number.NaN }] },
      { ...valid, chunks: [{ ...valid.chunks[0], pauseKind: "hesitation" }] },
      { ...valid, chapterId: undefined },
      { ...valid, signature: 7 },
      { ...valid, updatedAt: Number.POSITIVE_INFINITY },
      { ...valid, byteLength: null },
    ];

    for (const [index, payload] of payloads.entries()) {
      installDesktopBridge({ getAudio: vi.fn(async () => payload) });
      expect(await getCachedReaderAudio(valid.documentId, valid.sectionId), `payload ${index}`).toBeNull();
    }

    installDesktopBridge({ getAudio: vi.fn(async () => valid) });
    expect(await getCachedReaderAudio(valid.documentId, valid.sectionId)).toBe(valid);
  });
});

describe("legacy IndexedDB import into the desktop library", () => {
  beforeEach(async () => {
    delete window.electron;
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    await clearReaderLibraryForTests();
  });

  it("copies the pre-upgrade books and selection into SQLite on the first read", async () => {
    const older = createReaderDocument({ id: "legacy-older", text: "Older legacy book.", now: 100 });
    const newer = createReaderDocument({ id: "legacy-newer", text: "Newer legacy book.", now: 200 });
    await saveReaderDocument(older);
    await saveReaderDocument(newer);
    await setActiveReaderDocumentId(older.id);

    const bridge = installDesktopBridge();
    expect((await listReaderDocuments()).map((entry) => entry.id)).toEqual(["legacy-newer", "legacy-older"]);
    expect(await getActiveReaderDocumentId()).toBe(older.id);
    expect(localStorage.getItem(IMPORT_MARKER_KEY)).not.toBeNull();
    // The books stay in IndexedDB so downgrading to an older build still works.
    delete window.electron;
    expect((await listReaderDocuments()).map((entry) => entry.id)).toEqual(["legacy-newer", "legacy-older"]);
    expect(bridge.deleteDocument).not.toHaveBeenCalled();
  });

  it("keeps a selection SQLite already holds instead of the pre-upgrade one", async () => {
    const legacy = createReaderDocument({ id: "legacy-active", text: "Legacy book.", now: 100 });
    await saveReaderDocument(legacy);
    await setActiveReaderDocumentId(legacy.id);

    const bridge = installDesktopBridge({ getActiveDocumentId: vi.fn(async () => "sqlite-active") });
    await listReaderDocuments();
    expect(bridge.saveDocument).toHaveBeenCalledOnce();
    expect(bridge.setActiveDocumentId).not.toHaveBeenCalled();
  });

  it("skips a corrupt legacy record and never adopts it as the selection", async () => {
    const healthy = createReaderDocument({ id: "legacy-healthy", text: "Healthy legacy book.", now: 100 });
    await saveReaderDocument(healthy);
    await putRawDocument({ id: "legacy-corrupt", title: "Broken", text: null });
    await setActiveReaderDocumentId("legacy-corrupt");

    const bridge = installDesktopBridge();
    expect((await listReaderDocuments()).map((entry) => entry.id)).toEqual([healthy.id]);
    expect(bridge.saveDocument).toHaveBeenCalledOnce();
    // Pointing SQLite at a book the import could not carry over would strand
    // the Reader on a document it cannot load.
    expect(bridge.setActiveDocumentId).not.toHaveBeenCalled();
    expect(localStorage.getItem(IMPORT_MARKER_KEY)).not.toBeNull();
  });

  it("marks an empty legacy database imported so later launches skip the scan", async () => {
    const bridge = installDesktopBridge();
    expect(await listReaderDocuments()).toEqual([]);
    expect(bridge.saveDocument).not.toHaveBeenCalled();
    expect(localStorage.getItem(IMPORT_MARKER_KEY)).not.toBeNull();
  });

  it("runs once per install: the marker stops the next launch re-importing", async () => {
    const document = createReaderDocument({ id: "legacy-once", text: "Imported once.", now: 100 });
    await saveReaderDocument(document);

    const first = installDesktopBridge();
    expect((await listReaderDocuments()).map((entry) => entry.id)).toEqual([document.id]);
    expect(first.saveDocument).toHaveBeenCalledOnce();

    // A fresh module instance stands in for the next launch, so only the
    // persisted marker can hold the import back.
    vi.resetModules();
    const relaunched = await import("./readerLibrary");
    const second = installDesktopBridge({ listDocuments: vi.fn(async () => [document]) });
    expect((await relaunched.listReaderDocuments()).map((entry) => entry.id)).toEqual([document.id]);
    expect(second.saveDocument).not.toHaveBeenCalled();
  });

  it("shares one attempt between concurrent readers", async () => {
    const document = createReaderDocument({ id: "legacy-concurrent", text: "Concurrent read.", now: 100 });
    await saveReaderDocument(document);

    const bridge = installDesktopBridge();
    const [first, second] = await Promise.all([listReaderDocuments(), listReaderDocuments()]);
    expect(first.map((entry) => entry.id)).toEqual([document.id]);
    expect(second.map((entry) => entry.id)).toEqual([document.id]);
    expect(bridge.saveDocument).toHaveBeenCalledOnce();
  });

  it("still returns the SQLite library when the import fails, and retries next launch", async () => {
    const legacy = createReaderDocument({ id: "legacy-unimported", text: "Legacy book.", now: 100 });
    await saveReaderDocument(legacy);
    const sqlite = createReaderDocument({ id: "sqlite-book", text: "SQLite book.", now: 200 });
    const failing = {
      listDocuments: vi.fn(async () => [sqlite]),
      saveDocument: vi.fn(async () => {
        throw new Error("Reader library worker is unavailable.");
      }),
    };

    const bridge = installDesktopBridge(failing);
    expect((await listReaderDocuments()).map((entry) => entry.id)).toEqual([sqlite.id]);
    expect(bridge.saveDocument).toHaveBeenCalledOnce();
    expect(localStorage.getItem(IMPORT_MARKER_KEY)).toBeNull();

    vi.resetModules();
    const relaunched = await import("./readerLibrary");
    const retry = installDesktopBridge({ listDocuments: vi.fn(async () => [sqlite]) });
    expect((await relaunched.listReaderDocuments()).map((entry) => entry.id)).toEqual([sqlite.id]);
    expect(retry.saveDocument).toHaveBeenCalledWith(expect.objectContaining({ id: legacy.id }));
    expect(localStorage.getItem(IMPORT_MARKER_KEY)).not.toBeNull();
  });

  it("degrades quietly when the legacy database cannot be opened", async () => {
    const sqlite = createReaderDocument({ id: "sqlite-book", text: "SQLite book.", now: 200 });
    const bridge = installDesktopBridge({ listDocuments: vi.fn(async () => [sqlite]) });
    // A second window holding the old version open blocks the v3 upgrade.
    const blocker = await openBlockingVersionTwoDatabase();

    expect((await listReaderDocuments()).map((entry) => entry.id)).toEqual([sqlite.id]);
    expect(bridge.saveDocument).not.toHaveBeenCalled();
    expect(localStorage.getItem(IMPORT_MARKER_KEY)).toBeNull();
    blocker.close();
  });

  it("never touches the desktop bridge on the web build", async () => {
    const document = createReaderDocument({ id: "web-book", text: "Web book.", now: 100 });
    await saveReaderDocument(document);
    const bridge = installDesktopBridge();
    delete window.electron;

    expect((await listReaderDocuments()).map((entry) => entry.id)).toEqual([document.id]);
    expect(bridge.listDocuments).not.toHaveBeenCalled();
    expect(bridge.saveDocument).not.toHaveBeenCalled();
    expect(localStorage.getItem(IMPORT_MARKER_KEY)).toBeNull();
  });
});

describe("isReaderLibraryShutdownError", () => {
  // The document channels reach the renderer through ipcRenderer.invoke, which
  // re-wraps the main-process message; the audio stream ports deliver it bare.
  const wrap = (message: string) => (
    `Error invoking remote method 'reader-library:save-document': Error: ${message}`
  );

  it("matches both main-process producers, bare and re-wrapped by IPC", () => {
    for (const message of [
      // electron/readerLibraryWorkerClient.ts
      "Reader library worker is shutting down.",
      // electron/main.ts
      "Reader library is shutting down.",
    ]) {
      expect(isReaderLibraryShutdownError(new Error(message)), message).toBe(true);
      expect(isReaderLibraryShutdownError(new Error(wrap(message))), wrap(message)).toBe(true);
    }
  });

  it("reads the message structurally so a cross-realm rejection still matches", () => {
    expect(isReaderLibraryShutdownError({ message: "Reader library is shutting down." })).toBe(true);
    expect(isReaderLibraryShutdownError("Reader library worker is shutting down.")).toBe(true);
  });

  it("does not match a crashed worker, an unrelated failure, or a non-error", () => {
    for (const cause of [
      // The crash path reports the exit code instead, so a real fault is still shown.
      new Error("Reader library worker exited with code 1."),
      // Work handed to an already-dead worker is refused with this, also unsilenced.
      new Error("Reader library worker is unavailable."),
      new Error("Reader library request failed."),
      // A different subsystem's shutdown must not silence the Reader library.
      new Error("The local runtime is shutting down."),
      new Error("Database is locked."),
      new Error(""),
      "",
      null,
      undefined,
      42,
      {},
      { message: 42 },
      ["Reader library is shutting down."],
    ]) {
      expect(isReaderLibraryShutdownError(cause), String(cause)).toBe(false);
    }
  });
});

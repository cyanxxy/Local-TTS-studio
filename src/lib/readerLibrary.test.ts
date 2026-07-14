import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReaderDocument, type CachedReaderAudio } from "./readerDocument";
import {
  clearReaderLibraryForTests,
  deleteReaderDocument,
  getActiveReaderDocumentId,
  getCachedReaderAudio,
  getReaderDocument,
  listReaderDocuments,
  saveCachedReaderAudio,
  saveReaderDocument,
  setActiveReaderDocumentId,
} from "./readerLibrary";

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

  it("round-trips cached PCM audio and deletes it with the document", async () => {
    const document = createReaderDocument({ id: "audio-doc", text: "Audio text" });
    await saveReaderDocument(document);
    const cache: CachedReaderAudio = {
      documentId: document.id,
      signature: "signature",
      chunks: [{
        audio: new Float32Array([0.1, -0.2]).buffer,
        samplingRate: 24_000,
        text: "Audio text",
        index: 0,
        total: 1,
      }],
      currentTime: 0.5,
      playbackRate: 1.25,
      totalDuration: 1,
      updatedAt: 300,
    };
    await saveCachedReaderAudio(cache);
    const restored = await getCachedReaderAudio(document.id);
    expect(restored?.playbackRate).toBe(1.25);
    expect(restored).not.toBeNull();
    expect([...new Float32Array(restored!.chunks[0].audio)]).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(-0.2),
    ]);
    await deleteReaderDocument(document.id);
    expect(await getReaderDocument(document.id)).toBeNull();
    expect(await getCachedReaderAudio(document.id)).toBeNull();
  });
});

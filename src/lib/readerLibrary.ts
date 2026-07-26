import {
  createReaderAudioCacheKey,
  getCachedReaderAudioByteLength,
  normalizeReaderDocumentRecord,
  type CachedReaderAudio,
  type CachedReaderAudioChunk,
  type ReaderDocumentRecord,
} from "./readerDocument";

const DB_NAME = "open-tts-reader-library";
const DB_VERSION = 3;
const DOCUMENTS_STORE = "documents";
const LEGACY_AUDIO_STORE = "audio";
const CHAPTER_AUDIO_STORE = "chapter-audio";
const CHAPTER_AUDIO_META_STORE = "chapter-audio-meta";
const SETTINGS_STORE = "settings";
const ACTIVE_DOCUMENT_KEY = "active-document-id";
const LEGACY_IMPORT_STORAGE_KEY = "open-tts-reader-import-v1";
export const MAX_READER_AUDIO_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_READER_AUDIO_CACHE_ENTRIES = 96;
export const MAX_READER_AUDIO_MEMORY_CACHE_BYTES = 192 * 1024 * 1024;
export const MAX_READER_AUDIO_MEMORY_CACHE_ENTRIES = 12;
const READER_PAUSE_KINDS: readonly unknown[] = ["none", "comma", "sentence", "paragraph"];

interface ReaderSettingRecord {
  key: string;
  value: string;
}

interface ReaderAudioMetadata {
  cacheKey: string;
  documentId: string;
  chapterId: string;
  sectionId: string;
  byteLength: number;
  updatedAt: number;
}

type DesktopReaderLibraryBridge = NonNullable<NonNullable<Window["electron"]>["readerLibrary"]>;

let legacyReaderImport: Promise<void> | null = null;

function getDesktopReaderLibraryBridge(): DesktopReaderLibraryBridge | null {
  return typeof window !== "undefined" ? window.electron?.readerLibrary ?? null : null;
}

function isIndexedDbSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}

export function isReaderLibrarySupported(): boolean {
  return getDesktopReaderLibraryBridge() !== null || isIndexedDbSupported();
}

// The only signal a shutdown rejection carries is its text. `ipcMain.handle`
// rejections reach the renderer re-wrapped as
// `Error invoking remote method '<channel>': Error: <message>`, and the audio
// stream ports carry the bare string, so neither transport preserves a
// structured code and this has to stay a message match. Both producers live in
// the main process — keep this in sync with:
//   - electron/readerLibraryWorkerClient.ts ("Reader library worker is shutting down.")
//   - electron/main.ts                      ("Reader library is shutting down.")
const READER_LIBRARY_SHUTDOWN_MESSAGE = /Reader library (?:worker )?is shutting down\./;

function readerLibraryErrorText(cause: unknown): string {
  if (typeof cause === "string") return cause;
  // A rejection crosses a realm boundary on the way here, where `instanceof
  // Error` no longer recognizes a real error, so read `message` structurally.
  if (typeof cause !== "object" || cause === null) return "";
  const { message } = cause as { message?: unknown };
  return typeof message === "string" ? message : "";
}

/**
 * Quitting holds the window open for a couple of seconds while the desktop
 * Reader worker drains, and every call still in flight rejects during that
 * window. Those writes are moot once the app is closing, so callers drop the
 * rejection instead of flashing an error the user has no way to act on.
 *
 * A crashed worker reports a different message — `Reader library worker exited
 * with code N.` for the work it was holding when it died, `Reader library
 * worker is unavailable.` for work handed to it afterwards, or the underlying
 * failure verbatim — so a real fault still reaches the user.
 */
export function isReaderLibraryShutdownError(cause: unknown): boolean {
  return READER_LIBRARY_SHUTDOWN_MESSAGE.test(readerLibraryErrorText(cause));
}

export async function openReaderLibrary(): Promise<IDBDatabase> {
  if (!isIndexedDbSupported()) {
    throw new Error("This browser does not provide IndexedDB, so the document library cannot persist.");
  }

  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (database.objectStoreNames.contains(LEGACY_AUDIO_STORE)) {
      database.deleteObjectStore(LEGACY_AUDIO_STORE);
    }
    if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
      const documents = database.createObjectStore(DOCUMENTS_STORE, { keyPath: "id" });
      documents.createIndex("lastOpenedAt", "lastOpenedAt");
      documents.createIndex("updatedAt", "updatedAt");
    }
    if (!database.objectStoreNames.contains(CHAPTER_AUDIO_STORE)) {
      const audio = database.createObjectStore(CHAPTER_AUDIO_STORE, { keyPath: "cacheKey" });
      audio.createIndex("documentId", "documentId");
      audio.createIndex("updatedAt", "updatedAt");
    }
    if (!database.objectStoreNames.contains(CHAPTER_AUDIO_META_STORE)) {
      const metadata = database.createObjectStore(CHAPTER_AUDIO_META_STORE, { keyPath: "cacheKey" });
      metadata.createIndex("documentId", "documentId");
      metadata.createIndex("updatedAt", "updatedAt");
    }
    if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
      database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
    }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("Failed to open the Reader library."));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Reader library upgrade is blocked by another open tab. Close the other tab and try again."));
    };
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openReaderLibrary();
  try {
    const transaction = database.transaction(storeName, mode);
    const result = await requestResult(operation(transaction.objectStore(storeName)));
    await transactionDone(transaction);
    return result;
  } finally {
    database.close();
  }
}

function normalizeDocumentRecords(records: readonly unknown[]): ReaderDocumentRecord[] {
  const documents: ReaderDocumentRecord[] = [];
  for (const record of records) {
    if (
      !record
      || typeof record !== "object"
      || typeof (record as Partial<ReaderDocumentRecord>).id !== "string"
      || typeof (record as Partial<ReaderDocumentRecord>).title !== "string"
      || typeof (record as Partial<ReaderDocumentRecord>).text !== "string"
    ) continue;
    try {
      documents.push(normalizeReaderDocumentRecord(record as ReaderDocumentRecord));
    } catch {
      // A single damaged persistent value must not hide every healthy book.
    }
  }
  return documents.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.updatedAt - a.updatedAt);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  // PCM rehydrated from IndexedDB or the desktop bridge is deserialized in
  // another realm, where `instanceof` no longer recognizes a real buffer.
  return value instanceof ArrayBuffer
    || Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function isCachedReaderAudioChunk(value: unknown): value is CachedReaderAudioChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as Record<string, unknown>;
  return isArrayBuffer(chunk.audio)
    && isFiniteNumber(chunk.samplingRate)
    && typeof chunk.text === "string"
    && isFiniteNumber(chunk.index)
    && isFiniteNumber(chunk.total)
    && isOptionalFiniteNumber(chunk.textStart)
    && isOptionalFiniteNumber(chunk.textEnd)
    && isOptionalFiniteNumber(chunk.pauseAfterSec)
    && (chunk.pauseKind === undefined || READER_PAUSE_KINDS.includes(chunk.pauseKind));
}

/**
 * Cached audio is rehydrated across a process or database boundary before it
 * reaches the player, so a truncated or half-assembled payload must degrade to
 * a cache miss the caller can re-synthesize instead of reaching playback.
 * Values are validated, never repaired: callers already recompute `cacheKey`
 * and `byteLength`, so a stale-but-typed value here is harmless while a silent
 * fixup would hide real corruption.
 */
function normalizeCachedReaderAudio(value: unknown): CachedReaderAudio | null {
  if (!value || typeof value !== "object") return null;
  const audio = value as Record<string, unknown>;
  if (
    typeof audio.cacheKey !== "string"
    || typeof audio.documentId !== "string"
    || typeof audio.chapterId !== "string"
    || typeof audio.sectionId !== "string"
    || typeof audio.signature !== "string"
    || !isFiniteNumber(audio.byteLength)
    || !isFiniteNumber(audio.currentTime)
    || !isFiniteNumber(audio.playbackRate)
    || !isFiniteNumber(audio.totalDuration)
    || !isFiniteNumber(audio.updatedAt)
    || !Array.isArray(audio.chunks)
    || !audio.chunks.every(isCachedReaderAudioChunk)
  ) return null;
  return value as CachedReaderAudio;
}

async function listIndexedDbReaderDocuments(): Promise<ReaderDocumentRecord[]> {
  const records = await withStore(DOCUMENTS_STORE, "readonly", (store) => store.getAll()) as unknown[];
  return normalizeDocumentRecords(records);
}

async function getIndexedDbReaderDocument(id: string): Promise<ReaderDocumentRecord | null> {
  const result = await withStore(DOCUMENTS_STORE, "readonly", (store) => store.get(id)) as unknown;
  if (!result || typeof result !== "object") return null;
  try {
    return normalizeReaderDocumentRecord(result as ReaderDocumentRecord);
  } catch {
    return null;
  }
}

async function saveIndexedDbReaderDocument(document: ReaderDocumentRecord): Promise<void> {
  await withStore(DOCUMENTS_STORE, "readwrite", (store) => store.put(document));
}

async function deleteIndexedDbReaderDocument(id: string): Promise<void> {
  const database = await openReaderLibrary();
  try {
    const transaction = database.transaction([
      DOCUMENTS_STORE,
      CHAPTER_AUDIO_STORE,
      CHAPTER_AUDIO_META_STORE,
      SETTINGS_STORE,
    ], "readwrite");
    transaction.objectStore(DOCUMENTS_STORE).delete(id);
    const metadataStore = transaction.objectStore(CHAPTER_AUDIO_META_STORE);
    const metadata = await requestResult(metadataStore.index("documentId").getAll(id)) as ReaderAudioMetadata[];
    for (const entry of metadata) {
      transaction.objectStore(CHAPTER_AUDIO_STORE).delete(entry.cacheKey);
      metadataStore.delete(entry.cacheKey);
    }
    const settingStore = transaction.objectStore(SETTINGS_STORE);
    const active = await requestResult(settingStore.get(ACTIVE_DOCUMENT_KEY)) as ReaderSettingRecord | undefined;
    if (active?.value === id) settingStore.delete(ACTIVE_DOCUMENT_KEY);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function getIndexedDbActiveReaderDocumentId(): Promise<string | null> {
  const record = await withStore(SETTINGS_STORE, "readonly", (store) => store.get(ACTIVE_DOCUMENT_KEY)) as ReaderSettingRecord | undefined;
  return record?.value ?? null;
}

async function setIndexedDbActiveReaderDocumentId(id: string): Promise<void> {
  await withStore(SETTINGS_STORE, "readwrite", (store) => store.put({ key: ACTIVE_DOCUMENT_KEY, value: id }));
}

async function saveIndexedDbCachedReaderAudio(audio: CachedReaderAudio): Promise<void> {
  const cacheKey = createReaderAudioCacheKey(audio.documentId, audio.sectionId);
  const byteLength = getCachedReaderAudioByteLength(audio.chunks);
  const normalized: CachedReaderAudio = { ...audio, cacheKey, byteLength };
  const database = await openReaderLibrary();
  try {
    const transaction = database.transaction([CHAPTER_AUDIO_STORE, CHAPTER_AUDIO_META_STORE], "readwrite");
    const audioStore = transaction.objectStore(CHAPTER_AUDIO_STORE);
    const existing = await requestResult(audioStore.get(cacheKey)) as CachedReaderAudio | undefined;
    // A final section flush can race an older debounced write. Timestamps are
    // monotonic at the caller, so never let the stale snapshot win the race.
    if (!existing || existing.updatedAt <= normalized.updatedAt) {
      audioStore.put(normalized);
      transaction.objectStore(CHAPTER_AUDIO_META_STORE).put({
        cacheKey,
        documentId: normalized.documentId,
        chapterId: normalized.chapterId,
        sectionId: normalized.sectionId,
        byteLength,
        updatedAt: normalized.updatedAt,
      } satisfies ReaderAudioMetadata);
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
  await pruneCachedReaderAudio(cacheKey);
}

async function getIndexedDbCachedReaderAudio(
  documentId: string,
  sectionId: string,
): Promise<CachedReaderAudio | null> {
  const cacheKey = createReaderAudioCacheKey(documentId, sectionId);
  const result = await withStore(CHAPTER_AUDIO_STORE, "readonly", (store) => store.get(cacheKey)) as unknown;
  return normalizeCachedReaderAudio(result);
}

async function deleteIndexedDbCachedReaderAudio(documentId: string, sectionId?: string): Promise<void> {
  const database = await openReaderLibrary();
  try {
    const transaction = database.transaction([CHAPTER_AUDIO_STORE, CHAPTER_AUDIO_META_STORE], "readwrite");
    const audioStore = transaction.objectStore(CHAPTER_AUDIO_STORE);
    const metadataStore = transaction.objectStore(CHAPTER_AUDIO_META_STORE);
    if (sectionId) {
      const cacheKey = createReaderAudioCacheKey(documentId, sectionId);
      audioStore.delete(cacheKey);
      metadataStore.delete(cacheKey);
    } else {
      const metadata = await requestResult(metadataStore.index("documentId").getAll(documentId)) as ReaderAudioMetadata[];
      for (const entry of metadata) {
        audioStore.delete(entry.cacheKey);
        metadataStore.delete(entry.cacheKey);
      }
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function hasImportedLegacyReaderLibrary(): boolean {
  try {
    return localStorage.getItem(LEGACY_IMPORT_STORAGE_KEY) !== null;
  } catch {
    // A blocked marker only costs a repeated import, and every write below is
    // an upsert, so treat unreadable storage as "not imported yet".
    return false;
  }
}

function markLegacyReaderLibraryImported(): void {
  try {
    localStorage.setItem(LEGACY_IMPORT_STORAGE_KEY, new Date().toISOString());
  } catch {
    // See hasImportedLegacyReaderLibrary — a lost marker is not a lost library.
  }
}

/**
 * Desktop builds before the SQLite Reader library kept every book in the
 * renderer's IndexedDB. The renderer origin is unchanged, so that database is
 * still the one this build opens: copy the books into SQLite on the first
 * desktop read or an upgrading user launches into what looks like an erased
 * library. The IndexedDB copy is left untouched so downgrading still works.
 *
 * Cached audio is deliberately not carried over. It is regenerable, reaches
 * MAX_READER_AUDIO_CACHE_BYTES, and streaming that much PCM across the bridge
 * would stall the first launch behind a cache the Reader refills on demand.
 */
async function importLegacyReaderDocuments(bridge: DesktopReaderLibraryBridge): Promise<void> {
  const documents = await listIndexedDbReaderDocuments();
  const imported = new Set<string>();
  const failures: unknown[] = [];
  for (const document of documents) {
    // One book the bridge refuses must not strand the books queued behind it,
    // otherwise every later launch would abort at the same record.
    try {
      await bridge.saveDocument(document);
      imported.add(document.id);
    } catch (cause) {
      failures.push(cause);
    }
  }

  const legacyActiveId = imported.size > 0 ? await getIndexedDbActiveReaderDocumentId() : null;
  // SQLite wins when it already points somewhere: a book opened since the
  // upgrade is a better guess than the pre-upgrade selection.
  if (legacyActiveId && imported.has(legacyActiveId) && !await bridge.getActiveDocumentId()) {
    await bridge.setActiveDocumentId(legacyActiveId);
  }

  if (failures.length > 0) {
    throw new Error(`Failed to import ${failures.length} Reader document(s) from IndexedDB.`, {
      cause: failures[0],
    });
  }
}

function importLegacyReaderLibrary(bridge: DesktopReaderLibraryBridge): Promise<void> {
  // The latch is never cleared, so a failure retries on the next launch rather
  // than on every library refresh, and concurrent readers share one attempt.
  if (!legacyReaderImport) {
    legacyReaderImport = !isIndexedDbSupported() || hasImportedLegacyReaderLibrary()
      ? Promise.resolve()
      : importLegacyReaderDocuments(bridge).then(markLegacyReaderLibraryImported, () => {
        // A blocked or unreadable legacy database must not fail the load, and
        // the unset marker leaves the next launch free to try again.
      });
  }
  return legacyReaderImport;
}

export async function listReaderDocuments(): Promise<ReaderDocumentRecord[]> {
  const bridge = getDesktopReaderLibraryBridge();
  if (!bridge) return listIndexedDbReaderDocuments();
  // Awaited before the read so imported books are visible on the first launch,
  // ahead of the caller's "empty library, seed a starter document" branch.
  await importLegacyReaderLibrary(bridge);
  return normalizeDocumentRecords(await bridge.listDocuments());
}

export async function getReaderDocument(id: string): Promise<ReaderDocumentRecord | null> {
  const bridge = getDesktopReaderLibraryBridge();
  if (!bridge) return getIndexedDbReaderDocument(id);
  const record = await bridge.getDocument(id);
  return normalizeDocumentRecords(record ? [record] : [])[0] ?? null;
}

export async function saveReaderDocument(document: ReaderDocumentRecord): Promise<void> {
  const bridge = getDesktopReaderLibraryBridge();
  if (!bridge) return saveIndexedDbReaderDocument(document);
  await bridge.saveDocument(document);
}

export async function deleteReaderDocument(id: string): Promise<void> {
  const bridge = getDesktopReaderLibraryBridge();
  if (!bridge) return deleteIndexedDbReaderDocument(id);
  await bridge.deleteDocument(id);
}

export async function getActiveReaderDocumentId(): Promise<string | null> {
  const bridge = getDesktopReaderLibraryBridge();
  if (!bridge) return getIndexedDbActiveReaderDocumentId();
  return bridge.getActiveDocumentId();
}

export async function setActiveReaderDocumentId(id: string): Promise<void> {
  const bridge = getDesktopReaderLibraryBridge();
  if (!bridge) return setIndexedDbActiveReaderDocumentId(id);
  await bridge.setActiveDocumentId(id);
}

export async function saveCachedReaderAudio(audio: CachedReaderAudio): Promise<void> {
  const bridge = getDesktopReaderLibraryBridge();
  if (!bridge) return saveIndexedDbCachedReaderAudio(audio);
  const cacheKey = createReaderAudioCacheKey(audio.documentId, audio.sectionId);
  await bridge.saveAudio({
    ...audio,
    cacheKey,
    byteLength: getCachedReaderAudioByteLength(audio.chunks),
  });
}

export async function getCachedReaderAudio(
  documentId: string,
  sectionId: string,
): Promise<CachedReaderAudio | null> {
  const bridge = getDesktopReaderLibraryBridge();
  if (!bridge) return getIndexedDbCachedReaderAudio(documentId, sectionId);
  return normalizeCachedReaderAudio(await bridge.getAudio(documentId, sectionId));
}

export async function deleteCachedReaderAudio(documentId: string, sectionId?: string): Promise<void> {
  const bridge = getDesktopReaderLibraryBridge();
  if (!bridge) return deleteIndexedDbCachedReaderAudio(documentId, sectionId);
  await bridge.deleteAudio(documentId, sectionId);
}

async function pruneCachedReaderAudio(protectedCacheKey: string): Promise<void> {
  const database = await openReaderLibrary();
  try {
    const transaction = database.transaction([CHAPTER_AUDIO_STORE, CHAPTER_AUDIO_META_STORE], "readwrite");
    const audioStore = transaction.objectStore(CHAPTER_AUDIO_STORE);
    const metadataStore = transaction.objectStore(CHAPTER_AUDIO_META_STORE);
    const entries = await requestResult(metadataStore.getAll()) as ReaderAudioMetadata[];
    entries.sort((a, b) => a.updatedAt - b.updatedAt);
    let totalBytes = entries.reduce((total, entry) => total + entry.byteLength, 0);
    let totalEntries = entries.length;
    for (const entry of entries) {
      if (
        (totalBytes <= MAX_READER_AUDIO_CACHE_BYTES && totalEntries <= MAX_READER_AUDIO_CACHE_ENTRIES)
        || entry.cacheKey === protectedCacheKey
      ) continue;
      audioStore.delete(entry.cacheKey);
      metadataStore.delete(entry.cacheKey);
      totalBytes -= entry.byteLength;
      totalEntries -= 1;
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function clearReaderLibraryForTests(): Promise<void> {
  // The legacy import runs once per renderer, so its latch and marker are part
  // of the persistent state a test needs reset alongside the database itself.
  legacyReaderImport = null;
  try {
    localStorage.removeItem(LEGACY_IMPORT_STORAGE_KEY);
  } catch { /* localStorage unavailable */ }
  if (!isIndexedDbSupported()) return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Failed to clear Reader library."));
    request.onblocked = () => reject(new Error("Reader library deletion was blocked."));
  });
}

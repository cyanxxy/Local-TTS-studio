import {
  createReaderAudioCacheKey,
  getCachedReaderAudioByteLength,
  normalizeReaderDocumentRecord,
  type CachedReaderAudio,
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
export const MAX_READER_AUDIO_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_READER_AUDIO_CACHE_ENTRIES = 96;
export const MAX_READER_AUDIO_MEMORY_CACHE_BYTES = 192 * 1024 * 1024;
export const MAX_READER_AUDIO_MEMORY_CACHE_ENTRIES = 12;

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
  return typeof indexedDB !== "undefined";
}

export async function openReaderLibrary(): Promise<IDBDatabase> {
  if (!isReaderLibrarySupported()) {
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

export async function listReaderDocuments(): Promise<ReaderDocumentRecord[]> {
  const records = await withStore(DOCUMENTS_STORE, "readonly", (store) => store.getAll()) as unknown[];
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
      // A single damaged IndexedDB value must not hide every healthy book.
    }
  }
  return documents.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.updatedAt - a.updatedAt);
}

export async function getReaderDocument(id: string): Promise<ReaderDocumentRecord | null> {
  const result = await withStore(DOCUMENTS_STORE, "readonly", (store) => store.get(id)) as unknown;
  if (!result || typeof result !== "object") return null;
  try {
    return normalizeReaderDocumentRecord(result as ReaderDocumentRecord);
  } catch {
    return null;
  }
}

export async function saveReaderDocument(document: ReaderDocumentRecord): Promise<void> {
  await withStore(DOCUMENTS_STORE, "readwrite", (store) => store.put(document));
}

export async function deleteReaderDocument(id: string): Promise<void> {
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

export async function getActiveReaderDocumentId(): Promise<string | null> {
  const record = await withStore(SETTINGS_STORE, "readonly", (store) => store.get(ACTIVE_DOCUMENT_KEY)) as ReaderSettingRecord | undefined;
  return record?.value ?? null;
}

export async function setActiveReaderDocumentId(id: string): Promise<void> {
  await withStore(SETTINGS_STORE, "readwrite", (store) => store.put({ key: ACTIVE_DOCUMENT_KEY, value: id }));
}

export async function saveCachedReaderAudio(audio: CachedReaderAudio): Promise<void> {
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

export async function getCachedReaderAudio(documentId: string, sectionId: string): Promise<CachedReaderAudio | null> {
  const cacheKey = createReaderAudioCacheKey(documentId, sectionId);
  const result = await withStore(CHAPTER_AUDIO_STORE, "readonly", (store) => store.get(cacheKey)) as CachedReaderAudio | undefined;
  return result ?? null;
}

export async function deleteCachedReaderAudio(documentId: string, sectionId?: string): Promise<void> {
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
  if (!isReaderLibrarySupported()) return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Failed to clear Reader library."));
    request.onblocked = () => reject(new Error("Reader library deletion was blocked."));
  });
}

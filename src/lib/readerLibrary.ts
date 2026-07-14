import type { CachedReaderAudio, ReaderDocumentRecord } from "./readerDocument";

const DB_NAME = "open-tts-reader-library";
const DB_VERSION = 1;
const DOCUMENTS_STORE = "documents";
const AUDIO_STORE = "audio";
const SETTINGS_STORE = "settings";
const ACTIVE_DOCUMENT_KEY = "active-document-id";

interface ReaderSettingRecord {
  key: string;
  value: string;
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
    if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
      const documents = database.createObjectStore(DOCUMENTS_STORE, { keyPath: "id" });
      documents.createIndex("lastOpenedAt", "lastOpenedAt");
      documents.createIndex("updatedAt", "updatedAt");
    }
    if (!database.objectStoreNames.contains(AUDIO_STORE)) {
      database.createObjectStore(AUDIO_STORE, { keyPath: "documentId" });
    }
    if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
      database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
    }
  };
  return requestResult(request);
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
  const documents = await withStore(DOCUMENTS_STORE, "readonly", (store) => store.getAll()) as ReaderDocumentRecord[];
  return documents.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.updatedAt - a.updatedAt);
}

export async function getReaderDocument(id: string): Promise<ReaderDocumentRecord | null> {
  const result = await withStore(DOCUMENTS_STORE, "readonly", (store) => store.get(id)) as ReaderDocumentRecord | undefined;
  return result ?? null;
}

export async function saveReaderDocument(document: ReaderDocumentRecord): Promise<void> {
  await withStore(DOCUMENTS_STORE, "readwrite", (store) => store.put(document));
}

export async function deleteReaderDocument(id: string): Promise<void> {
  const database = await openReaderLibrary();
  try {
    const transaction = database.transaction([DOCUMENTS_STORE, AUDIO_STORE, SETTINGS_STORE], "readwrite");
    transaction.objectStore(DOCUMENTS_STORE).delete(id);
    transaction.objectStore(AUDIO_STORE).delete(id);
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
  await withStore(AUDIO_STORE, "readwrite", (store) => store.put(audio));
}

export async function getCachedReaderAudio(documentId: string): Promise<CachedReaderAudio | null> {
  const result = await withStore(AUDIO_STORE, "readonly", (store) => store.get(documentId)) as CachedReaderAudio | undefined;
  return result ?? null;
}

export async function deleteCachedReaderAudio(documentId: string): Promise<void> {
  await withStore(AUDIO_STORE, "readwrite", (store) => store.delete(documentId));
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

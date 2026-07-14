import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  calculateReaderProgress,
  chapterAtOffset,
  createReaderBookmark,
  createReaderDocument,
  createReaderNote,
  rebaseReaderChapters,
  structureTextChapters,
  type CachedReaderAudio,
  type ReaderDocumentInput,
  type ReaderDocumentRecord,
  type ReaderNote,
} from "../lib/readerDocument";
import {
  deleteCachedReaderAudio,
  deleteReaderDocument,
  getActiveReaderDocumentId,
  getCachedReaderAudio,
  isReaderLibrarySupported,
  listReaderDocuments,
  saveCachedReaderAudio,
  saveReaderDocument,
  setActiveReaderDocumentId,
} from "../lib/readerLibrary";

interface ProgressUpdate {
  positionSec: number;
  totalDurationSec: number;
  textOffset: number;
}

export interface UseReaderLibraryReturn {
  documents: ReaderDocumentRecord[];
  activeDocument: ReaderDocumentRecord | null;
  loading: boolean;
  error: string | null;
  persistent: boolean;
  createDocument: (input: ReaderDocumentInput) => Promise<ReaderDocumentRecord>;
  openDocument: (id: string) => Promise<ReaderDocumentRecord>;
  deleteDocument: (id: string) => Promise<void>;
  updateActiveText: (text: string) => void;
  updateActiveMetadata: (patch: Pick<Partial<ReaderDocumentRecord>, "title" | "author" | "description" | "language">) => void;
  updateProgress: (update: ProgressUpdate) => void;
  addBookmark: (input: { label: string; textOffset: number; positionSec: number }) => void;
  removeBookmark: (bookmarkId: string) => void;
  addNote: (input: { text: string; quote: string; textOffset: number }) => void;
  updateNote: (noteId: string, text: string) => void;
  removeNote: (noteId: string) => void;
  saveAudio: (audio: CachedReaderAudio) => Promise<void>;
  loadAudio: (documentId: string) => Promise<CachedReaderAudio | null>;
  clearAudio: (documentId: string) => Promise<void>;
}

function sortDocuments(documents: readonly ReaderDocumentRecord[]): ReaderDocumentRecord[] {
  return [...documents].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.updatedAt - a.updatedAt);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface InitializedReaderLibrary {
  documents: ReaderDocumentRecord[];
  activeDocumentId: string | null;
}

let persistentInitialization: Promise<InitializedReaderLibrary> | null = null;

function initializePersistentReaderLibrary(seedText: string): Promise<InitializedReaderLibrary> {
  if (persistentInitialization) return persistentInitialization;
  const initialization = (async () => {
    let documents = await listReaderDocuments();
    let activeDocumentId = await getActiveReaderDocumentId();
    if (documents.length === 0) {
      const seed = createReaderDocument({ text: seedText, sourceType: "text" });
      documents = [seed];
      activeDocumentId = seed.id;
      await saveReaderDocument(seed);
      await setActiveReaderDocumentId(seed.id);
    }
    if (!documents.some((document) => document.id === activeDocumentId)) {
      activeDocumentId = documents[0]?.id ?? null;
    }
    return { documents, activeDocumentId };
  })();
  persistentInitialization = initialization;
  void initialization.then(
    () => {
      if (persistentInitialization === initialization) persistentInitialization = null;
    },
    () => {
      if (persistentInitialization === initialization) persistentInitialization = null;
    },
  );
  return initialization;
}

export function useReaderLibrary(seedText: string): UseReaderLibraryReturn {
  const persistent = isReaderLibrarySupported();
  const [documents, setDocuments] = useState<ReaderDocumentRecord[]>([]);
  const [activeDocumentId, setActiveDocumentIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const documentsRef = useRef(documents);
  const activeDocumentIdRef = useRef(activeDocumentId);
  const textSaveTimersRef = useRef(new Map<string, number>());
  const progressSaveTimersRef = useRef(new Map<string, number>());
  const memoryAudioRef = useRef(new Map<string, CachedReaderAudio>());

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);
  useEffect(() => {
    activeDocumentIdRef.current = activeDocumentId;
  }, [activeDocumentId]);

  const persistDocument = useCallback((document: ReaderDocumentRecord) => {
    if (!persistent) return;
    void saveReaderDocument(document).catch((cause) => setError(errorMessage(cause)));
  }, [persistent]);

  const replaceDocument = useCallback((document: ReaderDocumentRecord, persist = true) => {
    const nextDocuments = sortDocuments([
      document,
      ...documentsRef.current.filter((entry) => entry.id !== document.id),
    ]);
    documentsRef.current = nextDocuments;
    setDocuments(nextDocuments);
    if (persist) persistDocument(document);
  }, [persistDocument]);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        let loaded: ReaderDocumentRecord[];
        let activeId: string | null;
        if (persistent) {
          const initialized = await initializePersistentReaderLibrary(seedText);
          loaded = initialized.documents;
          activeId = initialized.activeDocumentId;
        } else {
          const seed = createReaderDocument({ text: seedText, sourceType: "text" });
          loaded = [seed];
          activeId = seed.id;
        }
        if (!loaded.some((document) => document.id === activeId)) activeId = loaded[0]?.id ?? null;
        if (!cancelled) {
          setDocuments(sortDocuments(loaded));
          documentsRef.current = sortDocuments(loaded);
          activeDocumentIdRef.current = activeId;
          setActiveDocumentIdState(activeId);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          const seed = createReaderDocument({ text: seedText, sourceType: "text" });
          setDocuments([seed]);
          documentsRef.current = [seed];
          activeDocumentIdRef.current = seed.id;
          setActiveDocumentIdState(seed.id);
          setError(errorMessage(cause));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [persistent, seedText]);

  useEffect(() => () => {
    for (const timer of textSaveTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of progressSaveTimersRef.current.values()) window.clearTimeout(timer);
    textSaveTimersRef.current.clear();
    progressSaveTimersRef.current.clear();
  }, []);

  const activeDocument = useMemo(
    () => documents.find((document) => document.id === activeDocumentId) ?? null,
    [activeDocumentId, documents],
  );

  const createDocument = useCallback(async (input: ReaderDocumentInput) => {
    const document = createReaderDocument(input);
    replaceDocument(document, false);
    activeDocumentIdRef.current = document.id;
    setActiveDocumentIdState(document.id);
    if (persistent) {
      await saveReaderDocument(document);
      await setActiveReaderDocumentId(document.id);
    }
    return document;
  }, [persistent, replaceDocument]);

  const openDocument = useCallback(async (id: string) => {
    const existing = documentsRef.current.find((document) => document.id === id);
    if (!existing) throw new Error("The selected document no longer exists.");
    const opened = { ...existing, lastOpenedAt: Date.now() };
    replaceDocument(opened, false);
    activeDocumentIdRef.current = id;
    setActiveDocumentIdState(id);
    if (persistent) {
      await saveReaderDocument(opened);
      await setActiveReaderDocumentId(id);
    }
    return opened;
  }, [persistent, replaceDocument]);

  const deleteDocument = useCallback(async (id: string) => {
    const remaining = documentsRef.current.filter((document) => document.id !== id);
    documentsRef.current = sortDocuments(remaining);
    setDocuments(sortDocuments(remaining));
    if (persistent) await deleteReaderDocument(id);
    memoryAudioRef.current.delete(id);
    if (activeDocumentIdRef.current === id) {
      let replacement = remaining[0] ?? null;
      if (!replacement) {
        replacement = createReaderDocument({ text: "Start a new document here.", sourceType: "text" });
        documentsRef.current = [replacement];
        setDocuments([replacement]);
        if (persistent) await saveReaderDocument(replacement);
      }
      activeDocumentIdRef.current = replacement.id;
      setActiveDocumentIdState(replacement.id);
      if (persistent) await setActiveReaderDocumentId(replacement.id);
    }
  }, [persistent]);

  const updateActiveText = useCallback((text: string) => {
    const id = activeDocumentIdRef.current;
    if (!id) return;
    const current = documentsRef.current.find((document) => document.id === id);
    if (!current || current.text === text) return;
    const now = Date.now();
    const next = {
      ...current,
      text,
      chapters: rebaseReaderChapters(current.text, text, current.chapters, current.title),
      updatedAt: now,
    };
    replaceDocument(next, false);
    const pendingTimer = textSaveTimersRef.current.get(id);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    const timer = window.setTimeout(() => {
      textSaveTimersRef.current.delete(id);
      const latest = documentsRef.current.find((document) => document.id === id);
      if (!latest) return;
      const structured = {
        ...latest,
        chapters: latest.sourceType === "epub" || latest.sourceType === "url"
          ? latest.chapters
          : structureTextChapters(latest.text, latest.title),
        updatedAt: Date.now(),
      };
      replaceDocument(structured);
    }, 300);
    textSaveTimersRef.current.set(id, timer);
  }, [replaceDocument]);

  const updateActiveMetadata = useCallback((patch: Pick<Partial<ReaderDocumentRecord>, "title" | "author" | "description" | "language">) => {
    const current = documentsRef.current.find((document) => document.id === activeDocumentIdRef.current);
    if (!current) return;
    replaceDocument({ ...current, ...patch, updatedAt: Date.now() });
  }, [replaceDocument]);

  const updateProgress = useCallback((update: ProgressUpdate) => {
    const id = activeDocumentIdRef.current;
    if (!id) return;
    const current = documentsRef.current.find((document) => document.id === id);
    if (!current) return;
    const textOffset = Math.max(0, Math.min(current.text.length, update.textOffset));
    const chapter = chapterAtOffset(current.chapters, textOffset);
    const next = {
      ...current,
      progress: {
        positionSec: Math.max(0, update.positionSec),
        totalDurationSec: Math.max(0, update.totalDurationSec),
        textOffset,
        chapterId: chapter?.id ?? null,
        percent: calculateReaderProgress(
          current.text.length,
          textOffset,
          update.positionSec,
          update.totalDurationSec,
        ),
        updatedAt: Date.now(),
      },
    };
    replaceDocument(next, false);
    const pendingTimer = progressSaveTimersRef.current.get(id);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    const timer = window.setTimeout(() => {
      progressSaveTimersRef.current.delete(id);
      const latest = documentsRef.current.find((document) => document.id === id);
      if (latest) persistDocument(latest);
    }, 500);
    progressSaveTimersRef.current.set(id, timer);
  }, [persistDocument, replaceDocument]);

  const addBookmark = useCallback((input: { label: string; textOffset: number; positionSec: number }) => {
    const current = documentsRef.current.find((document) => document.id === activeDocumentIdRef.current);
    if (!current) return;
    const chapter = chapterAtOffset(current.chapters, input.textOffset);
    const bookmark = createReaderBookmark({
      label: input.label.trim() || chapter?.title || `Bookmark ${current.bookmarks.length + 1}`,
      textOffset: input.textOffset,
      chapterId: chapter?.id ?? null,
      positionSec: input.positionSec,
    });
    replaceDocument({ ...current, bookmarks: [...current.bookmarks, bookmark], updatedAt: Date.now() });
  }, [replaceDocument]);

  const removeBookmark = useCallback((bookmarkId: string) => {
    const current = documentsRef.current.find((document) => document.id === activeDocumentIdRef.current);
    if (!current) return;
    replaceDocument({
      ...current,
      bookmarks: current.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId),
      updatedAt: Date.now(),
    });
  }, [replaceDocument]);

  const addNote = useCallback((input: { text: string; quote: string; textOffset: number }) => {
    const current = documentsRef.current.find((document) => document.id === activeDocumentIdRef.current);
    if (!current || !input.text.trim()) return;
    const chapter = chapterAtOffset(current.chapters, input.textOffset);
    const note = createReaderNote({
      text: input.text.trim(),
      quote: input.quote.trim().slice(0, 500),
      textOffset: input.textOffset,
      chapterId: chapter?.id ?? null,
    });
    replaceDocument({ ...current, notes: [...current.notes, note], updatedAt: Date.now() });
  }, [replaceDocument]);

  const updateNote = useCallback((noteId: string, text: string) => {
    const current = documentsRef.current.find((document) => document.id === activeDocumentIdRef.current);
    if (!current) return;
    const notes: ReaderNote[] = current.notes.map((note) => note.id === noteId
      ? { ...note, text: text.trim(), updatedAt: Date.now() }
      : note);
    replaceDocument({ ...current, notes, updatedAt: Date.now() });
  }, [replaceDocument]);

  const removeNote = useCallback((noteId: string) => {
    const current = documentsRef.current.find((document) => document.id === activeDocumentIdRef.current);
    if (!current) return;
    replaceDocument({
      ...current,
      notes: current.notes.filter((note) => note.id !== noteId),
      updatedAt: Date.now(),
    });
  }, [replaceDocument]);

  const saveAudio = useCallback(async (audio: CachedReaderAudio) => {
    memoryAudioRef.current.set(audio.documentId, audio);
    if (persistent) await saveCachedReaderAudio(audio);
  }, [persistent]);

  const loadAudio = useCallback(async (documentId: string) => {
    const memory = memoryAudioRef.current.get(documentId);
    if (memory) return memory;
    if (!persistent) return null;
    const audio = await getCachedReaderAudio(documentId);
    if (audio) memoryAudioRef.current.set(documentId, audio);
    return audio;
  }, [persistent]);

  const clearAudio = useCallback(async (documentId: string) => {
    memoryAudioRef.current.delete(documentId);
    if (persistent) await deleteCachedReaderAudio(documentId);
  }, [persistent]);

  return {
    documents,
    activeDocument,
    loading,
    error,
    persistent,
    createDocument,
    openDocument,
    deleteDocument,
    updateActiveText,
    updateActiveMetadata,
    updateProgress,
    addBookmark,
    removeBookmark,
    addNote,
    updateNote,
    removeNote,
    saveAudio,
    loadAudio,
    clearAudio,
  };
}

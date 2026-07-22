import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildReaderSections,
  calculateReaderProgress,
  chapterAtOffset,
  createReaderAudioCacheKey,
  createReaderBookmark,
  createReaderDocument,
  createReaderNote,
  getCachedReaderAudioByteLength,
  normalizeReaderDocumentRecord,
  normalizeReaderText,
  readerSectionAtOffset,
  rebaseReaderChapters,
  rebaseReaderTextOffset,
  structureTextChapters,
  type CachedReaderAudio,
  type ReaderDocumentInput,
  type ReaderDocumentRecord,
  type ReaderNote,
  type ReaderSection,
} from "../lib/readerDocument";
import {
  deleteCachedReaderAudio,
  deleteReaderDocument,
  getActiveReaderDocumentId,
  getCachedReaderAudio,
  isReaderLibrarySupported,
  listReaderDocuments,
  MAX_READER_AUDIO_MEMORY_CACHE_BYTES,
  MAX_READER_AUDIO_MEMORY_CACHE_ENTRIES,
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
  updateActiveText: (text: string, options?: { preserveText?: boolean; deferStructure?: boolean }) => void;
  finalizeActiveTextEdit: (documentId?: string) => void;
  updateActiveMetadata: (patch: Pick<Partial<ReaderDocumentRecord>, "title" | "author" | "description" | "language">) => void;
  updateProgress: (update: ProgressUpdate) => void;
  addBookmark: (input: { label: string; textOffset: number; positionSec: number }) => void;
  removeBookmark: (bookmarkId: string) => void;
  addNote: (input: { text: string; quote: string; textOffset: number }) => void;
  updateNote: (noteId: string, text: string) => void;
  removeNote: (noteId: string) => void;
  saveAudio: (audio: CachedReaderAudio) => Promise<void>;
  loadAudio: (documentId: string, sectionId: string) => Promise<CachedReaderAudio | null>;
  clearAudio: (documentId: string, sectionId?: string) => Promise<void>;
}

function sortDocuments(documents: readonly ReaderDocumentRecord[]): ReaderDocumentRecord[] {
  return [...documents].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.updatedAt - a.updatedAt);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rememberReaderAudio(
  cache: Map<string, CachedReaderAudio>,
  audio: CachedReaderAudio,
): CachedReaderAudio {
  const cacheKey = createReaderAudioCacheKey(audio.documentId, audio.sectionId);
  const normalized = {
    ...audio,
    cacheKey,
    byteLength: getCachedReaderAudioByteLength(audio.chunks),
  };
  cache.delete(cacheKey);
  cache.set(cacheKey, normalized);

  const entries = [...cache.entries()];
  let totalBytes = entries.reduce((total, [, entry]) => total + entry.byteLength, 0);
  let totalEntries = entries.length;
  for (const [entryKey, entry] of entries) {
    if (
      totalBytes <= MAX_READER_AUDIO_MEMORY_CACHE_BYTES
      && totalEntries <= MAX_READER_AUDIO_MEMORY_CACHE_ENTRIES
    ) break;
    if (entryKey === cacheKey) continue;
    cache.delete(entryKey);
    totalBytes -= entry.byteLength;
    totalEntries -= 1;
  }
  return normalized;
}

interface InitializedReaderLibrary {
  documents: ReaderDocumentRecord[];
  activeDocumentId: string | null;
}

function structurePendingTextDocument(document: ReaderDocumentRecord): ReaderDocumentRecord {
  return normalizeReaderDocumentRecord({
    ...document,
    chapters: document.sourceType === "epub" || document.sourceType === "url"
      ? document.chapters
      : structureTextChapters(document.text, document.title),
    updatedAt: Date.now(),
  });
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
  const pendingTextStructureIdsRef = useRef(new Set<string>());
  const progressSaveTimersRef = useRef(new Map<string, number>());
  const documentSaveTimersRef = useRef(new Map<string, number>());
  const memoryAudioRef = useRef(new Map<string, CachedReaderAudio>());
  const sectionsRef = useRef(new Map<string, {
    text: string;
    chapters: ReaderDocumentRecord["chapters"];
    sections: ReaderSection[];
  }>());

  const sectionsForDocument = useCallback((document: ReaderDocumentRecord): ReaderSection[] => {
    const cached = sectionsRef.current.get(document.id);
    if (cached?.text === document.text && cached.chapters === document.chapters) return cached.sections;
    const sections = buildReaderSections(document.text, document.chapters);
    sectionsRef.current.set(document.id, { text: document.text, chapters: document.chapters, sections });
    return sections;
  }, []);

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

  const scheduleDocumentPersist = useCallback((id: string, delay = 500) => {
    const pendingTimer = documentSaveTimersRef.current.get(id);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    const timer = window.setTimeout(() => {
      documentSaveTimersRef.current.delete(id);
      const latest = documentsRef.current.find((document) => document.id === id);
      if (latest) persistDocument(latest);
    }, delay);
    documentSaveTimersRef.current.set(id, timer);
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
    const pendingTextIds = new Set([
      ...pendingTextStructureIdsRef.current,
      ...textSaveTimersRef.current.keys(),
    ]);
    const pendingIds = new Set([
      ...pendingTextIds,
      ...progressSaveTimersRef.current.keys(),
      ...documentSaveTimersRef.current.keys(),
    ]);
    for (const timer of textSaveTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of progressSaveTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of documentSaveTimersRef.current.values()) window.clearTimeout(timer);
    textSaveTimersRef.current.clear();
    pendingTextStructureIdsRef.current.clear();
    progressSaveTimersRef.current.clear();
    documentSaveTimersRef.current.clear();

    if (!persistent) return;
    for (const id of pendingIds) {
      const latest = documentsRef.current.find((document) => document.id === id);
      if (!latest) continue;
      const flushed = pendingTextIds.has(id) ? structurePendingTextDocument(latest) : latest;
      void saveReaderDocument(flushed);
    }
  }, [persistent]);

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
    for (const timers of [textSaveTimersRef, progressSaveTimersRef, documentSaveTimersRef]) {
      const timer = timers.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.current.delete(id);
    }
    pendingTextStructureIdsRef.current.delete(id);
    if (persistent) await deleteReaderDocument(id);
    for (const [cacheKey, audio] of memoryAudioRef.current) {
      if (audio.documentId === id) memoryAudioRef.current.delete(cacheKey);
    }
    sectionsRef.current.delete(id);
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

  const finalizeActiveTextEdit = useCallback((documentId?: string) => {
    const id = documentId ?? activeDocumentIdRef.current;
    if (!id || !pendingTextStructureIdsRef.current.has(id)) return;
    const timer = textSaveTimersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    textSaveTimersRef.current.delete(id);
    pendingTextStructureIdsRef.current.delete(id);
    const latest = documentsRef.current.find((document) => document.id === id);
    if (latest) replaceDocument(structurePendingTextDocument(latest));
  }, [replaceDocument]);

  const updateActiveText = useCallback((
    text: string,
    { preserveText = false, deferStructure = false }: { preserveText?: boolean; deferStructure?: boolean } = {},
  ) => {
    const id = activeDocumentIdRef.current;
    if (!id) return;
    const current = documentsRef.current.find((document) => document.id === id);
    const nextText = preserveText ? text : normalizeReaderText(text);
    if (!current || current.text === nextText) return;
    const now = Date.now();
    const rebaseOffset = (offset: number) => rebaseReaderTextOffset(current.text, nextText, offset);
    const next = {
      ...current,
      text: nextText,
      // The editor owns a frozen section range until it exits. Even a
      // best-effort chapter rebase can collapse or redirect that range when a
      // draft adds headings at both ends, so keep the complete structure
      // untouched for the whole deferred session.
      chapters: deferStructure
        ? current.chapters
        : rebaseReaderChapters(current.text, nextText, current.chapters, current.title),
      progress: {
        ...current.progress,
        textOffset: rebaseOffset(current.progress.textOffset),
        percent: calculateReaderProgress(nextText.length, rebaseOffset(current.progress.textOffset), 0, 0),
        updatedAt: now,
      },
      bookmarks: current.bookmarks.map((bookmark) => ({
        ...bookmark,
        textOffset: rebaseOffset(bookmark.textOffset),
      })),
      notes: current.notes.map((note) => ({
        ...note,
        textOffset: rebaseOffset(note.textOffset),
      })),
      updatedAt: now,
    };
    replaceDocument(next, false);
    pendingTextStructureIdsRef.current.add(id);
    const pendingTimer = textSaveTimersRef.current.get(id);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    textSaveTimersRef.current.delete(id);
    if (deferStructure) {
      scheduleDocumentPersist(id, 1_000);
      return;
    }
    const timer = window.setTimeout(() => {
      finalizeActiveTextEdit(id);
    }, 300);
    textSaveTimersRef.current.set(id, timer);
  }, [finalizeActiveTextEdit, replaceDocument, scheduleDocumentPersist]);

  const updateActiveMetadata = useCallback((patch: Pick<Partial<ReaderDocumentRecord>, "title" | "author" | "description" | "language">) => {
    const current = documentsRef.current.find((document) => document.id === activeDocumentIdRef.current);
    if (!current) return;
    replaceDocument({ ...current, ...patch, updatedAt: Date.now() }, false);
    scheduleDocumentPersist(current.id);
  }, [replaceDocument, scheduleDocumentPersist]);

  const updateProgress = useCallback((update: ProgressUpdate) => {
    const id = activeDocumentIdRef.current;
    if (!id) return;
    const current = documentsRef.current.find((document) => document.id === id);
    if (!current) return;
    const textOffset = Math.max(0, Math.min(current.text.length, update.textOffset));
    const chapter = chapterAtOffset(current.chapters, textOffset);
    const section = readerSectionAtOffset(sectionsForDocument(current), textOffset);
    const next = {
      ...current,
      progress: {
        positionSec: Math.max(0, update.positionSec),
        totalDurationSec: Math.max(0, update.totalDurationSec),
        textOffset,
        chapterId: chapter?.id ?? null,
        sectionId: section?.id ?? null,
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
  }, [persistDocument, replaceDocument, sectionsForDocument]);

  const addBookmark = useCallback((input: { label: string; textOffset: number; positionSec: number }) => {
    const current = documentsRef.current.find((document) => document.id === activeDocumentIdRef.current);
    if (!current) return;
    const chapter = chapterAtOffset(current.chapters, input.textOffset);
    const section = readerSectionAtOffset(sectionsForDocument(current), input.textOffset);
    const bookmark = createReaderBookmark({
      label: input.label.trim() || chapter?.title || `Bookmark ${current.bookmarks.length + 1}`,
      textOffset: input.textOffset,
      chapterId: chapter?.id ?? null,
      sectionId: section?.id ?? null,
      positionSec: input.positionSec,
    });
    replaceDocument({ ...current, bookmarks: [...current.bookmarks, bookmark], updatedAt: Date.now() });
  }, [replaceDocument, sectionsForDocument]);

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
    const section = readerSectionAtOffset(sectionsForDocument(current), input.textOffset);
    const note = createReaderNote({
      text: input.text.trim(),
      quote: input.quote.trim().slice(0, 500),
      textOffset: input.textOffset,
      chapterId: chapter?.id ?? null,
      sectionId: section?.id ?? null,
    });
    replaceDocument({ ...current, notes: [...current.notes, note], updatedAt: Date.now() });
  }, [replaceDocument, sectionsForDocument]);

  const updateNote = useCallback((noteId: string, text: string) => {
    const current = documentsRef.current.find((document) => document.id === activeDocumentIdRef.current);
    if (!current) return;
    const notes: ReaderNote[] = current.notes.map((note) => note.id === noteId
      ? { ...note, text, updatedAt: Date.now() }
      : note);
    replaceDocument({ ...current, notes, updatedAt: Date.now() }, false);
    scheduleDocumentPersist(current.id);
  }, [replaceDocument, scheduleDocumentPersist]);

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
    const normalized = rememberReaderAudio(memoryAudioRef.current, audio);
    if (persistent) await saveCachedReaderAudio(normalized);
  }, [persistent]);

  const loadAudio = useCallback(async (documentId: string, sectionId: string) => {
    const cacheKey = createReaderAudioCacheKey(documentId, sectionId);
    const memory = memoryAudioRef.current.get(cacheKey);
    if (memory) return rememberReaderAudio(memoryAudioRef.current, memory);
    if (!persistent) return null;
    const audio = await getCachedReaderAudio(documentId, sectionId);
    return audio ? rememberReaderAudio(memoryAudioRef.current, audio) : null;
  }, [persistent]);

  const clearAudio = useCallback(async (documentId: string, sectionId?: string) => {
    if (sectionId) {
      memoryAudioRef.current.delete(createReaderAudioCacheKey(documentId, sectionId));
    } else {
      for (const [cacheKey, audio] of memoryAudioRef.current) {
        if (audio.documentId === documentId) memoryAudioRef.current.delete(cacheKey);
      }
    }
    if (persistent) await deleteCachedReaderAudio(documentId, sectionId);
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
    finalizeActiveTextEdit,
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

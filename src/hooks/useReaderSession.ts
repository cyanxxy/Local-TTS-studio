import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  normalizeReaderTextFragment,
  readerSectionAtOffset,
  type ReaderDocumentRecord,
  type ReaderSection,
} from "../lib/readerDocument";
import { isReaderLibraryShutdownError } from "../lib/readerLibrary";
import type { SurfaceEngineId } from "../models/registry";
import type { EngineSignatureParts } from "../models/types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useReaderAudioCache } from "./useReaderAudioCache";
import type { UseReaderLibraryReturn } from "./useReaderLibrary";
import { useReaderProgress, type ReaderAdvance } from "./useReaderProgress";
import type { ReaderSections } from "./useReaderSections";

const NEW_DOCUMENT = {
  title: "Untitled document",
  sourceType: "text",
  text: "Start writing or paste text here.",
} as const;

interface Options {
  /** The Reader page is on screen. */
  active: boolean;
  library: UseReaderLibraryReturn;
  /** `useReaderSections` of the library's active document. */
  sections: ReaderSections;
  player: UseAudioPlayerReturn;
  /** The engine the Reader synthesizes with, and the inputs that shape its audio (null while unknown). */
  engineId: SurfaceEngineId;
  signatureParts: EngineSignatureParts | null;
  /** The book's own playback speed, used instead of the one a section was saved at. */
  playbackRate?: number | null;
  /** Saved audio that fails the signature check is kept, not discarded; see `useReaderAudioCache`. */
  keepMismatchedAudio?: boolean;
  /** The Reader engine is synthesizing. */
  isGenerating: boolean;
  /** Generates the active section with the Reader engine. */
  generate: () => void;
  /** The reader turned on "continue to the next section". */
  autoAdvance: boolean;
  /** Stops every engine's generation and clears what each put in the player. */
  retireAllAudio: () => void;
  /** Retires audio an edit has made stale, if there is any. */
  resetAudioForTextEdit: () => void;
  setShowPlayer: (show: boolean) => void;
  /** Clears the import and export errors a new section or an edit makes stale. */
  clearErrors: () => void;
  onError: (message: string) => void;
}

export interface ReaderSession extends ReaderSections {
  document: ReaderDocumentRecord | null;
  /** The signature the active section's audio is saved under, or null while unknown. */
  audioSignature: string | null;
  /** Saves the active section's audio now; call before anything replaces it. */
  flushAudio: () => void;
  /**
   * Generates the active section because the listener asked to. A lookup of
   * its saved audio still running is dropped, so that audio is not restored
   * into (or over) the generation.
   */
  generate: () => void;
  /** Turns to `section` and plays it, generating it first when it has no saved audio. */
  playSection: (section: ReaderSection) => void;
  /** Moves the reading position, turning to the section that holds it. */
  navigateToOffset: (textOffset: number, positionSec?: number) => void;
  startSectionEdit: () => void;
  changeSectionText: (sectionText: string) => void;
  endSectionEdit: () => void;
  newDocument: () => void;
  openDocument: (id: string) => void;
  deleteDocument: (id: string) => void;
  /** The sleep timer's hold on auto-continuation; see `useReaderProgress`. */
  setAutoAdvanceHold: (held: boolean) => void;
}

/** The span a section edit replaces, frozen when the editor opens. */
interface SectionEdit {
  documentId: string;
  sectionId: string;
  documentText: string;
  start: number;
  end: number;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Everything the Reader does between its document library and the shared
 * player: section edits, navigation, the per-section audio cache (restore on
 * entry, save while streaming and before replacement), progress recording and
 * auto-continuation.
 */
export function useReaderSession({
  active,
  library,
  sections: readerSections,
  player,
  engineId,
  signatureParts,
  playbackRate,
  keepMismatchedAudio,
  isGenerating,
  generate,
  autoAdvance,
  retireAllAudio,
  resetAudioForTextEdit,
  setShowPlayer,
  clearErrors,
  onError,
}: Options): ReaderSession {
  const document = library.activeDocument;
  const documentId = document?.id ?? null;
  const {
    sections,
    activeSection: section,
    activeSectionIndex,
    nextSection,
    activeSectionText,
  } = readerSections;
  const {
    createDocument,
    deleteDocument: deleteLibraryDocument,
    finalizeActiveTextEdit,
    openDocument: openLibraryDocument,
    flushProgress,
    updateActiveText,
    updateProgress,
  } = library;

  // Quitting holds the window open while the Reader worker drains, so a cache
  // write that loses that race is expected and must not surface as an error.
  const reportError = useCallback((cause: unknown) => {
    if (isReaderLibraryShutdownError(cause)) return;
    onError(errorMessage(cause));
  }, [onError]);

  const audioCache = useReaderAudioCache({
    active,
    document,
    section,
    sectionText: activeSectionText,
    engineId,
    signatureParts,
    playbackRate,
    keepMismatchedAudio,
    library,
    player,
    retireAllAudio,
    generate,
    setShowPlayer,
    onSectionEnter: clearErrors,
    reportError,
  });
  const {
    abandonRestore,
    discardForEdit,
    flush,
    isPartialAudio,
    isRestorePending,
    requestRestore,
    setContinuation,
  } = audioCache;

  const generateNow = useCallback(() => {
    abandonRestore();
    generate();
  }, [abandonRestore, generate]);

  const navigate = useCallback((
    textOffset: number,
    positionSec?: number,
    continuation?: ReaderAdvance,
  ) => {
    if (!document) return;
    const targetOffset = Math.max(0, Math.min(document.text.length, textOffset));
    const targetSection = readerSectionAtOffset(sections, targetOffset);
    if (targetSection && targetSection.id !== section?.id) {
      flush();
      requestRestore(targetSection.id, positionSec);
    }
    setContinuation(continuation && targetSection ? { sectionId: targetSection.id, ...continuation } : null);
    updateProgress({
      positionSec: Math.max(0, positionSec ?? 0),
      totalDurationSec: 0,
      textOffset: targetOffset,
    });
  }, [document, flush, requestRestore, section?.id, sections, setContinuation, updateProgress]);

  const navigateToOffset = useCallback((textOffset: number, positionSec?: number) => {
    navigate(textOffset, positionSec);
  }, [navigate]);

  const playSection = useCallback((target: ReaderSection) => {
    navigate(target.start, 0, { autoPlay: true, autoGenerate: true });
  }, [navigate]);

  const advance = useCallback((next: ReaderSection, continuation: ReaderAdvance | null) => {
    navigate(next.start, 0, continuation ?? undefined);
  }, [navigate]);

  const { setAutoAdvanceHold } = useReaderProgress({
    active,
    document,
    section,
    sectionIndex: activeSectionIndex,
    sectionCount: sections.length,
    nextSection,
    player,
    isGenerating,
    isRestorePending,
    updateProgress,
    flushProgress,
    autoAdvance,
    advance,
    isPartialAudio,
    regenerate: generate,
  });

  const editRef = useRef<SectionEdit | null>(null);

  const startSectionEdit = useCallback(() => {
    if (!document || !section) return;
    editRef.current = {
      documentId: document.id,
      sectionId: section.id,
      documentText: document.text,
      start: section.start,
      end: section.end,
    };
  }, [document, section]);

  const changeSectionText = useCallback((nextSectionText: string) => {
    const edit = editRef.current;
    if (!document || (!edit && !section)) return;
    if (edit && edit.documentId !== document.id) return;
    // The editor replaces the span it opened on, even after the draft has
    // moved chapter or section boundaries (and so their ids) around it.
    const sourceText = edit?.documentText ?? document.text;
    const start = edit?.start ?? section!.start;
    const end = edit?.end ?? section!.end;
    const normalizedSectionText = normalizeReaderTextFragment(nextSectionText);
    const nextDocumentText = `${sourceText.slice(0, start)}${normalizedSectionText}${sourceText.slice(end)}`;
    if (nextDocumentText === document.text) return;
    resetAudioForTextEdit();
    discardForEdit(document.id, edit?.sectionId ?? section!.id);
    updateActiveText(nextDocumentText, {
      preserveText: true,
      deferStructure: edit !== null,
      // Everything outside the span is unchanged, so rebasing annotations
      // only has to scan the span the draft replaced.
      hint: {
        start,
        previousEnd: document.text.length - (sourceText.length - end),
        nextEnd: start + normalizedSectionText.length,
      },
    });
    clearErrors();
  }, [clearErrors, discardForEdit, document, resetAudioForTextEdit, section, updateActiveText]);

  const endSectionEdit = useCallback(() => {
    const edit = editRef.current;
    editRef.current = null;
    if (edit) finalizeActiveTextEdit(edit.documentId);
  }, [finalizeActiveTextEdit]);

  // Leaving a document mid-edit commits the edit's structure.
  useEffect(() => () => {
    const edit = editRef.current;
    if (!edit || edit.documentId !== documentId) return;
    editRef.current = null;
    finalizeActiveTextEdit(edit.documentId);
  }, [documentId, finalizeActiveTextEdit]);

  const newDocument = useCallback(() => {
    flush();
    void createDocument(NEW_DOCUMENT).catch((cause: unknown) => onError(errorMessage(cause)));
  }, [createDocument, flush, onError]);

  const openDocument = useCallback((id: string) => {
    flush();
    void openLibraryDocument(id).catch((cause: unknown) => onError(errorMessage(cause)));
  }, [flush, onError, openLibraryDocument]);

  const deleteDocument = useCallback((id: string) => {
    void deleteLibraryDocument(id).catch((cause: unknown) => onError(errorMessage(cause)));
  }, [deleteLibraryDocument, onError]);

  return useMemo(() => ({
    ...readerSections,
    document,
    audioSignature: audioCache.signature,
    flushAudio: flush,
    generate: generateNow,
    playSection,
    navigateToOffset,
    startSectionEdit,
    changeSectionText,
    endSectionEdit,
    newDocument,
    openDocument,
    deleteDocument,
    setAutoAdvanceHold,
  }), [
    audioCache.signature,
    changeSectionText,
    deleteDocument,
    document,
    endSectionEdit,
    flush,
    generateNow,
    navigateToOffset,
    newDocument,
    openDocument,
    playSection,
    readerSections,
    setAutoAdvanceHold,
    startSectionEdit,
  ]);
}

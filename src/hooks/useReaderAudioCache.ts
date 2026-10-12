import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from "react";
import {
  buildAudioSignature,
  buildLegacyAudioSignature,
  createReaderAudioCacheKey,
  getCachedReaderAudioByteLength,
  type CachedReaderAudio,
  type CachedReaderAudioChunk,
  type ReaderDocumentRecord,
  type ReaderSection,
} from "../lib/readerDocument";
import type { SurfaceEngineId } from "../models/registry";
import type { EngineSignatureParts } from "../models/types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import type { UseReaderLibraryReturn } from "./useReaderLibrary";

/** How long the Reader waits after its audio last changed before saving it. */
export const READER_AUDIO_SAVE_DELAY_MS = 800;

/**
 * While a section is still streaming in, its audio is saved at most this often
 * (each save writes everything streamed so far). A finished section is saved
 * once it stops changing.
 */
export const READER_STREAMING_SAVE_INTERVAL_MS = 30_000;

/** What the last save (or restore) left in storage for the active section. */
interface SavedAudio {
  cacheKey: string;
  signature: string;
  synthesisComplete: boolean;
  /** The PCM buffers saved, by identity: unchanged audio is the same buffers. */
  buffers: readonly ArrayBuffer[];
}

function isSavedAudio(
  saved: SavedAudio | null,
  cacheKey: string,
  signature: string,
  synthesisComplete: boolean,
  chunks: readonly CachedReaderAudioChunk[],
): boolean {
  return saved !== null
    && saved.cacheKey === cacheKey
    && saved.signature === signature
    && saved.synthesisComplete === synthesisComplete
    && saved.buffers.length === chunks.length
    && chunks.every((chunk, index) => chunk.audio === saved.buffers[index]);
}

/** What entering a section should do once its saved audio has been looked up. */
export interface ReaderContinuation {
  sectionId: string;
  /** Play restored audio straight away. */
  autoPlay: boolean;
  /** Generate the section when it has no usable saved audio. */
  autoGenerate: boolean;
}

interface Options {
  /** The Reader page is on screen. */
  active: boolean;
  document: ReaderDocumentRecord | null;
  section: ReaderSection | null;
  sectionText: string;
  /** The engine the Reader synthesizes with. */
  engineId: SurfaceEngineId;
  /**
   * The inputs that shape that engine's audio (only those it reads), or null
   * while one of them is still unknown.
   */
  signatureParts: EngineSignatureParts | null;
  /** Plays restored audio at this speed instead of the one it was saved at. */
  playbackRate?: number | null;
  /**
   * The book's remembered voice is not what the Reader speaks with yet (its
   * engine is still being detected, or applied), so audio that does not match
   * the signature of the fallback voice may be exactly the book's own.
   */
  keepMismatchedAudio?: boolean;
  library: Pick<UseReaderLibraryReturn, "loadAudio" | "saveAudio" | "clearAudio">;
  player: Pick<
    UseAudioPlayerReturn,
    | "getAudioCacheSnapshot"
    | "getCurrentTime"
    | "getPlaybackSnapshot"
    | "isSynthesisComplete"
    | "restoreAudioCache"
    | "segments"
    | "togglePlay"
  >;
  /** Stops every engine's generation and clears the player before a section is restored. */
  retireAllAudio: () => void;
  /** Generates the active section. */
  generate: () => void;
  setShowPlayer: (show: boolean) => void;
  /** Runs as each section is entered, before its audio is looked up. */
  onSectionEnter: () => void;
  reportError: (cause: unknown) => void;
}

export interface ReaderAudioCache {
  /** What the active section's saved audio must match to be restored, or null while unknown. */
  signature: string | null;
  /**
   * Saves what the player holds as the active section's audio, at once.
   * Anything that is about to replace that audio calls this first.
   */
  flush: () => void;
  /**
   * True while the active section's saved audio is being looked up: the player
   * is empty for now, and its zero state is not a reading position.
   */
  isRestorePending: () => boolean;
  /** Resume `sectionId` at `currentTime` (seconds) instead of its saved position when it is entered next. */
  requestRestore: (sectionId: string, currentTime?: number) => void;
  /** What the next entry into `continuation.sectionId` does; null cancels a pending one. */
  setContinuation: (continuation: ReaderContinuation | null) => void;
  /**
   * Forgets a section's saved audio because its text is being edited; repeat
   * calls during one edit delete it only once.
   */
  discardForEdit: (documentId: string, sectionId: string) => void;
}

/**
 * The Reader's per-section audio cache: restores a section's saved audio as it
 * is entered, saves the player's audio for it while it streams and before it
 * is replaced, and carries a navigation's intent (resume position, autoplay,
 * autogenerate) into the section it lands on.
 *
 * Saved audio is keyed by section and tagged with a signature of the section
 * text and the engine inputs that shaped it; a lookup that finds a stale
 * signature discards the entry rather than playing old speech. An entry saved
 * under the version 1 signature scheme is accepted when its legacy signature
 * still matches, and is re-saved under the current one.
 */
export function useReaderAudioCache({
  active,
  document,
  section,
  sectionText,
  engineId,
  signatureParts,
  playbackRate,
  keepMismatchedAudio,
  library,
  player,
  retireAllAudio,
  generate,
  setShowPlayer,
  onSectionEnter,
  reportError,
}: Options): ReaderAudioCache {
  const documentId = document?.id ?? null;
  const sectionId = section?.id ?? null;
  const signatureKnown = signatureParts !== null;
  // Signatures are section-local: editing one passage or moving chapter
  // boundaries does not invalidate hours of unrelated generated audio.
  const signature = useMemo(() => (
    section && signatureParts
      ? buildAudioSignature({ text: sectionText, model: engineId, ...signatureParts })
      : null
  ), [engineId, section, sectionText, signatureParts]);

  // What the same inputs hashed to before signature version 2.
  const legacySignature = useMemo(() => (
    section && signatureParts
      ? buildLegacyAudioSignature({ text: sectionText, model: engineId, ...signatureParts.legacy })
      : null
  ), [engineId, section, sectionText, signatureParts]);

  const { clearAudio, loadAudio, saveAudio } = library;
  const {
    getAudioCacheSnapshot,
    getCurrentTime,
    getPlaybackSnapshot,
    isSynthesisComplete,
    restoreAudioCache,
    segments,
    togglePlay,
  } = player;

  const saveTimerRef = useRef<number | null>(null);
  const saveVersionRef = useRef(0);
  const restorePendingRef = useRef(false);
  const restoreVersionRef = useRef(0);
  const continuationRef = useRef<ReaderContinuation | null>(null);
  const restoreRequestRef = useRef<{ sectionId: string; currentTime?: number } | null>(null);
  const clearedForEditRef = useRef<string | null>(null);
  const savedAudioRef = useRef<SavedAudio | null>(null);
  const lastSaveAtRef = useRef(0);

  useEffect(() => {
    clearedForEditRef.current = null;
  }, [documentId, sectionId]);

  const flush = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!documentId || !section || !signature) return;
    const chunks = getAudioCacheSnapshot();
    if (chunks.length === 0) return;
    clearedForEditRef.current = null;

    // Read at call time from the buffers just snapshotted: neither the
    // position nor the streamed duration is current in React state.
    const playback = getPlaybackSnapshot();
    const cacheKey = createReaderAudioCacheKey(documentId, section.id);
    // Audio storage already holds exactly this PCM (a restore, or a flush that
    // follows a save with nothing streamed since): rewriting it would only
    // churn the disk. The resume position is kept in the book's progress.
    if (isSavedAudio(savedAudioRef.current, cacheKey, signature, playback.synthesisComplete, chunks)) return;
    const updatedAt = Math.max(Date.now(), saveVersionRef.current + 1);
    saveVersionRef.current = updatedAt;
    lastSaveAtRef.current = Date.now();
    const saved: SavedAudio = {
      cacheKey,
      signature,
      synthesisComplete: playback.synthesisComplete,
      buffers: chunks.map((chunk) => chunk.audio),
    };
    savedAudioRef.current = saved;
    void saveAudio({
      cacheKey,
      documentId,
      chapterId: section.chapterId,
      sectionId: section.id,
      signature,
      chunks,
      byteLength: getCachedReaderAudioByteLength(chunks),
      currentTime: getCurrentTime(),
      playbackRate: playback.playbackRate,
      totalDuration: playback.totalDuration,
      synthesisComplete: playback.synthesisComplete,
      updatedAt,
    }).catch((cause: unknown) => {
      // The write did not land, so the next flush must try again.
      if (savedAudioRef.current === saved) savedAudioRef.current = null;
      reportError(cause);
    });
  }, [
    documentId,
    getAudioCacheSnapshot,
    getCurrentTime,
    getPlaybackSnapshot,
    reportError,
    saveAudio,
    section,
    signature,
  ]);

  // The restore effect below runs once per section. These effect events give
  // it, and the async work it starts, the latest document, signature, library
  // functions and runtimes without re-running it whenever those change. (The
  // record changes with every progress write, and the library's audio
  // functions change when its storage backend settles.)
  const enteredSection = useEffectEvent(() => ({ document, section }));
  const currentSignature = useEffectEvent(() => ({ signature, legacySignature, playbackRate, keepMismatchedAudio }));
  const upgradeSectionAudio = useEffectEvent((cache: CachedReaderAudio, upgradedSignature: string) => {
    const updatedAt = Math.max(Date.now(), saveVersionRef.current + 1);
    saveVersionRef.current = updatedAt;
    savedAudioRef.current = {
      cacheKey: cache.cacheKey,
      signature: upgradedSignature,
      synthesisComplete: cache.synthesisComplete === true,
      buffers: cache.chunks.map((chunk) => chunk.audio),
    };
    void saveAudio({ ...cache, signature: upgradedSignature, updatedAt }).catch(reportError);
  });
  const enterSection = useEffectEvent(() => {
    // Not forced: a forced cancel hard-restarts the browser model even when
    // nothing is generating, which reloaded Kokoro/Supertonic on every page
    // turn. An in-flight generation is still stopped, because each runtime's
    // cancel checks its live generating state itself.
    retireAllAudio();
    onSectionEnter();
  });
  const loadSectionAudio = useEffectEvent((id: string, entered: string) => loadAudio(id, entered));
  const clearSectionAudio = useEffectEvent((id: string, entered: string) => clearAudio(id, entered));
  const generateEnteredSection = useEffectEvent(() => generate());
  const showPlayer = useEffectEvent((show: boolean) => setShowPlayer(show));

  useEffect(() => {
    const restoreVersion = ++restoreVersionRef.current;
    restorePendingRef.current = false;
    savedAudioRef.current = null;
    lastSaveAtRef.current = 0;
    const entered = enteredSection();
    const enteredDocument = entered.document;
    const enteredSectionValue = entered.section;
    if (
      !active
      || !enteredDocument
      || !enteredSectionValue
      || enteredDocument.id !== documentId
      || enteredSectionValue.id !== sectionId
    ) return;
    let cancelled = false;
    restorePendingRef.current = true;
    enterSection();
    // An engine whose inputs are not known yet has no signature to compare a
    // cache entry against. Restoring or discarding the entry now would act on
    // a guess; this effect runs again once the signature is known.
    if (!signatureKnown) {
      restorePendingRef.current = false;
      return;
    }

    const restore = async () => {
      try {
        const cache = await loadSectionAudio(enteredDocument.id, enteredSectionValue.id);
        if (cancelled) return;
        const continuation = continuationRef.current?.sectionId === enteredSectionValue.id
          ? continuationRef.current
          : null;
        const restoreRequest = restoreRequestRef.current?.sectionId === enteredSectionValue.id
          ? restoreRequestRef.current
          : null;
        // Read after the lookup: the inputs may have changed while it ran.
        const latest = currentSignature();
        const isLegacyMatch = cache !== null && cache.signature === latest.legacySignature;
        if (cache && latest.signature && (cache.signature === latest.signature || isLegacyMatch)) {
          savedAudioRef.current = {
            cacheKey: cache.cacheKey,
            signature: cache.signature,
            synthesisComplete: cache.synthesisComplete === true,
            buffers: cache.chunks.map((chunk) => chunk.audio),
          };
          if (isLegacyMatch) upgradeSectionAudio(cache, latest.signature);
          const preferredTime = restoreRequest
            ? restoreRequest.currentTime ?? cache.currentTime
            : enteredDocument.progress.sectionId === enteredSectionValue.id
              ? enteredDocument.progress.positionSec
              : cache.currentTime;
          const maximumTime = Math.max(0, cache.totalDuration);
          restoreAudioCache(cache.chunks, {
            // A saved 0 is meaningful (the user stopped or rewound).
            currentTime: Math.max(0, Math.min(maximumTime, preferredTime)),
            playbackRate: latest.playbackRate ?? cache.playbackRate,
            synthesisComplete: cache.synthesisComplete === true,
          });
          showPlayer(cache.chunks.length > 0);
          if (continuation?.autoPlay && cache.chunks.length > 0) {
            window.setTimeout(() => void togglePlay(), 0);
          }
        } else {
          if (cache && !latest.keepMismatchedAudio) void clearSectionAudio(enteredDocument.id, enteredSectionValue.id);
          if (continuation?.autoGenerate) {
            window.setTimeout(() => generateEnteredSection(), 0);
          }
        }
      } finally {
        if (continuationRef.current?.sectionId === enteredSectionValue.id) {
          continuationRef.current = null;
        }
        if (restoreRequestRef.current?.sectionId === enteredSectionValue.id) {
          restoreRequestRef.current = null;
        }
        if (restoreVersionRef.current === restoreVersion) {
          restorePendingRef.current = false;
        }
      }
    };
    void restore().catch((cause) => {
      if (!cancelled) reportError(cause);
    });
    return () => {
      cancelled = true;
      restorePendingRef.current = false;
    };
  }, [active, documentId, reportError, restoreAudioCache, sectionId, signatureKnown, togglePlay]);

  // Saves the section's audio: once a finished section stops changing, and at
  // most every READER_STREAMING_SAVE_INTERVAL_MS while one is still streaming
  // in (a save writes everything streamed so far, so saving at every gap
  // between chunks would rewrite the section quadratically).
  useEffect(() => {
    if (!active || !documentId || !sectionId || segments.length === 0) return;
    if (isSynthesisComplete) {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(flush, READER_AUDIO_SAVE_DELAY_MS);
    } else if (saveTimerRef.current === null) {
      const sinceLastSave = Date.now() - lastSaveAtRef.current;
      saveTimerRef.current = window.setTimeout(
        flush,
        Math.max(READER_AUDIO_SAVE_DELAY_MS, READER_STREAMING_SAVE_INTERVAL_MS - sinceLastSave),
      );
    }
  }, [
    active,
    documentId,
    flush,
    sectionId,
    // Segment identity changes for appended transport chunks and same-count
    // retakes. Watching only length could persist a partial Reader stream.
    segments,
    isSynthesisComplete,
  ]);

  // A pending save belongs to the flush that armed it. When the section or
  // the inputs that sign its audio change, that save must not fire: the
  // player may still hold audio the new signature would wrongly vouch for.
  useEffect(() => () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, [active, flush]);

  const isRestorePending = useCallback(() => restorePendingRef.current, []);
  const requestRestore = useCallback((target: string, currentTime?: number) => {
    restoreRequestRef.current = {
      sectionId: target,
      ...(currentTime === undefined ? {} : { currentTime: Math.max(0, currentTime) }),
    };
  }, []);
  const setContinuation = useCallback((continuation: ReaderContinuation | null) => {
    continuationRef.current = continuation;
  }, []);
  const discardForEdit = useCallback((id: string, edited: string) => {
    const cacheKey = createReaderAudioCacheKey(id, edited);
    if (clearedForEditRef.current === cacheKey) return;
    clearedForEditRef.current = cacheKey;
    void clearAudio(id, edited);
  }, [clearAudio]);

  return useMemo(() => ({
    signature,
    flush,
    isRestorePending,
    requestRestore,
    setContinuation,
    discardForEdit,
  }), [discardForEdit, flush, isRestorePending, requestRestore, setContinuation, signature]);
}

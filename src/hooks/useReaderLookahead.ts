import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  buildAudioSignature,
  createReaderAudioCacheKey,
  getCachedReaderAudioByteLength,
  type CachedReaderAudio,
  type ReaderDocumentRecord,
  type ReaderSection,
} from "../lib/readerDocument";
import { MAX_READER_AUDIO_MEMORY_CACHE_BYTES } from "../lib/readerLibrary";
import {
  cachedChunksDurationSec,
  collectSectionChunks,
  estimateSpeechBytes,
  RenderBudgetError,
} from "../lib/readerRender";
import type { SurfaceEngineId } from "../models/registry";
import type { EngineSignatureParts } from "../models/types";
import type { SynthesisChunk } from "../shared/engineRuntime";
import type { UseReaderLibraryReturn } from "./useReaderLibrary";

export type ReaderLookaheadStatus =
  /** Nothing to prepare: the feature is off, the section is last, or the current one is still being made. */
  | "idle"
  /** The next part will be prepared once the current one is playing and the engine is free. */
  | "waiting"
  | "rendering"
  /** The next part is in the audio cache, so turning to it starts at once. */
  | "ready"
  /** Not prepared on purpose (too large for the memory budget). */
  | "skipped"
  | "failed";

/** A look-ahead may hold at most this much PCM; the rest of the memory cache stays for playback. */
export const READER_LOOKAHEAD_MAX_BYTES = MAX_READER_AUDIO_MEMORY_CACHE_BYTES / 2;

/** The rate most engines produce audio at, for sizing a section before it exists. */
const TYPICAL_SAMPLE_RATE = 24_000;

interface Job {
  key: string;
  controller: AbortController;
  running: boolean;
  /** Settles once the render has fully wound down, aborted or not. */
  done: Promise<void>;
}

interface Options {
  /** The listener wants the next part prepared. */
  enabled: boolean;
  /** The Reader page is on screen. */
  active: boolean;
  document: ReaderDocumentRecord | null;
  nextSection: ReaderSection | null;
  nextSectionText: string;
  engineId: SurfaceEngineId;
  /** What the active section's audio is signed with; the next part is signed alike. */
  signatureParts: EngineSignatureParts | null;
  /**
   * Renders text with the Reader's engine, voice and tuning, as its own
   * generation would, through the engine's synthesize queue.
   */
  renderSection: (text: string, signal: AbortSignal) => AsyncIterable<SynthesisChunk>;
  /** The engine is running its own generation, which comes first. */
  engineBusy: boolean;
  modelReady: boolean;
  /** The active section's audio is complete and playing. */
  currentSectionPlaying: boolean;
  /** A segment is being regenerated on the engine's worker. */
  isRetaking: boolean;
  library: Pick<UseReaderLibraryReturn, "hasAudio" | "saveAudio">;
  /** Reported once per failed render; a look-ahead never surfaces an error banner. */
  onFailure?: (cause: unknown) => void;
}

export interface ReaderLookahead {
  status: ReaderLookaheadStatus;
  /** The section the status is about. */
  sectionId: string | null;
  /** Stops the render (softly) so the engine is free for what the listener asked for. */
  preempt: () => void;
  /** A render is in flight or still winding down, so the engine is not free yet. */
  isBusy: () => boolean;
  /** Resolves once the current render (if any) has wound down. */
  settled: () => Promise<void>;
}

/**
 * Prepares the next section while the current one plays. Once the active
 * section is fully synthesized and playing, the next section is rendered
 * through the engine's `synthesize` queue (behind anything the engine is
 * already doing, never touching the shared player) and saved to the Reader
 * audio cache, so the existing restore path turns the page without a gap.
 *
 * The render is soft-aborted the moment anything it depends on changes: the
 * document, either section, the voice or engine, an edit, or a request for
 * the engine itself (`preempt`). It never starts when the audio would not fit
 * the memory budget, and a failure is logged, not shown.
 */
export function useReaderLookahead({
  enabled,
  active,
  document,
  nextSection,
  nextSectionText,
  engineId,
  signatureParts,
  renderSection,
  engineBusy,
  modelReady,
  currentSectionPlaying,
  isRetaking,
  library,
  onFailure,
}: Options): ReaderLookahead {
  const documentId = document?.id ?? null;
  const nextSectionId = nextSection?.id ?? null;
  const signature = useMemo(() => (
    nextSection && signatureParts
      ? buildAudioSignature({ text: nextSectionText, model: engineId, ...signatureParts })
      : null
  ), [engineId, nextSection, nextSectionText, signatureParts]);

  // Everything that must hold, and keep holding, for a render to continue.
  const key = enabled
    && active
    && documentId !== null
    && nextSectionId !== null
    && signature !== null
    && modelReady
    && !engineBusy
    && !isRetaking
    ? `${documentId}\u0000${nextSectionId}\u0000${signature}`
    : null;

  const [outcome, setOutcome] = useState<{ key: string; status: ReaderLookaheadStatus } | null>(null);
  const jobRef = useRef<Job | null>(null);
  const finishedKeyRef = useRef<string | null>(null);
  const saveVersionRef = useRef(0);

  const render = useEffectEvent(async (job: Job) => {
    const { signal } = job.controller;
    const target = nextSection;
    if (!document || !target || !signatureParts || signature === null) return;
    const finish = (status: ReaderLookaheadStatus) => {
      finishedKeyRef.current = job.key;
      setOutcome({ key: job.key, status });
    };
    try {
      if (await library.hasAudio(document.id, target.id, signature)) {
        signal.throwIfAborted();
        finish("ready");
        return;
      }
      signal.throwIfAborted();
      if (estimateSpeechBytes(nextSectionText.length, TYPICAL_SAMPLE_RATE) > READER_LOOKAHEAD_MAX_BYTES) {
        finish("skipped");
        return;
      }
      setOutcome({ key: job.key, status: "rendering" });
      const chunks = await collectSectionChunks(
        renderSection(nextSectionText, signal),
        { maxBytes: READER_LOOKAHEAD_MAX_BYTES },
      );
      signal.throwIfAborted();
      if (chunks.length === 0) {
        finish("failed");
        return;
      }
      const updatedAt = Math.max(Date.now(), saveVersionRef.current + 1);
      saveVersionRef.current = updatedAt;
      const audio: CachedReaderAudio = {
        cacheKey: createReaderAudioCacheKey(document.id, target.id),
        documentId: document.id,
        chapterId: target.chapterId,
        sectionId: target.id,
        signature,
        chunks,
        byteLength: getCachedReaderAudioByteLength(chunks),
        currentTime: 0,
        playbackRate: document.listening?.playbackRate ?? 1,
        totalDuration: cachedChunksDurationSec(chunks),
        synthesisComplete: true,
        updatedAt,
      };
      await library.saveAudio(audio);
      signal.throwIfAborted();
      finish("ready");
    } catch (cause) {
      if (signal.aborted) return;
      if (cause instanceof RenderBudgetError) {
        finish("skipped");
        return;
      }
      finish("failed");
      onFailure?.(cause);
    } finally {
      job.running = false;
    }
  });

  // A render belongs to its key: any change to it, and leaving, aborts softly.
  useEffect(() => () => {
    const job = jobRef.current;
    if (!job) return;
    job.controller.abort(new DOMException("The look-ahead was superseded.", "AbortError"));
  }, [key]);

  // Starts once the current section is playing; pausing afterwards does not
  // stop a render that is under way.
  useEffect(() => {
    if (key === null || !currentSectionPlaying || finishedKeyRef.current === key) return;
    if (jobRef.current?.key === key && !jobRef.current.controller.signal.aborted) return;
    const job: Job = { key, controller: new AbortController(), running: true, done: Promise.resolve() };
    jobRef.current = job;
    job.done = render(job);
  }, [currentSectionPlaying, key]);

  const preempt = useCallback(() => {
    const job = jobRef.current;
    if (job?.running) job.controller.abort(new DOMException("The look-ahead yielded to the engine.", "AbortError"));
  }, []);
  const isBusy = useCallback(() => jobRef.current?.running === true, []);
  const settled = useCallback(() => jobRef.current?.done ?? Promise.resolve(), []);

  const status: ReaderLookaheadStatus = key === null
    ? "idle"
    : outcome?.key === key ? outcome.status : "waiting";
  return useMemo(() => ({ status, sectionId: key === null ? null : nextSectionId, preempt, isBusy, settled }), [
    isBusy,
    settled,
    key,
    nextSectionId,
    preempt,
    status,
  ]);
}

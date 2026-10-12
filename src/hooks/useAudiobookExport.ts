import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportAudioChunks } from "../lib/audioExportClient";
import {
  exportAudiobook,
  type AudiobookFormat,
  type AudiobookProgress,
  type AudiobookResult,
  type AudiobookSectionSource,
  type EncodedChapterStore,
} from "../lib/audiobook/exportAudiobook";
import { planAudiobook, type AudiobookPlan, type AudiobookScope } from "../lib/audiobook/plan";
import { downloadBlob, LOUDNESS_PRESETS } from "../lib/exportAudio";
import {
  buildAudioSignature,
  type ReaderDocumentRecord,
  type ReaderSection,
} from "../lib/readerDocument";
import { collectSectionChunks } from "../lib/readerRender";
import type { SurfaceEngineId } from "../models/registry";
import type { EngineSignatureParts } from "../models/types";
import type { SynthesisChunk } from "../shared/engineRuntime";
import type { UseReaderLibraryReturn } from "./useReaderLibrary";

const ACX = LOUDNESS_PRESETS.find((preset) => preset.id === "acx");

/**
 * Speech for listening to a whole book: constant loudness chapter to chapter
 * (the ACX audiobook level) at a bitrate that keeps a long book small.
 */
export const AUDIOBOOK_ENCODING = {
  bitrateKbps: 96,
  sampleRate: "source",
  mastering: { enabled: true, targetLufs: -20, truePeakDb: -3, measure: "rms", ...ACX?.mastering },
} as const;

export type AudiobookExportStatus = "idle" | "running" | "done" | "failed";

export interface AudiobookExportState {
  status: AudiobookExportStatus;
  progress: AudiobookProgress | null;
  error: string | null;
  result: Omit<AudiobookResult, "blob"> | null;
  scope: AudiobookScope | null;
  format: AudiobookFormat | null;
}

const IDLE: AudiobookExportState = {
  status: "idle",
  progress: null,
  error: null,
  result: null,
  scope: null,
  format: null,
};

interface Options {
  document: ReaderDocumentRecord | null;
  sections: readonly ReaderSection[];
  engineId: SurfaceEngineId;
  /** What the Reader's audio is signed with; null while a setting is unknown. */
  signatureParts: EngineSignatureParts | null;
  /** Renders text with the Reader's engine, voice and tuning (through its synthesize queue). */
  renderSection: (text: string, signal: AbortSignal) => AsyncIterable<SynthesisChunk>;
  library: Pick<UseReaderLibraryReturn, "hasAudio" | "loadAudio">;
  /** Overridable for tests. */
  encode?: typeof exportAudioChunks;
  save?: (blob: Blob, fileName: string) => void;
}

export interface AudiobookExport {
  state: AudiobookExportState;
  /** The plan for a scope, for the estimate shown before exporting. */
  planFor: (scope: AudiobookScope) => AudiobookPlan | null;
  start: (scope: AudiobookScope, format: AudiobookFormat) => void;
  /** Stops the export; chapters already finished are kept for the next attempt. */
  cancel: () => void;
  dismiss: () => void;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Renders a chapter or the whole book to a chapter-marked MP3 or a zip of
 * chapter files, then hands it to the save flow. Audio already in the Reader
 * cache is reused, so a book that was listened to exports fast; what is
 * missing is rendered through the engine's queue and cached as it goes.
 */
export function useAudiobookExport({
  document,
  sections,
  engineId,
  signatureParts,
  renderSection,
  library,
  encode = exportAudioChunks,
  save = downloadBlob,
}: Options): AudiobookExport {
  const [state, setState] = useState<AudiobookExportState>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);
  const resumeRef = useRef<{ documentId: string; store: EncodedChapterStore } | null>(null);
  const documentId = document?.id ?? null;

  const planFor = useCallback((scope: AudiobookScope) => (
    document ? planAudiobook(document, sections, scope) : null
  ), [document, sections]);

  // Another book starts afresh: its chapters and this one's never mix.
  useEffect(() => {
    resumeRef.current = null;
  }, [documentId]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const start = useCallback((scope: AudiobookScope, format: AudiobookFormat) => {
    if (!document || controllerRef.current) return;
    const plan = planAudiobook(document, sections, scope);
    if (!signatureParts) {
      setState({ ...IDLE, status: "failed", error: "Choose a voice and wait for it to load first.", scope, format });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    if (resumeRef.current?.documentId !== document.id) {
      resumeRef.current = { documentId: document.id, store: new Map() };
    }
    const resume = resumeRef.current.store;
    setState({ ...IDLE, status: "running", scope, format });

    const signatureFor = (text: string) => buildAudioSignature({ text, model: engineId, ...signatureParts });
    const source: AudiobookSectionSource = {
      signatureFor: (planned) => signatureFor(planned.text),
      load: async (planned, signal) => {
        if (planned.text.trim().length === 0) return { chunks: [], reused: true };
        const signature = signatureFor(planned.text);
        if (await library.hasAudio(document.id, planned.section.id, signature)) {
          const cached = await library.loadAudio(document.id, planned.section.id);
          if (cached?.signature === signature && cached.synthesisComplete === true && cached.chunks.length > 0) {
            return { chunks: cached.chunks, reused: true };
          }
        }
        signal.throwIfAborted();
        const chunks = await collectSectionChunks(renderSection(planned.text, signal));
        signal.throwIfAborted();
        if (chunks.length === 0) throw new Error("The voice produced no audio for a section.");
        // Not saved to the listening cache: a book's worth of sections would
        // evict the audio the listener already has. A finished chapter is kept
        // (as MP3) in the export's own resume store instead.
        return { chunks, reused: false };
      },
    };

    void exportAudiobook({
      document,
      plan,
      format,
      encoding: AUDIOBOOK_ENCODING,
      source,
      encode,
      signal: controller.signal,
      resume,
      onProgress: (progress) => {
        if (controllerRef.current === controller) setState((current) => ({ ...current, progress }));
      },
    }).then(({ blob, ...result }) => {
      if (controller.signal.aborted) return;
      save(blob, result.fileName);
      // Done: the chapters kept for a retry are no longer needed.
      resumeRef.current = null;
      setState({ status: "done", progress: null, error: null, result, scope, format });
    }, (cause: unknown) => {
      // A cancelled export is not a failure: the listener asked for it.
      if (controller.signal.aborted) {
        setState(IDLE);
        return;
      }
      setState({ ...IDLE, status: "failed", error: describe(cause), scope, format });
    }).finally(() => {
      if (controllerRef.current === controller) controllerRef.current = null;
    });
  }, [document, encode, engineId, library, renderSection, save, sections, signatureParts]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort(new DOMException("The export was cancelled.", "AbortError"));
  }, []);
  const dismiss = useCallback(() => {
    setState((current) => (current.status === "running" ? current : IDLE));
  }, []);

  return useMemo(() => ({ state, planFor, start, cancel, dismiss }), [cancel, dismiss, planFor, start, state]);
}

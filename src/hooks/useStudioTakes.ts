import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAuditionPlayer, type AuditionPlayer } from "../lib/auditionPlayer";
import { collectSynthesizedAudio } from "../lib/presetSynthesis";
import { buildSynthesisRequest } from "../lib/studioSynthesis";
import {
  MAX_VARIATIONS_PER_REQUEST,
  planTakeVariations,
  renderTakeVariations,
  type Take,
  type TakeAudio,
  type TakeStack,
} from "../lib/takes";
import { getEngine } from "../models/registry";
import type { SynthesisChunk } from "../shared/engineRuntime";
import type { SynthesisSession } from "../shared/useSynthesisSessionState";
import { useTakes } from "./useTakes";

/** The target id of the whole Studio script, as opposed to one of its segments. */
export const WHOLE_SCRIPT_TARGET = "studio:script";

export interface StudioTakeAudio extends TakeAudio {
  /** Silence already inside `samples` after the passage, kept for captions. */
  pauseAfterSec?: number;
  pauseKind?: SynthesisChunk["pauseKind"];
}

export interface TakeTarget {
  id: string;
  label: string;
  text: string;
}

export interface UseStudioTakesReturn {
  targets: TakeTarget[];
  stacks: Readonly<Record<string, TakeStack<StudioTakeAudio>>>;
  /** The take currently placed in the timeline for each target. */
  applied: Readonly<Record<string, string>>;
  /** True when takes differ by seed; otherwise they differ by a small speed change. */
  seedControl: boolean;
  /** Why variations cannot be rendered with this engine, or null. */
  unavailableReason: string | null;
  rendering: { targetId: string; done: number; total: number } | null;
  error: string | null;
  auditioningTakeId: string | null;
  renderVariations: (targetId: string, count: number) => Promise<void>;
  cancel: () => void;
  /** Make the take the active one and put it in the timeline. */
  pickTake: (targetId: string, takeId: string) => void;
  audition: (targetId: string, takeId: string) => void;
  stopAudition: () => void;
  removeTake: (targetId: string, takeId: string) => void;
  pinTake: (targetId: string, takeId: string, pinned: boolean) => void;
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function toArrayBuffer(samples: Float32Array): ArrayBuffer {
  return samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer;
}

/**
 * Variations and take stacks for Studio. Takes render through
 * `EngineRuntime.synthesize`, never the shared player, so the current audio
 * keeps playing while they render; choosing one replaces that passage in the
 * timeline (or, for the whole script, becomes the timeline).
 */
export function useStudioTakes(session: SynthesisSession): UseStudioTakesReturn {
  const { studio, player } = session;
  const { stacks, openTakes, addTake, setActiveTake, removeTake, pinTake, resetTakes } = useTakes<StudioTakeAudio>();
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [rendering, setRendering] = useState<UseStudioTakesReturn["rendering"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [auditioningTakeId, setAuditioningTakeId] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const auditionRef = useRef<AuditionPlayer | null>(null);
  const { segments, replaceSegment, restoreAudioCache } = player.state;

  const latest = useRef({ session, stacks });
  useEffect(() => {
    latest.current = { session, stacks };
  });

  const capabilities = getEngine(studio.engineId).capabilities;
  const seedControl = capabilities.seed;
  const unavailableReason = seedControl || capabilities.speed
    ? null
    : `${getEngine(studio.engineId).label} has no seed or speed control to vary takes with.`;

  const targets = useMemo<TakeTarget[]>(() => [
    { id: WHOLE_SCRIPT_TARGET, label: "Whole script", text: studio.text },
    ...segments.map((segment) => ({
      id: segment.id,
      label: `Passage ${segment.index}: ${segment.text.length > 48 ? `${segment.text.slice(0, 47)}…` : segment.text}`,
      text: segment.text,
    })),
  ], [segments, studio.text]);

  // Takes belong to the text and audio they were rendered for.
  const [seenText, setSeenText] = useState(studio.text);
  const hasAudio = player.state.totalDuration > 0;
  const [hadAudio, setHadAudio] = useState(hasAudio);
  // A new generation of the same text makes new segments, so old stacks go too.
  const isGenerating = studio.runtime.isGenerating;
  const [wasGenerating, setWasGenerating] = useState(isGenerating);
  const generationStarted = isGenerating && !wasGenerating;
  if (wasGenerating !== isGenerating) setWasGenerating(isGenerating);
  if (seenText !== studio.text || (hadAudio && !hasAudio) || generationStarted) {
    setSeenText(studio.text);
    resetTakes();
    setApplied({});
  }
  if (hadAudio !== hasAudio) setHadAudio(hasAudio);

  const stopAudition = useCallback(() => {
    auditionRef.current?.stop();
    setAuditioningTakeId(null);
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  useEffect(() => () => {
    controllerRef.current?.abort();
    auditionRef.current?.dispose();
  }, []);

  const renderVariations = useCallback(async (targetId: string, count: number) => {
    const { session: current, stacks: currentStacks } = latest.current;
    const target = (targetId === WHOLE_SCRIPT_TARGET
      ? { text: current.studio.text }
      : current.player.state.segments.find((segment) => segment.id === targetId));
    const text = target?.text.trim() ?? "";
    if (!target || text.length === 0) {
      setError("There is no text to render variations of.");
      return;
    }
    if (count < 1 || count > MAX_VARIATIONS_PER_REQUEST) {
      setError(`Request between 1 and ${MAX_VARIATIONS_PER_REQUEST} variations.`);
      return;
    }
    const engineId = current.studio.engineId;
    const engineCapabilities = getEngine(engineId).capabilities;
    const base = { settings: current.engines.surfaceEngineSettings, tuning: current.creator.generationSettings };
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    openTakes(targetId);
    let done = 0;
    setRendering({ targetId, done, total: count });
    try {
      const variations = planTakeVariations({
        count,
        seedControl: engineCapabilities.seed,
        existing: currentStacks[targetId]?.takes ?? [],
        baseSpeed: base.tuning.speed,
      });
      await renderTakeVariations<StudioTakeAudio>({
        variations,
        signal: controller.signal,
        render: async (variation, signal) => {
          const runtime = latest.current.session.engines.runtimes[engineId] as unknown as {
            synthesize: (request: ReturnType<typeof buildSynthesisRequest>) => AsyncIterable<SynthesisChunk>;
          };
          const request = buildSynthesisRequest(engineId, base, text, {
            seed: variation.seed ?? undefined,
            speed: variation.overrides?.speed,
            signal,
          });
          let last: SynthesisChunk | null = null;
          const tapped = (async function* () {
            for await (const chunk of runtime.synthesize(request)) {
              last = chunk;
              yield chunk;
            }
          })();
          const audio = await collectSynthesizedAudio(tapped, signal);
          const lastChunk = last as SynthesisChunk | null;
          return {
            samples: audio.samples,
            sampleRate: audio.sampleRate,
            ...(lastChunk?.pauseAfterSec === undefined ? {} : { pauseAfterSec: lastChunk.pauseAfterSec }),
            ...(lastChunk?.pauseKind === undefined ? {} : { pauseKind: lastChunk.pauseKind }),
          };
        },
        onTake: (take) => {
          addTake(targetId, take, { activate: false });
          done += 1;
          setRendering({ targetId, done, total: count });
        },
      });
    } catch (cause) {
      if (!isAbort(cause)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setRendering(null);
    }
  }, [addTake, openTakes]);

  const audition = useCallback((targetId: string, takeId: string) => {
    const take = latest.current.stacks[targetId]?.takes.find((entry) => entry.id === takeId);
    if (!take) return;
    try {
      auditionRef.current ??= createAuditionPlayer();
      setAuditioningTakeId(takeId);
      void auditionRef.current.play(take.audio, () => setAuditioningTakeId((current) => (current === takeId ? null : current)))
        .catch((cause: unknown) => {
          setAuditioningTakeId(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    } catch (cause) {
      setAuditioningTakeId(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const pickTake = useCallback((targetId: string, takeId: string) => {
    const { session: current, stacks: currentStacks } = latest.current;
    const take: Take<StudioTakeAudio> | undefined = currentStacks[targetId]?.takes.find((entry) => entry.id === takeId);
    if (!take) return;
    setActiveTake(targetId, takeId);
    if (targetId === WHOLE_SCRIPT_TARGET) {
      current.engines.runtimes[current.studio.engineId].cancelActiveGeneration();
      restoreAudioCache([{
        audio: toArrayBuffer(take.audio.samples),
        samplingRate: take.audio.sampleRate,
        text: current.studio.text,
        index: 1,
        total: 1,
        ...(take.audio.pauseAfterSec === undefined ? {} : { pauseAfterSec: take.audio.pauseAfterSec }),
        ...(take.audio.pauseKind === undefined ? {} : { pauseKind: take.audio.pauseKind }),
      }], { synthesisComplete: true });
      current.player.setShow(true);
    } else {
      const segment = current.player.state.segments.find((entry) => entry.id === targetId);
      if (!segment) {
        setError("That passage is no longer in the timeline.");
        return;
      }
      replaceSegment(targetId, {
        audio: take.audio.samples,
        samplingRate: take.audio.sampleRate,
        text: segment.text,
        index: segment.index,
        total: segment.total,
        textStart: segment.textStart,
        textEnd: segment.textEnd,
        pauseAfterSec: take.audio.pauseAfterSec ?? segment.pauseAfterSec,
        pauseKind: take.audio.pauseKind ?? segment.pauseKind,
      });
    }
    setApplied((currentApplied) => ({ ...currentApplied, [targetId]: takeId }));
  }, [replaceSegment, restoreAudioCache, setActiveTake]);

  return {
    targets,
    stacks,
    applied,
    seedControl,
    unavailableReason,
    rendering,
    error,
    auditioningTakeId,
    renderVariations,
    cancel,
    pickTake,
    audition,
    stopAudition,
    removeTake,
    pinTake,
  };
}

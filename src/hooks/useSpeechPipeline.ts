import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildSpeechPlanSafe, createChunkRemapper, type SpeechPlan } from "../lib/speechPipeline";
import type { SurfaceEngineId, SurfaceEngineSettings } from "../models/registry";
import type { EngineRuntimeMap } from "../shared/engineRuntime";
import {
  engineSpeechLanguage,
  resolveSpeechPipelineSettings,
  speechBreakBoundary,
  withSpeechPipelineAll,
  type SpeechPipelineChoices,
} from "../shared/speechPipelineRuntime";
import type { AudioChunk } from "../types";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";

type LanguageSettings = Pick<SurfaceEngineSettings, "kokoro" | "supertonic" | "supertonic3" | "qwen3">;

interface Options {
  /** The script the visible surface speaks, as written. */
  text: string;
  choices: SpeechPipelineChoices;
  /** The engine on screen, or null off the surfaces. */
  visibleEngineId: SurfaceEngineId | null;
  /** The engine whose language applies while none is on screen. */
  fallbackEngineId: SurfaceEngineId;
  /** What each engine reads to pick its language. */
  languageSettings: LanguageSettings;
  player: UseAudioPlayerReturn;
}

export interface UseSpeechPipelineReturn {
  plan: SpeechPlan;
  /** What the surface engines speak: the pipeline's spoken form of the script. */
  spokenText: string;
  /**
   * The player the surface engines write into. Chunks reach the real player
   * against the written script: ranges and text point at what the user wrote,
   * and a break's silence is exact.
   */
  player: UseAudioPlayerReturn;
  /** The text to regenerate a stored segment with: what the engine spoke for it. */
  retakeText: (segment: Pick<AudioChunk, "text" | "textStart" | "textEnd">) => string;
  /** `runtimes` with `synthesize` running the same pipeline, per request. */
  wrapRuntimes: (runtimes: EngineRuntimeMap) => EngineRuntimeMap;
}

/**
 * Wires the spoken-text pipeline between the script and the engines: the
 * surface generation speaks the spoken form and its chunks are remapped on
 * their way to the player, and `synthesize` requests get the same treatment.
 */
export function useSpeechPipeline({
  text,
  choices,
  visibleEngineId,
  fallbackEngineId,
  languageSettings,
  player,
}: Options): UseSpeechPipelineReturn {
  const { dictionaries, normalize, cleanup } = choices;
  const engineId = visibleEngineId ?? fallbackEngineId;
  const language = engineSpeechLanguage(engineId, languageSettings);
  const boundary = speechBreakBoundary(engineId);
  const settings = useMemo(
    () => resolveSpeechPipelineSettings({ dictionaries, normalize, cleanup }, language),
    [cleanup, dictionaries, language, normalize],
  );
  const plan = useMemo(() => buildSpeechPlanSafe(text, settings, boundary), [boundary, settings, text]);
  const remapper = useMemo(() => createChunkRemapper(plan), [plan]);

  const { beginStream, scheduleChunk } = player;
  // A generation maps its chunks with the plan its text came from, even if the
  // dictionary or the script changes while it runs.
  const streamRemapperRef = useRef(remapper);
  const scheduleRemapped = useCallback(
    (chunk: Parameters<typeof scheduleChunk>[0]) => scheduleChunk(streamRemapperRef.current.map(chunk)),
    [scheduleChunk],
  );
  const beginRemappedStream = useCallback(() => {
    remapper.reset();
    streamRemapperRef.current = remapper;
    beginStream();
  }, [beginStream, remapper]);
  const pipelinePlayer = useMemo<UseAudioPlayerReturn>(
    () => (plan.identity ? player : { ...player, scheduleChunk: scheduleRemapped, beginStream: beginRemappedStream }),
    [beginRemappedStream, plan.identity, player, scheduleRemapped],
  );

  const retakeText = useCallback<UseSpeechPipelineReturn["retakeText"]>((segment) => {
    if (plan.identity || segment.textStart === undefined || segment.textEnd === undefined) return segment.text;
    // The stored offsets belong to the script the audio was made from. Once it
    // is edited they point elsewhere, so the passage is retaken as it was written.
    if (plan.source.slice(segment.textStart, segment.textEnd) !== segment.text) return segment.text;
    const range = plan.toSpokenRange({ start: segment.textStart, end: segment.textEnd });
    return plan.spoken.slice(range.start, range.end);
  }, [plan]);

  // Requests resolve their settings when they are made, from what the user has
  // chosen by then, without the wrapped runtimes changing identity on each edit.
  // Each engine's wrapped `synthesize` also outlives the runtime objects it is
  // rewrapped into on every model-state tick and streamed chunk.
  const latest = useRef({ choices: { dictionaries, normalize, cleanup }, languageSettings });
  useEffect(() => {
    latest.current = { choices: { dictionaries, normalize, cleanup }, languageSettings };
  }, [cleanup, dictionaries, languageSettings, normalize]);
  const [synthesizeWrappers] = useState(() => new WeakMap<object, unknown>());
  const wrapRuntimes = useCallback((runtimes: EngineRuntimeMap) => withSpeechPipelineAll(
    runtimes,
    (id) => resolveSpeechPipelineSettings(latest.current.choices, engineSpeechLanguage(id, latest.current.languageSettings)),
    synthesizeWrappers,
  ), [synthesizeWrappers]);

  return { plan, spokenText: plan.spoken, player: pipelinePlayer, retakeText, wrapRuntimes };
}

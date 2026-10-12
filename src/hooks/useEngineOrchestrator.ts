import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import {
  getDefaultSupportedModel,
  isModelSupportedInBrowser,
  type LocalBrowserSupport,
} from "../lib/browserSupport";
import type { InitialAppState } from "../lib/appState";
import type { Audio8Settings } from "../models/audio8";
import type { ChatterboxSettings } from "../models/chatterbox";
import type { Supertonic3Settings } from "../models/supertonic3";
import {
  browserEngineWorkerFields,
  isBrowserEngineId,
  type BrowserEngineId,
  type DesktopInlineEngineId,
  type SurfaceEngineId,
  type SurfaceEngineSettings,
} from "../models/registry";
import type { EngineRuntimeMap } from "../shared/engineRuntime";
import type { SpeechPipelineChoices } from "../shared/speechPipelineRuntime";
import { describeDesktopModelOptions, type DesktopModelOption } from "../shared/desktopModelOptions";
import type { GenerationTuningSettings } from "../types";
import { useAudio8Runtime, type Audio8Runtime } from "./useAudio8Runtime";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useBrowserEngineRuntimes, type UseBrowserEngineRuntimesReturn } from "./useBrowserEngineRuntimes";
import { useQwen3LocalRuntime } from "./useQwen3LocalRuntime";
import { useSpeechPipeline } from "./useSpeechPipeline";
import { useSupertonic3Runtime } from "./useSupertonic3Runtime";

/** The pages that synthesize into the shared player. */
export type Surface = "studio" | "reader";

/** The voice and language each engine Studio owns renders with. */
export interface OrchestratedEngineSettings {
  kokoro: { voice: string };
  supertonic: { voice: string; language: string };
  kitten: { voice: string };
  paradee: { voice: string };
  piper: { voice: string };
  chatterbox: ChatterboxSettings;
  audio8: Audio8Settings;
  supertonic3: Supertonic3Settings;
}

interface Options {
  /** The surface on screen, or null on a page that synthesizes nothing (setup pages). */
  surface: Surface | null;
  /** Desktop runtimes (Audio8, Qwen3 inline) are compiled in and the preload bridge is live. */
  desktopRuntimesAvailable: boolean;
  /** The desktop entry injects the Supertonic 3 worker; the web bundle never has it. */
  createSupertonic3Worker?: () => Worker;
  /** The entry point opted into desktop runtimes, with or without a live bridge. */
  enableDesktopRuntimes: boolean;
  browserSupport: LocalBrowserSupport;
  debugProfiling: boolean;
  initialState: Pick<InitialAppState, "model" | "desktopModels">;
  /** What the visible surface generation speaks, as written. */
  text: string;
  engineSettings: OrchestratedEngineSettings;
  generationSettings: GenerationTuningSettings;
  /**
   * The spoken-text pipeline's Creator choices. Every engine speaks the
   * pipeline's form of the script and the player receives chunks against the
   * written one; see `lib/speechPipeline.ts`.
   */
  speech: SpeechPipelineChoices;
  player: UseAudioPlayerReturn;
  setShowPlayer: (show: boolean) => void;
  /**
   * Runs before anything replaces the audio the Reader is showing, so it can
   * be saved under the inputs that made it.
   */
  beforeReaderAudioChange: () => void;
  /** Runs after a selection or an engine input changed. */
  onEngineChange: () => void;
}

export interface UseEngineOrchestratorReturn {
  /** The browser engine both surfaces fall back to: the chosen one while this device can run it. */
  activeModel: BrowserEngineId;
  /** The browser engine the user chose, runnable or not; this is what to persist. */
  chosenModel: BrowserEngineId;
  /** Each surface's effective desktop engine: its saved choice while that engine is available. */
  desktopModels: Readonly<Record<Surface, DesktopInlineEngineId | null>>;
  /** Each surface's saved desktop engine, available or not, for persistence. */
  chosenDesktopModels: Readonly<Record<Surface, DesktopInlineEngineId | null>>;
  engineIds: Readonly<Record<Surface, SurfaceEngineId>>;
  /** The engine whose audio the visible surface plays and saves, or null off the surfaces. */
  visibleEngineId: SurfaceEngineId | null;
  runtimes: EngineRuntimeMap;
  /** What the visible surface's engines are asked to speak: the script after the speech pipeline. */
  spokenText: string;
  audio8: Audio8Runtime;
  browser: Omit<UseBrowserEngineRuntimesReturn, "runtimes">;
  desktopEngineAvailability: Readonly<Record<DesktopInlineEngineId, boolean>>;
  /** What every engine a surface can select reads right now, keyed by engine. */
  surfaceEngineSettings: SurfaceEngineSettings;
  desktopModelOptions: Readonly<Record<Surface, DesktopModelOption[]>>;
  /** Stops every engine's surface generation (unforced) and clears what each put in the player. */
  retireAllAudio: () => void;
  selectBrowserModel: (surface: Surface, model: BrowserEngineId) => void;
  selectDesktopModel: (surface: Surface, engine: DesktopInlineEngineId) => void;
  /**
   * Changes an input that shapes `engine`'s audio. When that engine drives the
   * visible surface, the audio made with the old input is first saved under
   * the old Reader signature, then its generation is cancelled and its audio
   * cleared, so it is never presented (or cached) as the new input's. Another
   * engine's input changes nothing audible, so the player keeps its audio.
   */
  changeEngineInput: (engine: SurfaceEngineId, apply: () => void) => void;
}

/**
 * Owns which engine each surface runs and every engine runtime behind one
 * keyed map. Each runtime hook is called once, in a fixed order, and the map
 * is the only place the engines are enumerated: cancelling, resetting and
 * picking a surface's runtime all go through it.
 *
 * Engines are activated per surface. A browser or Supertonic 3 model stays
 * loaded while either surface selects it, so switching pages reloads nothing;
 * only the generation of the surface being left is stopped.
 */
export function useEngineOrchestrator({
  surface,
  desktopRuntimesAvailable,
  createSupertonic3Worker,
  enableDesktopRuntimes,
  browserSupport,
  debugProfiling,
  initialState,
  text,
  engineSettings,
  generationSettings,
  speech,
  player,
  setShowPlayer,
  beforeReaderAudioChange,
  onEngineChange,
}: Options): UseEngineOrchestratorReturn {
  const qwen3Settings = useQwen3Runtime();
  // The desktop entry owns this capability by supplying the worker factory.
  // Do not also gate it on the preload bridge: Supertonic 3 runs entirely in
  // the renderer worker, and a delayed/stale preload must not hide the model.
  const supertonic3Available = enableDesktopRuntimes && typeof createSupertonic3Worker === "function";
  const desktopEngineAvailability = useMemo<Record<DesktopInlineEngineId, boolean>>(() => ({
    audio8: desktopRuntimesAvailable,
    supertonic3: supertonic3Available,
    qwen3: qwen3Settings.available,
  }), [desktopRuntimesAvailable, qwen3Settings.available, supertonic3Available]);

  // The browser model the user chose, kept even while it cannot run (WebGPU
  // missing, say) so it returns on a later launch. The model that actually
  // runs is derived from what the device supports now.
  const [chosenModel, setChosenModel] = useState<BrowserEngineId>(initialState.model);
  const activeModel = isModelSupportedInBrowser(chosenModel, browserSupport)
    ? chosenModel
    : getDefaultSupportedModel(browserSupport);
  // The desktop engine each surface last chose, persisted across launches. A
  // surface uses it only while that engine is available and otherwise runs the
  // browser model, without forgetting the choice for when it returns.
  const [chosenDesktopModels, setChosenDesktopModels] = useState<Record<Surface, DesktopInlineEngineId | null>>(
    () => ({ ...initialState.desktopModels }),
  );
  const effectiveDesktopModel = (chosen: DesktopInlineEngineId | null) => (
    chosen && desktopEngineAvailability[chosen] ? chosen : null
  );
  const studioDesktopModel = effectiveDesktopModel(chosenDesktopModels.studio);
  const readerDesktopModel = effectiveDesktopModel(chosenDesktopModels.reader);
  const desktopModels = useMemo(
    () => ({ studio: studioDesktopModel, reader: readerDesktopModel }),
    [readerDesktopModel, studioDesktopModel],
  );
  const studioEngineId: SurfaceEngineId = studioDesktopModel ?? activeModel;
  const readerEngineId: SurfaceEngineId = readerDesktopModel ?? activeModel;
  const engineIds = useMemo(
    () => ({ studio: studioEngineId, reader: readerEngineId }),
    [readerEngineId, studioEngineId],
  );
  const visibleEngineId: SurfaceEngineId | null = surface === null ? null : engineIds[surface];
  const selects = (engine: SurfaceEngineId) => studioEngineId === engine || readerEngineId === engine;

  const languageSettings = useMemo(() => ({
    kokoro: engineSettings.kokoro,
    supertonic: engineSettings.supertonic,
    supertonic3: engineSettings.supertonic3,
    qwen3: qwen3Settings,
  }), [engineSettings.kokoro, engineSettings.supertonic, engineSettings.supertonic3, qwen3Settings]);
  const pipeline = useSpeechPipeline({
    text,
    choices: speech,
    visibleEngineId,
    fallbackEngineId: activeModel,
    languageSettings,
    player,
  });
  // The pipeline applies the pronunciation dictionary to every engine, so the
  // engines' own copy of the rules is cleared; a rule must not apply twice.
  const engineTuning = useMemo<GenerationTuningSettings>(
    () => ({ ...generationSettings, pronunciationRules: [] }),
    [generationSettings],
  );

  const {
    kokoro: kokoroSettings,
    supertonic: supertonicSettings,
    kitten: kittenSettings,
    paradee: paradeeSettings,
    piper: piperSettings,
    chatterbox: chatterboxSettings,
  } = engineSettings;
  // Warms the Supertonic 2 worker, and downloads the Piper voice, the user
  // will speak first.
  const preferredBrowserVoices = useMemo(
    () => ({ supertonic: supertonicSettings.voice, piper: piperSettings.voice }),
    [piperSettings.voice, supertonicSettings.voice],
  );
  const savedBrowserVoices = useMemo(
    () => ({
      kokoro: kokoroSettings.voice,
      supertonic: supertonicSettings.voice,
      kitten: kittenSettings.voice,
      paradee: paradeeSettings.voice,
      piper: piperSettings.voice,
      chatterbox: chatterboxSettings.voice,
    }),
    [
      kittenSettings.voice,
      chatterboxSettings.voice,
      kokoroSettings.voice,
      paradeeSettings.voice,
      piperSettings.voice,
      supertonicSettings.voice,
    ],
  );
  // What only the shared browser model's worker reads (Chatterbox's reference voice and sampling).
  const browserEngineFields = useMemo(
    () => browserEngineWorkerFields(activeModel, engineSettings[activeModel]),
    [activeModel, engineSettings],
  );
  const browser = useBrowserEngineRuntimes({
    activeModel,
    // Pages that synthesize nothing leave the browser model running, as the
    // Studio they usually return to expects.
    active: browserSupport.isSupported && (visibleEngineId === null || isBrowserEngineId(visibleEngineId)),
    // Studio and the Reader share the browser model, so a page switch keeps it
    // loaded while the other surface still selects it.
    retain: browserSupport.isSupported && selects(activeModel),
    browserSupport,
    preferredVoices: preferredBrowserVoices,
    debugProfiling,
    text: pipeline.spokenText,
    savedVoices: savedBrowserVoices,
    generationSettings: engineTuning,
    engineFields: browserEngineFields,
    player: pipeline.player,
    retakeText: pipeline.retakeText,
    setShowPlayer,
  });
  const qwen3 = useQwen3LocalRuntime({
    enabled: desktopRuntimesAvailable && qwen3Settings.available && visibleEngineId === "qwen3",
    retain: desktopRuntimesAvailable && qwen3Settings.available && selects("qwen3"),
    text: pipeline.spokenText,
    allowLongText: visibleEngineId === "qwen3",
    player: pipeline.player,
    setShowPlayer,
  });
  const supertonic3 = useSupertonic3Runtime({
    available: supertonic3Available,
    active: visibleEngineId === "supertonic3",
    retain: selects("supertonic3"),
    createWorker: createSupertonic3Worker,
    text: pipeline.spokenText,
    voice: engineSettings.supertonic3.voice,
    language: engineSettings.supertonic3.language,
    seed: engineSettings.supertonic3.seed,
    generationSettings: engineTuning,
    player: pipeline.player,
    setShowPlayer,
  });
  const { seed: audio8Seed, temperature: audio8Temperature } = engineSettings.audio8;
  const audio8Sampling = useMemo(
    () => ({ seed: audio8Seed, temperature: audio8Temperature }),
    [audio8Seed, audio8Temperature],
  );
  const audio8 = useAudio8Runtime({
    active: visibleEngineId === "audio8",
    text: pipeline.spokenText,
    voice: engineSettings.audio8.voice,
    sampling: audio8Sampling,
    generationSettings: engineTuning,
    player: pipeline.player,
    setShowPlayer,
  });

  const { wrapRuntimes } = pipeline;
  const runtimes = useMemo<EngineRuntimeMap>(() => wrapRuntimes({
    ...browser.runtimes,
    audio8,
    supertonic3,
    qwen3,
  }), [audio8, browser.runtimes, qwen3, supertonic3, wrapRuntimes]);

  const retireAllAudio = useCallback(() => {
    const all = Object.values(runtimes);
    for (const runtime of all) runtime.cancelActiveGeneration();
    for (const runtime of all) runtime.resetGeneratedAudio();
  }, [runtimes]);

  // When the visible engine changes, whether because the page or its
  // selection did, the engine left behind stops: its audio would otherwise
  // keep streaming into the player under a surface that did not ask for it.
  // Switching between surfaces that select the same engine changes nothing
  // here, so a generation continues across that switch.
  const previousVisibleEngineRef = useRef(visibleEngineId);
  useEffect(() => {
    const previous = previousVisibleEngineRef.current;
    previousVisibleEngineRef.current = visibleEngineId;
    if (previous !== null && previous !== visibleEngineId) runtimes[previous].cancelActiveGeneration();
  }, [runtimes, visibleEngineId]);

  const { loadModel } = browser;
  const selectBrowserModel = useCallback((target: Surface, model: BrowserEngineId) => {
    if (target === "reader") beforeReaderAudioChange();
    if (!isModelSupportedInBrowser(model, browserSupport)) return;
    if (model === activeModel && desktopModels[target] === null) return;
    retireAllAudio();
    setChosenDesktopModels((current) => ({ ...current, [target]: null }));
    if (model !== activeModel) {
      setChosenModel(model);
      loadModel(model);
    }
    onEngineChange();
  }, [activeModel, beforeReaderAudioChange, browserSupport, desktopModels, loadModel, onEngineChange, retireAllAudio]);

  const selectDesktopModel = useCallback((target: Surface, engine: DesktopInlineEngineId) => {
    if (target === "reader") beforeReaderAudioChange();
    if (desktopModels[target] === engine) return;
    retireAllAudio();
    setChosenDesktopModels((current) => ({ ...current, [target]: engine }));
    onEngineChange();
  }, [beforeReaderAudioChange, desktopModels, onEngineChange, retireAllAudio]);

  const changeEngineInput = useCallback((engine: SurfaceEngineId, apply: () => void) => {
    if (engine === visibleEngineId) {
      if (surface === "reader") beforeReaderAudioChange();
      const runtime = runtimes[engine];
      runtime.cancelActiveGeneration();
      runtime.resetGeneratedAudio();
    }
    apply();
    onEngineChange();
  }, [beforeReaderAudioChange, onEngineChange, runtimes, surface, visibleEngineId]);

  const { voicesInUse } = browser;
  const surfaceEngineSettings = useMemo<SurfaceEngineSettings>(() => ({
    kokoro: { voice: voicesInUse.kokoro },
    supertonic: { voice: voicesInUse.supertonic, language: supertonicSettings.language },
    kitten: { voice: voicesInUse.kitten },
    paradee: { voice: voicesInUse.paradee },
    piper: { voice: voicesInUse.piper },
    chatterbox: { ...chatterboxSettings, voice: voicesInUse.chatterbox },
    audio8: engineSettings.audio8,
    supertonic3: engineSettings.supertonic3,
    qwen3: qwen3Settings,
  }), [chatterboxSettings, engineSettings.audio8, engineSettings.supertonic3, qwen3Settings, supertonicSettings.language, voicesInUse]);

  const desktopModelOptions = useMemo(() => {
    const optionsFor = (target: Surface) => describeDesktopModelOptions(
      desktopEngineAvailability,
      surfaceEngineSettings,
      desktopModels[target],
    ).map((option) => ({ ...option, onSelect: () => selectDesktopModel(target, option.key) }));
    return { studio: optionsFor("studio"), reader: optionsFor("reader") };
  }, [desktopEngineAvailability, desktopModels, selectDesktopModel, surfaceEngineSettings]);

  const browserExtras = useMemo(() => ({
    voicesInUse: browser.voicesInUse,
    states: browser.states,
    voices: browser.voices,
    loadModel: browser.loadModel,
    isRetakingSegment: browser.isRetakingSegment,
    handleRetakeSegment: browser.handleRetakeSegment,
    cacheBusy: browser.cacheBusy,
    cacheStatus: browser.cacheStatus,
    clearCache: browser.clearCache,
    redownloadActiveModel: browser.redownloadActiveModel,
  }), [
    browser.cacheBusy,
    browser.cacheStatus,
    browser.clearCache,
    browser.handleRetakeSegment,
    browser.isRetakingSegment,
    browser.loadModel,
    browser.redownloadActiveModel,
    browser.states,
    browser.voices,
    browser.voicesInUse,
  ]);

  return {
    activeModel,
    chosenModel,
    desktopModels,
    chosenDesktopModels,
    engineIds,
    visibleEngineId,
    runtimes,
    spokenText: pipeline.spokenText,
    audio8,
    browser: browserExtras,
    desktopEngineAvailability,
    surfaceEngineSettings,
    desktopModelOptions,
    retireAllAudio,
    selectBrowserModel,
    selectDesktopModel,
    changeEngineInput,
  };
}

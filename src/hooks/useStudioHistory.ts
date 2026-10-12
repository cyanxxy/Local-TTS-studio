import { useCallback, useEffect, useRef, useState } from "react";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { downloadAudioChunks } from "../lib/audioExportClient";
import {
  historyAudioToExportChunks,
  historyDownloadFileName,
  type GenerationHistoryEntry,
  type HistorySettings,
  type ReusableGenerationSettings,
} from "../lib/history/generationHistory";
import { presetFromSelection, type SynthesisBase } from "../lib/studioSynthesis";
import { getEngine, isBrowserEngineId, isDesktopInlineEngineId, type SurfaceEngineId } from "../models/registry";
import type { SynthesisSession } from "../shared/useSynthesisSessionState";
import type { UseGenerationHistoryReturn } from "./useGenerationHistory";

export interface UseStudioHistoryOptions {
  session: SynthesisSession;
  history: UseGenerationHistoryReturn;
}

export interface UseStudioHistoryReturn {
  /** The last history action that failed, for the panel to show. */
  error: string | null;
  clearError: () => void;
  replay: (id: string) => Promise<void>;
  download: (entry: GenerationHistoryEntry) => Promise<void>;
  reuse: (id: string) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Connects Studio to Generation History: every generation that finishes in
 * the shared player is saved, and saved ones can be replayed into the player,
 * exported with the Creator export settings, or reused (text, engine, voice
 * and tuning put back). Audio the user restored from history is not saved a
 * second time when it reports complete.
 */
export function useStudioHistory({ session, history }: UseStudioHistoryOptions): UseStudioHistoryReturn {
  const qwen3 = useQwen3Runtime();
  const { player, studio, engines, creator } = session;
  const playerState = player.state;
  const { getAudioCacheSnapshot, getContentEpoch, restoreAudioCache, togglePlay } = playerState;
  const { saveGeneration, loadAudio, reuseSettings } = history;
  const [error, setError] = useState<string | null>(null);

  const base: SynthesisBase = { settings: engines.surfaceEngineSettings, tuning: creator.generationSettings };
  const latest = useRef({ session, base, qwen3, saveGeneration });
  useEffect(() => {
    latest.current = { session, base, qwen3, saveGeneration };
  });

  // Capture: a generation that completes in the shared player is saved once.
  const wasCompleteRef = useRef(playerState.isSynthesisComplete);
  const restoredEpochRef = useRef<number | null>(null);
  const isComplete = playerState.isSynthesisComplete;
  useEffect(() => {
    const was = wasCompleteRef.current;
    wasCompleteRef.current = isComplete;
    if (!isComplete || was) return;
    if (restoredEpochRef.current === getContentEpoch()) return;
    const chunks = getAudioCacheSnapshot();
    const current = latest.current;
    const { studio: studioNow } = current.session;
    if (chunks.length === 0 || studioNow.text.trim().length === 0) return;
    const engineId = studioNow.engineId;
    const voice = presetFromSelection(engineId, current.base);
    current.saveGeneration({
      text: studioNow.text,
      engineId,
      voice,
      settings: voice.settings as HistorySettings,
      ...(voice.settings.seed === undefined ? {} : { seed: voice.settings.seed }),
      chunks,
    }).catch((cause: unknown) => setError(`Could not save to history: ${errorMessage(cause)}`));
  }, [getAudioCacheSnapshot, getContentEpoch, isComplete]);

  const replay = useCallback(async (id: string) => {
    setError(null);
    try {
      const chunks = await loadAudio(id);
      if (!chunks || chunks.length === 0) {
        setError("The audio for this generation is no longer stored.");
        return;
      }
      const current = latest.current.session;
      current.engines.runtimes[current.studio.engineId].cancelActiveGeneration();
      restoreAudioCache(chunks, { synthesisComplete: true });
      restoredEpochRef.current = getContentEpoch();
      current.player.setShow(true);
      togglePlay();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [getContentEpoch, loadAudio, restoreAudioCache, togglePlay]);

  const download = useCallback(async (entry: GenerationHistoryEntry) => {
    setError(null);
    try {
      const chunks = await loadAudio(entry.id);
      if (!chunks || chunks.length === 0) {
        setError("The audio for this generation is no longer stored.");
        return;
      }
      const fileName = historyDownloadFileName(entry, "wav").replace(/\.wav$/, "");
      await downloadAudioChunks(historyAudioToExportChunks(chunks), latest.current.session.creator.exportOptions, { fileName });
    } catch (cause) {
      if ((cause as { name?: unknown } | null)?.name !== "AbortError") setError(errorMessage(cause));
    }
  }, [loadAudio]);

  // Reuse selects the engine first; the voice and tuning are applied once the
  // engine is the one Studio runs, because they act on the selected engine.
  const pendingReuseRef = useRef<ReusableGenerationSettings | null>(null);

  const applyReusable = useCallback((reusable: ReusableGenerationSettings) => {
    const { session: current, qwen3: qwen } = latest.current;
    const { engines: engine, creator: tuning, studio: studioNow } = current;
    const preset = reusable.voice;
    const settings = preset.settings;
    studioNow.changeText(reusable.text);
    if (typeof settings.speed === "number") tuning.onSpeedChange(settings.speed);
    if (typeof settings.quality === "number" && getEngine(reusable.engineId as SurfaceEngineId).capabilities.quality) {
      engine.changeQuality(settings.quality);
    }
    switch (reusable.engineId) {
      case "kokoro":
        engine.changeVoice(preset.voiceId);
        break;
      case "supertonic":
        engine.changeVoice(preset.voiceId);
        if (settings.language) engine.changeSupertonicLanguage(settings.language);
        break;
      case "audio8":
        engine.changeAudio8Voice(preset.voiceId);
        break;
      case "supertonic3":
        engine.changeSupertonic3Voice(preset.voiceId);
        if (settings.language) engine.changeSupertonic3Language(settings.language);
        break;
      case "qwen3":
        qwen.setSpeaker(preset.voiceId);
        if (settings.language) qwen.setLanguage(settings.language);
        if (settings.instruction !== undefined) qwen.setInstruct(settings.instruction);
        qwen.setSeed(reusable.seed ?? null);
        break;
      default:
        break;
    }
  }, []);

  const pendingEngineId = studio.engineId;
  const applyReusableRef = useRef(applyReusable);
  useEffect(() => {
    applyReusableRef.current = applyReusable;
  });
  useEffect(() => {
    const pending = pendingReuseRef.current;
    if (!pending || pending.engineId !== pendingEngineId) return;
    pendingReuseRef.current = null;
    applyReusableRef.current(pending);
  }, [pendingEngineId]);

  const reuse = useCallback(async (id: string) => {
    setError(null);
    try {
      const reusable = await reuseSettings(id);
      if (!reusable) {
        setError("This generation is no longer in history.");
        return;
      }
      const current = latest.current.session;
      if (reusable.engineId === current.studio.engineId) {
        pendingReuseRef.current = null;
        applyReusable(reusable);
        return;
      }
      if (isBrowserEngineId(reusable.engineId)) {
        pendingReuseRef.current = reusable;
        current.studio.changeModel(reusable.engineId);
      } else if (isDesktopInlineEngineId(reusable.engineId)) {
        const option = current.engines.desktopModelOptions.studio.find((entry) => entry.key === reusable.engineId);
        if (!option) {
          setError(`${getEngine(reusable.engineId).label} is not available on this device.`);
          return;
        }
        pendingReuseRef.current = reusable;
        option.onSelect();
      } else {
        setError("This generation used an engine that is not available.");
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [applyReusable, reuseSettings]);

  return { error, clearError: () => setError(null), replay, download, reuse };
}

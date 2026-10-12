import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { collectSynthesizedAudio, type PresetSynthesize } from "../lib/presetSynthesis";
import { encodeWavPcm16 } from "../lib/wavCodec";
import type { CatalogVoice } from "../lib/voiceLibrary/catalog";
import { previewCacheKey } from "../lib/voiceLibrary/previewKey";
import type { VoiceLibraryStore } from "../lib/voiceLibrary/store";
import type { VoicePreset } from "../lib/voiceLibrary/types";
import { useAudition, type CreateAuditionAudio } from "./useAudition";

export type VoicePreviewStatus = "rendering" | "playing" | "error";

export interface VoicePreviewState {
  key: string;
  status: VoicePreviewStatus;
  message?: string;
  /** The sample came from the preview cache rather than a fresh render. */
  cached?: boolean;
}

export interface UseVoicePreviewReturn {
  state: VoicePreviewState | null;
  /** Play `text` in the voice, rendering it once and replaying it from the cache after. */
  preview: (voice: CatalogVoice, text: string) => Promise<void>;
  stop: () => void;
}

/** Previews of built-in voices are owned per voice, so each can be cleared on its own. */
export function previewOwnerId(voice: Pick<CatalogVoice, "origin" | "key" | "record">): string {
  return voice.record ? voice.record.id : voice.key;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The preview could not be rendered.";
}

/**
 * Renders short voice previews through the shared preset synthesizer, caches
 * them in the library's preview store, and auditions them. One preview runs at
 * a time: starting another cancels the first.
 */
export function useVoicePreview(
  synthesize: PresetSynthesize,
  store: Pick<VoiceLibraryStore, "getPreview" | "putPreview">,
  createAudio?: CreateAuditionAudio,
): UseVoicePreviewReturn {
  const audition = useAudition(createAudio);
  const { play, stop: stopAudition, playingKey } = audition;
  const [state, setState] = useState<VoicePreviewState | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controllerRef.current?.abort(new DOMException("Preview cancelled", "AbortError"));
    controllerRef.current = null;
  }, []);

  const stop = useCallback(() => {
    cancel();
    stopAudition();
    setState(null);
  }, [cancel, stopAudition]);

  const preview = useCallback(async (voice: CatalogVoice, text: string) => {
    cancel();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { key } = voice;
    const preset: VoicePreset = voice.preset;
    const owner = previewOwnerId(voice);
    const previewKey = previewCacheKey(preset, text);
    setState({ key, status: "rendering" });
    try {
      let wav: Uint8Array;
      let cached = false;
      const hit = await store.getPreview(owner, previewKey).catch(() => null);
      if (hit) {
        wav = hit.wav;
        cached = true;
      } else {
        const audio = await collectSynthesizedAudio(synthesize(text, preset, controller.signal), controller.signal);
        // The cache is a convenience: a full or failing store never blocks hearing the voice.
        wav = await store.putPreview(owner, previewKey, { samples: audio.samples, sampleRate: audio.sampleRate })
          .then((row) => row.wav)
          .catch(() => encodeWavPcm16(audio.samples, audio.sampleRate));
      }
      controller.signal.throwIfAborted();
      setState({ key, status: "playing", cached });
      await play(key, wav);
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({ key, status: "error", message: errorMessage(error) });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [cancel, play, store, synthesize]);

  useEffect(() => cancel, [cancel]);

  // When the clip ends the audition clears its key; the preview state follows.
  const visibleState = useMemo(() => {
    if (!state) return null;
    if (state.status === "playing" && playingKey !== state.key) return null;
    return state;
  }, [playingKey, state]);

  return { state: visibleState, preview, stop };
}

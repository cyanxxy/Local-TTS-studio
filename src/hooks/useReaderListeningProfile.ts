import { useCallback, useEffect, useEffectEvent, useState } from "react";
import type { ReaderDocumentRecord, ReaderListeningProfile } from "../lib/readerDocument";
import {
  buildListeningProfile,
  isSurfaceListeningEngine,
  listeningMatches,
} from "../lib/readerListening";
import type { SurfaceEngineId, SurfaceEngineSettings } from "../models/registry";

/** A stored profile whose engine this build can drive. */
export type SurfaceListeningProfile = ReaderListeningProfile & { engine: SurfaceEngineId };

/** The parts of a profile a listener can change. */
export type ListeningChange = Partial<Omit<ReaderListeningProfile, "updatedAt" | "engine">> & {
  engine?: SurfaceEngineId;
};

interface Options {
  /** The Reader page is on screen. */
  active: boolean;
  /** The library is still loading, so the open book is not the saved one yet. */
  loading: boolean;
  document: ReaderDocumentRecord | null;
  /** The engine the Reader speaks with, and what every engine reads right now. */
  engineId: SurfaceEngineId;
  surfaceEngineSettings: SurfaceEngineSettings;
  quality: number;
  playbackRate: number;
  /** Whether the engine can run here (a desktop engine can be unavailable). */
  isEngineUsable: (engine: SurfaceEngineId) => boolean;
  /** Puts the Reader's engine, voice, language, quality and speed where the profile says. */
  apply: (profile: SurfaceListeningProfile) => void;
  updateListening: (profile: Omit<ReaderListeningProfile, "updatedAt">) => void;
}

export interface ReaderListening {
  /**
   * False from opening a book until its remembered voice and engine are in
   * place. Audio is only looked up (and generated) once it is true: looking
   * up a cached section under the wrong voice would discard it.
   */
  settled: boolean;
  /** Records a change the listener made on the Reader page for the open book. */
  remember: (change: ListeningChange) => void;
}

/**
 * Per-book listening profile. Opening a book applies what it was last
 * listened to with; a change made on the Reader page is saved with the book.
 * A book never listened to differently from the defaults has no profile and
 * leaves the global settings alone.
 */
export function useReaderListeningProfile({
  active,
  loading,
  document,
  engineId,
  surfaceEngineSettings,
  quality,
  playbackRate,
  isEngineUsable,
  apply,
  updateListening,
}: Options): ReaderListening {
  const documentId = document?.id ?? null;
  const stored = document?.listening;
  const profile = stored && isSurfaceListeningEngine(stored) ? stored : null;
  const applicable = active && !loading && profile !== null && isEngineUsable(profile.engine);
  const matches = profile === null
    || listeningMatches(profile, engineId, surfaceEngineSettings, quality);
  const needsApply = applicable && !matches;
  const key = documentId !== null && profile !== null ? `${documentId}:${profile.updatedAt}` : null;
  // The profile that was last applied. Applying dispatches several state
  // changes at once; this marks the render after them as settled even if a
  // setting refused to move, so one stubborn input cannot hold the Reader.
  const [appliedKey, setAppliedKey] = useState<string | null>(null);

  const applyProfile = useEffectEvent((target: SurfaceListeningProfile) => apply(target));
  useEffect(() => {
    if (!needsApply || key === null || profile === null || appliedKey === key) return;
    // Deferred past this commit's effects, so the Reader has already emptied
    // the player for the book it opened; applying earlier would let a change
    // of voice save the previous book's audio under the new one.
    const timer = window.setTimeout(() => {
      applyProfile(profile);
      setAppliedKey(key);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [appliedKey, key, needsApply, profile]);

  const settled = !needsApply || appliedKey === key;

  const remember = useCallback((change: ListeningChange) => {
    if (!active || !document) return;
    const engine = change.engine ?? engineId;
    const base = profile && profile.engine === engine
      ? profile
      : buildListeningProfile(engine, surfaceEngineSettings, quality, playbackRate, 0);
    const { engine: _engine, ...rest } = change;
    void _engine;
    updateListening({ ...base, ...rest, engine });
  }, [active, document, engineId, playbackRate, profile, quality, surfaceEngineSettings, updateListening]);

  return { settled, remember };
}

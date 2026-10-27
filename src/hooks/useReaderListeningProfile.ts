import { useCallback, useEffect, useEffectEvent, useState } from "react";
import type { ReaderDocumentRecord, ReaderListeningProfile } from "../lib/readerDocument";
import {
  buildListeningProfile,
  isSurfaceListeningEngine,
  listeningMatches,
} from "../lib/readerListening";
import type { SurfaceEngineId, SurfaceEngineSettings } from "../models/registry";

/** A stored profile whose engine this build can drive. */
export type SurfaceListeningProfile = ReaderListeningProfile & { engine: SurfaceEngineId; voice: string };

/** What opening a book puts in place: the engine part, the speed, or both. */
export interface ListeningTarget {
  engine: SurfaceListeningProfile | null;
  playbackRate: number | null;
}

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
  apply: (target: ListeningTarget) => void;
  updateListening: (profile: Omit<ReaderListeningProfile, "updatedAt">) => void;
}

export interface ReaderListening {
  /**
   * False from opening a book until its remembered voice and engine are in
   * place. Audio is only looked up (and generated) once it is true: looking
   * up a cached section under the wrong voice would discard it.
   */
  settled: boolean;
  /**
   * The book has a remembered engine or voice that is not what the Reader
   * speaks with right now (still being applied, or its engine is not available
   * yet). Audio saved for the book must not be discarded as stale meanwhile.
   */
  pending: boolean;
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
  const targetRate = stored?.playbackRate ?? null;
  const engineApplicable = active && !loading && profile !== null && isEngineUsable(profile.engine);
  const engineMatches = profile === null
    || listeningMatches(profile, engineId, surfaceEngineSettings, quality);
  const rateMatches = targetRate === null || targetRate === playbackRate;
  const needsApply = active && !loading
    && ((engineApplicable && !engineMatches) || (targetRate !== null && !rateMatches));
  const key = documentId !== null && stored ? `${documentId}:${stored.updatedAt}` : null;
  // The profile that was last applied. Applying dispatches several state
  // changes at once; this marks the render after them as settled even if a
  // setting refused to move, so one stubborn input cannot hold the Reader.
  const [appliedKey, setAppliedKey] = useState<string | null>(null);
  // Leaving the Reader puts Studio's voice, quality and speed back, so the
  // profile applied on this visit is not in place on the next one.
  if (!active && appliedKey !== null) setAppliedKey(null);

  const applyProfile = useEffectEvent((target: ListeningTarget) => apply(target));
  useEffect(() => {
    if (!needsApply || key === null || appliedKey === key) return;
    // Deferred past this commit's effects, so the Reader has already emptied
    // the player for the book it opened; applying earlier would let a change
    // of voice save the previous book's audio under the new one.
    const timer = window.setTimeout(() => {
      applyProfile({
        engine: engineApplicable && !engineMatches ? profile : null,
        playbackRate: rateMatches ? null : targetRate,
      });
      setAppliedKey(key);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [appliedKey, engineApplicable, engineMatches, key, needsApply, profile, rateMatches, targetRate]);

  const settled = !needsApply || appliedKey === key;
  // An engine that is not available yet (a desktop engine is detected after
  // launch) is not applied, but the book's audio belongs to it all the same.
  const pending = profile !== null && !engineMatches;

  const remember = useCallback((change: ListeningChange) => {
    if (!active || !document) return;
    const { engine: changedEngine, playbackRate: changedRate, ...rest } = change;
    const touchesEngine = changedEngine !== undefined || Object.keys(rest).length > 0;
    if (!touchesEngine) {
      // A speed alone is remembered alone: building a full profile here would
      // pin the book to whatever engine and voice are global right now.
      updateListening({ ...(stored ?? {}), playbackRate: changedRate });
      return;
    }
    const engine = changedEngine ?? profile?.engine ?? engineId;
    const base = profile && profile.engine === engine
      ? profile
      : buildListeningProfile(engine, surfaceEngineSettings, quality, playbackRate, 0);
    updateListening({
      ...base,
      ...rest,
      engine,
      playbackRate: changedRate ?? stored?.playbackRate ?? base.playbackRate,
    });
  }, [active, document, engineId, playbackRate, profile, quality, stored, surfaceEngineSettings, updateListening]);

  return { settled, pending, remember };
}

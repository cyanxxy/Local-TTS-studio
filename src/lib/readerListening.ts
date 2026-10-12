import {
  getEngine,
  isBrowserEngineId,
  isDesktopInlineEngineId,
  type SurfaceEngineId,
  type SurfaceEngineSettings,
} from "../models/registry";
import type { ReaderListeningProfile } from "./readerDocument";

/**
 * The part of a listening profile an engine's own settings hold: its voice
 * and, for engines conditioned on a language, that language. Qwen3 keeps its
 * speaker and language in its setup page's profile, so only its selection is
 * remembered.
 */
export interface EngineVoiceSelection {
  voice: string;
  language?: string;
}

export function engineVoiceSelection(
  engine: SurfaceEngineId,
  settings: SurfaceEngineSettings,
): EngineVoiceSelection {
  switch (engine) {
    case "kokoro":
    case "audio8":
      return { voice: settings[engine].voice };
    case "supertonic":
    case "supertonic3":
      return { voice: settings[engine].voice, language: settings[engine].language };
    case "qwen3":
      return { voice: "" };
  }
}

/** The profile that captures what `engine` would speak with right now. */
export function buildListeningProfile(
  engine: SurfaceEngineId,
  settings: SurfaceEngineSettings,
  quality: number,
  playbackRate: number,
  updatedAt: number,
): ReaderListeningProfile {
  const selection = engineVoiceSelection(engine, settings);
  return {
    engine,
    voice: selection.voice,
    ...(selection.language === undefined ? {} : { language: selection.language }),
    ...(getEngine(engine).capabilities.quality ? { quality } : {}),
    playbackRate,
    updatedAt,
  };
}

/** Whether a stored profile names an engine this build knows how to drive in a surface. */
export function isSurfaceListeningEngine(profile: ReaderListeningProfile): profile is ReaderListeningProfile & {
  engine: SurfaceEngineId;
} {
  return isBrowserEngineId(profile.engine) || isDesktopInlineEngineId(profile.engine);
}

/**
 * Whether the Reader already speaks the way `profile` says: the same engine,
 * voice, language and (for engines that have one) quality. Speed is not part
 * of it, because it changes nothing audible about cached audio.
 */
export function listeningMatches(
  profile: ReaderListeningProfile & { engine: SurfaceEngineId },
  engine: SurfaceEngineId,
  settings: SurfaceEngineSettings,
  quality: number,
): boolean {
  if (profile.engine !== engine) return false;
  const selection = engineVoiceSelection(engine, settings);
  if (engine !== "qwen3" && profile.voice !== selection.voice) return false;
  if (profile.language !== undefined && selection.language !== undefined && profile.language !== selection.language) {
    return false;
  }
  if (profile.quality !== undefined && getEngine(engine).capabilities.quality && profile.quality !== quality) {
    return false;
  }
  return true;
}

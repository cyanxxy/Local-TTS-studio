import { CLONE_TARGET_ENGINE, voicePresetFromRecord } from "./store";
import type { VoiceCloneTarget, VoicePreset, VoiceRecord } from "./types";
import { ENGINE_REGISTRY, engineVoices, type EngineId } from "../../models/registry";

/**
 * One searchable list of every voice the app can speak with: the built-in
 * voices of each registered engine plus the user's own voices from the Voice
 * Library. Each entry carries the VoicePreset a synthesizer renders it with.
 */

export type CatalogGender = "female" | "male";
export type CatalogOrigin = "engine" | "library";

export interface CatalogVoice {
  /** Stable list key: `engine:<engineId>:<voiceId>` or `library:<recordId>`. */
  key: string;
  origin: CatalogOrigin;
  engineId: string;
  engineLabel: string;
  voiceId: string;
  name: string;
  /** Secondary line, such as "English · Female" or "Cloned voice · 12.0 s". */
  detail: string;
  /** Section the engine groups the voice under, when it has one. */
  group: string | null;
  language: string | null;
  gender: CatalogGender | null;
  favorite: boolean;
  /** The library record behind a "My Voices" entry. */
  record: VoiceRecord | null;
  preset: VoicePreset;
}

/** Voice ids an engine's loaded runtime reported, keyed by engine. */
export type RuntimeVoiceMap = Partial<Record<string, readonly string[]>>;

const GENDER_PATTERN = /\b(female|male)\b/i;

/** Gender named in an engine's group or detail text ("American · Female"), or null. */
export function inferGender(...texts: ReadonlyArray<string | undefined>): CatalogGender | null {
  for (const text of texts) {
    const match = text ? GENDER_PATTERN.exec(text) : null;
    if (match) return match[1].toLowerCase() === "female" ? "female" : "male";
  }
  return null;
}

/** The language part of "English · Female"-style text: the first segment that is not a gender. */
export function inferLanguage(...texts: ReadonlyArray<string | undefined>): string | null {
  for (const text of texts) {
    if (!text) continue;
    for (const segment of text.split("·")) {
      const trimmed = segment.trim();
      if (trimmed && !GENDER_PATTERN.test(trimmed)) return trimmed;
    }
  }
  return null;
}

export function engineVoiceKey(engineId: string, voiceId: string): string {
  return `engine:${engineId}:${voiceId}`;
}

/** Every built-in voice of every registered engine that lists voices. */
export function buildEngineCatalog(
  runtimeVoices: RuntimeVoiceMap = {},
  favorites: ReadonlySet<string> = new Set(),
): CatalogVoice[] {
  const catalog: CatalogVoice[] = [];
  for (const engine of ENGINE_REGISTRY) {
    const voices = engineVoices(engine.id as EngineId, { runtimeVoices: runtimeVoices[engine.id] });
    for (const voice of voices) {
      const key = engineVoiceKey(engine.id, voice.id);
      catalog.push({
        key,
        origin: "engine",
        engineId: engine.id,
        engineLabel: engine.label,
        voiceId: voice.id,
        name: voice.label,
        detail: voice.detail ?? voice.group ?? "",
        group: voice.group ?? null,
        language: inferLanguage(voice.detail, voice.group),
        gender: inferGender(voice.detail, voice.group),
        favorite: favorites.has(key),
        record: null,
        preset: { engineId: engine.id, voiceId: voice.id, mode: "preset", settings: {}, label: voice.label },
      });
    }
  }
  return catalog;
}

function engineLabelFor(engineId: string): string {
  return ENGINE_REGISTRY.find((engine) => engine.id === engineId)?.label ?? engineId;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)} s`;
}

/** The catalog entry for one saved voice, with the preset that renders it. */
export function libraryCatalogVoice(record: VoiceRecord): CatalogVoice {
  const preset = voicePresetFromRecord(record);
  const base = {
    key: `library:${record.id}`,
    origin: "library" as const,
    engineId: preset.engineId,
    engineLabel: engineLabelFor(preset.engineId),
    voiceId: preset.voiceId,
    name: record.name,
    group: null,
    favorite: record.favorite,
    record,
    preset,
  };
  switch (record.kind) {
    case "preset":
      return {
        ...base,
        detail: `Preset · ${engineLabelFor(record.preset.engineId)}`,
        language: record.preset.settings.language ?? null,
        gender: inferGender(record.description, ...record.tags),
      };
    case "cloned":
      return {
        ...base,
        detail: `Cloned voice · ${formatSeconds(record.reference.durationSec)}`,
        language: record.language === "Auto" ? null : record.language,
        gender: inferGender(record.description, ...record.tags),
      };
    case "designed":
      return {
        ...base,
        detail: "Designed voice · Qwen3 VoiceDesign",
        language: record.design.language === "Auto" ? null : record.design.language,
        gender: inferGender(record.description, record.design.description, ...record.tags),
      };
  }
}

export interface CatalogFilter {
  query?: string;
  /** "mine" lists only saved voices; "builtin" only engine voices. */
  scope?: "all" | "mine" | "builtin";
  engineId?: string;
  language?: string;
  gender?: CatalogGender;
  favoritesOnly?: boolean;
}

/** Filter the catalog: favorites first, then my voices, then the engines' own order. */
export function filterCatalog(voices: readonly CatalogVoice[], filter: CatalogFilter = {}): CatalogVoice[] {
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const language = filter.language?.toLocaleLowerCase();
  const matches = voices.filter((voice) => {
    if (filter.scope === "mine" && voice.origin !== "library") return false;
    if (filter.scope === "builtin" && voice.origin !== "engine") return false;
    if (filter.engineId && voice.engineId !== filter.engineId) return false;
    if (language && voice.language?.toLocaleLowerCase() !== language) return false;
    if (filter.gender && voice.gender !== filter.gender) return false;
    if (filter.favoritesOnly && !voice.favorite) return false;
    if (!query) return true;
    const haystack = [
      voice.name,
      voice.detail,
      voice.engineLabel,
      voice.group ?? "",
      voice.record?.description ?? "",
      ...(voice.record?.tags ?? []),
      voice.record?.kind === "cloned" ? voice.record.transcript : "",
      voice.record?.kind === "designed" ? voice.record.design.description : "",
    ].join("\n").toLocaleLowerCase();
    return haystack.includes(query);
  });
  // Array.prototype.sort is stable, so engine order survives within a rank.
  return matches
    .map((voice, index) => ({ voice, index }))
    .sort((a, b) => (
      Number(b.voice.favorite) - Number(a.voice.favorite)
      || Number(b.voice.origin === "library") - Number(a.voice.origin === "library")
      || a.index - b.index
    ))
    .map(({ voice }) => voice);
}

export interface CatalogFacets {
  engines: Array<{ id: string; label: string }>;
  languages: string[];
}

/** The engines and languages present in a catalog, for the filter menus. */
export function catalogFacets(voices: readonly CatalogVoice[]): CatalogFacets {
  const engines = new Map<string, string>();
  const languages = new Set<string>();
  for (const voice of voices) {
    engines.set(voice.engineId, voice.engineLabel);
    if (voice.language) languages.add(voice.language);
  }
  return {
    engines: [...engines].map(([id, label]) => ({ id, label })),
    languages: [...languages].sort((a, b) => a.localeCompare(b)),
  };
}

/** Whether a clone target renders through an engine the app can preview here. */
export function cloneTargetEngine(target: VoiceCloneTarget): string {
  return CLONE_TARGET_ENGINE[target];
}

/**
 * The user's saved voice presets as casting choices for Dialogue: presets of
 * engines that can speak a turn, newest first. Cloned and designed voices need
 * their reference audio loaded, so they are not offered here.
 */
export function dialoguePoolPresets(records: readonly VoiceRecord[], castableEngineIds: readonly string[]): VoicePreset[] {
  return [...records]
    .filter((record): record is Extract<VoiceRecord, { kind: "preset" }> => record.kind === "preset" && castableEngineIds.includes(record.preset.engineId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((record) => voicePresetFromRecord(record));
}

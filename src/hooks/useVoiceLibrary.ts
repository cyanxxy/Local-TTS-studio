import { useMemo } from "react";
import { getVoiceLibraryStore, type VoiceLibraryStore } from "../lib/voiceLibrary/store";
import type { NewVoice, VoiceKind, VoicePatch, VoiceRecord } from "../lib/voiceLibrary/types";
import { useStoreSnapshot } from "./useStoreSnapshot";

export interface VoiceLibraryFilter {
  /** Case-insensitive match on name, description, tags and transcript. */
  query?: string;
  kind?: VoiceKind;
  /** Voices that carry every listed tag (case-insensitive). */
  tags?: readonly string[];
  /** Presets for this engine, plus cloned/designed voices it can render. */
  engineId?: string;
  favoritesOnly?: boolean;
}

function engineCanRender(record: VoiceRecord, engineId: string): boolean {
  if (record.kind === "preset") return record.preset.engineId === engineId;
  if (record.kind === "designed") return engineId === "qwen3";
  return (engineId === "qwen3" && record.targets.includes("qwen3-base"))
    || (engineId === "neutts" && record.targets.includes("neutts"))
    || (engineId === "chatterbox" && record.targets.includes("chatterbox"));
}

/** Filter and order voices for a picker: favorites first, then most recent. */
export function filterVoices(records: readonly VoiceRecord[], filter: VoiceLibraryFilter = {}): VoiceRecord[] {
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const tags = (filter.tags ?? []).map((tag) => tag.toLocaleLowerCase());
  return records
    .filter((record) => {
      if (filter.kind && record.kind !== filter.kind) return false;
      if (filter.favoritesOnly && !record.favorite) return false;
      if (filter.engineId && !engineCanRender(record, filter.engineId)) return false;
      const recordTags = record.tags.map((tag) => tag.toLocaleLowerCase());
      if (!tags.every((tag) => recordTags.includes(tag))) return false;
      if (!query) return true;
      const haystack = [
        record.name,
        record.description,
        ...record.tags,
        record.kind === "cloned" ? record.transcript : "",
        record.kind === "designed" ? record.design.description : "",
      ].join("\n").toLocaleLowerCase();
      return haystack.includes(query);
    })
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt);
}

export interface UseVoiceLibraryReturn {
  voices: VoiceRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createVoice: (input: NewVoice) => Promise<VoiceRecord>;
  /** Save several voices atomically; see VoiceLibraryStore.createVoices. */
  createVoices: (inputs: readonly NewVoice[]) => Promise<VoiceRecord[]>;
  updateVoice: (id: string, patch: VoicePatch) => Promise<VoiceRecord>;
  setFavorite: (id: string, favorite: boolean) => Promise<VoiceRecord>;
  deleteVoice: (id: string) => Promise<void>;
  importVoice: (bytes: Uint8Array) => Promise<VoiceRecord>;
  exportVoice: (id: string) => Promise<{ fileName: string; bytes: Uint8Array }>;
  store: VoiceLibraryStore;
}

const EMPTY_VOICES: VoiceRecord[] = [];

function listVoices(store: VoiceLibraryStore): Promise<VoiceRecord[]> {
  return store.listVoices();
}

/**
 * Live view of the Voice Library. The list reloads after every change made
 * through any store instance (including other tabs), and mutations reject
 * with user-presentable messages instead of setting `error`, so a form can
 * show them next to the field that caused them.
 */
export function useVoiceLibrary(store: VoiceLibraryStore = getVoiceLibraryStore()): UseVoiceLibraryReturn {
  const { data: voices, loading, error, refresh } = useStoreSnapshot(store, listVoices, EMPTY_VOICES);

  return useMemo(() => ({
    voices,
    loading,
    error,
    refresh,
    createVoice: (input) => store.createVoice(input),
    createVoices: (inputs) => store.createVoices(inputs),
    updateVoice: (id, patch) => store.updateVoice(id, patch),
    setFavorite: (id, favorite) => store.setFavorite(id, favorite),
    deleteVoice: (id) => store.deleteVoice(id),
    importVoice: (bytes) => store.importVoice(bytes),
    exportVoice: (id) => store.exportVoice(id),
    store,
  }), [error, loading, refresh, store, voices]);
}

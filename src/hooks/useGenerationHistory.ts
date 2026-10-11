import { useMemo } from "react";
import {
  getGenerationHistoryStore,
  reusableSettingsFromEntry,
  type GenerationAudioChunk,
  type GenerationHistoryEntry,
  type GenerationHistoryStore,
  type NewGenerationEntry,
  type ReusableGenerationSettings,
} from "../lib/history/generationHistory";
import { useStoreSnapshot } from "./useStoreSnapshot";

export interface UseGenerationHistoryReturn {
  /** Newest first. */
  entries: GenerationHistoryEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  saveGeneration: (input: NewGenerationEntry) => Promise<GenerationHistoryEntry>;
  /** Audio to hand to `player.restoreAudioCache`; null when it is gone. */
  loadAudio: (id: string) => Promise<GenerationAudioChunk[] | null>;
  /** Text, engine, voice, settings and seed of an entry, for reuse. */
  reuseSettings: (id: string) => Promise<ReusableGenerationSettings | null>;
  setFavorite: (id: string, favorite: boolean) => Promise<GenerationHistoryEntry>;
  rename: (id: string, title: string) => Promise<GenerationHistoryEntry>;
  deleteEntry: (id: string) => Promise<void>;
  clear: (options?: { keepFavorites?: boolean }) => Promise<void>;
  store: GenerationHistoryStore;
}

const EMPTY_ENTRIES: GenerationHistoryEntry[] = [];

function listEntries(store: GenerationHistoryStore): Promise<GenerationHistoryEntry[]> {
  return store.listEntries();
}

/** Live view of Generation History with its actions. */
export function useGenerationHistory(
  store: GenerationHistoryStore = getGenerationHistoryStore(),
): UseGenerationHistoryReturn {
  const { data: entries, loading, error, refresh } = useStoreSnapshot(store, listEntries, EMPTY_ENTRIES);

  return useMemo(() => ({
    entries,
    loading,
    error,
    refresh,
    saveGeneration: async (input) => (await store.saveGeneration(input)).entry,
    loadAudio: (id) => store.getAudio(id),
    reuseSettings: async (id) => {
      const entry = await store.getEntry(id);
      return entry ? reusableSettingsFromEntry(entry) : null;
    },
    setFavorite: (id, favorite) => store.setFavorite(id, favorite),
    rename: (id, title) => store.rename(id, title),
    deleteEntry: (id) => store.deleteEntry(id),
    clear: (options) => store.clear(options),
    store,
  }), [entries, error, loading, refresh, store]);
}

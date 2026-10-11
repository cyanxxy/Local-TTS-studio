import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVoiceLibraryStore, type VoiceLibraryStore } from "../lib/voiceLibrary/store";
import type { NewVoice, VoiceKind, VoicePatch, VoiceRecord } from "../lib/voiceLibrary/types";

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
    || (engineId === "neutts" && record.targets.includes("neutts"));
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
  updateVoice: (id: string, patch: VoicePatch) => Promise<VoiceRecord>;
  setFavorite: (id: string, favorite: boolean) => Promise<VoiceRecord>;
  deleteVoice: (id: string) => Promise<void>;
  importVoice: (bytes: Uint8Array) => Promise<VoiceRecord>;
  exportVoice: (id: string) => Promise<{ fileName: string; bytes: Uint8Array }>;
  store: VoiceLibraryStore;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Live view of the Voice Library. The list reloads after every change made
 * through any store instance (including other tabs), and mutations reject
 * with user-presentable messages instead of setting `error`, so a form can
 * show them next to the field that caused them.
 */
export function useVoiceLibrary(store: VoiceLibraryStore = getVoiceLibraryStore()): UseVoiceLibraryReturn {
  const [voices, setVoices] = useState<VoiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);

  const refresh = useCallback((): Promise<void> => {
    // Reloads can overlap when changes arrive quickly; only the newest wins.
    // State is set from promise callbacks, never synchronously, so the
    // subscription effect below does not cascade renders.
    const sequence = ++loadSequenceRef.current;
    const isCurrent = () => sequence === loadSequenceRef.current;
    return store.listVoices().then(
      (next) => {
        if (!isCurrent()) return;
        setVoices(next);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!isCurrent()) return;
        setError(errorMessage(cause));
        setLoading(false);
      },
    );
  }, [store]);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      void refresh();
    });
    void refresh();
    return () => {
      unsubscribe();
      // Drop any reload still in flight for this store.
      loadSequenceRef.current += 1;
    };
  }, [refresh, store]);

  return useMemo(() => ({
    voices,
    loading,
    error,
    refresh,
    createVoice: (input) => store.createVoice(input),
    updateVoice: (id, patch) => store.updateVoice(id, patch),
    setFavorite: (id, favorite) => store.setFavorite(id, favorite),
    deleteVoice: (id) => store.deleteVoice(id),
    importVoice: (bytes) => store.importVoice(bytes),
    exportVoice: (id) => store.exportVoice(id),
    store,
  }), [error, loading, refresh, store, voices]);
}

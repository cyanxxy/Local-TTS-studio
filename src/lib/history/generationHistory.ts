import { createWavBlob, type WavEncoding } from "../audio";
import type { AudioExportSourceChunk } from "../audioExportClient";
import {
  createChangeNotifier,
  deleteIndexedDatabase,
  isArrayBufferLike,
  openVersionedDatabase,
  requestResult,
  runTransaction,
  type IndexedDbMigration,
} from "../indexedDb";
import { resampleAudio } from "../pcmTransforms";
import type { CachedReaderAudioChunk } from "../readerDocument";
import type { VoicePreset } from "../voiceLibrary/types";
import { normalizeVoicePreset } from "../voiceLibrary/validation";

/**
 * Generation History keeps every Studio generation: its text, engine, voice,
 * settings and seed in a small metadata record, and its PCM in a separate
 * object store so listing history never loads audio. The store is bounded by
 * entry count and total audio bytes; least recently used entries go first and
 * favorites are never evicted.
 */

export const GENERATION_HISTORY_DATABASE_NAME = "open-tts-generation-history";
export const GENERATION_HISTORY_SCHEMA_VERSION = 1;
const ENTRIES_STORE = "entries";
const AUDIO_STORE = "audio";
const CHANGE_CHANNEL = "open-tts-generation-history";

export const GENERATION_HISTORY_MIGRATIONS: readonly IndexedDbMigration[] = [
  {
    version: 1,
    migrate: (database) => {
      const entries = database.createObjectStore(ENTRIES_STORE, { keyPath: "id" });
      entries.createIndex("createdAt", "createdAt");
      entries.createIndex("lastAccessedAt", "lastAccessedAt");
      database.createObjectStore(AUDIO_STORE, { keyPath: "id" });
    },
  },
];

/**
 * Favorites are never evicted, so they get their own share of the budget:
 * at most `maxFavoriteEntries`, and at most the bytes left after reserving
 * room for one maximum-size new entry. Saving can then always evict down to
 * the limits, and the store never grows past them.
 */
export const GENERATION_HISTORY_LIMITS = {
  maxEntries: 200,
  maxTotalBytes: 512 * 1024 * 1024,
  /** Matches the Reader's per-entry audio cap. */
  maxEntryBytes: 256 * 1024 * 1024,
  maxFavoriteEntries: 50,
  maxTextLength: 200_000,
  maxSettingsJsonLength: 64 * 1024,
  maxTitleLength: 80,
  maxChunks: 20_000,
} as const;

export type HistoryJsonValue = string | number | boolean | null | HistoryJsonValue[] | { [key: string]: HistoryJsonValue };
export type HistorySettings = { [key: string]: HistoryJsonValue };

/** One audio chunk exactly as the shared player snapshots and restores it. */
export type GenerationAudioChunk = CachedReaderAudioChunk;

export interface GenerationHistoryEntry {
  schemaVersion: typeof GENERATION_HISTORY_SCHEMA_VERSION;
  id: string;
  createdAt: number;
  /** Updated on replay; drives LRU eviction. */
  lastAccessedAt: number;
  title: string;
  text: string;
  engineId: string;
  voice: VoicePreset;
  /** Engine settings and tuning, as plain JSON, for reuse-settings. */
  settings: HistorySettings;
  seed?: number;
  durationSec: number;
  sampleRate: number;
  byteLength: number;
  chunkCount: number;
  favorite: boolean;
  /** False for a generation the user stopped before it finished. */
  completed: boolean;
  /** Groups takes of the same script: the entry this one is a retake of. */
  parentId?: string;
}

export interface NewGenerationEntry {
  text: string;
  engineId: string;
  voice: VoicePreset;
  settings?: Record<string, unknown>;
  seed?: number;
  chunks: readonly GenerationAudioChunk[];
  completed?: boolean;
  parentId?: string;
  title?: string;
}

/** What "reuse settings" hands back to the Studio. */
export interface ReusableGenerationSettings {
  text: string;
  engineId: string;
  voice: VoicePreset;
  settings: HistorySettings;
  seed?: number;
}

export interface GenerationHistoryUsage {
  entryCount: number;
  totalBytes: number;
  favoriteCount: number;
}

export interface GenerationHistoryStoreOptions {
  databaseName?: string;
  now?: () => number;
  createId?: () => string;
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEntryBytes?: number;
  /** Capped below maxEntries. */
  maxFavoriteEntries?: number;
  /** Capped at maxTotalBytes - maxEntryBytes. */
  maxFavoriteBytes?: number;
}

export interface GenerationHistoryStore {
  /** Newest first. */
  listEntries(): Promise<GenerationHistoryEntry[]>;
  getEntry(id: string): Promise<GenerationHistoryEntry | null>;
  /** Save a generation; returns it with the ids of entries evicted to fit. */
  saveGeneration(input: NewGenerationEntry): Promise<{ entry: GenerationHistoryEntry; evictedIds: string[] }>;
  /** Audio for replay, marking the entry as recently used. */
  getAudio(id: string): Promise<GenerationAudioChunk[] | null>;
  /** Refuses with GenerationHistoryError once the favorites budget is full. */
  setFavorite(id: string, favorite: boolean): Promise<GenerationHistoryEntry>;
  rename(id: string, title: string): Promise<GenerationHistoryEntry>;
  deleteEntry(id: string): Promise<void>;
  /** Delete everything, or everything except favorites. */
  clear(options?: { keepFavorites?: boolean }): Promise<void>;
  getUsage(): Promise<GenerationHistoryUsage>;
  subscribe(listener: () => void): () => void;
  destroy(): Promise<void>;
}

export class GenerationHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationHistoryError";
  }
}

function fail(message: string): never {
  throw new GenerationHistoryError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function defaultId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** First line of the text, whitespace-collapsed and shortened for lists. */
export function generationTitle(text: string, maxLength: number = GENERATION_HISTORY_LIMITS.maxTitleLength): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed || "Untitled generation";
  const cut = collapsed.slice(0, maxLength - 1);
  const wordBoundary = cut.lastIndexOf(" ");
  return `${(wordBoundary > maxLength / 2 ? cut.slice(0, wordBoundary) : cut).trimEnd()}…`;
}

/** Deep-copy settings through JSON, refusing values JSON cannot carry. */
function normalizeSettings(value: Record<string, unknown> | undefined): HistorySettings {
  if (value === undefined) return {};
  if (!isRecord(value)) fail("Generation settings must be an object.");
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    fail("Generation settings must be plain JSON.");
  }
  if (json.length > GENERATION_HISTORY_LIMITS.maxSettingsJsonLength) fail("Generation settings are too large to keep.");
  return JSON.parse(json) as HistorySettings;
}

function isValidChunk(chunk: unknown): chunk is GenerationAudioChunk {
  if (!isRecord(chunk)) return false;
  return isArrayBufferLike(chunk.audio)
    && chunk.audio.byteLength % Float32Array.BYTES_PER_ELEMENT === 0
    && Number.isInteger(chunk.samplingRate)
    && (chunk.samplingRate as number) > 0
    && typeof chunk.text === "string"
    && isFiniteNumber(chunk.index)
    && isFiniteNumber(chunk.total)
    && (chunk.textStart === undefined || isFiniteNumber(chunk.textStart))
    && (chunk.textEnd === undefined || isFiniteNumber(chunk.textEnd))
    && (chunk.pauseAfterSec === undefined || isFiniteNumber(chunk.pauseAfterSec));
}

/**
 * Copy chunk audio into fresh buffers. The player's snapshot hands out its
 * live ArrayBuffers, and IndexedDB or a later transfer must never detach them.
 */
function copyChunks(chunks: readonly GenerationAudioChunk[]): GenerationAudioChunk[] {
  return chunks.map((chunk) => ({ ...chunk, audio: chunk.audio.slice(0) }));
}

function measureChunks(chunks: readonly GenerationAudioChunk[]): { durationSec: number; byteLength: number } {
  let durationSec = 0;
  let byteLength = 0;
  for (const chunk of chunks) {
    durationSec += chunk.audio.byteLength / Float32Array.BYTES_PER_ELEMENT / chunk.samplingRate;
    byteLength += chunk.audio.byteLength;
  }
  // Round away float noise from summing per-chunk durations.
  return { durationSec: Math.round(durationSec * 1e6) / 1e6, byteLength };
}

/** Validate a stored entry; damaged or newer-schema values read as null. */
export function parseGenerationHistoryEntry(value: unknown): GenerationHistoryEntry | null {
  if (!isRecord(value) || value.schemaVersion !== GENERATION_HISTORY_SCHEMA_VERSION) return null;
  if (
    typeof value.id !== "string"
    || !isFiniteNumber(value.createdAt)
    || !isFiniteNumber(value.lastAccessedAt)
    || typeof value.title !== "string"
    || typeof value.text !== "string"
    || typeof value.engineId !== "string"
    || !isRecord(value.settings)
    || !isFiniteNumber(value.durationSec)
    || !Number.isInteger(value.sampleRate)
    || !Number.isInteger(value.byteLength)
    || !Number.isInteger(value.chunkCount)
    || typeof value.favorite !== "boolean"
    || typeof value.completed !== "boolean"
    || (value.seed !== undefined && !Number.isInteger(value.seed))
    || (value.parentId !== undefined && typeof value.parentId !== "string")
  ) return null;
  try {
    return { ...(value as unknown as GenerationHistoryEntry), voice: normalizeVoicePreset(value.voice) };
  } catch {
    return null;
  }
}

function isNewerSchemaEntry(value: unknown): boolean {
  return isRecord(value) && typeof value.schemaVersion === "number" && value.schemaVersion > GENERATION_HISTORY_SCHEMA_VERSION;
}

/** The fields Studio needs to set up the same generation again. */
export function reusableSettingsFromEntry(entry: GenerationHistoryEntry): ReusableGenerationSettings {
  return {
    text: entry.text,
    engineId: entry.engineId,
    voice: entry.voice,
    settings: entry.settings,
    ...(entry.seed === undefined ? {} : { seed: entry.seed }),
  };
}

/** Float32 views for the export worker (`downloadAudioChunks`). */
export function historyAudioToExportChunks(chunks: readonly GenerationAudioChunk[]): AudioExportSourceChunk[] {
  return chunks.map((chunk) => ({ audio: new Float32Array(chunk.audio), samplingRate: chunk.samplingRate }));
}

/**
 * A quick WAV of a history entry, resampled to its first chunk's rate when an
 * entry mixes rates. Use the export worker for MP3 or mastering.
 */
export function historyAudioToWavBlob(chunks: readonly GenerationAudioChunk[], encoding: WavEncoding = "pcm16"): Blob {
  if (chunks.length === 0) fail("This generation has no audio.");
  const targetRate = chunks[0].samplingRate;
  const parts = chunks.map((chunk) => resampleAudio(new Float32Array(chunk.audio), chunk.samplingRate, targetRate));
  return createWavBlob(parts, targetRate, { encoding });
}

/** `open-tts-2026-10-11-1405-first-words.wav` */
export function historyDownloadFileName(entry: Pick<GenerationHistoryEntry, "createdAt" | "title">, extension: string): string {
  const date = new Date(entry.createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const slug = entry.title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `open-tts-${stamp}${slug ? `-${slug}` : ""}.${extension.replace(/^\./, "")}`;
}

/** Pick entries to evict, least recently used first, never favorites or `keepId`. */
export function selectHistoryEvictions(
  entries: readonly Pick<GenerationHistoryEntry, "id" | "lastAccessedAt" | "byteLength" | "favorite">[],
  limits: { maxEntries: number; maxTotalBytes: number },
  keepId?: string,
): string[] {
  let count = entries.length;
  let bytes = entries.reduce((total, entry) => total + entry.byteLength, 0);
  const evicted: string[] = [];
  const candidates = [...entries]
    .filter((entry) => !entry.favorite && entry.id !== keepId)
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  for (const entry of candidates) {
    if (count <= limits.maxEntries && bytes <= limits.maxTotalBytes) break;
    evicted.push(entry.id);
    count -= 1;
    bytes -= entry.byteLength;
  }
  return evicted;
}

export function createGenerationHistoryStore(options: GenerationHistoryStoreOptions = {}): GenerationHistoryStore {
  const databaseName = options.databaseName ?? GENERATION_HISTORY_DATABASE_NAME;
  const now = options.now ?? Date.now;
  const createId = options.createId ?? defaultId;
  const limits = {
    maxEntries: options.maxEntries ?? GENERATION_HISTORY_LIMITS.maxEntries,
    maxTotalBytes: options.maxTotalBytes ?? GENERATION_HISTORY_LIMITS.maxTotalBytes,
  };
  const maxEntryBytes = Math.min(options.maxEntryBytes ?? GENERATION_HISTORY_LIMITS.maxEntryBytes, limits.maxTotalBytes);
  const maxFavoriteEntries = Math.max(0, Math.min(
    options.maxFavoriteEntries ?? GENERATION_HISTORY_LIMITS.maxFavoriteEntries,
    limits.maxEntries - 1,
  ));
  const maxFavoriteBytes = Math.max(0, Math.min(
    options.maxFavoriteBytes ?? Number.POSITIVE_INFINITY,
    limits.maxTotalBytes - maxEntryBytes,
  ));
  const changes = createChangeNotifier(CHANGE_CHANNEL);

  function open(): Promise<IDBDatabase> {
    return openVersionedDatabase({
      name: databaseName,
      migrations: GENERATION_HISTORY_MIGRATIONS,
      blockedMessage: "The generation history upgrade is blocked by another open tab. Close the other tab and try again.",
      unsupportedMessage: "This browser does not provide IndexedDB, so generation history cannot persist.",
      newerVersionMessage: "Generation history was saved by a newer version of Open TTS. Update Open TTS to use it.",
    });
  }

  function withTransaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    operation: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    return runTransaction(open, stores, mode, operation);
  }

  function emitChange(): void {
    changes.emit();
  }

  async function readEntries(transaction: IDBTransaction): Promise<GenerationHistoryEntry[]> {
    const raws = await requestResult(transaction.objectStore(ENTRIES_STORE).getAll()) as unknown[];
    return raws.map(parseGenerationHistoryEntry).filter((entry): entry is GenerationHistoryEntry => entry !== null);
  }

  async function updateEntry(id: string, change: (entry: GenerationHistoryEntry) => GenerationHistoryEntry): Promise<GenerationHistoryEntry> {
    const updated = await withTransaction([ENTRIES_STORE], "readwrite", async (transaction) => {
      const store = transaction.objectStore(ENTRIES_STORE);
      const current = parseGenerationHistoryEntry(await requestResult(store.get(id)));
      if (!current) fail("That generation is no longer in history.");
      const next = change(current);
      store.put(next);
      return next;
    });
    emitChange();
    return updated;
  }

  async function getEntry(id: string): Promise<GenerationHistoryEntry | null> {
    return withTransaction([ENTRIES_STORE], "readonly", async (transaction) => (
      parseGenerationHistoryEntry(await requestResult(transaction.objectStore(ENTRIES_STORE).get(id)))
    ));
  }

  return {
    async listEntries() {
      const entries = await withTransaction([ENTRIES_STORE], "readonly", readEntries);
      return entries.sort((a, b) => b.createdAt - a.createdAt);
    },

    getEntry,

    async saveGeneration(input) {
      if (typeof input.text !== "string" || input.text.trim().length === 0) fail("A generation needs its text.");
      if (input.text.length > GENERATION_HISTORY_LIMITS.maxTextLength) fail("This text is too long to keep in history.");
      if (typeof input.engineId !== "string" || input.engineId.length === 0) fail("A generation needs its engine id.");
      if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0)) fail("Seeds must be whole numbers.");
      if (!Array.isArray(input.chunks) || input.chunks.length === 0) fail("A generation needs audio.");
      if (input.chunks.length > GENERATION_HISTORY_LIMITS.maxChunks) fail("This generation has too many chunks to keep.");
      if (!input.chunks.every(isValidChunk)) fail("This generation's audio is malformed.");
      let voice: VoicePreset;
      try {
        voice = normalizeVoicePreset(input.voice);
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : "The voice is invalid.");
      }
      const settings = normalizeSettings(input.settings);
      const chunks = copyChunks(input.chunks);
      const { durationSec, byteLength } = measureChunks(chunks);
      if (byteLength > maxEntryBytes) fail("This generation is too large to keep in history.");

      const timestamp = now();
      const entry: GenerationHistoryEntry = {
        schemaVersion: GENERATION_HISTORY_SCHEMA_VERSION,
        id: createId(),
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        title: generationTitle(input.title ?? input.text),
        text: input.text,
        engineId: input.engineId,
        voice,
        settings,
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        durationSec,
        sampleRate: chunks[0].samplingRate,
        byteLength,
        chunkCount: chunks.length,
        favorite: false,
        completed: input.completed !== false,
        ...(input.parentId ? { parentId: input.parentId } : {}),
      };

      const evictedIds = await withTransaction([ENTRIES_STORE, AUDIO_STORE], "readwrite", async (transaction) => {
        const entries = transaction.objectStore(ENTRIES_STORE);
        const audio = transaction.objectStore(AUDIO_STORE);
        entries.put(entry);
        audio.put({ id: entry.id, chunks });
        const existing = await readEntries(transaction);
        const evictions = selectHistoryEvictions(existing, limits, entry.id);
        // Only favorites written before their budget existed, or by another
        // tab at the same moment, can leave the store over its limits.
        const kept = existing.filter((item) => !evictions.includes(item.id));
        const keptBytes = kept.reduce((total, item) => total + item.byteLength, 0);
        if (kept.length > limits.maxEntries || keptBytes > limits.maxTotalBytes) {
          fail("History is full of favorites. Unfavorite or delete some generations first.");
        }
        for (const id of evictions) {
          entries.delete(id);
          audio.delete(id);
        }
        return evictions;
      });
      emitChange();
      return { entry, evictedIds };
    },

    async getAudio(id) {
      const chunks = await withTransaction([ENTRIES_STORE, AUDIO_STORE], "readwrite", async (transaction) => {
        const entries = transaction.objectStore(ENTRIES_STORE);
        const entry = parseGenerationHistoryEntry(await requestResult(entries.get(id)));
        if (!entry) return null;
        const row = await requestResult(transaction.objectStore(AUDIO_STORE).get(id)) as { chunks?: unknown } | undefined;
        if (!row || !Array.isArray(row.chunks) || row.chunks.length === 0 || !row.chunks.every(isValidChunk)) return null;
        entries.put({ ...entry, lastAccessedAt: Math.max(now(), entry.lastAccessedAt) });
        return row.chunks as GenerationAudioChunk[];
      });
      return chunks;
    },

    async setFavorite(id, favorite) {
      const updated = await withTransaction([ENTRIES_STORE], "readwrite", async (transaction) => {
        const store = transaction.objectStore(ENTRIES_STORE);
        const entries = await readEntries(transaction);
        const current = entries.find((entry) => entry.id === id);
        if (!current) fail("That generation is no longer in history.");
        if (favorite && !current.favorite) {
          const favorites = entries.filter((entry) => entry.favorite);
          const favoriteBytes = favorites.reduce((total, entry) => total + entry.byteLength, 0);
          if (favorites.length + 1 > maxFavoriteEntries) {
            fail(`History keeps at most ${maxFavoriteEntries} favorites. Unfavorite one first.`);
          }
          if (favoriteBytes + current.byteLength > maxFavoriteBytes) {
            fail("Favorites have used their share of history storage. Unfavorite or download and delete some first.");
          }
        }
        const next = { ...current, favorite };
        store.put(next);
        return next;
      });
      emitChange();
      return updated;
    },

    rename(id, title) {
      const trimmed = title.replace(/\s+/g, " ").trim();
      if (!trimmed) return Promise.reject(new GenerationHistoryError("A title is required."));
      return updateEntry(id, (entry) => ({ ...entry, title: generationTitle(trimmed) }));
    },

    async deleteEntry(id) {
      await withTransaction([ENTRIES_STORE, AUDIO_STORE], "readwrite", async (transaction) => {
        transaction.objectStore(ENTRIES_STORE).delete(id);
        transaction.objectStore(AUDIO_STORE).delete(id);
      });
      emitChange();
    },

    async clear(clearOptions = {}) {
      await withTransaction([ENTRIES_STORE, AUDIO_STORE], "readwrite", async (transaction) => {
        const entries = transaction.objectStore(ENTRIES_STORE);
        const audio = transaction.objectStore(AUDIO_STORE);
        if (!clearOptions.keepFavorites) {
          entries.clear();
          audio.clear();
          return;
        }
        // Entries a newer version wrote cannot be read here, so they may be
        // favorites; leave them alone like the voice library does.
        const raws = await requestResult(entries.getAll()) as unknown[];
        for (const raw of raws) {
          const entry = parseGenerationHistoryEntry(raw);
          if (entry?.favorite || isNewerSchemaEntry(raw)) continue;
          const id = isRecord(raw) ? raw.id : undefined;
          if (typeof id !== "string" && typeof id !== "number") continue;
          entries.delete(id);
          audio.delete(id);
        }
      });
      emitChange();
    },

    async getUsage() {
      const entries = await withTransaction([ENTRIES_STORE], "readonly", readEntries);
      return {
        entryCount: entries.length,
        totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
        favoriteCount: entries.filter((entry) => entry.favorite).length,
      };
    },

    subscribe(listener) {
      return changes.subscribe(listener);
    },

    async destroy() {
      await deleteIndexedDatabase(databaseName);
      emitChange();
    },
  };
}

let defaultStore: GenerationHistoryStore | null = null;

export function getGenerationHistoryStore(): GenerationHistoryStore {
  defaultStore ??= createGenerationHistoryStore();
  return defaultStore;
}

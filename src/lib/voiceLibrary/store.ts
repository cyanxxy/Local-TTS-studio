import {
  createChangeNotifier,
  deleteIndexedDatabase,
  isArrayBufferLike,
  isUint8ArrayLike,
  openVersionedDatabase,
  requestResult,
  runTransaction,
  type IndexedDbMigration,
} from "../indexedDb";
import { decodeWav, encodeWavPcm16, toStandaloneArrayBuffer } from "../wavCodec";
import { buildVoicePackage, parseVoicePackage, voicePackageFileName } from "./portable";
import {
  VOICE_LIBRARY_SCHEMA_VERSION,
  type NewVoice,
  type StoredAudioInfo,
  type VoiceAudioRole,
  type VoicePatch,
  type VoicePreset,
  type VoiceRecord,
} from "./types";
import {
  VOICE_LIBRARY_LIMITS,
  VoiceLibraryValidationError,
  isNewerSchemaRecord,
  normalizeCloneTargets,
  normalizeLanguage,
  normalizePreset,
  normalizeStoredAudioInfo,
  normalizeTranscript,
  normalizeVoiceDescription,
  normalizeVoiceDesign,
  normalizeVoiceName,
  normalizeVoiceSource,
  normalizeVoiceTags,
  parseStoredVoiceRecord,
} from "./validation";

export const VOICE_LIBRARY_DATABASE_NAME = "open-tts-voice-library";
const VOICES_STORE = "voices";
const AUDIO_STORE = "voice-audio";
const PREVIEWS_STORE = "previews";
const CHANGE_CHANNEL = "open-tts-voice-library";

/**
 * Schema history. Append a step for every change and never edit a shipped
 * one: browsers run each step newer than the stored version, in order.
 */
export const VOICE_LIBRARY_MIGRATIONS: readonly IndexedDbMigration[] = [
  {
    version: 1,
    migrate: (database) => {
      const voices = database.createObjectStore(VOICES_STORE, { keyPath: "id" });
      voices.createIndex("updatedAt", "updatedAt");
      const audio = database.createObjectStore(AUDIO_STORE, { keyPath: "key" });
      audio.createIndex("voiceId", "voiceId");
      const previews = database.createObjectStore(PREVIEWS_STORE, { keyPath: "key" });
      previews.createIndex("ownerId", "ownerId");
      previews.createIndex("lastUsedAt", "lastUsedAt");
    },
  },
];

export const DEFAULT_PREVIEW_CACHE_LIMITS = {
  maxEntries: 64,
  maxBytes: 64 * 1024 * 1024,
} as const;

interface StoredAudioRow {
  key: string;
  voiceId: string;
  role: VoiceAudioRole;
  bytes: ArrayBuffer;
}

interface StoredPreviewRow {
  key: string;
  ownerId: string;
  previewKey: string;
  wav: ArrayBuffer;
  byteLength: number;
  sampleRate: number;
  durationSec: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface VoicePreview {
  ownerId: string;
  previewKey: string;
  /** 16-bit PCM WAV, directly playable from a Blob URL. */
  wav: Uint8Array;
  sampleRate: number;
  durationSec: number;
  createdAt: number;
}

export interface VoiceLibraryUsage {
  voiceCount: number;
  audioBytes: number;
  previewCount: number;
  previewBytes: number;
}

export interface VoiceLibraryStoreOptions {
  databaseName?: string;
  now?: () => number;
  createId?: () => string;
  digest?: (bytes: Uint8Array) => Promise<string>;
  maxVoices?: number;
  maxTotalAudioBytes?: number;
  previewCache?: { maxEntries?: number; maxBytes?: number };
}

export interface VoiceLibraryStore {
  listVoices(): Promise<VoiceRecord[]>;
  getVoice(id: string): Promise<VoiceRecord | null>;
  createVoice(input: NewVoice): Promise<VoiceRecord>;
  updateVoice(id: string, patch: VoicePatch): Promise<VoiceRecord>;
  setFavorite(id: string, favorite: boolean): Promise<VoiceRecord>;
  deleteVoice(id: string): Promise<void>;
  /** WAV bytes of a cloned voice's reference or a designed voice's sample. */
  getVoiceAudio(id: string, role: VoiceAudioRole): Promise<Uint8Array | null>;
  getPreview(ownerId: string, previewKey: string): Promise<VoicePreview | null>;
  putPreview(ownerId: string, previewKey: string, audio: { samples: Float32Array; sampleRate: number }): Promise<VoicePreview>;
  clearPreviews(ownerId?: string): Promise<void>;
  exportVoice(id: string): Promise<{ fileName: string; bytes: Uint8Array }>;
  importVoice(bytes: Uint8Array): Promise<VoiceRecord>;
  getUsage(): Promise<VoiceLibraryUsage>;
  /** Called after every change made here or, while subscribed, in another tab. */
  subscribe(listener: () => void): () => void;
  /** Delete the whole database (tests and "reset library"). */
  destroy(): Promise<void>;
}

function audioKey(voiceId: string, role: VoiceAudioRole): string {
  return `${voiceId}:${role}`;
}

function previewRowKey(ownerId: string, previewKey: string): string {
  return `${ownerId}\u0000${previewKey}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", toStandaloneArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function defaultId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function recordAudioBytes(record: VoiceRecord): number {
  if (record.kind === "cloned") return record.reference.byteLength;
  if (record.kind === "designed") return record.sample?.byteLength ?? 0;
  return 0;
}

function storedBytes(value: unknown): Uint8Array | null {
  if (isArrayBufferLike(value)) return new Uint8Array(value);
  if (isUint8ArrayLike(value)) return value;
  return null;
}

/**
 * Persisted catalog of user voices in IndexedDB, which both the web app and
 * the Electron renderer provide. Metadata, audio and the preview cache live in
 * separate object stores so listing voices never loads audio.
 */
export function createVoiceLibraryStore(options: VoiceLibraryStoreOptions = {}): VoiceLibraryStore {
  const databaseName = options.databaseName ?? VOICE_LIBRARY_DATABASE_NAME;
  const now = options.now ?? Date.now;
  const createId = options.createId ?? defaultId;
  const digest = options.digest ?? sha256Hex;
  const maxVoices = options.maxVoices ?? VOICE_LIBRARY_LIMITS.maxVoices;
  const maxTotalAudioBytes = options.maxTotalAudioBytes ?? VOICE_LIBRARY_LIMITS.maxTotalAudioBytes;
  const maxPreviewEntries = options.previewCache?.maxEntries ?? DEFAULT_PREVIEW_CACHE_LIMITS.maxEntries;
  const maxPreviewBytes = options.previewCache?.maxBytes ?? DEFAULT_PREVIEW_CACHE_LIMITS.maxBytes;
  const changes = createChangeNotifier(CHANGE_CHANNEL);

  function open(): Promise<IDBDatabase> {
    return openVersionedDatabase({
      name: databaseName,
      migrations: VOICE_LIBRARY_MIGRATIONS,
      blockedMessage: "The voice library upgrade is blocked by another open tab. Close the other tab and try again.",
      unsupportedMessage: "This browser does not provide IndexedDB, so the voice library cannot persist.",
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


  async function readAudioInfo(bytes: Uint8Array, maxDurationSec?: number): Promise<StoredAudioInfo> {
    if (!isUint8ArrayLike(bytes) || bytes.byteLength === 0) {
      throw new VoiceLibraryValidationError("Voice audio must be a non-empty WAV file.");
    }
    if (bytes.byteLength > VOICE_LIBRARY_LIMITS.maxAudioBytes) {
      throw new VoiceLibraryValidationError(`Voice audio is limited to ${VOICE_LIBRARY_LIMITS.maxAudioBytes.toLocaleString("en-US")} bytes.`);
    }
    let decoded;
    try {
      decoded = decodeWav(bytes);
    } catch (cause) {
      throw new VoiceLibraryValidationError(cause instanceof Error ? cause.message : "Voice audio is not a valid WAV file.");
    }
    const frames = decoded.channels[0]?.length ?? 0;
    return normalizeStoredAudioInfo({
      sampleRate: decoded.sampleRate,
      durationSec: frames / decoded.sampleRate,
      byteLength: bytes.byteLength,
      sha256: await digest(bytes),
    }, { maxDurationSec });
  }

  /** Validate input and derive audio metadata before any transaction opens. */
  async function buildRecord(input: NewVoice, id: string, timestamp: number): Promise<{
    record: VoiceRecord;
    audio: Array<{ role: VoiceAudioRole; bytes: Uint8Array }>;
  }> {
    const base = {
      schemaVersion: VOICE_LIBRARY_SCHEMA_VERSION,
      id,
      name: normalizeVoiceName(input.name),
      description: normalizeVoiceDescription(input.description),
      tags: normalizeVoiceTags(input.tags),
      favorite: input.favorite === true,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;
    switch (input.kind) {
      case "preset":
        return { record: { ...base, kind: "preset", preset: normalizePreset(input.preset) }, audio: [] };
      case "cloned": {
        const record: VoiceRecord = {
          ...base,
          kind: "cloned",
          transcript: normalizeTranscript(input.transcript),
          language: normalizeLanguage(input.language),
          targets: normalizeCloneTargets(input.targets),
          source: normalizeVoiceSource(input.source),
          reference: await readAudioInfo(input.referenceWav, VOICE_LIBRARY_LIMITS.maxReferenceDurationSec),
        };
        if (input.designedFromId) record.designedFromId = input.designedFromId;
        return { record, audio: [{ role: "reference", bytes: input.referenceWav }] };
      }
      case "designed": {
        const record: VoiceRecord = { ...base, kind: "designed", design: normalizeVoiceDesign(input.design) };
        if (input.sampleWav === undefined) return { record, audio: [] };
        record.sample = await readAudioInfo(input.sampleWav);
        return { record, audio: [{ role: "sample", bytes: input.sampleWav }] };
      }
      default:
        throw new VoiceLibraryValidationError("Unknown voice kind.");
    }
  }

  async function readAllRaw(transaction: IDBTransaction): Promise<unknown[]> {
    return await requestResult(transaction.objectStore(VOICES_STORE).getAll()) as unknown[];
  }

  async function insertRecord(input: NewVoice): Promise<VoiceRecord> {
    const timestamp = now();
    const { record, audio } = await buildRecord(input, createId(), timestamp);
    await withTransaction([VOICES_STORE, AUDIO_STORE], "readwrite", async (transaction) => {
      const existing = await readAllRaw(transaction);
      if (existing.length >= maxVoices) {
        throw new VoiceLibraryValidationError(`The voice library holds at most ${maxVoices} voices. Delete some voices first.`);
      }
      const usedBytes = existing.reduce<number>((total, raw) => {
        const parsed = parseStoredVoiceRecord(raw);
        return total + (parsed ? recordAudioBytes(parsed) : 0);
      }, 0);
      if (usedBytes + recordAudioBytes(record) > maxTotalAudioBytes) {
        throw new VoiceLibraryValidationError("The voice library is out of space. Delete cloned or designed voices first.");
      }
      if (existing.some((raw) => (raw as { id?: unknown }).id === record.id)) {
        throw new VoiceLibraryValidationError("A voice with this id already exists.");
      }
      transaction.objectStore(VOICES_STORE).put(record);
      for (const entry of audio) {
        transaction.objectStore(AUDIO_STORE).put({
          key: audioKey(record.id, entry.role),
          voiceId: record.id,
          role: entry.role,
          bytes: toStandaloneArrayBuffer(entry.bytes),
        } satisfies StoredAudioRow);
      }
    });
    emitChange();
    return record;
  }

  async function mutateRecord(id: string, change: (record: VoiceRecord) => VoiceRecord): Promise<VoiceRecord> {
    const updated = await withTransaction([VOICES_STORE], "readwrite", async (transaction) => {
      const store = transaction.objectStore(VOICES_STORE);
      const raw = await requestResult(store.get(id)) as unknown;
      if (isNewerSchemaRecord(raw)) {
        throw new VoiceLibraryValidationError("This voice was saved by a newer version of Open TTS and cannot be edited here.");
      }
      const current = parseStoredVoiceRecord(raw);
      if (!current) throw new VoiceLibraryValidationError("That voice no longer exists.");
      const next = change(current);
      store.put(next);
      return next;
    });
    emitChange();
    return updated;
  }

  function applyPatch(record: VoiceRecord, patch: VoicePatch): VoiceRecord {
    const next: VoiceRecord = {
      ...record,
      name: patch.name === undefined ? record.name : normalizeVoiceName(patch.name),
      description: patch.description === undefined ? record.description : normalizeVoiceDescription(patch.description),
      tags: patch.tags === undefined ? record.tags : normalizeVoiceTags(patch.tags),
      favorite: patch.favorite === undefined ? record.favorite : patch.favorite === true,
      updatedAt: Math.max(now(), record.updatedAt),
    };
    if (next.kind === "preset" && patch.preset !== undefined) next.preset = normalizePreset(patch.preset);
    if (next.kind === "cloned") {
      if (patch.transcript !== undefined) next.transcript = normalizeTranscript(patch.transcript);
      if (patch.language !== undefined) next.language = normalizeLanguage(patch.language);
      if (patch.targets !== undefined) next.targets = normalizeCloneTargets(patch.targets);
    }
    return next;
  }

  function toPreview(row: StoredPreviewRow): VoicePreview {
    return {
      ownerId: row.ownerId,
      previewKey: row.previewKey,
      wav: new Uint8Array(row.wav),
      sampleRate: row.sampleRate,
      durationSec: row.durationSec,
      createdAt: row.createdAt,
    };
  }

  async function prunePreviews(transaction: IDBTransaction, protectedKey: string): Promise<void> {
    const store = transaction.objectStore(PREVIEWS_STORE);
    const rows = await requestResult(store.index("lastUsedAt").getAll()) as StoredPreviewRow[];
    let entries = rows.length;
    let bytes = rows.reduce((total, row) => total + row.byteLength, 0);
    // The index yields least recently used first.
    for (const row of rows) {
      if (entries <= maxPreviewEntries && bytes <= maxPreviewBytes) break;
      if (row.key === protectedKey) continue;
      store.delete(row.key);
      entries -= 1;
      bytes -= row.byteLength;
    }
  }

  async function getVoice(id: string): Promise<VoiceRecord | null> {
    const raw = await withTransaction([VOICES_STORE], "readonly", async (transaction) => (
      await requestResult(transaction.objectStore(VOICES_STORE).get(id)) as unknown
    ));
    return parseStoredVoiceRecord(raw);
  }

  async function getVoiceAudio(id: string, role: VoiceAudioRole): Promise<Uint8Array | null> {
    const row = await withTransaction([AUDIO_STORE], "readonly", async (transaction) => (
      await requestResult(transaction.objectStore(AUDIO_STORE).get(audioKey(id, role))) as StoredAudioRow | undefined
    ));
    return row ? storedBytes(row.bytes) : null;
  }

  return {
    async listVoices() {
      const raws = await withTransaction([VOICES_STORE], "readonly", readAllRaw);
      const records: VoiceRecord[] = [];
      for (const raw of raws) {
        const record = parseStoredVoiceRecord(raw);
        if (record) records.push(record);
      }
      return records.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
    },

    getVoice,

    createVoice: insertRecord,

    updateVoice(id, patch) {
      return mutateRecord(id, (record) => applyPatch(record, patch));
    },

    setFavorite(id, favorite) {
      return mutateRecord(id, (record) => applyPatch(record, { favorite }));
    },

    async deleteVoice(id) {
      await withTransaction([VOICES_STORE, AUDIO_STORE, PREVIEWS_STORE], "readwrite", async (transaction) => {
        transaction.objectStore(VOICES_STORE).delete(id);
        transaction.objectStore(AUDIO_STORE).delete(audioKey(id, "reference"));
        transaction.objectStore(AUDIO_STORE).delete(audioKey(id, "sample"));
        const previews = transaction.objectStore(PREVIEWS_STORE);
        const keys = await requestResult(previews.index("ownerId").getAllKeys(id));
        for (const key of keys) previews.delete(key);
      });
      emitChange();
    },

    getVoiceAudio,

    async getPreview(ownerId, previewKey) {
      const key = previewRowKey(ownerId, previewKey);
      const row = await withTransaction([PREVIEWS_STORE], "readwrite", async (transaction) => {
        const store = transaction.objectStore(PREVIEWS_STORE);
        const found = await requestResult(store.get(key)) as StoredPreviewRow | undefined;
        if (!found || !isArrayBufferLike(found.wav)) return null;
        // Touch on read so the LRU keeps previews people actually replay.
        store.put({ ...found, lastUsedAt: Math.max(now(), found.lastUsedAt) });
        return found;
      });
      return row ? toPreview(row) : null;
    },

    async putPreview(ownerId, previewKey, audio) {
      if (!ownerId || !previewKey) throw new VoiceLibraryValidationError("Preview keys are required.");
      if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0 || audio.samples.length === 0) {
        throw new VoiceLibraryValidationError("Preview audio is empty or has an invalid sample rate.");
      }
      const wav = encodeWavPcm16(audio.samples, audio.sampleRate);
      if (wav.byteLength > maxPreviewBytes) {
        throw new VoiceLibraryValidationError("The preview is too long to cache.");
      }
      const timestamp = now();
      const row: StoredPreviewRow = {
        key: previewRowKey(ownerId, previewKey),
        ownerId,
        previewKey,
        wav: toStandaloneArrayBuffer(wav),
        byteLength: wav.byteLength,
        sampleRate: audio.sampleRate,
        durationSec: audio.samples.length / audio.sampleRate,
        createdAt: timestamp,
        lastUsedAt: timestamp,
      };
      await withTransaction([PREVIEWS_STORE], "readwrite", async (transaction) => {
        transaction.objectStore(PREVIEWS_STORE).put(row);
        await prunePreviews(transaction, row.key);
      });
      return toPreview(row);
    },

    async clearPreviews(ownerId) {
      await withTransaction([PREVIEWS_STORE], "readwrite", async (transaction) => {
        const store = transaction.objectStore(PREVIEWS_STORE);
        if (ownerId === undefined) {
          store.clear();
          return;
        }
        const keys = await requestResult(store.index("ownerId").getAllKeys(ownerId));
        for (const key of keys) store.delete(key);
      });
    },

    async exportVoice(id) {
      const record = await getVoice(id);
      if (!record) throw new VoiceLibraryValidationError("That voice no longer exists.");
      const reference = record.kind === "cloned" ? await getVoiceAudio(id, "reference") : null;
      const sample = record.kind === "designed" && record.sample ? await getVoiceAudio(id, "sample") : null;
      if ((record.kind === "cloned" && !reference) || (record.kind === "designed" && record.sample && !sample)) {
        throw new Error("This voice's audio is missing from the library.");
      }
      const bytes = await buildVoicePackage(record, { reference, sample }, now());
      return { fileName: voicePackageFileName(record.name), bytes };
    },

    async importVoice(bytes) {
      const input = await parseVoicePackage(bytes, digest);
      return insertRecord(input);
    },

    async getUsage() {
      return withTransaction([VOICES_STORE, PREVIEWS_STORE], "readonly", async (transaction) => {
        const raws = await readAllRaw(transaction);
        const records = raws.map(parseStoredVoiceRecord).filter((record): record is VoiceRecord => record !== null);
        const previews = await requestResult(transaction.objectStore(PREVIEWS_STORE).getAll()) as StoredPreviewRow[];
        return {
          voiceCount: records.length,
          audioBytes: records.reduce((total, record) => total + recordAudioBytes(record), 0),
          previewCount: previews.length,
          previewBytes: previews.reduce((total, row) => total + row.byteLength, 0),
        };
      });
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

let defaultStore: VoiceLibraryStore | null = null;

/** The app-wide library instance. */
export function getVoiceLibraryStore(): VoiceLibraryStore {
  defaultStore ??= createVoiceLibraryStore();
  return defaultStore;
}

/**
 * The VoicePreset a synthesizer should use for a library voice. Cloned voices
 * render through Qwen3 Base or NeuTTS (the first target unless one is asked
 * for); designed voices render through Qwen3 VoiceDesign with their seed.
 */
export function voicePresetFromRecord(
  record: VoiceRecord,
  options: { cloneTarget?: "qwen3-base" | "neutts" } = {},
): VoicePreset {
  switch (record.kind) {
    case "preset":
      return { ...record.preset, mode: "preset", libraryVoiceId: record.id, label: record.name };
    case "cloned": {
      const target = options.cloneTarget && record.targets.includes(options.cloneTarget)
        ? options.cloneTarget
        : record.targets[0];
      return {
        engineId: target === "neutts" ? "neutts" : "qwen3",
        voiceId: `library:${record.id}`,
        mode: "voiceClone",
        settings: { language: record.language },
        libraryVoiceId: record.id,
        label: record.name,
      };
    }
    case "designed":
      return {
        engineId: "qwen3",
        voiceId: `library:${record.id}`,
        mode: "voiceDesign",
        settings: {
          instruction: record.design.description,
          seed: record.design.seed,
          language: record.design.language,
        },
        libraryVoiceId: record.id,
        label: record.name,
      };
  }
}

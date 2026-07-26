import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;
const ACTIVE_DOCUMENT_KEY = "active-document-id";
const MAX_DOCUMENT_TEXT_CHARS = 1_500_000;
const MAX_DOCUMENT_JSON_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_AUDIO_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_AUDIO_CACHE_ENTRIES = 96;
const MAX_AUDIO_CHUNKS = 16_384;
const MAX_AUDIO_CHUNK_BYTES = 16 * 1024 * 1024;

interface ReaderDocumentRecord {
  id: string;
  title: string;
  text: string;
  updatedAt: number;
  lastOpenedAt: number;
  [key: string]: unknown;
}

interface ReaderAudioChunk {
  audio: ArrayBuffer;
  samplingRate: number;
  text: string;
  index: number;
  total: number;
  textStart?: number;
  textEnd?: number;
  pauseAfterSec?: number;
  pauseKind?: "none" | "comma" | "sentence" | "paragraph";
}

interface CachedReaderAudio {
  cacheKey: string;
  documentId: string;
  chapterId: string;
  sectionId: string;
  signature: string;
  chunks: ReaderAudioChunk[];
  byteLength: number;
  currentTime: number;
  playbackRate: number;
  totalDuration: number;
  updatedAt: number;
}

interface DocumentRow {
  record_json: string;
  last_opened_at: number;
}

interface SettingRow {
  value: string;
}

interface AudioRow {
  record_json: string;
}

interface AudioChunkRow {
  metadata_json: string;
  audio: Uint8Array;
}

interface AudioPruneRow {
  cache_key: string;
  byte_length: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, maxLength = 2_048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${label} must be a finite number greater than or equal to ${minimum}.`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, label);
}

function parseDocument(value: unknown): {
  record: ReaderDocumentRecord;
  json: string;
  snapshotUpdatedAt: number;
} {
  if (!isRecord(value)) throw new TypeError("Reader document must be an object.");
  const record = value as ReaderDocumentRecord;
  requiredString(record.id, "Reader document id", 512);
  requiredString(record.title, "Reader document title", 160);
  if (typeof record.text !== "string" || record.text.length > MAX_DOCUMENT_TEXT_CHARS) {
    throw new TypeError(`Reader document text must be at most ${MAX_DOCUMENT_TEXT_CHARS} characters.`);
  }
  const updatedAt = finiteNumber(record.updatedAt, "Reader document updatedAt");
  finiteNumber(record.lastOpenedAt, "Reader document lastOpenedAt");
  const progressUpdatedAt = isRecord(record.progress)
    ? finiteNumber(record.progress.updatedAt, "Reader document progress updatedAt")
    : updatedAt;
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json, "utf8") > MAX_DOCUMENT_JSON_BYTES) {
    throw new TypeError("Reader document exceeds the SQLite record size limit.");
  }
  return { record, json, snapshotUpdatedAt: Math.max(updatedAt, progressUpdatedAt) };
}

function toAudioBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${label} must be binary audio data.`);
}

function parseAudioChunk(value: unknown, order: number): {
  chunk: ReaderAudioChunk;
  bytes: Uint8Array;
  metadataJson: string;
} {
  if (!isRecord(value)) throw new TypeError(`Reader audio chunk ${order} must be an object.`);
  const sourceBytes = toAudioBytes(value.audio, `Reader audio chunk ${order}`);
  if (sourceBytes.byteLength > MAX_AUDIO_CHUNK_BYTES) {
    throw new TypeError(`Reader audio chunk ${order} exceeds the per-chunk SQLite size limit.`);
  }
  const audio = (
    sourceBytes.buffer instanceof ArrayBuffer
    && sourceBytes.byteOffset === 0
    && sourceBytes.byteLength === sourceBytes.buffer.byteLength
  )
    ? sourceBytes.buffer
    : sourceBytes.slice().buffer;
  const bytes = new Uint8Array(audio);
  const pauseKind = value.pauseKind;
  if (
    pauseKind !== undefined
    && pauseKind !== "none"
    && pauseKind !== "comma"
    && pauseKind !== "sentence"
    && pauseKind !== "paragraph"
  ) {
    throw new TypeError(`Reader audio chunk ${order} has an invalid pause kind.`);
  }
  const chunk: ReaderAudioChunk = {
    audio,
    samplingRate: finiteNumber(value.samplingRate, `Reader audio chunk ${order} samplingRate`, 1),
    text: typeof value.text === "string" ? value.text : "",
    index: finiteNumber(value.index, `Reader audio chunk ${order} index`),
    total: finiteNumber(value.total, `Reader audio chunk ${order} total`, 1),
    textStart: optionalFiniteNumber(value.textStart, `Reader audio chunk ${order} textStart`),
    textEnd: optionalFiniteNumber(value.textEnd, `Reader audio chunk ${order} textEnd`),
    pauseAfterSec: optionalFiniteNumber(value.pauseAfterSec, `Reader audio chunk ${order} pauseAfterSec`),
    pauseKind,
  };
  const { audio: _audio, ...metadata } = chunk;
  void _audio;
  return { chunk, bytes, metadataJson: JSON.stringify(metadata) };
}

function parseCachedAudio(value: unknown): {
  audio: CachedReaderAudio;
  chunks: Array<{ chunk: ReaderAudioChunk; bytes: Uint8Array; metadataJson: string }>;
  metadataJson: string;
} {
  if (!isRecord(value)) throw new TypeError("Cached Reader audio must be an object.");
  if (!Array.isArray(value.chunks) || value.chunks.length > MAX_AUDIO_CHUNKS) {
    throw new TypeError(`Cached Reader audio must contain at most ${MAX_AUDIO_CHUNKS} chunks.`);
  }
  const chunks = value.chunks.map(parseAudioChunk);
  const byteLength = chunks.reduce((total, entry) => total + entry.bytes.byteLength, 0);
  if (byteLength > MAX_AUDIO_ENTRY_BYTES) {
    throw new TypeError("Cached Reader audio exceeds the per-entry SQLite size limit.");
  }
  const documentId = requiredString(value.documentId, "Reader audio documentId", 512);
  const sectionId = requiredString(value.sectionId, "Reader audio sectionId", 512);
  const cacheKey = requiredString(value.cacheKey, "Reader audio cacheKey", 2_048);
  if (cacheKey !== JSON.stringify([documentId, sectionId])) {
    throw new TypeError("Reader audio cacheKey does not match its document and section.");
  }
  const audio: CachedReaderAudio = {
    cacheKey,
    documentId,
    chapterId: requiredString(value.chapterId, "Reader audio chapterId", 512),
    sectionId,
    signature: requiredString(value.signature, "Reader audio signature", 2_048),
    chunks: chunks.map((entry) => entry.chunk),
    byteLength,
    currentTime: finiteNumber(value.currentTime, "Reader audio currentTime"),
    playbackRate: finiteNumber(value.playbackRate, "Reader audio playbackRate", 0.01),
    totalDuration: finiteNumber(value.totalDuration, "Reader audio totalDuration"),
    updatedAt: finiteNumber(value.updatedAt, "Reader audio updatedAt"),
  };
  const { chunks: _chunks, ...metadata } = audio;
  void _chunks;
  const metadataJson = JSON.stringify(metadata);
  const metadataBytes = chunks.reduce(
    (total, entry) => total + Buffer.byteLength(entry.metadataJson, "utf8"),
    Buffer.byteLength(metadataJson, "utf8"),
  );
  if (metadataBytes > MAX_AUDIO_METADATA_BYTES) {
    throw new TypeError("Cached Reader audio metadata exceeds the SQLite record size limit.");
  }
  return { audio, chunks, metadataJson };
}

function decodeDocument(json: string, lastOpenedAt: number): ReaderDocumentRecord | null {
  try {
    return {
      ...parseDocument(JSON.parse(json)).record,
      lastOpenedAt,
    };
  } catch {
    return null;
  }
}

function decodeCachedAudio(audioRow: AudioRow, chunkRows: AudioChunkRow[]): CachedReaderAudio | null {
  try {
    const metadata = JSON.parse(audioRow.record_json) as Omit<CachedReaderAudio, "chunks">;
    const chunks = chunkRows.map((row) => {
      const chunkMetadata = JSON.parse(row.metadata_json) as Omit<ReaderAudioChunk, "audio">;
      return {
        ...chunkMetadata,
        audio: Uint8Array.from(row.audio).buffer,
      };
    });
    return parseCachedAudio({ ...metadata, chunks }).audio;
  } catch {
    return null;
  }
}

/**
 * Local Reader persistence for Electron.
 *
 * `PRAGMA user_version` records the schema created for this local database.
 */
export class ReaderLibraryDatabase {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    const database = new DatabaseSync(databasePath);
    this.#database = database;
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = NORMAL");
      this.#initializeSchema();
    } catch (cause) {
      this.#closed = true;
      database.close();
      throw cause;
    }
  }

  #initializeSchema(): void {
    this.#transaction(() => {
      const row = this.#database.prepare("PRAGMA user_version").get() as { user_version: number };
      if (row.user_version > SCHEMA_VERSION) {
        throw new Error(
          `Reader library schema ${row.user_version} is newer than supported schema ${SCHEMA_VERSION}.`,
        );
      }
      if (row.user_version === 0) {
        this.#database.exec(`
          CREATE TABLE documents (
            id TEXT PRIMARY KEY,
            record_json TEXT NOT NULL,
            last_opened_at REAL NOT NULL,
            updated_at REAL NOT NULL
          ) STRICT;
          CREATE INDEX documents_recency_idx
            ON documents(last_opened_at DESC, updated_at DESC);

          CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          ) STRICT;

          CREATE TABLE reader_audio (
            cache_key TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            byte_length INTEGER NOT NULL,
            updated_at REAL NOT NULL,
            record_json TEXT NOT NULL
          ) STRICT;
          CREATE INDEX reader_audio_document_idx
            ON reader_audio(document_id);
          CREATE INDEX reader_audio_lru_idx
            ON reader_audio(updated_at ASC);

          CREATE TABLE reader_audio_chunks (
            cache_key TEXT NOT NULL REFERENCES reader_audio(cache_key) ON DELETE CASCADE,
            chunk_order INTEGER NOT NULL,
            metadata_json TEXT NOT NULL,
            audio BLOB NOT NULL,
            PRIMARY KEY (cache_key, chunk_order)
          ) STRICT;

          PRAGMA user_version = 1;
        `);
      }
    });
  }

  #transaction<T>(operation: () => T, mode: "DEFERRED" | "IMMEDIATE" = "IMMEDIATE"): T {
    this.#database.exec(`BEGIN ${mode}`);
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      // A failed COMMIT may have rolled back already, so the rollback is
      // best-effort: never let it mask the error that broke the transaction.
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // No transaction is active.
      }
      throw error;
    }
  }

  listDocuments(): ReaderDocumentRecord[] {
    const rows = this.#database.prepare(`
      SELECT record_json, last_opened_at
      FROM documents
      ORDER BY last_opened_at DESC, updated_at DESC
    `).all() as unknown as DocumentRow[];
    return rows
      .map((row) => decodeDocument(row.record_json, row.last_opened_at))
      .filter((record): record is ReaderDocumentRecord => record !== null);
  }

  getDocument(idValue: unknown): ReaderDocumentRecord | null {
    const id = requiredString(idValue, "Reader document id", 512);
    const row = this.#database
      .prepare("SELECT record_json, last_opened_at FROM documents WHERE id = ?")
      .get(id) as DocumentRow | undefined;
    return row ? decodeDocument(row.record_json, row.last_opened_at) : null;
  }

  saveDocument(value: unknown): void {
    const { record, json, snapshotUpdatedAt } = parseDocument(value);
    this.#database.prepare(`
      INSERT INTO documents(id, record_json, last_opened_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        record_json = CASE
          -- Equal timestamps are the same logical snapshot, so the last write
          -- wins, matching saveAudio and the IndexedDB backend the web Reader
          -- uses. Only stale snapshots keep the stored record.
          WHEN excluded.updated_at >= MAX(
            documents.updated_at,
            COALESCE(
              CASE
                WHEN json_valid(documents.record_json)
                THEN CAST(json_extract(documents.record_json, '$.progress.updatedAt') AS REAL)
              END,
              documents.updated_at
            )
          )
          THEN excluded.record_json
          ELSE documents.record_json
        END,
        last_opened_at = MAX(documents.last_opened_at, excluded.last_opened_at),
        updated_at = MAX(
          documents.updated_at,
          COALESCE(
            CASE
              WHEN json_valid(documents.record_json)
              THEN CAST(json_extract(documents.record_json, '$.progress.updatedAt') AS REAL)
            END,
            documents.updated_at
          ),
          excluded.updated_at
        )
    `).run(record.id, json, record.lastOpenedAt, snapshotUpdatedAt);
  }

  deleteDocument(idValue: unknown): void {
    const id = requiredString(idValue, "Reader document id", 512);
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM reader_audio WHERE document_id = ?").run(id);
      this.#database.prepare("DELETE FROM documents WHERE id = ?").run(id);
      this.#database.prepare("DELETE FROM settings WHERE key = ? AND value = ?").run(ACTIVE_DOCUMENT_KEY, id);
    });
  }

  getActiveDocumentId(): string | null {
    const row = this.#database
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(ACTIVE_DOCUMENT_KEY) as SettingRow | undefined;
    return row?.value ?? null;
  }

  setActiveDocumentId(idValue: unknown): void {
    const id = requiredString(idValue, "Active Reader document id", 512);
    this.#database.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(ACTIVE_DOCUMENT_KEY, id);
  }

  saveAudio(value: unknown): void {
    const parsed = parseCachedAudio(value);
    this.#transaction(() => {
      const existing = this.#database
        .prepare("SELECT updated_at FROM reader_audio WHERE cache_key = ?")
        .get(parsed.audio.cacheKey) as { updated_at: number } | undefined;
      // A final section flush can race an older debounced write. Timestamps are
      // monotonic at the caller, so never let the stale snapshot win the race.
      // Equal timestamps: last write wins, matching the IndexedDB backend.
      if (existing && existing.updated_at > parsed.audio.updatedAt) return;
      this.#database.prepare("DELETE FROM reader_audio WHERE cache_key = ?").run(parsed.audio.cacheKey);
      this.#database.prepare(`
        INSERT INTO reader_audio(
          cache_key, document_id, section_id, byte_length, updated_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        parsed.audio.cacheKey,
        parsed.audio.documentId,
        parsed.audio.sectionId,
        parsed.audio.byteLength,
        parsed.audio.updatedAt,
        parsed.metadataJson,
      );
      const insertChunk = this.#database.prepare(`
        INSERT INTO reader_audio_chunks(cache_key, chunk_order, metadata_json, audio)
        VALUES (?, ?, ?, ?)
      `);
      parsed.chunks.forEach(({ bytes, metadataJson }, order) => {
        insertChunk.run(parsed.audio.cacheKey, order, metadataJson, bytes);
      });
      this.#pruneAudio(parsed.audio.cacheKey);
    });
  }

  getAudio(documentIdValue: unknown, sectionIdValue: unknown): CachedReaderAudio | null {
    const documentId = requiredString(documentIdValue, "Reader audio documentId", 512);
    const sectionId = requiredString(sectionIdValue, "Reader audio sectionId", 512);
    return this.#transaction(() => {
      const audioRow = this.#database.prepare(`
        SELECT record_json
        FROM reader_audio
        WHERE document_id = ? AND section_id = ?
      `).get(documentId, sectionId) as AudioRow | undefined;
      if (!audioRow) return null;
      const cacheKey = JSON.stringify([documentId, sectionId]);
      const chunkRows = this.#database.prepare(`
        SELECT metadata_json, audio
        FROM reader_audio_chunks
        WHERE cache_key = ?
        ORDER BY chunk_order ASC
      `).all(cacheKey) as unknown as AudioChunkRow[];
      return decodeCachedAudio(audioRow, chunkRows);
    }, "DEFERRED");
  }

  deleteAudio(documentIdValue: unknown, sectionIdValue?: unknown): void {
    const documentId = requiredString(documentIdValue, "Reader audio documentId", 512);
    if (sectionIdValue === undefined) {
      this.#database.prepare("DELETE FROM reader_audio WHERE document_id = ?").run(documentId);
      return;
    }
    const sectionId = requiredString(sectionIdValue, "Reader audio sectionId", 512);
    this.#database
      .prepare("DELETE FROM reader_audio WHERE document_id = ? AND section_id = ?")
      .run(documentId, sectionId);
  }

  #pruneAudio(protectedCacheKey: string): void {
    const entries = this.#database.prepare(`
      SELECT cache_key, byte_length
      FROM reader_audio
      ORDER BY updated_at ASC
    `).all() as unknown as AudioPruneRow[];
    let totalBytes = entries.reduce((total, entry) => total + entry.byte_length, 0);
    let totalEntries = entries.length;
    const deleteAudio = this.#database.prepare("DELETE FROM reader_audio WHERE cache_key = ?");
    for (const entry of entries) {
      if (totalBytes <= MAX_AUDIO_CACHE_BYTES && totalEntries <= MAX_AUDIO_CACHE_ENTRIES) break;
      if (entry.cache_key === protectedCacheKey) continue;
      deleteAudio.run(entry.cache_key);
      totalBytes -= entry.byte_length;
      totalEntries -= 1;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}

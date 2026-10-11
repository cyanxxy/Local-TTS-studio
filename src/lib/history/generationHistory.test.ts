import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openVersionedDatabase, requestResult, transactionDone } from "../indexedDb";
import { decodeWav } from "../wavCodec";
import {
  GENERATION_HISTORY_DATABASE_NAME,
  GENERATION_HISTORY_MIGRATIONS,
  createGenerationHistoryStore,
  generationTitle,
  getGenerationHistoryStore,
  historyAudioToExportChunks,
  historyAudioToWavBlob,
  historyDownloadFileName,
  parseGenerationHistoryEntry,
  reusableSettingsFromEntry,
  selectHistoryEvictions,
  type GenerationAudioChunk,
  type GenerationHistoryStore,
  type NewGenerationEntry,
} from "./generationHistory";

function chunk(samples: number, samplingRate = 24000, overrides: Partial<GenerationAudioChunk> = {}): GenerationAudioChunk {
  const audio = new Float32Array(samples).fill(0.25);
  return { audio: audio.buffer, samplingRate, text: "Hello world.", index: 1, total: 1, textStart: 0, textEnd: 12, ...overrides };
}

function generation(overrides: Partial<NewGenerationEntry> = {}): NewGenerationEntry {
  return {
    text: "Hello world. This is a Studio generation.",
    engineId: "kokoro",
    voice: { engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1 } },
    settings: { speed: 1, quality: 5, pronunciationRules: [{ from: "TTS", to: "tee tee ess" }] },
    seed: 7,
    chunks: [chunk(2400), chunk(4800, 24000, { index: 2, total: 2 })],
    ...overrides,
  };
}

async function putRawEntry(record: unknown): Promise<void> {
  const database = await openVersionedDatabase({
    name: GENERATION_HISTORY_DATABASE_NAME,
    migrations: GENERATION_HISTORY_MIGRATIONS,
    blockedMessage: "blocked",
    unsupportedMessage: "unsupported",
  });
  const transaction = database.transaction(["entries"], "readwrite");
  transaction.objectStore("entries").put(record);
  await transactionDone(transaction);
  database.close();
}

describe("generation history store", () => {
  let clock: number;
  let ids: number;
  let store: GenerationHistoryStore;

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    clock = 1_000;
    ids = 0;
    store = createGenerationHistoryStore({ now: () => clock, createId: () => `gen-${++ids}` });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves a generation with metadata separate from its audio", async () => {
    const input = generation();
    const { entry, evictedIds } = await store.saveGeneration(input);
    expect(evictedIds).toEqual([]);
    expect(entry).toEqual({
      schemaVersion: 1,
      id: "gen-1",
      createdAt: 1000,
      lastAccessedAt: 1000,
      title: "Hello world. This is a Studio generation.",
      text: input.text,
      engineId: "kokoro",
      voice: { engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1 } },
      settings: { speed: 1, quality: 5, pronunciationRules: [{ from: "TTS", to: "tee tee ess" }] },
      seed: 7,
      durationSec: 0.3,
      sampleRate: 24000,
      byteLength: 7200 * 4,
      chunkCount: 2,
      favorite: false,
      completed: true,
    });
    expect(await store.listEntries()).toEqual([entry]);
    expect(await store.getEntry("gen-1")).toEqual(entry);
    expect(await store.getEntry("missing")).toBeNull();
  });

  it("copies audio so the player's live buffers are never shared or detached", async () => {
    const input = generation();
    await store.saveGeneration(input);
    new Float32Array(input.chunks[0].audio).fill(-1);
    const audio = await store.getAudio("gen-1");
    expect(audio).toHaveLength(2);
    expect(new Float32Array(audio![0].audio)[0]).toBe(0.25);
    expect(audio![1]).toMatchObject({ index: 2, total: 2, text: "Hello world.", textStart: 0, textEnd: 12 });
  });

  it("records stopped generations, retakes, custom titles and omitted seeds", async () => {
    const { entry } = await store.saveGeneration(generation({
      completed: false,
      parentId: "gen-0",
      title: "  My   take ",
      seed: undefined,
      settings: undefined,
    }));
    expect(entry).toMatchObject({ completed: false, parentId: "gen-0", title: "My take", settings: {} });
    expect(entry).not.toHaveProperty("seed");
  });

  it("lists newest first and replays mark entries as recently used", async () => {
    await store.saveGeneration(generation({ text: "First generation text" }));
    clock = 2_000;
    await store.saveGeneration(generation({ text: "Second generation text" }));
    expect((await store.listEntries()).map((entry) => entry.title)).toEqual(["Second generation text", "First generation text"]);
    clock = 3_000;
    await store.getAudio("gen-1");
    expect((await store.getEntry("gen-1"))?.lastAccessedAt).toBe(3000);
    expect(await store.getAudio("missing")).toBeNull();
  });

  it("evicts least recently used entries by count, keeping favorites and the new entry", async () => {
    const bounded = createGenerationHistoryStore({ databaseName: "bounded", now: () => clock, createId: () => `b-${++ids}`, maxEntries: 2 });
    const first = (await bounded.saveGeneration(generation())).entry;
    clock = 2_000;
    const second = (await bounded.saveGeneration(generation())).entry;
    await bounded.setFavorite(first.id, true);
    clock = 3_000;
    const third = await bounded.saveGeneration(generation());
    expect(third.evictedIds).toEqual([second.id]);
    expect((await bounded.listEntries()).map((entry) => entry.id)).toEqual([third.entry.id, first.id]);
    expect(await bounded.getAudio(second.id)).toBeNull();
  });

  it("evicts by total bytes and refuses single entries over the per-entry cap", async () => {
    const bounded = createGenerationHistoryStore({
      databaseName: "bytes",
      now: () => clock,
      createId: () => `b-${++ids}`,
      maxTotalBytes: 40_000,
      maxEntryBytes: 30_000,
    });
    const first = (await bounded.saveGeneration(generation())).entry;
    clock = 2_000;
    const second = await bounded.saveGeneration(generation());
    expect(second.evictedIds).toEqual([first.id]);
    await expect(bounded.saveGeneration(generation({ chunks: [chunk(8000)] }))).rejects.toThrow(/too large/);
    expect((await bounded.getUsage()).entryCount).toBe(1);
  });

  it("validates input", async () => {
    await expect(store.saveGeneration(generation({ text: "  " }))).rejects.toThrow(/needs its text/);
    await expect(store.saveGeneration(generation({ text: "x".repeat(200_001) }))).rejects.toThrow(/too long/);
    await expect(store.saveGeneration(generation({ engineId: "" }))).rejects.toThrow(/engine id/);
    await expect(store.saveGeneration(generation({ seed: -1 }))).rejects.toThrow(/Seeds/);
    await expect(store.saveGeneration(generation({ chunks: [] }))).rejects.toThrow(/needs audio/);
    await expect(store.saveGeneration(generation({ chunks: [chunk(10, 0)] }))).rejects.toThrow(/malformed/);
    await expect(store.saveGeneration(generation({ chunks: [{ ...chunk(10), audio: new ArrayBuffer(3) }] }))).rejects.toThrow(/malformed/);
    await expect(store.saveGeneration(generation({ voice: { engineId: "", voiceId: "a", settings: {} } }))).rejects.toThrow(/Engine id/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(store.saveGeneration(generation({ settings: circular }))).rejects.toThrow(/plain JSON/);
    await expect(store.saveGeneration(generation({ settings: { blob: "x".repeat(70_000) } }))).rejects.toThrow(/too large/);
    await expect(store.saveGeneration(generation({ settings: [] as unknown as Record<string, unknown> }))).rejects.toThrow(/object/);
    const many = Array.from({ length: 20_001 }, () => chunk(1));
    await expect(store.saveGeneration(generation({ chunks: many }))).rejects.toThrow(/too many chunks/);
    expect(await store.listEntries()).toEqual([]);
  });

  it("renames, favorites, deletes and clears", async () => {
    await store.saveGeneration(generation());
    await store.saveGeneration(generation());
    expect((await store.rename("gen-1", "  Final   cut ")).title).toBe("Final cut");
    await expect(store.rename("gen-1", " ")).rejects.toThrow(/title is required/);
    await expect(store.rename("missing", "x")).rejects.toThrow(/no longer in history/);
    expect((await store.setFavorite("gen-1", true)).favorite).toBe(true);
    expect(await store.getUsage()).toEqual({ entryCount: 2, totalBytes: 2 * 7200 * 4, favoriteCount: 1 });

    await store.clear({ keepFavorites: true });
    expect((await store.listEntries()).map((entry) => entry.id)).toEqual(["gen-1"]);
    expect(await store.getAudio("gen-1")).not.toBeNull();

    await store.saveGeneration(generation());
    await store.deleteEntry("gen-3");
    expect(await store.getAudio("gen-3")).toBeNull();
    await store.clear();
    expect(await store.listEntries()).toEqual([]);
  });

  it("skips damaged entries and treats missing audio as unavailable", async () => {
    await store.saveGeneration(generation());
    await putRawEntry({ id: "broken", schemaVersion: 1 });
    await putRawEntry({ id: "future", schemaVersion: 2 });
    expect((await store.listEntries()).map((entry) => entry.id)).toEqual(["gen-1"]);

    const database = await openVersionedDatabase({
      name: GENERATION_HISTORY_DATABASE_NAME,
      migrations: GENERATION_HISTORY_MIGRATIONS,
      blockedMessage: "blocked",
      unsupportedMessage: "unsupported",
    });
    const transaction = database.transaction(["audio"], "readwrite");
    await requestResult(transaction.objectStore("audio").put({ id: "gen-1", chunks: [{ audio: "not audio" }] }));
    await transactionDone(transaction);
    database.close();
    expect(await store.getAudio("gen-1")).toBeNull();
  });

  it("notifies subscribers and deletes the database", async () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.saveGeneration(generation());
    expect(listener).toHaveBeenCalledTimes(1);
    await store.destroy();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(await store.listEntries()).toEqual([]);
    unsubscribe();
  });

  it("exposes a shared default instance", () => {
    expect(getGenerationHistoryStore()).toBe(getGenerationHistoryStore());
  });
});

describe("generation history helpers", () => {
  it("builds short titles on word boundaries", () => {
    expect(generationTitle("  Hello\n\nworld  ")).toBe("Hello world");
    expect(generationTitle("   ")).toBe("Untitled generation");
    const long = "The quick brown fox jumps over the lazy dog and keeps running far away";
    expect(generationTitle(long, 30)).toBe("The quick brown fox jumps…");
    expect(generationTitle("x".repeat(40), 10)).toBe("xxxxxxxxx…");
  });

  it("selects LRU evictions without touching favorites or the kept entry", () => {
    const entries = [
      { id: "a", lastAccessedAt: 1, byteLength: 10, favorite: true },
      { id: "b", lastAccessedAt: 2, byteLength: 10, favorite: false },
      { id: "c", lastAccessedAt: 3, byteLength: 10, favorite: false },
      { id: "d", lastAccessedAt: 0, byteLength: 10, favorite: false },
    ];
    expect(selectHistoryEvictions(entries, { maxEntries: 2, maxTotalBytes: 100 }, "d")).toEqual(["b", "c"]);
    expect(selectHistoryEvictions(entries, { maxEntries: 10, maxTotalBytes: 25 })).toEqual(["d", "b"]);
    expect(selectHistoryEvictions(entries, { maxEntries: 0, maxTotalBytes: 0 }, "d")).toEqual(["b", "c"]);
  });

  it("returns settings to reuse", () => {
    const entry = parseGenerationHistoryEntry({
      schemaVersion: 1,
      id: "g",
      createdAt: 1,
      lastAccessedAt: 1,
      title: "t",
      text: "Text",
      engineId: "qwen3",
      voice: { engineId: "qwen3", voiceId: "Aiden", settings: { seed: 3 } },
      settings: { temperature: 0.9 },
      seed: 3,
      durationSec: 1,
      sampleRate: 24000,
      byteLength: 4,
      chunkCount: 1,
      favorite: false,
      completed: true,
    });
    expect(entry && reusableSettingsFromEntry(entry)).toEqual({
      text: "Text",
      engineId: "qwen3",
      voice: { engineId: "qwen3", voiceId: "Aiden", settings: { seed: 3 } },
      settings: { temperature: 0.9 },
      seed: 3,
    });
    expect(reusableSettingsFromEntry({ ...entry!, seed: undefined })).not.toHaveProperty("seed");
    expect(parseGenerationHistoryEntry({ ...entry, voice: { engineId: "qwen3" } })).toBeNull();
    expect(parseGenerationHistoryEntry({ ...entry, seed: 1.5 })).toBeNull();
    expect(parseGenerationHistoryEntry(null)).toBeNull();
  });

  it("converts audio for export and WAV download, resampling mixed rates", async () => {
    const chunks = [chunk(2400, 24000), chunk(4410, 44100)];
    const exportChunks = historyAudioToExportChunks(chunks);
    expect(exportChunks.map((item) => [item.audio.length, item.samplingRate])).toEqual([[2400, 24000], [4410, 44100]]);
    const decoded = decodeWav(await historyAudioToWavBlob(chunks).arrayBuffer());
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.bitsPerSample).toBe(16);
    expect(decoded.channels[0]).toHaveLength(4800);
    expect(decodeWav(await historyAudioToWavBlob(chunks, "float32").arrayBuffer()).formatCode).toBe(3);
    expect(() => historyAudioToWavBlob([])).toThrow(/no audio/);
  });

  it("names downloads with a timestamp and a slug", () => {
    const createdAt = new Date(2026, 9, 11, 14, 5).getTime();
    expect(historyDownloadFileName({ createdAt, title: "Café: the first words!" }, "wav"))
      .toBe("open-tts-2026-10-11-1405-cafe-the-first-words.wav");
    expect(historyDownloadFileName({ createdAt, title: "日本語" }, ".mp3")).toBe("open-tts-2026-10-11-1405.mp3");
  });
});

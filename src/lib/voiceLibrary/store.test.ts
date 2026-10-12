import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openVersionedDatabase, requestResult, transactionDone } from "../indexedDb";
import { decodeWav, encodeWavPcm16 } from "../wavCodec";
import { MAX_VOICE_PACKAGE_BYTES, parseVoicePackage, voicePackageFileName } from "./portable";
import { fnv1a64Hex, previewCacheKey, stableStringify } from "./previewKey";
import {
  VOICE_LIBRARY_DATABASE_NAME,
  VOICE_LIBRARY_MIGRATIONS,
  createVoiceLibraryStore,
  getVoiceLibraryStore,
  voicePresetFromRecord,
  type VoiceLibraryStore,
} from "./store";
import type { NewClonedVoice, NewDesignedVoice, NewPresetVoice } from "./types";

function tone(seconds: number, sampleRate = 24000): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, index) => 0.3 * Math.sin(index / 7));
}

function wav(seconds: number, sampleRate = 24000): Uint8Array {
  return encodeWavPcm16(tone(seconds, sampleRate), sampleRate);
}

const PRESET: NewPresetVoice = {
  kind: "preset",
  name: "Heart, brisk",
  tags: ["English"],
  preset: { engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1.1 } },
};

function cloned(overrides: Partial<NewClonedVoice> = {}): NewClonedVoice {
  return {
    kind: "cloned",
    name: "My voice",
    transcript: "This is exactly what I said in the clip.",
    language: "English",
    targets: ["qwen3-base", "neutts"],
    source: "recording",
    referenceWav: wav(4),
    ...overrides,
  };
}

const DESIGNED: NewDesignedVoice = {
  kind: "designed",
  name: "Gravel",
  design: { description: "A low, gravelly storyteller", seed: 42, language: "English", previewText: "Once upon a time." },
  sampleWav: wav(2),
};

async function putRaw(record: unknown): Promise<void> {
  const database = await openVersionedDatabase({
    name: VOICE_LIBRARY_DATABASE_NAME,
    migrations: VOICE_LIBRARY_MIGRATIONS,
    blockedMessage: "blocked",
    unsupportedMessage: "unsupported",
  });
  const transaction = database.transaction("voices", "readwrite");
  transaction.objectStore("voices").put(record);
  await transactionDone(transaction);
  database.close();
}

describe("voice library store", () => {
  let clock: number;
  let ids: number;
  let store: VoiceLibraryStore;

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    clock = 1_000;
    ids = 0;
    store = createVoiceLibraryStore({
      now: () => clock,
      createId: () => `voice-${++ids}`,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates, lists, updates and deletes preset voices", async () => {
    const created = await store.createVoice(PRESET);
    expect(created).toMatchObject({
      schemaVersion: 1,
      id: "voice-1",
      kind: "preset",
      name: "Heart, brisk",
      description: "",
      tags: ["English"],
      favorite: false,
      createdAt: 1000,
      updatedAt: 1000,
    });
    clock = 2_000;
    await store.createVoice({ ...PRESET, name: "Second" });
    expect((await store.listVoices()).map((voice) => voice.name)).toEqual(["Second", "Heart, brisk"]);

    clock = 3_000;
    const updated = await store.updateVoice("voice-1", {
      name: "Heart",
      description: "Default narrator",
      tags: ["english", "narration"],
      preset: { engineId: "kokoro", voiceId: "af_bella", settings: {} },
      transcript: "ignored for presets",
    });
    expect(updated).toMatchObject({ name: "Heart", updatedAt: 3000, preset: { voiceId: "af_bella" } });
    expect(updated).not.toHaveProperty("transcript");
    expect((await store.listVoices())[0].id).toBe("voice-1");

    await store.deleteVoice("voice-1");
    expect(await store.getVoice("voice-1")).toBeNull();
    expect(await store.listVoices()).toHaveLength(1);
  });

  it("stores cloned voices with reference audio metadata and bytes", async () => {
    const input = cloned();
    const voice = await store.createVoice(input);
    if (voice.kind !== "cloned") throw new Error("expected a cloned voice");
    expect(voice.reference).toMatchObject({ sampleRate: 24000, durationSec: 4, byteLength: input.referenceWav.byteLength });
    expect(voice.reference.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(voice.targets).toEqual(["qwen3-base", "neutts"]);
    const bytes = await store.getVoiceAudio(voice.id, "reference");
    expect(bytes && Array.from(bytes)).toEqual(Array.from(input.referenceWav));
    expect(await store.getVoiceAudio(voice.id, "sample")).toBeNull();

    const edited = await store.updateVoice(voice.id, { transcript: "Fixed transcript.", targets: ["neutts"], language: "German" });
    expect(edited).toMatchObject({ transcript: "Fixed transcript.", targets: ["neutts"], language: "German" });

    await store.deleteVoice(voice.id);
    expect(await store.getVoiceAudio(voice.id, "reference")).toBeNull();
  });

  it("refuses references the bridge would reject", async () => {
    await expect(store.createVoice(cloned({ referenceWav: wav(21) }))).rejects.toThrow(/20 seconds/);
    await expect(store.createVoice(cloned({ referenceWav: new Uint8Array(0) }))).rejects.toThrow(/non-empty WAV/);
    await expect(store.createVoice(cloned({ referenceWav: new Uint8Array(64) }))).rejects.toThrow(/RIFF/);
    await expect(store.createVoice(cloned({ referenceWav: new Uint8Array(45_000_001) }))).rejects.toThrow(/45,000,000/);
    await expect(store.createVoice(cloned({ targets: [] }))).rejects.toThrow(/Clone targets/);
    await expect(store.createVoice({ ...PRESET, kind: "robot" } as unknown as NewPresetVoice)).rejects.toThrow(/Unknown voice kind/);
    expect(await store.listVoices()).toEqual([]);
  });

  it("stores designed voices with and without a sample", async () => {
    const designed = await store.createVoice(DESIGNED);
    expect(designed).toMatchObject({ kind: "designed", sample: { durationSec: 2 } });
    expect(await store.getVoiceAudio(designed.id, "sample")).not.toBeNull();
    const bare = await store.createVoice({ ...DESIGNED, sampleWav: undefined, name: "Bare" });
    expect(bare).not.toHaveProperty("sample");
  });

  it("toggles favorites and rejects edits to missing voices", async () => {
    const voice = await store.createVoice(PRESET);
    expect((await store.setFavorite(voice.id, true)).favorite).toBe(true);
    expect((await store.setFavorite(voice.id, false)).favorite).toBe(false);
    await expect(store.setFavorite("missing", true)).rejects.toThrow(/no longer exists/);
    await expect(store.updateVoice(voice.id, { name: "" })).rejects.toThrow(/required/);
    expect((await store.getVoice(voice.id))?.name).toBe("Heart, brisk");
  });

  it("enforces voice-count and audio-size limits", async () => {
    const small = createVoiceLibraryStore({ createId: () => `v-${++ids}`, maxVoices: 1 });
    await small.createVoice(PRESET);
    await expect(small.createVoice(PRESET)).rejects.toThrow(/at most 1 voices/);

    const tight = createVoiceLibraryStore({ databaseName: "tight", createId: () => `t-${++ids}`, maxTotalAudioBytes: 300_000 });
    await tight.createVoice(cloned());
    await expect(tight.createVoice(cloned())).rejects.toThrow(/out of space/);
    expect((await tight.getUsage()).voiceCount).toBe(1);

    const fixedId = createVoiceLibraryStore({ databaseName: "fixed", createId: () => "same" });
    await fixedId.createVoice(PRESET);
    await expect(fixedId.createVoice(PRESET)).rejects.toThrow(/already exists/);
  });

  it("explains a library upgraded by a newer build", async () => {
    (await openVersionedDatabase({
      name: VOICE_LIBRARY_DATABASE_NAME,
      migrations: [...VOICE_LIBRARY_MIGRATIONS, { version: 99, migrate: () => {} }],
      blockedMessage: "blocked",
      unsupportedMessage: "unsupported",
    })).close();
    await expect(store.listVoices()).rejects.toThrow("The voice library was saved by a newer version of Open TTS. Update Open TTS to use it.");
  });

  it("saves several voices atomically with linked caller-chosen ids", async () => {
    const [designed, clone] = await store.createVoices([
      { ...DESIGNED, id: "design-1" },
      cloned({ designedFromId: "design-1" }),
    ]);
    expect(designed.id).toBe("design-1");
    expect(clone).toMatchObject({ id: "voice-1", designedFromId: "design-1" });
    expect(await store.createVoices([])).toEqual([]);

    // Count, space, id and validation failures write nothing at all.
    const small = createVoiceLibraryStore({ databaseName: "small", createId: () => `s-${++ids}`, maxVoices: 2 });
    const kept = await small.createVoice(PRESET);
    await expect(small.createVoices([PRESET, PRESET])).rejects.toThrow(/at most 2 voices/);
    const tight = createVoiceLibraryStore({ databaseName: "tight-batch", createId: () => `b-${++ids}`, maxTotalAudioBytes: 300_000 });
    await expect(tight.createVoices([cloned(), cloned()])).rejects.toThrow(/out of space/);
    await expect(store.createVoices([{ ...PRESET, id: "design-1" }])).rejects.toThrow(/already exists/);
    await expect(store.createVoices([{ ...PRESET, id: "x" }, { ...PRESET, id: "x" }])).rejects.toThrow(/different ids/);
    await expect(store.createVoices([PRESET, { ...PRESET, id: "bad id!" }])).rejects.toThrow(/Voice ids must be/);
    expect((await small.listVoices()).map((voice) => voice.id)).toEqual([kept.id]);
    expect(await tight.listVoices()).toEqual([]);
    expect(await store.listVoices()).toHaveLength(2);
  });

  it("skips damaged records and leaves newer-schema records untouched", async () => {
    await store.createVoice(PRESET);
    await putRaw({ id: "broken", schemaVersion: 1, kind: "preset" });
    const future = { id: "future", schemaVersion: 2, kind: "hologram", name: "From the future", createdAt: 1, updatedAt: 1 };
    await putRaw(future);
    expect((await store.listVoices()).map((voice) => voice.id)).toEqual(["voice-1"]);
    await expect(store.updateVoice("future", { name: "Overwrite" })).rejects.toThrow(/newer version/);
    expect((await store.getUsage()).voiceCount).toBe(1);
  });

  it("caches previews with LRU eviction by count and bytes", async () => {
    const lru = createVoiceLibraryStore({ now: () => clock, previewCache: { maxEntries: 2, maxBytes: 1_000_000 } });
    const audio = { samples: tone(0.5), sampleRate: 24000 };
    clock = 1;
    await lru.putPreview("voice-a", "k1", audio);
    clock = 2;
    await lru.putPreview("voice-a", "k2", audio);
    clock = 3;
    // Reading k1 makes k2 the least recently used.
    const hit = await lru.getPreview("voice-a", "k1");
    expect(hit).toMatchObject({ ownerId: "voice-a", previewKey: "k1", sampleRate: 24000, durationSec: 0.5 });
    expect(decodeWav(hit!.wav).channels[0]).toHaveLength(12000);
    clock = 4;
    await lru.putPreview("voice-b", "k3", audio);
    expect(await lru.getPreview("voice-a", "k2")).toBeNull();
    expect(await lru.getPreview("voice-a", "k1")).not.toBeNull();
    expect((await lru.getUsage()).previewCount).toBe(2);

    const bytesBound = createVoiceLibraryStore({ databaseName: "bytes", previewCache: { maxEntries: 10, maxBytes: 30_000 } });
    await bytesBound.putPreview("a", "1", audio);
    await bytesBound.putPreview("a", "2", audio);
    expect((await bytesBound.getUsage()).previewCount).toBe(1);
    await expect(bytesBound.putPreview("a", "3", { samples: tone(1), sampleRate: 24000 })).rejects.toThrow(/too long/);
    await expect(bytesBound.putPreview("", "3", audio)).rejects.toThrow(/keys/);
    await expect(bytesBound.putPreview("a", "3", { samples: new Float32Array(0), sampleRate: 24000 })).rejects.toThrow(/empty/);
  });

  it("clears previews per owner, all at once, and with their voice", async () => {
    const voice = await store.createVoice(PRESET);
    const audio = { samples: tone(0.1), sampleRate: 24000 };
    await store.putPreview(voice.id, "a", audio);
    await store.putPreview("builtin:kokoro:af_bella", "a", audio);
    await store.putPreview("builtin:kokoro:am_adam", "a", audio);
    await store.clearPreviews("builtin:kokoro:af_bella");
    expect(await store.getPreview("builtin:kokoro:af_bella", "a")).toBeNull();
    await store.deleteVoice(voice.id);
    expect(await store.getPreview(voice.id, "a")).toBeNull();
    expect(await store.getPreview("builtin:kokoro:am_adam", "a")).not.toBeNull();
    await store.clearPreviews();
    expect((await store.getUsage()).previewCount).toBe(0);
  });

  it("reports usage", async () => {
    await store.createVoice(PRESET);
    const voice = await store.createVoice(cloned());
    await store.putPreview(voice.id, "p", { samples: tone(0.1), sampleRate: 24000 });
    const usage = await store.getUsage();
    expect(usage.voiceCount).toBe(2);
    expect(usage.audioBytes).toBe(cloned().referenceWav.byteLength);
    expect(usage.previewCount).toBe(1);
    expect(usage.previewBytes).toBe(44 + 2400 * 2);
  });

  it("notifies subscribers after changes and across store instances", async () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.createVoice(PRESET);
    expect(listener).toHaveBeenCalledTimes(1);

    const throwing = vi.fn(() => {
      throw new Error("subscriber bug");
    });
    const unsubscribeThrowing = store.subscribe(throwing);
    await store.setFavorite("voice-1", true);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribeThrowing();

    const other = createVoiceLibraryStore({ createId: () => "other-1" });
    await other.createVoice(PRESET);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(3));

    unsubscribe();
    await store.deleteVoice("voice-1");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("deletes the whole database", async () => {
    await store.createVoice(PRESET);
    await store.destroy();
    expect(await store.listVoices()).toEqual([]);
  });

  it("exposes a shared default instance", () => {
    expect(getVoiceLibraryStore()).toBe(getVoiceLibraryStore());
  });
});

describe("portable voice files", () => {
  let store: VoiceLibraryStore;
  let ids = 0;

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    store = createVoiceLibraryStore({ createId: () => `voice-${++ids}`, now: () => Date.UTC(2026, 9, 11) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips every voice kind through a zip", async () => {
    for (const input of [PRESET, cloned({ favorite: true, description: "Recorded at home" }), DESIGNED]) {
      const original = await store.createVoice(input);
      const exported = await store.exportVoice(original.id);
      expect(exported.fileName).toBe(`${original.name}.voice.zip`);
      const imported = await store.importVoice(exported.bytes);
      expect(imported.id).not.toBe(original.id);
      // Favorites are a local preference and do not travel.
      expect(imported.favorite).toBe(false);
      const strip = (record: typeof original) => {
        const copy: Record<string, unknown> = { ...record };
        for (const key of ["id", "favorite", "createdAt", "updatedAt"]) delete copy[key];
        return copy;
      };
      expect(strip(imported)).toEqual(strip(original));
      if (original.kind === "cloned") {
        expect(await store.getVoiceAudio(imported.id, "reference")).toEqual(await store.getVoiceAudio(original.id, "reference"));
      }
    }
  });

  it("writes a readable manifest", async () => {
    const original = await store.createVoice(cloned());
    const { bytes } = await store.exportVoice(original.id);
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(["reference.wav", "voice.json"]);
    const manifest = JSON.parse(strFromU8(files["voice.json"]));
    expect(manifest).toMatchObject({
      format: "open-tts-voice",
      version: 1,
      exportedAt: "2026-10-11T00:00:00.000Z",
      voice: { kind: "cloned", name: "My voice", targets: ["qwen3-base", "neutts"] },
    });
    expect(manifest.voice).not.toHaveProperty("id");
  });

  it("rejects damaged, foreign, newer and oversized files", async () => {
    const digest = async () => "0".repeat(64);
    const manifest = (voice: unknown, extra: Record<string, unknown> = {}) =>
      strToU8(JSON.stringify({ format: "open-tts-voice", version: 1, voice, ...extra }));

    await expect(parseVoicePackage(new Uint8Array([1, 2, 3]), digest)).rejects.toThrow(/zip archive/);
    await expect(parseVoicePackage(zipSync({ "other.txt": strToU8("x") }), digest)).rejects.toThrow(/no voice.json/);
    await expect(parseVoicePackage(zipSync({ "voice.json": strToU8("{") }), digest)).rejects.toThrow(/not valid JSON/);
    await expect(parseVoicePackage(zipSync({ "voice.json": strToU8('{"format":"x"}') }), digest)).rejects.toThrow(/not an Open TTS/);
    await expect(parseVoicePackage(zipSync({ "voice.json": manifest({}, { version: 2 }) }), digest)).rejects.toThrow(/newer version/);
    await expect(parseVoicePackage(zipSync({ "voice.json": manifest(null) }), digest)).rejects.toThrow(/has no voice/);
    await expect(parseVoicePackage(zipSync({ "voice.json": manifest({ kind: "robot" }) }), digest)).rejects.toThrow(/unknown voice kind/);
    await expect(parseVoicePackage(zipSync({ "voice.json": manifest({ kind: "cloned", reference: {} }) }), digest))
      .rejects.toThrow(/missing reference.wav/);

    const audio = wav(1);
    const reference = { sampleRate: 24000, durationSec: 1, byteLength: audio.byteLength, sha256: "1".repeat(64) };
    await expect(parseVoicePackage(zipSync({
      "voice.json": manifest({ kind: "cloned", reference }),
      "reference.wav": audio,
    }), digest)).rejects.toThrow(/does not match/);
    await expect(parseVoicePackage(zipSync({
      "voice.json": manifest({ kind: "designed", design: {}, sample: reference }),
    }), digest)).rejects.toThrow(/missing sample.wav/);

    const oversizedManifest = zipSync({ "voice.json": [new Uint8Array(70 * 1024), { level: 0 }] });
    await expect(parseVoicePackage(oversizedManifest, digest)).rejects.toThrow(/no voice.json/);
    await expect(parseVoicePackage(new Uint8Array(MAX_VOICE_PACKAGE_BYTES + 1), digest)).rejects.toThrow(/too large/);

    // Field validation still applies when an imported voice is saved.
    const bad = zipSync({ "voice.json": manifest({ kind: "preset", name: "", preset: { engineId: "kokoro", voiceId: "a" } }) });
    await expect(store.importVoice(bad)).rejects.toThrow(/Voice name is required/);
  });

  it("re-checks stored entries whose declared size understates the data", async () => {
    const zipped = zipSync({ "voice.json": [new Uint8Array(70 * 1024).fill(32), { level: 0 }] });
    // Patch the declared uncompressed size in the central directory to 1 byte.
    const view = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
    for (let offset = zipped.byteLength - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        view.setUint32(offset + 24, 1, true);
        break;
      }
    }
    await expect(parseVoicePackage(zipped, async () => "")).rejects.toThrow(/too large/);
  });

  it("refuses to export a voice whose audio is gone", async () => {
    const voice = await store.createVoice(cloned());
    const database = await openVersionedDatabase({
      name: VOICE_LIBRARY_DATABASE_NAME,
      migrations: VOICE_LIBRARY_MIGRATIONS,
      blockedMessage: "blocked",
      unsupportedMessage: "unsupported",
    });
    const transaction = database.transaction("voice-audio", "readwrite");
    await requestResult(transaction.objectStore("voice-audio").clear());
    await transactionDone(transaction);
    database.close();
    await expect(store.exportVoice(voice.id)).rejects.toThrow(/audio is missing/);
    await expect(store.exportVoice("missing")).rejects.toThrow(/no longer exists/);
  });

  it("builds file-system-safe names", () => {
    expect(voicePackageFileName('My: "best" voice?')).toBe("My best voice.voice.zip");
    expect(voicePackageFileName("...")).toBe("voice.voice.zip");
  });
});

describe("voice presets from records", () => {
  const base = { schemaVersion: 1 as const, id: "v1", name: "Voice", description: "", tags: [], favorite: false, createdAt: 1, updatedAt: 1 };
  const audio = { sampleRate: 24000, durationSec: 4, byteLength: 10, sha256: "a".repeat(64) };

  it("maps each kind onto the engine that renders it", () => {
    expect(voicePresetFromRecord({ ...base, kind: "preset", preset: { engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1 } } }))
      .toEqual({ engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1 }, mode: "preset", libraryVoiceId: "v1", label: "Voice" });
    const clone = { ...base, kind: "cloned" as const, transcript: "Hi.", language: "English", targets: ["qwen3-base" as const, "neutts" as const], source: "upload" as const, reference: audio };
    expect(voicePresetFromRecord(clone)).toMatchObject({ engineId: "qwen3", mode: "voiceClone", voiceId: "library:v1", settings: { language: "English" } });
    expect(voicePresetFromRecord(clone, { cloneTarget: "neutts" }).engineId).toBe("neutts");
    expect(voicePresetFromRecord({ ...clone, targets: ["qwen3-base"] }, { cloneTarget: "neutts" }).engineId).toBe("qwen3");
    expect(voicePresetFromRecord({
      ...base,
      kind: "designed",
      design: { description: "Calm", seed: 9, language: "English", previewText: "Hi." },
    })).toMatchObject({ engineId: "qwen3", mode: "voiceDesign", settings: { instruction: "Calm", seed: 9, language: "English" } });
  });
});

describe("preview cache keys", () => {
  it("serializes deterministically and ignores display labels", () => {
    expect(stableStringify({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(stableStringify(undefined)).toBe("null");
    const preset = { engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1, seed: 2 } };
    const reordered = { voiceId: "af_heart", settings: { seed: 2, speed: 1 }, engineId: "kokoro", label: "Heart" };
    expect(previewCacheKey(preset, "Hello")).toBe(previewCacheKey(reordered, "Hello"));
    expect(previewCacheKey(preset, "Hello")).not.toBe(previewCacheKey(preset, "Hello!"));
    expect(previewCacheKey(preset, "Hello")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("matches the published FNV-1a 64 vectors", () => {
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
    expect(fnv1a64Hex("a")).toBe("af63dc4c8601ec8c");
  });
});

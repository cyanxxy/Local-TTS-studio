import { act, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceLibraryStore, type VoiceLibraryStore } from "../lib/voiceLibrary/store";
import type { VoiceRecord } from "../lib/voiceLibrary/types";
import { encodeWavPcm16 } from "../lib/wavCodec";
import { filterVoices, useVoiceLibrary } from "./useVoiceLibrary";

const base = { schemaVersion: 1 as const, description: "", favorite: false, createdAt: 1 };
const audio = { sampleRate: 24000, durationSec: 4, byteLength: 10, sha256: "a".repeat(64) };
const RECORDS: VoiceRecord[] = [
  { ...base, id: "p1", name: "Heart", tags: ["Warm"], updatedAt: 5, kind: "preset", preset: { engineId: "kokoro", voiceId: "af_heart", settings: {} } },
  { ...base, id: "p2", name: "Aiden", tags: [], updatedAt: 4, favorite: true, kind: "preset", preset: { engineId: "qwen3", voiceId: "Aiden", settings: {} } },
  { ...base, id: "c1", name: "Me", tags: ["warm", "mine"], updatedAt: 3, kind: "cloned", transcript: "Quick brown fox", language: "English", targets: ["neutts"], source: "recording", reference: audio },
  { ...base, id: "c2", name: "Me too", tags: [], updatedAt: 2, kind: "cloned", transcript: "Hi", language: "English", targets: ["qwen3-base"], source: "upload", reference: audio },
  { ...base, id: "d1", name: "Gravel", tags: [], updatedAt: 1, kind: "designed", design: { description: "Gravelly pirate", seed: 1, language: "English", previewText: "Arr." } },
];

describe("filterVoices", () => {
  it("orders favorites first, then by recency", () => {
    expect(filterVoices(RECORDS).map((record) => record.id)).toEqual(["p2", "p1", "c1", "c2", "d1"]);
  });

  it("filters by kind, favorites, tags, engine and query", () => {
    const ids = (filter: Parameters<typeof filterVoices>[1]) => filterVoices(RECORDS, filter).map((record) => record.id);
    expect(ids({ kind: "cloned" })).toEqual(["c1", "c2"]);
    expect(ids({ favoritesOnly: true })).toEqual(["p2"]);
    expect(ids({ tags: ["WARM"] })).toEqual(["p1", "c1"]);
    expect(ids({ tags: ["warm", "mine"] })).toEqual(["c1"]);
    expect(ids({ engineId: "qwen3" })).toEqual(["p2", "c2", "d1"]);
    expect(ids({ engineId: "neutts" })).toEqual(["c1"]);
    expect(ids({ engineId: "kokoro" })).toEqual(["p1"]);
    expect(ids({ query: " brown " })).toEqual(["c1"]);
    expect(ids({ query: "pirate" })).toEqual(["d1"]);
    expect(ids({ query: "heart" })).toEqual(["p1"]);
  });
});

describe("useVoiceLibrary", () => {
  let store: VoiceLibraryStore;

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    let ids = 0;
    store = createVoiceLibraryStore({ createId: () => `voice-${++ids}` });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads voices and reloads after mutations", async () => {
    await store.createVoice({ kind: "preset", name: "Existing", preset: { engineId: "kokoro", voiceId: "af_heart", settings: {} } });
    const { result } = renderHook(() => useVoiceLibrary(store));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.voices.map((voice) => voice.name)).toEqual(["Existing"]);
    expect(result.current.store).toBe(store);

    await act(async () => {
      await result.current.createVoice({
        kind: "cloned",
        name: "Recorded",
        transcript: "Hello there.",
        targets: ["neutts"],
        referenceWav: encodeWavPcm16(new Float32Array(24000).fill(0.1), 24000),
      });
    });
    await waitFor(() => expect(result.current.voices).toHaveLength(2));

    await act(async () => {
      await result.current.setFavorite("voice-1", true);
      await result.current.updateVoice("voice-2", { name: "Renamed" });
    });
    await waitFor(() => expect(result.current.voices.find((voice) => voice.id === "voice-2")?.name).toBe("Renamed"));
    expect(result.current.voices.find((voice) => voice.id === "voice-1")?.favorite).toBe(true);

    let exported: { fileName: string; bytes: Uint8Array } | undefined;
    await act(async () => {
      exported = await result.current.exportVoice("voice-2");
      await result.current.importVoice(exported.bytes);
    });
    expect(exported?.fileName).toBe("Renamed.voice.zip");
    await waitFor(() => expect(result.current.voices).toHaveLength(3));

    await act(async () => {
      await result.current.deleteVoice("voice-1");
    });
    await waitFor(() => expect(result.current.voices).toHaveLength(2));

    await act(async () => {
      await result.current.createVoices([
        { kind: "preset", name: "Batch A", preset: { engineId: "kokoro", voiceId: "af_bella", settings: {} } },
        { kind: "preset", name: "Batch B", preset: { engineId: "kokoro", voiceId: "am_adam", settings: {} } },
      ]);
    });
    await waitFor(() => expect(result.current.voices).toHaveLength(4));
  });

  it("reports load failures and recovers on refresh", async () => {
    const listVoices = vi.spyOn(store, "listVoices").mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useVoiceLibrary(store));
    await waitFor(() => expect(result.current.error).toBe("disk full"));
    expect(result.current.loading).toBe(false);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    listVoices.mockRejectedValueOnce("plain failure");
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe("plain failure");
  });

  it("ignores stale reloads and unsubscribes on unmount", async () => {
    let resolveFirst: (records: VoiceRecord[]) => void = () => {};
    const listVoices = vi.spyOn(store, "listVoices")
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([RECORDS[0]]);
    const unsubscribe = vi.fn();
    vi.spyOn(store, "subscribe").mockReturnValue(unsubscribe);
    const { result, unmount } = renderHook(() => useVoiceLibrary(store));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.voices.map((voice) => voice.id)).toEqual(["p1"]);
    await act(async () => {
      resolveFirst(RECORDS);
    });
    expect(result.current.voices.map((voice) => voice.id)).toEqual(["p1"]);
    expect(listVoices).toHaveBeenCalledTimes(2);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

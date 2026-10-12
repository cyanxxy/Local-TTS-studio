import { act, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerationHistoryStore, type GenerationHistoryStore } from "../lib/history/generationHistory";
import { useGenerationHistory } from "./useGenerationHistory";

const INPUT = {
  text: "A Studio generation worth keeping.",
  engineId: "supertonic3",
  voice: { engineId: "supertonic3", voiceId: "F1", settings: { language: "en" } },
  settings: { speed: 1.05 },
  chunks: [{ audio: new Float32Array(441).buffer, samplingRate: 44100, text: "A Studio generation worth keeping.", index: 1, total: 1 }],
};

describe("useGenerationHistory", () => {
  let store: GenerationHistoryStore;

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    let ids = 0;
    store = createGenerationHistoryStore({ createId: () => `gen-${++ids}` });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves, replays, reuses, renames, favorites, deletes and clears", async () => {
    const { result } = renderHook(() => useGenerationHistory(store));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toEqual([]);
    expect(result.current.store).toBe(store);

    await act(async () => {
      await result.current.saveGeneration(INPUT);
      await result.current.saveGeneration({ ...INPUT, text: "A second take of the script." });
    });
    await waitFor(() => expect(result.current.entries).toHaveLength(2));

    const audio = await result.current.loadAudio("gen-1");
    expect(audio?.[0].samplingRate).toBe(44100);
    expect(await result.current.reuseSettings("gen-1")).toEqual({
      text: INPUT.text,
      engineId: "supertonic3",
      voice: INPUT.voice,
      settings: { speed: 1.05 },
    });
    expect(await result.current.reuseSettings("missing")).toBeNull();

    await act(async () => {
      await result.current.rename("gen-1", "Keeper");
      await result.current.setFavorite("gen-1", true);
    });
    await waitFor(() => expect(result.current.entries.find((entry) => entry.id === "gen-1")).toMatchObject({ title: "Keeper", favorite: true }));

    await act(async () => {
      await result.current.clear({ keepFavorites: true });
    });
    await waitFor(() => expect(result.current.entries.map((entry) => entry.id)).toEqual(["gen-1"]));

    await act(async () => {
      await result.current.deleteEntry("gen-1");
    });
    await waitFor(() => expect(result.current.entries).toEqual([]));

    await act(async () => {
      await result.current.saveGeneration(INPUT);
      await result.current.clear();
    });
    await waitFor(() => expect(result.current.entries).toEqual([]));
  });

  it("surfaces read failures", async () => {
    vi.spyOn(store, "listEntries").mockRejectedValue(new Error("quota exceeded"));
    const { result } = renderHook(() => useGenerationHistory(store));
    await waitFor(() => expect(result.current.error).toBe("quota exceeded"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe("quota exceeded");
  });
});

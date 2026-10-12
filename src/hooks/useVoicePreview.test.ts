import { act, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresetSynthesize } from "../lib/presetSynthesis";
import type { CatalogVoice } from "../lib/voiceLibrary/catalog";
import { createVoiceLibraryStore, type VoiceLibraryStore } from "../lib/voiceLibrary/store";
import type { AuditionAudio } from "./useAudition";
import { previewOwnerId, useVoicePreview } from "./useVoicePreview";

class FakeAudio implements AuditionAudio {
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event | string) => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
}

const voice: CatalogVoice = {
  key: "engine:kokoro:af_heart",
  origin: "engine",
  engineId: "kokoro",
  engineLabel: "Kokoro",
  voiceId: "af_heart",
  name: "Heart",
  detail: "",
  group: null,
  language: "English",
  gender: "female",
  favorite: false,
  record: null,
  preset: { engineId: "kokoro", voiceId: "af_heart", mode: "preset", settings: {} },
};

function rendering(synthesize: PresetSynthesize, store: VoiceLibraryStore) {
  const audios: FakeAudio[] = [];
  return {
    audios,
    ...renderHook(() => useVoicePreview(synthesize, store, () => { const audio = new FakeAudio(); audios.push(audio); return audio; })),
  };
}

describe("useVoicePreview", () => {
  let store: VoiceLibraryStore;
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    store = createVoiceLibraryStore();
  });
  afterEach(async () => {
    await store.destroy();
    vi.unstubAllGlobals();
  });

  it("renders once, caches the sample, and replays from the cache", async () => {
    const synthesize = vi.fn<PresetSynthesize>(async function* () {
      yield { audio: new Float32Array(2400).fill(0.2), samplingRate: 24000 };
    });
    const { result, audios } = rendering(synthesize, store);

    await act(() => result.current.preview(voice, "Hello."));
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0][0]).toBe("Hello.");
    expect(result.current.state).toMatchObject({ key: voice.key, status: "playing", cached: false });
    expect(audios).toHaveLength(1);
    expect((await store.getUsage()).previewCount).toBe(1);

    await act(() => result.current.preview(voice, "Hello."));
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ status: "playing", cached: true });

    await act(() => result.current.preview(voice, "A different line."));
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it("renders again when the engine's settings change, even for the same preset and text", async () => {
    const synthesize = vi.fn<PresetSynthesize>(async function* () {
      yield { audio: new Float32Array(2400).fill(0.2), samplingRate: 24000 };
    });
    let key = "speed-1";
    const audios: FakeAudio[] = [];
    const { result } = renderHook(() => useVoicePreview(synthesize, store, () => { const a = new FakeAudio(); audios.push(a); return a; }, async () => key));
    await act(() => result.current.preview(voice, "Hello."));
    await act(() => result.current.preview(voice, "Hello."));
    expect(synthesize).toHaveBeenCalledTimes(1);
    key = "speed-1.4";
    await act(() => result.current.preview(voice, "Hello."));
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it("reports a failed render without caching it", async () => {
    const synthesize = vi.fn<PresetSynthesize>(async function* () {
      throw new Error("Model missing");
      yield { audio: new Float32Array(1), samplingRate: 24000 };
    });
    const { result } = rendering(synthesize, store);
    await act(() => result.current.preview(voice, "Hello."));
    expect(result.current.state).toEqual({ key: voice.key, status: "error", message: "Model missing" });
    expect((await store.getUsage()).previewCount).toBe(0);
  });

  it("cancels a render in progress when stopped or replaced", async () => {
    let seenSignal: AbortSignal | undefined;
    const synthesize = vi.fn<PresetSynthesize>(async function* (_text, _preset, signal) {
      seenSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      signal.throwIfAborted();
      yield { audio: new Float32Array(1), samplingRate: 24000 };
    });
    const { result } = rendering(synthesize, store);
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.preview(voice, "Hello."); });
    await waitFor(() => expect(seenSignal).toBeDefined());
    act(() => result.current.stop());
    await act(() => pending);
    expect(seenSignal?.aborted).toBe(true);
    expect(result.current.state).toBeNull();
  });

  it("still plays when the cache cannot be written", async () => {
    const synthesize = vi.fn<PresetSynthesize>(async function* () {
      yield { audio: new Float32Array(2400).fill(0.2), samplingRate: 24000 };
    });
    const broken = { getPreview: async () => null, putPreview: async () => { throw new Error("quota"); } };
    const audios: FakeAudio[] = [];
    const { result } = renderHook(() => useVoicePreview(synthesize, broken, () => { const audio = new FakeAudio(); audios.push(audio); return audio; }));
    await act(() => result.current.preview(voice, "Hello."));
    expect(result.current.state?.status).toBe("playing");
    expect(audios[0].play).toHaveBeenCalled();
  });

  it("owns library previews by voice id and engine previews by catalog key", () => {
    expect(previewOwnerId(voice)).toBe("engine:kokoro:af_heart");
    expect(previewOwnerId({ ...voice, origin: "library", key: "library:v1", record: { id: "v1" } as CatalogVoice["record"] })).toBe("v1");
  });
});

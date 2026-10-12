import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChatterboxClip, setChatterboxClipResolver } from "../chatterboxClips";
import { encodeWavPcm16 } from "../wavCodec";
import { attachLibraryChatterboxClips, chatterboxClipForVoice, resetLibraryChatterboxClips } from "./chatterboxLibrary";
import { createVoiceLibraryStore, type VoiceLibraryStore } from "./store";

const RATE = 24_000;
function speech(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = 0.2 * (0.6 + 0.4 * Math.sin((index / RATE) * 6)) * (Math.sin(index / 9) + 0.5 * Math.sin(index / 4.1));
  }
  return out;
}

describe("Chatterbox clones from the Voice Library", () => {
  let store: VoiceLibraryStore;
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    resetLibraryChatterboxClips();
    store = createVoiceLibraryStore();
  });
  afterEach(async () => {
    setChatterboxClipResolver(null);
    await store.destroy();
    vi.unstubAllGlobals();
  });

  const save = (name: string, targets: ("chatterbox" | "neutts")[] = ["chatterbox"]) => store.createVoice({
    kind: "cloned", name, transcript: targets.includes("neutts") ? "Words." : "", targets, referenceWav: encodeWavPcm16(speech(6), RATE),
  });

  it("prepares a saved clone once and names it like a clip loaded from a file", async () => {
    const record = await save("Narrator");
    const spy = vi.spyOn(store, "getVoiceAudio");
    const clip = await chatterboxClipForVoice(store, record);
    expect(clip.id).toMatch(/^[0-9a-f]{16}~Narrator$/);
    expect(clip.samplingRate).toBe(24_000);
    expect(clip.durationSec).toBeGreaterThan(3);
    expect(await chatterboxClipForVoice(store, record)).toBe(clip);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses voices that are not Chatterbox clones", async () => {
    const record = await save("Other", ["neutts"]);
    await expect(chatterboxClipForVoice(store, record)).rejects.toThrow(/not a Chatterbox clone/);
  });

  it("supplies saved clones to the engine through its resolver, including ones saved earlier or later", async () => {
    const earlier = await save("Earlier");
    const detach = attachLibraryChatterboxClips(store);
    const earlierId = (await chatterboxClipForVoice(store, earlier)).id;
    await vi.waitFor(() => expect(getChatterboxClip(earlierId)?.name).toBe("Earlier"));

    const later = await save("Later");
    const laterId = (await chatterboxClipForVoice(store, later)).id;
    expect(getChatterboxClip(laterId)?.name).toBe("Later");
    expect(getChatterboxClip("unknown~x")).toBeUndefined();

    detach();
    expect(getChatterboxClip(earlierId)).toBeUndefined();
  });
});

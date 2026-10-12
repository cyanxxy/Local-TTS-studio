import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  clearStagedReference,
  getStagedReference,
  resetStagedReferences,
  stageReference,
  subscribeStagedReferences,
  type StagedReference,
} from "./stagedReference";
import { loadBuiltinFavorites, saveBuiltinFavorites } from "./builtinFavorites";

const reference: StagedReference = {
  voiceId: "v1",
  name: "Me",
  target: "neutts",
  wavBase64: "AAAA",
  transcript: "Hi.",
  language: "English",
  durationSec: 4,
  sha256: "a".repeat(64),
};

afterEach(resetStagedReferences);

describe("staged references", () => {
  it("stages one reference per target and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStagedReferences(listener);
    stageReference(reference);
    expect(getStagedReference("neutts")).toBe(reference);
    expect(getStagedReference("chatterbox")).toBeNull();
    clearStagedReference("chatterbox");
    expect(listener).toHaveBeenCalledTimes(1);
    clearStagedReference("neutts");
    expect(getStagedReference("neutts")).toBeNull();
    unsubscribe();
    stageReference(reference);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("encodes bytes as base64 in slices", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (char) => char.charCodeAt(0));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[69_999]).toBe(bytes[69_999]);
  });
});

describe("built-in favorites", () => {
  it("round-trips through storage and survives damage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    saveBuiltinFavorites(new Set(["b", "a"]), storage);
    expect([...loadBuiltinFavorites(storage)]).toEqual(["a", "b"]);
    store.set("open-tts.voice-favorites.v1", "{not json");
    expect(loadBuiltinFavorites(storage).size).toBe(0);
    store.set("open-tts.voice-favorites.v1", JSON.stringify([1, "x"]));
    expect([...loadBuiltinFavorites(storage)]).toEqual(["x"]);
    expect(() => saveBuiltinFavorites(new Set(["a"]), { setItem: () => { throw new Error("full"); } })).not.toThrow();
    expect(loadBuiltinFavorites(null).size).toBe(0);
  });
});

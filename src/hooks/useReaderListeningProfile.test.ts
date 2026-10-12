import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReaderDocument, type ReaderDocumentRecord, type ReaderListeningProfile } from "../lib/readerDocument";
import type { SurfaceEngineId, SurfaceEngineSettings } from "../models/registry";
import { useReaderListeningProfile } from "./useReaderListeningProfile";

const settings = {
  kokoro: { voice: "af_heart" },
  supertonic: { voice: "F1", language: "en" },
  audio8: { voice: "Clara" },
  supertonic3: { voice: "M1", language: "en" },
  qwen3: {},
} as unknown as SurfaceEngineSettings;

const book = createReaderDocument({ id: "listening-book", text: "Some text to listen to." });
const withProfile = (listening?: ReaderListeningProfile): ReaderDocumentRecord => (
  listening ? { ...book, listening } : book
);

interface Props {
  document: ReaderDocumentRecord | null;
  engineId: SurfaceEngineId;
  active?: boolean;
  usable?: boolean;
}

function setup(initial: Props) {
  const apply = vi.fn();
  const updateListening = vi.fn();
  const view = renderHook((props: Props) => useReaderListeningProfile({
    active: props.active ?? true,
    loading: false,
    document: props.document,
    engineId: props.engineId,
    surfaceEngineSettings: settings,
    quality: 5,
    playbackRate: 1,
    isEngineUsable: () => props.usable ?? true,
    apply,
    updateListening,
  }), { initialProps: initial });
  return { ...view, apply, updateListening };
}

describe("useReaderListeningProfile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is settled at once for a book with no profile and applies nothing", () => {
    const { result, apply } = setup({ document: withProfile(), engineId: "kokoro" });
    expect(result.current.settled).toBe(true);
    act(() => vi.advanceTimersByTime(10));
    expect(apply).not.toHaveBeenCalled();
  });

  it("is settled at once when the Reader already speaks the way the profile says", () => {
    const { result, apply } = setup({
      document: withProfile({ engine: "kokoro", voice: "af_heart", playbackRate: 1, updatedAt: 1 }),
      engineId: "kokoro",
    });
    expect(result.current.settled).toBe(true);
    expect(result.current.pending).toBe(false);
    act(() => vi.advanceTimersByTime(10));
    expect(apply).not.toHaveBeenCalled();
  });

  it("holds audio lookups until the remembered voice is applied, then lets them through", () => {
    const profile = { engine: "audio8" as const, voice: "Clara", playbackRate: 1.5, updatedAt: 1 };
    const { result, apply } = setup({ document: withProfile(profile), engineId: "kokoro" });
    expect(result.current.settled).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(apply).toHaveBeenCalledWith({ engine: profile, playbackRate: 1.5 });
    expect(result.current.settled).toBe(true);
  });

  it("does not hold the Reader when a setting refuses to move", () => {
    const profile = { engine: "audio8" as const, voice: "Clara", playbackRate: 1, updatedAt: 1 };
    const { result, apply } = setup({ document: withProfile(profile), engineId: "kokoro" });
    act(() => vi.advanceTimersByTime(1));
    // The engine is still kokoro: apply changed nothing, yet the Reader goes on.
    expect(apply).toHaveBeenCalledTimes(1);
    expect(result.current.settled).toBe(true);
    act(() => vi.advanceTimersByTime(50));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("leaves a book alone whose engine is not available here", () => {
    const { result, apply } = setup({
      document: withProfile({ engine: "qwen3", voice: "", playbackRate: 1, updatedAt: 1 }),
      engineId: "kokoro",
      usable: false,
    });
    expect(result.current.settled).toBe(true);
    // Not applied, but the book's audio is still its own: lookups must keep it.
    expect(result.current.pending).toBe(true);
    act(() => vi.advanceTimersByTime(10));
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies the next book's profile after the book changes", () => {
    const first = { engine: "audio8" as const, voice: "Clara", playbackRate: 1, updatedAt: 1 };
    const second = { engine: "supertonic3" as const, voice: "F2", language: "ja", playbackRate: 1.25, updatedAt: 2 };
    const { rerender, apply } = setup({ document: withProfile(first), engineId: "kokoro" });
    act(() => vi.advanceTimersByTime(1));
    rerender({ document: { ...withProfile(second), id: "other-book" }, engineId: "audio8" });
    act(() => vi.advanceTimersByTime(1));
    expect(apply).toHaveBeenLastCalledWith({ engine: second, playbackRate: 1.25 });
  });

  it("remembers a change on the Reader page, filling in everything else from what is current", () => {
    const { result, updateListening } = setup({ document: withProfile(), engineId: "supertonic3" });
    act(() => result.current.remember({ language: "fr" }));
    expect(updateListening).toHaveBeenCalledWith(expect.objectContaining({
      engine: "supertonic3",
      voice: "M1",
      language: "fr",
      quality: 5,
      playbackRate: 1,
    }));

    act(() => result.current.remember({ engine: "kokoro" }));
    expect(updateListening).toHaveBeenLastCalledWith(expect.objectContaining({
      engine: "kokoro",
      voice: "af_heart",
    }));
  });

  it("builds on the stored profile when the engine is the same", () => {
    const { result, updateListening } = setup({
      document: withProfile({ engine: "kokoro", voice: "am_adam", playbackRate: 1.75, updatedAt: 1 }),
      engineId: "kokoro",
    });
    act(() => result.current.remember({ voice: "af_nova" }));
    expect(updateListening).toHaveBeenCalledWith(expect.objectContaining({
      engine: "kokoro",
      voice: "af_nova",
      playbackRate: 1.75,
    }));
  });

  it("remembers a speed alone without pinning the engine and voice that are global", () => {
    const { result, updateListening } = setup({ document: withProfile(), engineId: "supertonic3" });
    act(() => result.current.remember({ playbackRate: 1.5 }));
    expect(updateListening).toHaveBeenCalledWith({ playbackRate: 1.5 });
    expect(updateListening.mock.calls[0][0]).not.toHaveProperty("engine");
    expect(updateListening.mock.calls[0][0]).not.toHaveProperty("voice");
  });

  it("applies a remembered speed on open, and only the speed", () => {
    const { result, apply } = setup({
      document: withProfile({ playbackRate: 1.75, updatedAt: 2 }),
      engineId: "kokoro",
    });
    expect(result.current.settled).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(apply).toHaveBeenCalledWith({ engine: null, playbackRate: 1.75 });
    expect(result.current.pending).toBe(false);
  });

  it("keeps a stored speed when a voice is chosen later", () => {
    const { result, updateListening } = setup({
      document: withProfile({ playbackRate: 1.75, updatedAt: 2 }),
      engineId: "kokoro",
    });
    act(() => result.current.remember({ voice: "af_nova" }));
    expect(updateListening).toHaveBeenCalledWith(expect.objectContaining({
      engine: "kokoro",
      voice: "af_nova",
      playbackRate: 1.75,
    }));
  });

  it("remembers nothing off the Reader page or without an open book", () => {
    const off = setup({ document: withProfile(), engineId: "kokoro", active: false });
    act(() => off.result.current.remember({ voice: "x" }));
    expect(off.updateListening).not.toHaveBeenCalled();
    const none = setup({ document: null, engineId: "kokoro" });
    act(() => none.result.current.remember({ voice: "x" }));
    expect(none.updateListening).not.toHaveBeenCalled();
  });
});

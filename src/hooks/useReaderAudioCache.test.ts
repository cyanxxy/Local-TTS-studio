import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAudioSignature,
  buildLegacyAudioSignature,
  buildReaderSections,
  createReaderAudioCacheKey,
  createReaderDocument,
  type CachedReaderAudio,
  type CachedReaderAudioChunk,
} from "../lib/readerDocument";
import type { AudioSegment as ReaderSegment } from "../lib/audioTimeline";
import {
  READER_AUDIO_SAVE_DELAY_MS,
  READER_STREAMING_SAVE_INTERVAL_MS,
  useReaderAudioCache,
} from "./useReaderAudioCache";

const document = createReaderDocument({
  id: "cache-book",
  text: "A paragraph long enough to fill several sections. ".repeat(900),
});
const sections = buildReaderSections(document.text, document.chapters);
const legacy = { voice: "af_heart", quality: 5, tuning: { speed: 1.1, quality: 5 } };
const parts = { voice: "af_heart", tuning: {}, legacy };
const legacySignatureFor = (index: number) => buildLegacyAudioSignature({
  text: document.text.slice(sections[index].start, sections[index].end),
  model: "kokoro",
  ...legacy,
});
const signatureFor = (index: number) => buildAudioSignature({
  text: document.text.slice(sections[index].start, sections[index].end),
  model: "kokoro",
  ...parts,
});

const chunk: CachedReaderAudioChunk = {
  audio: new Float32Array([0.1, -0.1]).buffer,
  samplingRate: 24_000,
  text: "spoken",
  index: 0,
  total: 1,
};

function cachedAudio(overrides: Partial<CachedReaderAudio> = {}): CachedReaderAudio {
  return {
    cacheKey: createReaderAudioCacheKey(document.id, sections[0].id),
    documentId: document.id,
    chapterId: sections[0].chapterId,
    sectionId: sections[0].id,
    signature: signatureFor(0),
    chunks: [chunk],
    byteLength: chunk.audio.byteLength,
    currentTime: 3,
    playbackRate: 1.25,
    totalDuration: 8,
    synthesisComplete: true,
    updatedAt: 1,
    ...overrides,
  };
}

function setup(overrides: {
  active?: boolean;
  signatureParts?: typeof parts | null;
  loaded?: CachedReaderAudio | null;
  loadError?: Error;
  segments?: ReaderSegment[];
} = {}) {
  const library = {
    loadAudio: vi.fn(async () => {
      if (overrides.loadError) throw overrides.loadError;
      return overrides.loaded ?? null;
    }),
    saveAudio: vi.fn<(audio: CachedReaderAudio) => Promise<void>>(async () => undefined),
    clearAudio: vi.fn(async () => undefined),
  };
  const player = {
    getAudioCacheSnapshot: vi.fn(() => [chunk]),
    getCurrentTime: vi.fn(() => 2.5),
    getPlaybackSnapshot: vi.fn(() => ({ playbackRate: 1.5, totalDuration: 9, synthesisComplete: false })),
    isSynthesisComplete: false,
    restoreAudioCache: vi.fn(),
    segments: overrides.segments ?? [],
    togglePlay: vi.fn(async () => undefined),
  };
  const callbacks = {
    retireAllAudio: vi.fn(),
    generate: vi.fn(),
    setShowPlayer: vi.fn(),
    onSectionEnter: vi.fn(),
    reportError: vi.fn(),
  };
  const view = renderHook((props: { signatureParts: typeof parts | null; segments: ReaderSegment[]; complete?: boolean }) => (
    useReaderAudioCache({
      active: overrides.active ?? true,
      document,
      section: sections[0],
      sectionText: document.text.slice(sections[0].start, sections[0].end),
      engineId: "kokoro",
      signatureParts: props.signatureParts,
      library,
      player: { ...player, segments: props.segments, isSynthesisComplete: props.complete ?? false },
      ...callbacks,
    })
  ), {
    initialProps: {
      signatureParts: overrides.signatureParts === undefined ? parts : overrides.signatureParts,
      segments: player.segments,
    } as { signatureParts: typeof parts | null; segments: ReaderSegment[]; complete?: boolean },
  });
  return { ...view, library, player, callbacks };
}

const segment = (id: string): ReaderSegment => ({
  id, text: id, startSec: 0, endSec: 1, index: 1, total: 1,
});

describe("useReaderAudioCache", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores a section's matching saved audio at its saved position when entered", async () => {
    const { library, player, callbacks } = setup({ loaded: cachedAudio() });

    await waitFor(() => expect(player.restoreAudioCache).toHaveBeenCalledTimes(1));
    expect(library.loadAudio).toHaveBeenCalledWith(document.id, sections[0].id);
    // Retired and cleared of stale errors before the lookup.
    expect(callbacks.retireAllAudio).toHaveBeenCalledTimes(1);
    expect(callbacks.onSectionEnter).toHaveBeenCalledTimes(1);
    expect(player.restoreAudioCache).toHaveBeenCalledWith([chunk], {
      currentTime: 0,
      playbackRate: 1.25,
      synthesisComplete: true,
    });
    expect(callbacks.setShowPlayer).toHaveBeenCalledWith(true);
    expect(library.clearAudio).not.toHaveBeenCalled();
  });

  it("discards audio saved under another signature and generates when asked to continue", async () => {
    // The signature is unknown at first, so the continuation is set before the section is entered for real.
    const { rerender, library, player, callbacks, result } = setup({
      signatureParts: null,
      loaded: cachedAudio({ signature: "stale" }),
    });
    act(() => result.current.setContinuation({ sectionId: sections[0].id, autoPlay: true, autoGenerate: true }));
    rerender({ signatureParts: parts, segments: [] });

    await waitFor(() => expect(callbacks.generate).toHaveBeenCalledTimes(1));
    expect(library.clearAudio).toHaveBeenCalledWith(document.id, sections[0].id);
    expect(player.restoreAudioCache).not.toHaveBeenCalled();
  });

  it("reuses audio cached under the version 1 signature and re-saves it under the current one", async () => {
    const saved = cachedAudio({ signature: legacySignatureFor(0), updatedAt: 5 });
    const { library, player } = setup({ loaded: saved });

    await waitFor(() => expect(player.restoreAudioCache).toHaveBeenCalledTimes(1));
    expect(library.clearAudio).not.toHaveBeenCalled();
    expect(library.saveAudio).toHaveBeenCalledTimes(1);
    expect(library.saveAudio.mock.calls[0][0]).toMatchObject({
      cacheKey: saved.cacheKey,
      chunks: saved.chunks,
      signature: signatureFor(0),
    });
    expect(library.saveAudio.mock.calls[0][0].updatedAt).toBeGreaterThan(5);
  });

  it("still discards version 1 audio whose settings differ", async () => {
    const other = buildLegacyAudioSignature({
      text: document.text.slice(sections[0].start, sections[0].end),
      model: "kokoro",
      ...legacy,
      tuning: { speed: 1.4, quality: 5 },
    });
    const { library, player } = setup({ loaded: cachedAudio({ signature: other }) });

    await waitFor(() => expect(library.clearAudio).toHaveBeenCalledTimes(1));
    expect(player.restoreAudioCache).not.toHaveBeenCalled();
    expect(library.saveAudio).not.toHaveBeenCalled();
  });

  it("generates an unsaved section when the navigation asked to continue", async () => {
    const { rerender, library, callbacks, result } = setup({ signatureParts: null });
    // Signature unknown: nothing is looked up or discarded on a guess.
    expect(library.loadAudio).not.toHaveBeenCalled();
    act(() => result.current.setContinuation({ sectionId: sections[0].id, autoPlay: true, autoGenerate: true }));
    rerender({ signatureParts: parts, segments: [] });

    await waitFor(() => expect(callbacks.generate).toHaveBeenCalledTimes(1));
    expect(library.loadAudio).toHaveBeenCalledTimes(1);
    expect(library.clearAudio).not.toHaveBeenCalled();
  });

  it("plays restored audio when the navigation asked to continue, from the requested position", async () => {
    const { rerender, player, result } = setup({ signatureParts: null, loaded: cachedAudio() });
    act(() => {
      result.current.requestRestore(sections[0].id, 5);
      result.current.setContinuation({ sectionId: sections[0].id, autoPlay: true, autoGenerate: false });
    });
    rerender({ signatureParts: parts, segments: [] });

    await waitFor(() => expect(player.togglePlay).toHaveBeenCalledTimes(1));
    expect(player.restoreAudioCache).toHaveBeenCalledWith([chunk], expect.objectContaining({ currentTime: 5 }));
  });

  it("looks nothing up while the Reader is not on screen", async () => {
    const { library, callbacks } = setup({ active: false, loaded: cachedAudio() });
    await Promise.resolve();
    expect(library.loadAudio).not.toHaveBeenCalled();
    expect(callbacks.retireAllAudio).not.toHaveBeenCalled();
  });

  it("reports a failed lookup", async () => {
    const { callbacks, result } = setup({ loadError: new Error("disk gone") });
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledWith(new Error("disk gone")));
    expect(result.current.isRestorePending()).toBe(false);
  });

  it("flushes the player's audio under the section's signature with increasing timestamps", () => {
    const { result, library, player } = setup();
    act(() => result.current.flush());
    // More audio streamed in between the two flushes.
    const more = { ...chunk, audio: new Float32Array([0.2]).buffer, index: 1 };
    player.getAudioCacheSnapshot.mockReturnValue([chunk, more]);
    act(() => result.current.flush());

    expect(library.saveAudio).toHaveBeenCalledTimes(2);
    const [first, second] = library.saveAudio.mock.calls.map(([audio]) => audio as CachedReaderAudio);
    expect(first).toMatchObject({
      cacheKey: createReaderAudioCacheKey(document.id, sections[0].id),
      documentId: document.id,
      sectionId: sections[0].id,
      chapterId: sections[0].chapterId,
      signature: signatureFor(0),
      currentTime: 2.5,
      playbackRate: 1.5,
      totalDuration: 9,
      synthesisComplete: false,
      byteLength: chunk.audio.byteLength,
    });
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it("saves nothing without audio or without a known signature", () => {
    const empty = setup();
    empty.player.getAudioCacheSnapshot.mockReturnValue([]);
    act(() => empty.result.current.flush());
    expect(empty.library.saveAudio).not.toHaveBeenCalled();

    const unknown = setup({ signatureParts: null });
    act(() => unknown.result.current.flush());
    expect(unknown.library.saveAudio).not.toHaveBeenCalled();
  });

  it("reports a save that fails", async () => {
    const { result, library, callbacks } = setup();
    library.saveAudio.mockRejectedValue(new Error("quota"));
    act(() => result.current.flush());
    await waitFor(() => expect(callbacks.reportError).toHaveBeenCalledWith(new Error("quota")));
  });

  it("saves a finished section once it stops changing", () => {
    vi.useFakeTimers();
    const { rerender, library, player } = setup({ segments: [segment("a")] });
    player.getPlaybackSnapshot.mockReturnValue({ playbackRate: 1, totalDuration: 9, synthesisComplete: true });
    const finished = (segments: ReaderSegment[]) => ({ signatureParts: parts, segments, complete: true });
    rerender(finished([segment("a")]));
    act(() => vi.advanceTimersByTime(READER_AUDIO_SAVE_DELAY_MS - 1));
    // A new segment restarts the quiet period.
    rerender(finished([segment("a"), segment("b")]));
    act(() => vi.advanceTimersByTime(READER_AUDIO_SAVE_DELAY_MS - 1));
    expect(library.saveAudio).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(library.saveAudio).toHaveBeenCalledTimes(1);
  });

  it("saves a streaming section at most once per interval however many chunk gaps there are", () => {
    vi.useFakeTimers();
    const { rerender, library, player } = setup({ segments: [segment("a")] });
    // The first partial save lands after the quiet period.
    act(() => vi.advanceTimersByTime(READER_AUDIO_SAVE_DELAY_MS));
    expect(library.saveAudio).toHaveBeenCalledTimes(1);

    // Chunks keep arriving with gaps longer than the quiet period.
    for (let count = 2; count <= 12; count += 1) {
      player.getAudioCacheSnapshot.mockReturnValue(
        Array.from({ length: count }, (_, index) => ({ ...chunk, audio: new Float32Array([index]).buffer, index })),
      );
      rerender({ signatureParts: parts, segments: Array.from({ length: count }, (_, i) => segment(`s${i}`)) });
      act(() => vi.advanceTimersByTime(READER_AUDIO_SAVE_DELAY_MS * 2));
    }
    expect(library.saveAudio).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(READER_STREAMING_SAVE_INTERVAL_MS));
    expect(library.saveAudio).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite audio that a restore just put in the player", async () => {
    vi.useFakeTimers();
    const saved = cachedAudio();
    const { library, player, rerender, result } = setup({ loaded: saved });
    player.getAudioCacheSnapshot.mockReturnValue(saved.chunks);
    player.getPlaybackSnapshot.mockReturnValue({ playbackRate: 1.25, totalDuration: 8, synthesisComplete: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(player.restoreAudioCache).toHaveBeenCalledTimes(1);

    // Restoring publishes segments, which used to schedule a full rewrite.
    rerender({ signatureParts: parts, segments: [segment("a")], complete: true });
    act(() => vi.advanceTimersByTime(READER_AUDIO_SAVE_DELAY_MS * 3));
    act(() => result.current.flush());
    expect(library.saveAudio).not.toHaveBeenCalled();

    // Anything streamed or retaken since is a change and is saved.
    player.getAudioCacheSnapshot.mockReturnValue([{ ...saved.chunks[0], audio: new Float32Array([0.5, 0.5]).buffer }]);
    act(() => result.current.flush());
    expect(library.saveAudio).toHaveBeenCalledTimes(1);
  });

  it("saves again after a write fails and skips an unchanged repeat after one lands", async () => {
    const { result, library } = setup();
    library.saveAudio.mockRejectedValueOnce(new Error("quota"));
    act(() => result.current.flush());
    await waitFor(() => expect(library.saveAudio).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.flush());
    expect(library.saveAudio).toHaveBeenCalledTimes(2);
    act(() => result.current.flush());
    expect(library.saveAudio).toHaveBeenCalledTimes(2);
  });

  it("cancels the pending save when it flushes", () => {
    vi.useFakeTimers();
    const { result, library } = setup({ segments: [segment("a")] });
    act(() => result.current.flush());
    act(() => vi.advanceTimersByTime(READER_AUDIO_SAVE_DELAY_MS * 2));
    expect(library.saveAudio).toHaveBeenCalledTimes(1);
  });

  it("forgets an edited section's audio once per edit", () => {
    const { result, library } = setup();
    act(() => {
      result.current.discardForEdit(document.id, sections[0].id);
      result.current.discardForEdit(document.id, sections[0].id);
    });
    expect(library.clearAudio).toHaveBeenCalledTimes(1);

    // Saving fresh audio ends the edit, so the next edit forgets it again.
    act(() => result.current.flush());
    act(() => result.current.discardForEdit(document.id, sections[0].id));
    expect(library.clearAudio).toHaveBeenCalledTimes(2);
  });

  it("is pending only while a section's lookup runs", async () => {
    const { result } = setup({ loaded: cachedAudio() });
    expect(result.current.isRestorePending()).toBe(true);
    await waitFor(() => expect(result.current.isRestorePending()).toBe(false));
  });
});

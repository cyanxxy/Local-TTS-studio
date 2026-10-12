import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaybackClock } from "../lib/playbackClock";
import {
  buildAudioSignature,
  createReaderDocument,
  type CachedReaderAudio,
} from "../lib/readerDocument";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import type { UseReaderLibraryReturn } from "./useReaderLibrary";
import { useReaderSections } from "./useReaderSections";
import { useReaderSession } from "./useReaderSession";

const book = createReaderDocument({
  id: "session-book",
  text: "A paragraph long enough to fill several sections. ".repeat(900),
});

function setup(options: { loaded?: CachedReaderAudio | null; saveError?: Error } = {}) {
  const clock = new PlaybackClock();
  const library = {
    activeDocument: book,
    createDocument: vi.fn(async () => book),
    openDocument: vi.fn(async () => book),
    deleteDocument: vi.fn(async () => undefined),
    updateActiveText: vi.fn(),
    finalizeActiveTextEdit: vi.fn(),
    updateProgress: vi.fn(),
    loadAudio: vi.fn(async () => options.loaded ?? null),
    saveAudio: vi.fn(async () => {
      if (options.saveError) throw options.saveError;
    }),
    clearAudio: vi.fn(async () => undefined),
  };
  const chunk = { audio: new Float32Array([0.1]).buffer, samplingRate: 24_000, text: "x", index: 0, total: 1 };
  const player = {
    activeSegmentId: null,
    clock,
    getAudioCacheSnapshot: vi.fn(() => [chunk]),
    getCurrentTime: vi.fn(() => 1),
    getPlaybackSnapshot: vi.fn(() => ({ playbackRate: 1, totalDuration: 5, synthesisComplete: true })),
    isPlaying: false,
    isSynthesisComplete: true,
    restoreAudioCache: vi.fn(),
    segments: [],
    togglePlay: vi.fn(async () => undefined),
    totalDuration: 0,
  };
  const callbacks = {
    generate: vi.fn(),
    retireAllAudio: vi.fn(),
    resetAudioForTextEdit: vi.fn(),
    setShowPlayer: vi.fn(),
    clearErrors: vi.fn(),
    onError: vi.fn(),
  };
  const view = renderHook(() => {
    const sections = useReaderSections(library.activeDocument);
    return useReaderSession({
      active: true,
      library: library as unknown as UseReaderLibraryReturn,
      sections,
      player: player as unknown as UseAudioPlayerReturn,
      engineId: "kokoro",
      signatureParts: { voice: "af_heart", tuning: {} },
      isGenerating: false,
      autoAdvance: false,
      ...callbacks,
    });
  });
  return { ...view, library, player, callbacks };
}

describe("useReaderSession", () => {
  it("exposes the active section with the signature its audio is saved under", async () => {
    const { result, library } = setup();
    await waitFor(() => expect(library.loadAudio).toHaveBeenCalled());
    const section = result.current.activeSection!;
    expect(result.current.document).toBe(book);
    expect(result.current.audioSignature).toBe(buildAudioSignature({
      text: result.current.activeSectionText,
      model: "kokoro",
      voice: "af_heart",
      tuning: {},
    }));
    expect(library.loadAudio).toHaveBeenCalledWith(book.id, section.id);
  });

  it("saves the audio and records progress when navigating to another section", async () => {
    const { result, library, player } = setup();
    await waitFor(() => expect(library.loadAudio).toHaveBeenCalled());
    const target = result.current.sections[1];

    act(() => result.current.navigateToOffset(target.start + 5, 12));

    expect(library.saveAudio).toHaveBeenCalledWith(expect.objectContaining({
      sectionId: result.current.sections[0].id,
    }));
    expect(library.updateProgress).toHaveBeenCalledWith({
      positionSec: 12,
      totalDurationSec: 0,
      textOffset: target.start + 5,
    });
    expect(player.restoreAudioCache).not.toHaveBeenCalled();
  });

  it("keeps the section's audio when navigating within it, and clamps the offset", async () => {
    const { result, library } = setup();
    await waitFor(() => expect(library.loadAudio).toHaveBeenCalled());

    act(() => result.current.navigateToOffset(-40));
    act(() => result.current.navigateToOffset(book.text.length + 40));

    expect(library.saveAudio).toHaveBeenCalledTimes(1);
    expect(library.updateProgress).toHaveBeenNthCalledWith(1, {
      positionSec: 0, totalDurationSec: 0, textOffset: 0,
    });
    expect(library.updateProgress).toHaveBeenNthCalledWith(2, {
      positionSec: 0, totalDurationSec: 0, textOffset: book.text.length,
    });
  });

  it("splices a section edit into the document and tells the library where it happened", async () => {
    const { result, library, callbacks } = setup();
    await waitFor(() => expect(library.loadAudio).toHaveBeenCalled());
    const section = result.current.activeSection!;

    act(() => result.current.startSectionEdit());
    act(() => result.current.changeSectionText("Replacement."));

    expect(callbacks.resetAudioForTextEdit).toHaveBeenCalledTimes(1);
    expect(library.clearAudio).toHaveBeenCalledWith(book.id, section.id);
    expect(library.updateActiveText).toHaveBeenCalledWith(
      `${book.text.slice(0, section.start)}Replacement.${book.text.slice(section.end)}`,
      {
        preserveText: true,
        deferStructure: true,
        hint: {
          start: section.start,
          previousEnd: section.end,
          nextEnd: section.start + "Replacement.".length,
        },
      },
    );
    expect(callbacks.clearErrors).toHaveBeenCalled();

    act(() => result.current.endSectionEdit());
    expect(library.finalizeActiveTextEdit).toHaveBeenCalledWith(book.id);
  });

  it("applies an unframed edit to the active section and ignores a no-op edit", async () => {
    const { result, library } = setup();
    await waitFor(() => expect(library.loadAudio).toHaveBeenCalled());
    const section = result.current.activeSection!;

    act(() => result.current.changeSectionText(result.current.activeSectionText));
    expect(library.updateActiveText).not.toHaveBeenCalled();

    act(() => result.current.changeSectionText("Shorter."));
    expect(library.updateActiveText).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      deferStructure: false,
      hint: expect.objectContaining({ start: section.start }),
    }));
  });

  it("commits an unfinished edit's structure when the session ends", async () => {
    const { result, library, unmount } = setup();
    await waitFor(() => expect(library.loadAudio).toHaveBeenCalled());
    act(() => result.current.startSectionEdit());
    unmount();
    expect(library.finalizeActiveTextEdit).toHaveBeenCalledWith(book.id);
  });

  it("saves the audio before creating or opening a document and reports an open that fails", async () => {
    const { result, library, callbacks } = setup();
    await waitFor(() => expect(library.loadAudio).toHaveBeenCalled());

    act(() => result.current.newDocument());
    expect(library.saveAudio).toHaveBeenCalledTimes(1);
    expect(library.createDocument).toHaveBeenCalledWith(expect.objectContaining({ title: "Untitled document" }));

    library.openDocument.mockRejectedValueOnce(new Error("gone"));
    act(() => result.current.openDocument("other"));
    expect(library.saveAudio).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith("gone"));

    library.deleteDocument.mockRejectedValueOnce("plain failure");
    act(() => result.current.deleteDocument("other"));
    await waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith("plain failure"));
  });

  it("reports a failed audio save, except one that lost the race with quitting", async () => {
    const failing = setup({ saveError: new Error("quota") });
    await waitFor(() => expect(failing.library.loadAudio).toHaveBeenCalled());
    act(() => failing.result.current.flushAudio());
    await waitFor(() => expect(failing.callbacks.onError).toHaveBeenCalledWith("quota"));

    const quitting = setup({ saveError: new Error("Reader library worker is shutting down.") });
    await waitFor(() => expect(quitting.library.loadAudio).toHaveBeenCalled());
    act(() => quitting.result.current.flushAudio());
    await waitFor(() => expect(quitting.library.saveAudio).toHaveBeenCalled());
    expect(quitting.callbacks.onError).not.toHaveBeenCalled();
  });
});

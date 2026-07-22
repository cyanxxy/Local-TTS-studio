import { StrictMode, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearReaderLibraryForTests, listReaderDocuments } from "../lib/readerLibrary";
import {
  buildReaderSections,
  createReaderAudioCacheKey,
  type CachedReaderAudio,
} from "../lib/readerDocument";
import { useReaderLibrary } from "./useReaderLibrary";

function StrictModeWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

describe("useReaderLibrary", () => {
  beforeEach(async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    await clearReaderLibraryForTests();
  });

  it("creates only one seed document across the Strict Mode effect replay", async () => {
    const { result } = renderHook(
      () => useReaderLibrary("A single local seed document."),
      { wrapper: StrictModeWrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.documents).toHaveLength(1);
    await waitFor(async () => expect(await listReaderDocuments()).toHaveLength(1));
  });

  it("does not let a delayed progress write overwrite a newer text save", async () => {
    const { result } = renderHook(() => useReaderLibrary("Original reader text."));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const id = result.current.activeDocument?.id;

    vi.useFakeTimers();
    act(() => {
      result.current.updateProgress({ positionSec: 2, totalDurationSec: 10, textOffset: 4 });
      result.current.updateActiveText("Newest reader text survives the progress flush.");
      vi.advanceTimersByTime(600);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.useRealTimers();

    await waitFor(async () => {
      const stored = (await listReaderDocuments()).find((document) => document.id === id);
      expect(stored?.text).toBe("Newest reader text survives the progress flush.");
    });
  });

  it("normalizes edited text before deriving sections or storing it", async () => {
    const { result } = renderHook(() => useReaderLibrary("Original reader text."));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.updateActiveText("Opening   \n\n\n\n\nTail   ");
    });

    expect(result.current.activeDocument?.text).toBe("Opening\n\n\nTail");
    const document = result.current.activeDocument!;
    const sections = buildReaderSections(document.text, document.chapters);
    expect(sections.map((section) => document.text.slice(section.start, section.end)).join(""))
      .toBe(document.text);
  });

  it("preserves exact document bytes and defers re-structuring during an edit session", async () => {
    const seed = "CHAPTER ONE\nOpening.\n\nCHAPTER TWO\nEnding.";
    const { result } = renderHook(() => useReaderLibrary(seed));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const originalChapterIds = result.current.activeDocument!.chapters.map((chapter) => chapter.id);
    const edited = `  ${seed}\n\nCHAPTER THREE\nA new ending.\n\n\n\n  `;

    vi.useFakeTimers();
    act(() => {
      result.current.updateActiveText(edited, { preserveText: true, deferStructure: true });
      vi.advanceTimersByTime(1_500);
    });

    expect(result.current.activeDocument?.text).toBe(edited);
    expect(result.current.activeDocument?.chapters.map((chapter) => chapter.id)).toEqual(originalChapterIds);

    act(() => result.current.finalizeActiveTextEdit());
    expect(result.current.activeDocument?.text).toBe(edited);
    expect(result.current.activeDocument?.chapters).toHaveLength(3);
    vi.useRealTimers();
  });

  it("keeps note whitespace while typing and trims only the committed blur value", async () => {
    const { result } = renderHook(() => useReaderLibrary("A passage for notes."));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.addNote({ text: "Draft", quote: "passage", textOffset: 2 }));
    const noteId = result.current.activeDocument!.notes[0].id;

    act(() => result.current.updateNote(noteId, "great "));
    expect(result.current.activeDocument?.notes[0].text).toBe("great ");

    act(() => result.current.updateNote(noteId, "great ".trim()));
    expect(result.current.activeDocument?.notes[0].text).toBe("great");
  });

  it("flushes pending text and progress when the hook unmounts", async () => {
    const { result, unmount } = renderHook(() => useReaderLibrary("Original reader text."));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const id = result.current.activeDocument!.id;

    act(() => {
      result.current.updateActiveText("Flushed reader text.   ");
      result.current.updateProgress({ positionSec: 3, totalDurationSec: 12, textOffset: 7 });
    });
    unmount();

    await waitFor(async () => {
      const stored = (await listReaderDocuments()).find((document) => document.id === id);
      expect(stored?.text).toBe("Flushed reader text.");
      expect(stored?.progress.positionSec).toBe(3);
      expect(stored?.progress.textOffset).toBe(7);
    });
  });

  it("debounces metadata writes instead of storing the whole book per keystroke", async () => {
    const { result } = renderHook(() => useReaderLibrary("Original reader text."));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const id = result.current.activeDocument!.id;
    const originalTitle = result.current.activeDocument!.title;

    act(() => result.current.updateActiveMetadata({ title: "A" }));
    act(() => result.current.updateActiveMetadata({ title: "A much better title" }));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect((await listReaderDocuments()).find((document) => document.id === id)?.title).toBe(originalTitle);

    await waitFor(async () => {
      expect((await listReaderDocuments()).find((document) => document.id === id)?.title)
        .toBe("A much better title");
    });
  });

  it("selects and persists a replacement when the active document is deleted", async () => {
    const { result } = renderHook(() => useReaderLibrary("Original reader text."));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const originalId = result.current.activeDocument!.id;
    let createdId = "";
    await act(async () => {
      createdId = (await result.current.createDocument({ text: "Second reader document." })).id;
    });

    await act(async () => result.current.deleteDocument(createdId));

    expect(result.current.activeDocument?.id).toBe(originalId);
    expect(result.current.documents.map((document) => document.id)).toEqual([originalId]);
  });

  it("evicts memory audio by last use instead of original write time", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const { result } = renderHook(() => useReaderLibrary("Memory-only reader."));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const makeAudio = (sectionId: string): CachedReaderAudio => {
      const audio = new Float32Array([Number(sectionId.slice(1))]).buffer;
      return {
        cacheKey: createReaderAudioCacheKey("memory-doc", sectionId),
        documentId: "memory-doc",
        chapterId: "chapter-1",
        sectionId,
        signature: sectionId,
        chunks: [{ audio, samplingRate: 24_000, text: sectionId, index: 0, total: 1 }],
        byteLength: audio.byteLength,
        currentTime: 0,
        playbackRate: 1,
        totalDuration: 1,
        updatedAt: Number(sectionId.slice(1)),
      };
    };

    for (let index = 0; index < 12; index += 1) {
      await result.current.saveAudio(makeAudio(`s${index}`));
    }
    expect(await result.current.loadAudio("memory-doc", "s0")).not.toBeNull();
    await result.current.saveAudio(makeAudio("s12"));

    expect(await result.current.loadAudio("memory-doc", "s1")).toBeNull();
    expect(await result.current.loadAudio("memory-doc", "s0")).not.toBeNull();
  });
});

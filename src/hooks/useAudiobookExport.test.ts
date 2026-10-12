import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildAudioSignature, buildReaderSections, createReaderDocument } from "../lib/readerDocument";
import type { CachedReaderAudio } from "../lib/readerDocument";
import type { ExportResult } from "../lib/exportAudio";
import type { SynthesisChunk } from "../shared/engineRuntime";
import { useAudiobookExport } from "./useAudiobookExport";

const book = createReaderDocument({
  id: "export-book",
  title: "Exported",
  author: "An Author",
  text: ["# One\n\n" + "First sentence. ".repeat(900), "# Two\n\n" + "Second sentence. ".repeat(30)].join("\n\n"),
});
const sections = buildReaderSections(book.text, book.chapters);
const parts = { voice: "af_heart", tuning: {}, legacy: { voice: "af_heart", quality: 5, tuning: { speed: 1, quality: 5 } } };
const textOf = (index: number) => book.text.slice(sections[index].start, sections[index].end);
const signatureOf = (index: number) => buildAudioSignature({ text: textOf(index), model: "kokoro", ...parts });

const chunk = (): SynthesisChunk => ({
  audio: new Float32Array(24_000).fill(0.1),
  samplingRate: 24_000,
  text: "x",
  index: 1,
  total: 0,
});

function setup(options: { cached?: Record<string, CachedReaderAudio> } = {}) {
  const cached = options.cached ?? {};
  const library = {
    hasAudio: vi.fn(async (_documentId: string, sectionId: string, signature: string) => (
      cached[sectionId]?.signature === signature
    )),
    loadAudio: vi.fn(async (_documentId: string, sectionId: string) => cached[sectionId] ?? null),
    saveAudio: vi.fn<(audio: CachedReaderAudio) => Promise<void>>(async () => undefined),
  };
  const renderSection = vi.fn((_text: string, signal: AbortSignal): AsyncIterable<SynthesisChunk> => (
    (async function* () {
      signal.throwIfAborted();
      yield chunk();
    })()
  ));
  const encode = vi.fn(async () => ({
    blob: new Blob([new Uint8Array(16)], { type: "audio/mpeg" }),
    extension: "mp3",
  } as ExportResult));
  const save = vi.fn();
  const view = renderHook(() => useAudiobookExport({
    document: book,
    sections,
    engineId: "kokoro",
    signatureParts: parts,
    renderSection,
    library,
    encode,
    save,
  }));
  return { ...view, library, renderSection, encode, save };
}

describe("useAudiobookExport", () => {
  it("plans a scope for the estimate before anything runs", () => {
    const { result } = setup();
    expect(result.current.planFor({ kind: "book" })?.chapters.map((entry) => entry.chapter.title)).toEqual(["One", "Two"]);
    expect(result.current.state.status).toBe("idle");
  });

  it("exports the book, rendering what the cache lacks and saving it, then hands the file to the save flow", async () => {
    const reusable: CachedReaderAudio = {
      cacheKey: "k",
      documentId: book.id,
      chapterId: sections[0].chapterId,
      sectionId: sections[0].id,
      signature: signatureOf(0),
      chunks: [{ audio: new Float32Array(24_000).buffer, samplingRate: 24_000, text: "x", index: 0, total: 1 }],
      byteLength: 96_000,
      currentTime: 0,
      playbackRate: 1,
      totalDuration: 1,
      synthesisComplete: true,
      updatedAt: 1,
    };
    const { result, renderSection, library, encode, save } = setup({ cached: { [sections[0].id]: reusable } });
    act(() => result.current.start({ kind: "book" }, "mp3"));
    expect(result.current.state.status).toBe("running");

    await waitFor(() => expect(result.current.state.status).toBe("done"));
    expect(renderSection).toHaveBeenCalledTimes(sections.length - 1);
    expect(library.saveAudio).toHaveBeenCalledTimes(sections.length - 1);
    expect(library.saveAudio.mock.calls[0][0]).toMatchObject({ documentId: book.id, synthesisComplete: true });
    expect(encode).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith(expect.any(Blob), "Exported.mp3");
    expect(result.current.state.result).toMatchObject({
      chapters: 2,
      reusedSections: 1,
      renderedSections: sections.length - 1,
    });
  });

  it("exports one chapter as a zip", async () => {
    const { result, encode, save } = setup();
    const second = book.chapters.find((chapter) => chapter.title === "Two")!;
    act(() => result.current.start({ kind: "chapter", chapterId: second.id }, "zip"));
    await waitFor(() => expect(result.current.state.status).toBe("done"));
    expect(encode).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.any(Blob), "Exported - Two.zip");
  });

  it("cancels without calling it a failure, and a retry resumes with the finished chapters", async () => {
    const { result, encode, renderSection, save } = setup();
    let release: () => void = () => undefined;
    renderSection.mockImplementationOnce(() => (async function* () {
      await new Promise<void>((resolve) => { release = resolve; });
      yield chunk();
    })());
    act(() => result.current.start({ kind: "book" }, "mp3"));
    await waitFor(() => expect(renderSection).toHaveBeenCalledTimes(1));
    act(() => result.current.cancel());
    release();
    await waitFor(() => expect(result.current.state.status).toBe("idle"));
    expect(save).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();

    act(() => result.current.start({ kind: "book" }, "mp3"));
    await waitFor(() => expect(result.current.state.status).toBe("done"));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps finished chapters when a later one fails and reuses them on retry", async () => {
    const { result, encode, renderSection } = setup();
    const lastSectionIndex = sections.length - 1;
    let calls = 0;
    renderSection.mockImplementation((_text, signal) => (async function* () {
      calls += 1;
      signal.throwIfAborted();
      if (calls === sections.length) throw new Error("engine fell over");
      yield chunk();
    })());
    act(() => result.current.start({ kind: "book" }, "mp3"));
    await waitFor(() => expect(result.current.state.status).toBe("failed"));
    expect(result.current.state.error).toBe("engine fell over");
    expect(encode).toHaveBeenCalledTimes(1);
    expect(lastSectionIndex).toBeGreaterThan(0);

    act(() => result.current.start({ kind: "book" }, "mp3"));
    await waitFor(() => expect(result.current.state.status).toBe("done"));
    // The finished chapter was not encoded again.
    expect(encode).toHaveBeenCalledTimes(2);
    expect(result.current.state.result?.reusedChapters).toBe(1);
  });

  it("refuses to start before the voice is known", async () => {
    const { result } = setup();
    // No signature parts: rendered with the hook below.
    const unknown = renderHook(() => useAudiobookExport({
      document: book,
      sections,
      engineId: "kokoro",
      signatureParts: null,
      renderSection: () => (async function* () { yield chunk(); })(),
      library: { hasAudio: vi.fn(), loadAudio: vi.fn(), saveAudio: vi.fn() } as never,
    }));
    act(() => unknown.result.current.start({ kind: "book" }, "mp3"));
    expect(unknown.result.current.state).toMatchObject({ status: "failed", error: expect.stringMatching(/voice/i) });
    expect(result.current.state.status).toBe("idle");
  });

  it("runs one export at a time", async () => {
    const { result, encode } = setup();
    act(() => {
      result.current.start({ kind: "book" }, "mp3");
      result.current.start({ kind: "book" }, "zip");
    });
    await waitFor(() => expect(result.current.state.status).toBe("done"));
    expect(encode).toHaveBeenCalledTimes(2);
    expect(result.current.state.format).toBe("mp3");
  });
});

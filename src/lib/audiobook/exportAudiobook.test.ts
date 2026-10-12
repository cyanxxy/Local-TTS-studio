import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { AudioExportSourceChunk } from "../audioExportClient";
import type { ExportOptions, ExportResult } from "../exportAudio";
import { buildReaderSections, createReaderDocument, type CachedReaderAudioChunk } from "../readerDocument";
import {
  exportAudiobook,
  trimResumeStore,
  type AudiobookProgress,
  type AudiobookSectionSource,
  type EncodedChapterStore,
} from "./exportAudiobook";
import { planAudiobook, type PlannedSection } from "./plan";

const text = [
  "# One\n\n" + "First chapter sentence. ".repeat(700),
  "# Two\n\n" + "Second chapter sentence. ".repeat(40),
].join("\n\n");
const book = createReaderDocument({ id: "book", title: "A Book", author: "An Author", text });
const sections = buildReaderSections(book.text, book.chapters);
const plan = planAudiobook(book, sections, { kind: "book" });

const SECTION_SECONDS = 4;
const chunkFor = (): CachedReaderAudioChunk => ({
  audio: new Float32Array(24_000 * SECTION_SECONDS).fill(0.1).buffer,
  samplingRate: 24_000,
  text: "t",
  index: 0,
  total: 1,
});

function fakeSource(options: { cached?: ReadonlySet<string>; fail?: string } = {}) {
  const loaded: string[] = [];
  const source: AudiobookSectionSource = {
    signatureFor: (planned: PlannedSection) => `sig-${planned.section.id}`,
    load: vi.fn(async (planned: PlannedSection, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (options.fail === planned.section.id) throw new Error("engine fell over");
      loaded.push(planned.section.id);
      return { chunks: [chunkFor()], reused: options.cached?.has(planned.section.id) ?? false };
    }),
  };
  return { source, loaded };
}

function fakeEncode() {
  const calls: Array<{ chunks: readonly AudioExportSourceChunk[]; options: ExportOptions }> = [];
  const encode = vi.fn(async (chunks: readonly AudioExportSourceChunk[], options: ExportOptions) => {
    calls.push({ chunks, options });
    return {
      blob: new Blob([new Uint8Array(32).fill(calls.length)], { type: "audio/mpeg" }),
      extension: "mp3",
    } as ExportResult;
  });
  return { encode, calls };
}

const encoding = {
  bitrateKbps: 96,
  sampleRate: "source" as const,
  mastering: { enabled: true, targetLufs: -16, truePeakDb: -1 },
};

function request(overrides: Partial<Parameters<typeof exportAudiobook>[0]> = {}) {
  const { source } = fakeSource();
  const { encode } = fakeEncode();
  return {
    document: book,
    plan,
    format: "mp3" as const,
    encoding,
    source,
    encode,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("exportAudiobook", () => {
  it("renders every section, encodes one MP3 per chapter and joins them under chapter markers", async () => {
    const { source, loaded } = fakeSource({ cached: new Set([sections[0].id]) });
    const { encode, calls } = fakeEncode();
    const result = await exportAudiobook(request({ source, encode }));

    expect(loaded).toEqual(sections.map((section) => section.id));
    expect(calls).toHaveLength(2);
    expect(calls[0].chunks).toHaveLength(plan.chapters[0].sections.length);
    expect(calls[0].options).toMatchObject({ format: "mp3", bitrateKbps: 96, mastering: encoding.mastering });
    // A single MP3 carries the chapters in the book's tag, not in each chapter.
    expect(calls[0].options.metadata).toBeUndefined();

    expect(result.fileName).toBe("A Book.mp3");
    expect(result.chapters).toBe(2);
    expect(result.reusedSections).toBe(1);
    expect(result.renderedSections).toBe(sections.length - 1);
    expect(result.durationSec).toBeCloseTo(sections.length * SECTION_SECONDS);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 3))).toBe("ID3");
    expect(String.fromCharCode(...bytes.subarray(10, 14))).toBe("TIT2");
  });

  it("packs a zip of numbered chapter files with a playlist, each tagged on its own", async () => {
    const withCover = { ...book, cover: { dataUrl: `data:image/png;base64,${btoa("png")}` } };
    const { encode, calls } = fakeEncode();
    const result = await exportAudiobook(request({ format: "zip", document: withCover, encode }));

    expect(result.fileName).toBe("A Book.zip");
    expect(calls[0].options.metadata).toEqual({ title: "One", artist: "An Author", album: "A Book" });
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(Object.keys(files)).toEqual(["01 - One.mp3", "02 - Two.mp3", "playlist.m3u8", "cover.png"]);
    expect(new TextDecoder().decode(files["playlist.m3u8"])).toContain("02 - Two.mp3");
  });

  it("holds one chapter's audio at a time", async () => {
    const live = new Set<ArrayBuffer>();
    let peak = 0;
    const source: AudiobookSectionSource = {
      signatureFor: (planned) => `sig-${planned.section.id}`,
      load: async () => {
        const chunk = chunkFor();
        live.add(chunk.audio);
        peak = Math.max(peak, live.size);
        return { chunks: [chunk], reused: false };
      },
    };
    const encode = vi.fn(async (chunks: readonly AudioExportSourceChunk[]) => {
      // Once a chapter is encoded the exporter lets go of its audio.
      void chunks;
      live.clear();
      return { blob: new Blob([new Uint8Array(8)]), extension: "mp3" } as ExportResult;
    });
    await exportAudiobook(request({ source, encode }));
    expect(peak).toBe(plan.chapters[0].sections.length);
  });

  it("reports progress through rendering, encoding and packaging up to 1", async () => {
    const progress: AudiobookProgress[] = [];
    await exportAudiobook(request({ onProgress: (entry) => progress.push(entry) }));
    const phases = new Set(progress.map((entry) => entry.phase));
    expect([...phases]).toEqual(["rendering", "encoding", "packaging"]);
    const fractions = progress.map((entry) => entry.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBeGreaterThan(0.9);
    expect(Math.max(...fractions)).toBeLessThan(1);
    expect(progress.at(-1)).toMatchObject({ chapterCount: 2 });
  });

  it("stops at once when cancelled and rejects with the abort", async () => {
    const controller = new AbortController();
    const { source } = fakeSource();
    const loading = vi.mocked(source.load);
    loading.mockImplementationOnce(async () => {
      controller.abort(new DOMException("The export was cancelled.", "AbortError"));
      return { chunks: [chunkFor()], reused: false };
    });
    await expect(exportAudiobook(request({ source, signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(loading).toHaveBeenCalledTimes(1);
  });

  it("resumes: finished chapters are reused without touching the engine or the encoder", async () => {
    const resume: EncodedChapterStore = new Map();
    const first = fakeSource({ fail: sections.at(-1)!.id });
    const firstEncode = fakeEncode();
    // The second chapter fails after the first was finished and kept.
    await expect(exportAudiobook(request({ source: first.source, encode: firstEncode.encode, resume })))
      .rejects.toThrow("engine fell over");
    expect(firstEncode.calls).toHaveLength(1);
    expect(resume.size).toBe(1);

    const second = fakeSource();
    const secondEncode = fakeEncode();
    const result = await exportAudiobook(request({ source: second.source, encode: secondEncode.encode, resume }));
    expect(second.loaded).toEqual(plan.chapters[1].sections.map((section) => section.id));
    expect(secondEncode.calls).toHaveLength(1);
    expect(result).toMatchObject({ chapters: 2, reusedChapters: 1 });
  });

  it("does not reuse a chapter whose audio or encoder settings changed", async () => {
    const resume: EncodedChapterStore = new Map();
    await exportAudiobook(request({ resume }));
    const changedSource = fakeSource();
    changedSource.source.signatureFor = (planned) => `new-${planned.section.id}`;
    const encode = fakeEncode();
    await exportAudiobook(request({ source: changedSource.source, encode: encode.encode, resume }));
    expect(encode.calls).toHaveLength(2);

    const sameAudio = fakeEncode();
    await exportAudiobook(request({
      encoding: { ...encoding, bitrateKbps: 64 },
      encode: sameAudio.encode,
      resume,
    }));
    expect(sameAudio.calls).toHaveLength(2);
  });

  it("puts chapter markers on the encoded file's own timeline, not the PCM's", async () => {
    // Each chapter's MP3 is 10 s of frames whatever the PCM length was.
    const frames = new Uint8Array(417 * 288);
    for (let index = 0; index < 417; index += 1) frames.set([0xff, 0xf3, 0xa4, 0x00], index * 288);
    const encode = vi.fn(async () => ({ blob: new Blob([frames]), extension: "mp3" } as ExportResult));
    const result = await exportAudiobook(request({ encode }));
    expect(result.durationSec).toBeCloseTo(2 * 417 * 576 / 24_000, 6);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    // The first CHAP frame's end time is the first chapter's encoded length.
    const chap = bytes.findIndex((_, index) => String.fromCharCode(...bytes.subarray(index, index + 4)) === "CHAP");
    const idEnd = bytes.indexOf(0, chap + 10);
    expect(view.getUint32(idEnd + 1 + 4)).toBe(Math.round((417 * 576 / 24_000) * 1000));
  });

  it("keeps the retry store bounded, dropping the oldest chapters first", () => {
    const store: EncodedChapterStore = new Map();
    for (const key of ["a", "b", "c"]) store.set(key, { title: key, mp3: new Blob([new Uint8Array(100)]), durationSec: 1 });
    trimResumeStore(store, 250);
    expect([...store.keys()]).toEqual(["b", "c"]);
    trimResumeStore(store, 1);
    expect([...store.keys()]).toEqual(["c"]);
  });

  it("refuses an empty plan", async () => {
    const empty = planAudiobook(createReaderDocument({ id: "e", text: " " }), [], { kind: "book" });
    await expect(exportAudiobook(request({ plan: empty }))).rejects.toThrow("no text to export");
  });
});

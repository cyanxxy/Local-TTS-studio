import { describe, expect, it } from "vitest";
import { buildId3Tag, chaptersFromStarts, type Id3Chapter } from "./id3";

interface ParsedFrame {
  id: string;
  body: Uint8Array;
}

const decoder = new TextDecoder();

function readSyncsafe(bytes: Uint8Array, offset: number): number {
  for (let index = 0; index < 4; index += 1) expect(bytes[offset + index] & 0x80).toBe(0);
  return (bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3];
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset);
}

/** Reads v2.4 frames until padding (a zero byte where a frame ID would start). */
function parseFrames(bytes: Uint8Array): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  let offset = 0;
  while (offset + 10 <= bytes.length && bytes[offset] !== 0) {
    const id = decoder.decode(bytes.subarray(offset, offset + 4));
    const size = readSyncsafe(bytes, offset + 4);
    expect([bytes[offset + 8], bytes[offset + 9]]).toEqual([0, 0]);
    frames.push({ id, body: bytes.subarray(offset + 10, offset + 10 + size) });
    offset += 10 + size;
  }
  expect(bytes.subarray(offset).every((byte) => byte === 0)).toBe(true);
  return frames;
}

function parseTag(tag: Uint8Array): { size: number; frames: ParsedFrame[] } {
  expect(decoder.decode(tag.subarray(0, 3))).toBe("ID3");
  expect([tag[3], tag[4], tag[5]]).toEqual([4, 0, 0]);
  const size = readSyncsafe(tag, 6);
  expect(tag.length).toBe(10 + size);
  return { size, frames: parseFrames(tag.subarray(10)) };
}

function text(frame: ParsedFrame): string {
  expect(frame.body[0]).toBe(3);
  return decoder.decode(frame.body.subarray(1));
}

function readCString(bytes: Uint8Array, offset: number): [string, number] {
  const end = bytes.indexOf(0, offset);
  return [decoder.decode(bytes.subarray(offset, end)), end + 1];
}

function parseChapter(frame: ParsedFrame) {
  const [id, offset] = readCString(frame.body, 0);
  const [title] = parseFrames(frame.body.subarray(offset + 16));
  return {
    id,
    startMs: readUint32(frame.body, offset),
    endMs: readUint32(frame.body, offset + 4),
    offsets: [readUint32(frame.body, offset + 8), readUint32(frame.body, offset + 12)],
    title: text(title),
  };
}

function parseToc(frame: ParsedFrame) {
  const [id, idEnd] = readCString(frame.body, 0);
  let offset = idEnd;
  const flags = frame.body[offset];
  const count = frame.body[offset + 1];
  offset += 2;
  const children: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let child: string;
    [child, offset] = readCString(frame.body, offset);
    children.push(child);
  }
  const embedded = parseFrames(frame.body.subarray(offset));
  return { id, flags, children, title: embedded[0] ? text(embedded[0]) : undefined };
}

describe("buildId3Tag", () => {
  it("writes UTF-8 metadata frames with syncsafe sizes", () => {
    const tag = buildId3Tag({
      title: "Ünïcode   title",
      artist: "Narrator 🎙",
      album: "Book",
      date: "2026-10-11",
      comment: "Made with Open TTS",
      durationMs: 61234.4,
    }, [], { paddingBytes: 16 });
    const { frames } = parseTag(tag);
    expect(frames.map((frame) => frame.id)).toEqual(["TIT2", "TPE1", "TALB", "TDRC", "COMM", "TLEN"]);
    expect(text(frames[0])).toBe("Ünïcode title");
    expect(text(frames[1])).toBe("Narrator 🎙");
    expect(text(frames[3])).toBe("2026-10-11");
    expect(Array.from(frames[4].body.subarray(0, 5))).toEqual([3, 0x75, 0x6e, 0x64, 0]);
    expect(decoder.decode(frames[4].body.subarray(5))).toBe("Made with Open TTS");
    expect(text(frames[5])).toBe("61234");
    expect(tag.subarray(tag.length - 16).every((byte) => byte === 0)).toBe(true);
  });

  it("skips empty, invalid and control-character-only values", () => {
    const { frames } = parseTag(buildId3Tag({ title: "  ", artist: "\u0001\u0002", date: "11/10/2026", durationMs: -1 }));
    expect(frames).toEqual([]);
    expect(buildId3Tag({}).length).toBe(10 + 1024);
  });

  it("writes chapters with an ordered top-level table of contents", () => {
    const chapters: Id3Chapter[] = [
      { title: "Opening", startMs: 0, endMs: 1500 },
      { title: "", startMs: 1500, endMs: 4000.4 },
    ];
    const { frames } = parseTag(buildId3Tag({ title: "Book" }, chapters));
    expect(frames.map((frame) => frame.id)).toEqual(["TIT2", "CTOC", "CHAP", "CHAP"]);
    expect(parseToc(frames[1])).toEqual({ id: "toc", flags: 0x03, children: ["ch0", "ch1"], title: undefined });
    expect(parseChapter(frames[2])).toEqual({ id: "ch0", startMs: 0, endMs: 1500, offsets: [0xffffffff, 0xffffffff], title: "Opening" });
    // A chapter without a title falls back to its ID.
    expect(parseChapter(frames[3])).toMatchObject({ id: "ch1", startMs: 1500, endMs: 4000, title: "ch1" });
  });

  it("nests tables of contents beyond 255 chapters", () => {
    const chapters = Array.from({ length: 600 }, (_, index) => ({ title: `Part ${index + 1}`, startMs: index * 1000, endMs: (index + 1) * 1000 }));
    const { frames } = parseTag(buildId3Tag({}, chapters));
    const tocs = frames.filter((frame) => frame.id === "CTOC").map(parseToc);
    expect(tocs.map((toc) => [toc.id, toc.flags, toc.children.length, toc.title])).toEqual([
      ["toc", 0x03, 3, undefined],
      ["toc1", 0x01, 255, "Chapters 1-255"],
      ["toc2", 0x01, 255, "Chapters 256-510"],
      ["toc3", 0x01, 90, "Chapters 511-600"],
    ]);
    expect(tocs[0].children).toEqual(["toc1", "toc2", "toc3"]);
    expect(tocs[3].children.at(-1)).toBe("ch599");
    const chaps = frames.filter((frame) => frame.id === "CHAP").map(parseChapter);
    expect(chaps).toHaveLength(600);
    expect(chaps[599]).toMatchObject({ id: "ch599", startMs: 599000, endMs: 600000, title: "Part 600" });
  });

  it("rejects invalid chapter times and impossible sizes", () => {
    expect(() => buildId3Tag({}, [{ title: "a", startMs: 10, endMs: 5 }])).toThrow(/invalid time range/);
    expect(() => buildId3Tag({}, [{ title: "a", startMs: -1, endMs: 5 }])).toThrow(/invalid time range/);
    expect(() => buildId3Tag({}, [{ title: "a", startMs: Number.NaN, endMs: 5 }])).toThrow(/invalid time range/);
    expect(() => buildId3Tag({}, [
      { title: "a", startMs: 50, endMs: 60 },
      { title: "b", startMs: 10, endMs: 20 },
    ])).toThrow(/starts before the previous/);
    expect(() => buildId3Tag({}, [], { paddingBytes: 0x10000000 })).toThrow(/too large/);
    const tooMany = Array.from({ length: 255 * 255 + 1 }, (_, index) => ({ title: "", startMs: index, endMs: index + 1 }));
    expect(() => buildId3Tag({}, tooMany)).toThrow(/Too many chapters/);
  });
});

describe("chaptersFromStarts", () => {
  it("ends each chapter at the next start and the last at the duration", () => {
    expect(chaptersFromStarts([
      { title: "Two", startSec: 12.5 },
      { title: "One", startSec: 0 },
      { title: "Three", startSec: 30 },
    ], 45)).toEqual([
      { title: "One", startMs: 0, endMs: 12500 },
      { title: "Two", startMs: 12500, endMs: 30000 },
      { title: "Three", startMs: 30000, endMs: 45000 },
    ]);
  });

  it("clamps to the audio and drops empty or invalid chapters", () => {
    expect(chaptersFromStarts([
      { title: "Before", startSec: -3 },
      { title: "Same", startSec: 0 },
      { title: "Bad", startSec: Number.NaN },
      { title: "After", startSec: 99 },
    ], 10)).toEqual([{ title: "Same", startMs: 0, endMs: 10000 }]);
  });
});

import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { buildId3Tag } from "../audio/id3";
import {
  buildChapteredMp3,
  buildPlaylist,
  buildZip,
  coverFile,
  mp3AudioOffset,
} from "./package";

const frames = (fill: number, length = 64) => new Uint8Array(length).fill(fill);
const blobOf = (...parts: Uint8Array[]) => new Blob(parts as BlobPart[], { type: "audio/mpeg" });
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

function readSyncsafe(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3];
}
const uint32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset);

/** Reads the CHAP frames of a tag back: id, start, end. */
function readChapters(tag: Uint8Array) {
  const end = 10 + readSyncsafe(tag, 6);
  const chapters: Array<{ id: string; startMs: number; endMs: number; title: string }> = [];
  let offset = 10;
  while (offset + 10 < end && tag[offset] !== 0) {
    const id = String.fromCharCode(...tag.subarray(offset, offset + 4));
    const size = readSyncsafe(tag, offset + 4);
    const body = tag.subarray(offset + 10, offset + 10 + size);
    if (id === "CHAP") {
      const zero = body.indexOf(0);
      const times = zero + 1;
      const embedded = body.subarray(times + 16);
      chapters.push({
        id: String.fromCharCode(...body.subarray(0, zero)),
        startMs: uint32(body, times),
        endMs: uint32(body, times + 4),
        title: new TextDecoder().decode(embedded.subarray(10 + 1, 10 + readSyncsafe(embedded, 4))),
      });
    }
    offset += 10 + size;
  }
  return chapters;
}

describe("mp3AudioOffset", () => {
  it("is 0 for audio with no tag and skips a tag when there is one", async () => {
    expect(await mp3AudioOffset(blobOf(frames(0xff)))).toBe(0);
    const tag = buildId3Tag({ title: "Chapter" }, [], { paddingBytes: 20 });
    expect(await mp3AudioOffset(blobOf(tag, frames(0xff)))).toBe(tag.length);
  });
});

describe("buildChapteredMp3", () => {
  it("joins the chapters' audio under a tag whose chapters start where each one does", async () => {
    const one = blobOf(frames(1));
    const two = blobOf(buildId3Tag({ title: "own tag" }), frames(2));
    const three = blobOf(frames(3));
    const blob = await buildChapteredMp3([
      { title: "One", mp3: one, durationSec: 10 },
      { title: "Two", mp3: two, durationSec: 20.5 },
      { title: "Three", mp3: three, durationSec: 5 },
    ], { title: "A Book", artist: "An Author", album: "A Book" });

    const bytes = await bytesOf(blob);
    expect(String.fromCharCode(...bytes.subarray(0, 3))).toBe("ID3");
    const tagLength = 10 + readSyncsafe(bytes, 6);
    expect(readChapters(bytes.subarray(0, tagLength))).toEqual([
      { id: "ch0", startMs: 0, endMs: 10_000, title: "One" },
      { id: "ch1", startMs: 10_000, endMs: 30_500, title: "Two" },
      { id: "ch2", startMs: 30_500, endMs: 35_500, title: "Three" },
    ]);
    // Audio frames only: a chapter's own tag does not survive the join.
    const audio = bytes.subarray(tagLength);
    expect(Array.from(audio)).toEqual([...frames(1), ...frames(2), ...frames(3)]);
  });
});

describe("buildZip", () => {
  it("stores each entry as given", async () => {
    const zip = await buildZip([
      { name: "01 - One.mp3", data: blobOf(frames(7, 10)) },
      { name: "playlist.m3u8", data: new TextEncoder().encode("#EXTM3U\n") },
    ]);
    const files = unzipSync(await bytesOf(zip));
    expect(Object.keys(files)).toEqual(["01 - One.mp3", "playlist.m3u8"]);
    expect(Array.from(files["01 - One.mp3"])).toEqual(Array.from(frames(7, 10)));
    expect(strFromU8(files["playlist.m3u8"])).toBe("#EXTM3U\n");
  });
});

describe("buildPlaylist", () => {
  it("lists the chapters with their lengths and titles", () => {
    expect(buildPlaylist([
      { fileName: "01 - One.mp3", title: "One", durationSec: 61.4 },
      { fileName: "02 - Two.mp3", title: "Two\nmulti", durationSec: 5 },
    ])).toBe("#EXTM3U\n#EXTINF:61,One\n01 - One.mp3\n#EXTINF:5,Two multi\n02 - Two.mp3\n");
  });
});

describe("coverFile", () => {
  it("turns a raster data URL into a file and ignores anything else", () => {
    const cover = coverFile(`data:image/jpeg;base64,${btoa("jpegbytes")}`);
    expect(cover?.name).toBe("cover.jpg");
    expect(new TextDecoder().decode(cover?.data as Uint8Array)).toBe("jpegbytes");
    expect(coverFile("data:image/svg+xml;base64,AAAA")).toBeNull();
    expect(coverFile(undefined)).toBeNull();
  });
});

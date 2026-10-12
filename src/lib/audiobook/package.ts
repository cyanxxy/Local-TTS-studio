import { Zip, ZipPassThrough } from "fflate";
import { buildId3Tag, chaptersFromStarts, type Id3Metadata } from "../audio/id3";

/** One encoded chapter: an MP3 with no tag of its own, and how long it plays. */
export interface EncodedChapter {
  title: string;
  mp3: Blob;
  durationSec: number;
}

const ID3_HEADER_BYTES = 10;

/**
 * Where the MPEG frames of an MP3 begin, after an ID3v2 tag if it has one.
 * Reads only the 10 byte header.
 */
export async function mp3AudioOffset(mp3: Blob): Promise<number> {
  const header = new Uint8Array(await mp3.slice(0, ID3_HEADER_BYTES).arrayBuffer());
  if (header.length < ID3_HEADER_BYTES || header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return 0;
  const size = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) | ((header[8] & 0x7f) << 7) | (header[9] & 0x7f);
  const footer = (header[5] & 0x10) !== 0 ? ID3_HEADER_BYTES : 0;
  return ID3_HEADER_BYTES + size + footer;
}

/**
 * One MP3 holding every chapter back to back, with a book-level ID3v2.4 tag
 * whose CHAP/CTOC frames mark where each chapter starts. MPEG audio frames
 * concatenate without re-encoding, so each chapter is encoded (and cached)
 * on its own and joined here.
 */
export async function buildChapteredMp3(
  chapters: readonly EncodedChapter[],
  metadata: Omit<Id3Metadata, "durationMs">,
): Promise<Blob> {
  let elapsed = 0;
  const starts = chapters.map((chapter) => {
    const start = { title: chapter.title, startSec: elapsed };
    elapsed += chapter.durationSec;
    return start;
  });
  const tag = buildId3Tag({ ...metadata, durationMs: elapsed * 1000 }, chaptersFromStarts(starts, elapsed));
  const bodies = await Promise.all(chapters.map(async (chapter) => chapter.mp3.slice(await mp3AudioOffset(chapter.mp3))));
  return new Blob([tag as BlobPart, ...bodies], { type: "audio/mpeg" });
}

export interface ZipEntry {
  name: string;
  data: Blob | Uint8Array;
}

/** A zip of stored (not recompressed) entries; MP3 and images do not shrink. */
export async function buildZip(entries: readonly ZipEntry[]): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const zip = new Zip();
  const finished = new Promise<void>((resolve, reject) => {
    zip.ondata = (error, data, final) => {
      if (error) {
        reject(error);
        return;
      }
      parts.push(data.slice());
      if (final) resolve();
    };
  });
  for (const entry of entries) {
    const file = new ZipPassThrough(entry.name);
    zip.add(file);
    file.push(entry.data instanceof Blob ? new Uint8Array(await entry.data.arrayBuffer()) : entry.data, true);
  }
  zip.end();
  await finished;
  return new Blob(parts, { type: "application/zip" });
}

/** An extended M3U playlist, so players that open the folder keep chapter order and titles. */
export function buildPlaylist(entries: ReadonlyArray<{ fileName: string; title: string; durationSec: number }>): string {
  const lines = ["#EXTM3U"];
  for (const entry of entries) {
    lines.push(`#EXTINF:${Math.round(entry.durationSec)},${entry.title.replace(/[\r\n]+/g, " ")}`, entry.fileName);
  }
  return `${lines.join("\n")}\n`;
}

const COVER_DATA_URL = /^data:image\/(jpeg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/** The cover of a document as a file for the zip, or null. */
export function coverFile(dataUrl: string | undefined): ZipEntry | null {
  const match = dataUrl ? COVER_DATA_URL.exec(dataUrl) : null;
  if (!match) return null;
  const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
  return { name: `cover.${match[1] === "jpeg" ? "jpg" : match[1]}`, data: bytes };
}

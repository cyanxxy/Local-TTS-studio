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

const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

/**
 * The playing time of an MP3's frames, counted from the frame headers (Layer
 * III only), or null when it has none. Chapter markers are written from this
 * rather than from the PCM that was encoded, so they sit on the timeline a
 * player will actually decode, encoder padding included.
 */
export async function mp3DurationSec(mp3: Blob): Promise<number | null> {
  const bytes = new Uint8Array(await mp3.arrayBuffer());
  let offset = await mp3AudioOffset(mp3);
  let samples = 0;
  let rate = 0;
  let misses = 0;
  while (offset + 4 <= bytes.length) {
    const version = (bytes[offset + 1] >> 3) & 3;
    const layer = (bytes[offset + 1] >> 1) & 3;
    const bitrateIndex = bytes[offset + 2] >> 4;
    const rateIndex = (bytes[offset + 2] >> 2) & 3;
    const valid = bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0 && version !== 1
      && layer === 1 && bitrateIndex > 0 && bitrateIndex < 15 && rateIndex < 3;
    if (!valid) {
      // Padding or a trailing tag: resync, and give up on a long run of junk.
      offset += 1;
      misses += 1;
      if (misses > 4096 && samples === 0) return null;
      continue;
    }
    const sampleRate = SAMPLE_RATES[version][rateIndex];
    const kbps = (version === 3 ? MPEG1_L3_KBPS : MPEG2_L3_KBPS)[bitrateIndex];
    const padding = (bytes[offset + 2] >> 1) & 1;
    const frameBytes = Math.floor(((version === 3 ? 144_000 : 72_000) * kbps) / sampleRate) + padding;
    samples += version === 3 ? 1152 : 576;
    rate = sampleRate;
    offset += frameBytes;
  }
  return samples > 0 ? samples / rate : null;
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

const ZIP_READ_BYTES = 4 * 1024 * 1024;

/**
 * A zip of stored (not recompressed) entries; MP3 and images do not shrink.
 * Entries are read and written a few MiB at a time, and the output is kept as
 * Blob pieces, so the whole book is never in JavaScript memory at once.
 */
export async function buildZip(entries: readonly ZipEntry[]): Promise<Blob> {
  const parts: Blob[] = [];
  const zip = new Zip();
  const finished = new Promise<void>((resolve, reject) => {
    zip.ondata = (error, data, final) => {
      if (error) {
        reject(error);
        return;
      }
      parts.push(new Blob([data.slice()]));
      if (final) resolve();
    };
  });
  for (const entry of entries) {
    const file = new ZipPassThrough(entry.name);
    zip.add(file);
    if (entry.data instanceof Blob) {
      for (let start = 0; start < entry.data.size; start += ZIP_READ_BYTES) {
        const end = Math.min(entry.data.size, start + ZIP_READ_BYTES);
        file.push(new Uint8Array(await entry.data.slice(start, end).arrayBuffer()), end === entry.data.size);
      }
      if (entry.data.size === 0) file.push(new Uint8Array(0), true);
    } else {
      file.push(entry.data, true);
    }
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

import type { AudioExportSourceChunk } from "../audioExportClient";
import type { ExportOptions, ExportResult } from "../exportAudio";
import type { CachedReaderAudioChunk, ReaderDocumentRecord } from "../readerDocument";
import { cachedChunksDurationSec } from "../readerRender";
import {
  audiobookFileName,
  chapterFileName,
  plannedSections,
  type AudiobookPlan,
  type PlannedSection,
} from "./plan";
import {
  buildChapteredMp3,
  buildPlaylist,
  buildZip,
  coverFile,
  mp3DurationSec,
  type EncodedChapter,
  type ZipEntry,
} from "./package";

export type AudiobookFormat = "mp3" | "zip";

export interface AudiobookSection {
  chunks: CachedReaderAudioChunk[];
  /** Taken from the audio cache rather than rendered. */
  reused: boolean;
}

/** Where a section's audio comes from: the cache when it holds it, else the engine. */
export interface AudiobookSectionSource {
  /**
   * What the section's audio is made with, without making it. A finished
   * chapter is reused only while every section's signature is unchanged.
   */
  signatureFor: (planned: PlannedSection) => string;
  load: (planned: PlannedSection, signal: AbortSignal) => Promise<AudiobookSection>;
}

export type AudiobookPhase = "rendering" | "encoding" | "packaging";

export interface AudiobookProgress {
  phase: AudiobookPhase;
  /** 1-based chapter being worked on and how many there are. */
  chapter: number;
  chapterCount: number;
  /** Overall progress, 0 to 1. */
  fraction: number;
  /** Sections taken from the cache so far, and rendered so far. */
  reusedSections: number;
  renderedSections: number;
}

/**
 * Chapters already encoded, kept by the caller between attempts so a cancelled
 * or failed export resumes where it stopped. A chapter is reused only while
 * the audio it was made from (every section signature) and the encoder
 * settings are unchanged.
 */
export type EncodedChapterStore = Map<string, EncodedChapter>;

export interface AudiobookExportRequest {
  document: Pick<ReaderDocumentRecord, "id" | "title" | "author" | "text" | "cover" | "language">;
  plan: AudiobookPlan;
  format: AudiobookFormat;
  encoding: Pick<ExportOptions, "bitrateKbps" | "sampleRate" | "mastering">;
  source: AudiobookSectionSource;
  /** The export worker's entry point; injectable for tests. */
  encode: (
    chunks: readonly AudioExportSourceChunk[],
    options: ExportOptions,
    request: { signal?: AbortSignal },
  ) => Promise<ExportResult>;
  signal: AbortSignal;
  onProgress?: (progress: AudiobookProgress) => void;
  resume?: EncodedChapterStore;
}

export interface AudiobookResult {
  blob: Blob;
  fileName: string;
  durationSec: number;
  chapters: number;
  reusedSections: number;
  renderedSections: number;
  reusedChapters: number;
}

/** Encoded chapters kept for a retry, at most this many bytes (oldest dropped first). */
export const MAX_RESUME_BYTES = 256 * 1024 * 1024;

export function trimResumeStore(store: EncodedChapterStore, maxBytes: number): void {
  let total = 0;
  for (const entry of store.values()) total += entry.mp3.size;
  for (const [key, entry] of store) {
    if (total <= maxBytes || store.size <= 1) break;
    store.delete(key);
    total -= entry.mp3.size;
  }
}

function toExportChunk(chunk: CachedReaderAudioChunk): AudioExportSourceChunk {
  return {
    audio: new Float32Array(chunk.audio),
    samplingRate: chunk.samplingRate,
    ...(chunk.pauseAfterSec === undefined ? {} : { pauseAfterSec: chunk.pauseAfterSec }),
  };
}

function chapterStoreKey(
  plan: AudiobookPlan,
  chapterIndex: number,
  signatures: readonly string[],
  encoding: AudiobookExportRequest["encoding"],
  tagged: boolean,
): string {
  return JSON.stringify([
    plan.documentId,
    plan.chapters[chapterIndex].chapter.id,
    signatures,
    encoding.bitrateKbps,
    encoding.sampleRate,
    encoding.mastering,
    tagged,
  ]);
}

/**
 * Renders a book or a chapter to a chapter-marked MP3 or a zip of per-chapter
 * MP3s. Sections are taken one at a time from `source` (the audio cache first,
 * the engine for what is missing) and only one chapter's PCM is held at once;
 * a finished chapter is MP3 and is kept in `resume`.
 */
export async function exportAudiobook(request: AudiobookExportRequest): Promise<AudiobookResult> {
  const { document, plan, format, encoding, source, encode, signal, onProgress, resume } = request;
  if (plan.chapters.length === 0) throw new Error("There is no text to export.");
  const sections = plannedSections(plan, document);
  const totalCharacters = Math.max(1, sections.reduce((total, entry) => total + entry.text.length, 0));
  let doneCharacters = 0;
  let reusedSections = 0;
  let renderedSections = 0;
  let reusedChapters = 0;
  const encoded: EncodedChapter[] = [];

  const report = (phase: AudiobookPhase, chapterIndex: number, sectionFraction = 0, currentCharacters = 0) => {
    onProgress?.({
      phase,
      chapter: chapterIndex + 1,
      chapterCount: plan.chapters.length,
      // Rendering is nearly all of the work; encoding and packaging share the rest.
      fraction: phase === "packaging"
        ? 0.99
        : Math.min(0.98, ((doneCharacters + currentCharacters * sectionFraction) / totalCharacters) * 0.97),
      reusedSections,
      renderedSections,
    });
  };

  for (let chapterIndex = 0; chapterIndex < plan.chapters.length; chapterIndex += 1) {
    signal.throwIfAborted();
    const chapter = plan.chapters[chapterIndex];
    const chapterSections = sections.filter((entry) => entry.chapterIndex === chapterIndex);
    const signatures = chapterSections.map((planned) => source.signatureFor(planned));
    const storeKey = chapterStoreKey(plan, chapterIndex, signatures, encoding, format === "zip");
    const kept = resume?.get(storeKey);
    if (kept) {
      // Finished on an earlier attempt, and nothing it was made from changed.
      reusedChapters += 1;
      reusedSections += chapterSections.length;
      doneCharacters += chapterSections.reduce((total, planned) => total + planned.text.length, 0);
      encoded.push(kept);
      report("rendering", chapterIndex);
      continue;
    }

    const chunks: CachedReaderAudioChunk[] = [];
    for (const planned of chapterSections) {
      signal.throwIfAborted();
      report("rendering", chapterIndex, 0, planned.text.length);
      const result = await source.load(planned, signal);
      if (result.reused) reusedSections += 1;
      else renderedSections += 1;
      chunks.push(...result.chunks);
      doneCharacters += planned.text.length;
      report("rendering", chapterIndex);
    }

    if (chunks.length === 0) throw new Error(`Chapter “${chapter.chapter.title}” produced no audio.`);

    report("encoding", chapterIndex);
    const result = await encode(chunks.map(toExportChunk), {
      format: "mp3",
      sampleRate: encoding.sampleRate,
      bitrateKbps: encoding.bitrateKbps,
      mastering: encoding.mastering,
      // Zip entries are standalone files and carry their own tags; in a single
      // MP3 the book-level tag holds them all.
      ...(format === "zip"
        ? { metadata: { title: chapter.chapter.title, artist: plan.author, album: plan.title } }
        : {}),
    }, { signal });
    const entry: EncodedChapter = {
      title: chapter.chapter.title,
      mp3: result.blob,
      // The marker timeline is the encoded file's own, not the PCM's.
      durationSec: (await mp3DurationSec(result.blob)) ?? cachedChunksDurationSec(chunks),
    };
    if (resume) {
      resume.set(storeKey, entry);
      trimResumeStore(resume, MAX_RESUME_BYTES);
    }
    encoded.push(entry);
  }

  signal.throwIfAborted();
  report("packaging", plan.chapters.length - 1);
  const durationSec = encoded.reduce((total, chapter) => total + chapter.durationSec, 0);

  if (format === "mp3") {
    const blob = await buildChapteredMp3(encoded, {
      title: plan.scope.kind === "chapter" ? plan.chapters[0].chapter.title : plan.title,
      artist: plan.author,
      album: plan.title,
    });
    return {
      blob,
      fileName: audiobookFileName(plan, "mp3"),
      durationSec,
      chapters: encoded.length,
      reusedSections,
      renderedSections,
      reusedChapters,
    };
  }

  const entries: ZipEntry[] = encoded.map((chapter, index) => ({
    name: chapterFileName(plan, index),
    data: chapter.mp3,
  }));
  entries.push({
    name: "playlist.m3u8",
    data: new TextEncoder().encode(buildPlaylist(encoded.map((chapter, index) => ({
      fileName: chapterFileName(plan, index),
      title: chapter.title,
      durationSec: chapter.durationSec,
    })))),
  });
  const cover = coverFile(document.cover?.dataUrl);
  if (cover) entries.push(cover);
  return {
    blob: await buildZip(entries),
    fileName: audiobookFileName(plan, "zip"),
    durationSec,
    chapters: encoded.length,
    reusedSections,
    renderedSections,
    reusedChapters,
  };
}

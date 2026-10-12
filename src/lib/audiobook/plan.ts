import {
  getReaderSectionText,
  type ReaderChapter,
  type ReaderDocumentRecord,
  type ReaderSection,
} from "../readerDocument";
import { estimateSpeechBytes } from "../readerRender";

/** What to turn into an audiobook: the whole book, or one chapter of it. */
export type AudiobookScope = { kind: "book" } | { kind: "chapter"; chapterId: string };

export interface AudiobookChapterPlan {
  chapter: ReaderChapter;
  /** 1-based position among the chapters being exported. */
  number: number;
  sections: ReaderSection[];
  characters: number;
}

export interface AudiobookPlan {
  documentId: string;
  title: string;
  author: string;
  scope: AudiobookScope;
  chapters: AudiobookChapterPlan[];
  sectionCount: number;
  characters: number;
}

/** A section of the plan with its text, in listening order. */
export interface PlannedSection {
  chapterIndex: number;
  section: ReaderSection;
  text: string;
}

const SPEECH_CHARACTERS_PER_SECOND = 14;

/**
 * Groups the document's sections by chapter for an export. Chapters with no
 * speakable text are left out, so they never become empty entries in the
 * table of contents.
 */
export function planAudiobook(
  document: Pick<ReaderDocumentRecord, "id" | "title" | "author" | "text" | "chapters">,
  sections: readonly ReaderSection[],
  scope: AudiobookScope,
): AudiobookPlan {
  const chapters: AudiobookChapterPlan[] = [];
  for (const chapter of document.chapters) {
    if (scope.kind === "chapter" && chapter.id !== scope.chapterId) continue;
    const owned = sections.filter((section) => section.chapterId === chapter.id);
    const characters = owned.reduce(
      (total, section) => total + getReaderSectionText(document.text, section).trim().length,
      0,
    );
    if (owned.length === 0 || characters === 0) continue;
    chapters.push({ chapter, number: chapters.length + 1, sections: owned, characters });
  }
  return {
    documentId: document.id,
    title: document.title,
    author: document.author,
    scope,
    chapters,
    sectionCount: chapters.reduce((total, entry) => total + entry.sections.length, 0),
    characters: chapters.reduce((total, entry) => total + entry.characters, 0),
  };
}

export function plannedSections(
  plan: AudiobookPlan,
  document: Pick<ReaderDocumentRecord, "text">,
): PlannedSection[] {
  return plan.chapters.flatMap((entry, chapterIndex) => entry.sections.map((section) => ({
    chapterIndex,
    section,
    text: getReaderSectionText(document.text, section),
  })));
}

/** About how long the finished audio will be, from the text alone. */
export function estimateAudiobookSeconds(plan: Pick<AudiobookPlan, "characters">): number {
  return plan.characters / SPEECH_CHARACTERS_PER_SECOND;
}

/** About how much PCM the plan's audio is, for deciding whether it fits at once. */
export function estimateAudiobookPcmBytes(plan: Pick<AudiobookPlan, "characters">, sampleRate = 24_000): number {
  return estimateSpeechBytes(plan.characters, sampleRate);
}

/** "8 h 12 min", "42 min", "under a minute". */
export function formatAudiobookDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes} min` : `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const MAX_FILE_NAME_PART = 80;

/** A file name part safe on every platform: no separators or control characters, bounded length. */
export function safeFileNamePart(value: string, fallback = "Untitled"): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, MAX_FILE_NAME_PART)
    .trim();
  return cleaned || fallback;
}

/** "03 - Chapter title.mp3": numbered so any player sorts chapters in order. */
export function chapterFileName(plan: Pick<AudiobookPlan, "chapters">, index: number, extension = "mp3"): string {
  const width = Math.max(2, String(plan.chapters.length).length);
  const entry = plan.chapters[index];
  return `${String(entry.number).padStart(width, "0")} - ${safeFileNamePart(entry.chapter.title, `Chapter ${entry.number}`)}.${extension}`;
}

export function audiobookFileName(plan: Pick<AudiobookPlan, "title" | "scope" | "chapters">, extension: string): string {
  const book = safeFileNamePart(plan.title, "Audiobook");
  if (plan.scope.kind === "chapter" && plan.chapters[0]) {
    return `${book} - ${safeFileNamePart(plan.chapters[0].chapter.title)}.${extension}`;
  }
  return `${book}.${extension}`;
}

import type { ReaderChapter, ReaderSection } from "../../lib/readerDocument";

/** "af_heart" → "Heart" */
export function formatVoiceName(id: string): string {
  const i = id.indexOf("_");
  if (i === -1) return id;
  const name = id.slice(i + 1).replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Sections are a synthesis-sized window inside a chapter, so the same pair of
 * arrows turns a page within a long chapter and crosses into the next one.
 * Saying which it is beats a bare "next section" the reader has to decode.
 */
export function chapterStepLabel(
  section: ReaderSection | null,
  forward: boolean,
  currentChapterId: string | null,
  chapters: readonly ReaderChapter[],
): string {
  const direction = forward ? "Next" : "Previous";
  if (!section) return `${direction} page`;
  if (section.chapterId === currentChapterId) return `${direction} part of this chapter`;
  const chapter = chapters.find((entry) => entry.id === section.chapterId);
  return chapter ? `${direction} chapter: ${chapter.title}` : `${direction} chapter`;
}

/**
 * The ordinal is noise on screen for a 135-entry EPUB, but it is real
 * orientation for anyone hearing the label instead of seeing the rail.
 */
export function contentsButtonLabel(
  chapter: ReaderChapter | null,
  chapterCount: number,
  partIndex: number,
  partCount: number,
): string {
  if (!chapter) return "Contents";
  return `Contents · Chapter ${chapter.order + 1} of ${chapterCount}: ${chapter.title}`
    + (partCount > 1 ? `, part ${partIndex + 1} of ${partCount}` : "");
}

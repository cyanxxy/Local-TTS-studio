import { useMemo } from "react";
import {
  buildReaderSections,
  chapterAtOffset,
  getReaderSectionText,
  readerSectionAtOffset,
  type ReaderChapter,
  type ReaderDocumentRecord,
  type ReaderSection,
} from "../lib/readerDocument";

export interface ReaderSections {
  sections: readonly ReaderSection[];
  /** The section the document's progress points at, or null without a document. */
  activeSection: ReaderSection | null;
  /** `activeSection`'s position in `sections`, or -1 without one. */
  activeSectionIndex: number;
  activeChapter: ReaderChapter | null;
  previousSection: ReaderSection | null;
  nextSection: ReaderSection | null;
  /** The text the Reader synthesizes: the active section's slice of the document. */
  activeSectionText: string;
}

/**
 * Splits the open Reader document into bounded sections and locates the one its
 * progress points at.
 *
 * Every memo is keyed on the fields it reads, never on the record: a progress
 * write replaces the record about once a second during playback but keeps its
 * text and chapter references, so the sections (and their identities) survive
 * until the text or the chapter structure actually changes.
 */
export function useReaderSections(document: ReaderDocumentRecord | null): ReaderSections {
  const text = document?.text;
  const chapters = document?.chapters;
  const progressSectionId = document?.progress.sectionId;
  const progressTextOffset = document?.progress.textOffset;

  const sections = useMemo(
    () => (text === undefined || chapters === undefined ? [] : buildReaderSections(text, chapters)),
    [chapters, text],
  );

  const activeSection = useMemo(() => {
    if (progressTextOffset === undefined) return null;
    return sections.find((section) => section.id === progressSectionId)
      ?? readerSectionAtOffset(sections, progressTextOffset);
  }, [progressSectionId, progressTextOffset, sections]);

  const activeChapter = useMemo(() => {
    if (!chapters || !activeSection) return null;
    return chapters.find((chapter) => chapter.id === activeSection.chapterId)
      ?? chapterAtOffset(chapters, activeSection.start);
  }, [activeSection, chapters]);

  const activeSectionIndex = activeSection ? sections.indexOf(activeSection) : -1;
  return {
    sections,
    activeSection,
    activeSectionIndex,
    activeChapter,
    previousSection: activeSectionIndex > 0 ? sections[activeSectionIndex - 1] : null,
    nextSection: activeSectionIndex >= 0 ? sections[activeSectionIndex + 1] ?? null : null,
    activeSectionText: text === undefined ? "" : getReaderSectionText(text, activeSection),
  };
}

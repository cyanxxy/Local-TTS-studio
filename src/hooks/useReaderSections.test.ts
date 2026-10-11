import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as readerDocument from "../lib/readerDocument";
import { createReaderDocument, type ReaderDocumentRecord } from "../lib/readerDocument";
import { useReaderSections } from "./useReaderSections";

function longDocument(): ReaderDocumentRecord {
  return createReaderDocument({
    id: "long-book",
    title: "Long book",
    text: "A long paragraph for bounded synthesis. ".repeat(900),
  });
}

function withProgress(
  document: ReaderDocumentRecord,
  progress: Partial<ReaderDocumentRecord["progress"]>,
): ReaderDocumentRecord {
  return { ...document, progress: { ...document.progress, ...progress } };
}

describe("useReaderSections", () => {
  it("returns empty sections without a document", () => {
    const { result } = renderHook(() => useReaderSections(null));

    expect(result.current).toEqual({
      sections: [],
      activeSection: null,
      activeSectionIndex: -1,
      activeChapter: null,
      previousSection: null,
      nextSection: null,
      activeSectionText: "",
    });
  });

  it("locates the progress section with its neighbours, chapter and text", () => {
    const document = longDocument();
    const { result, rerender } = renderHook(({ doc }) => useReaderSections(doc), {
      initialProps: { doc: document },
    });
    const { sections } = result.current;
    expect(sections.length).toBeGreaterThan(2);
    expect(result.current.activeSection).toBe(sections[0]);
    expect(result.current.previousSection).toBeNull();
    expect(result.current.nextSection).toBe(sections[1]);

    rerender({ doc: withProgress(document, { sectionId: sections[1].id }) });
    expect(result.current.activeSection).toBe(sections[1]);
    expect(result.current.activeSectionIndex).toBe(1);
    expect(result.current.previousSection).toBe(sections[0]);
    expect(result.current.nextSection).toBe(sections[2]);
    expect(result.current.activeChapter?.id).toBe(sections[1].chapterId);
    expect(result.current.activeSectionText).toBe(document.text.slice(sections[1].start, sections[1].end));

    const last = sections.at(-1)!;
    rerender({ doc: withProgress(document, { sectionId: last.id }) });
    expect(result.current.nextSection).toBeNull();
  });

  it("falls back to the text offset when the progress names an unknown section", () => {
    const document = longDocument();
    const { result, rerender } = renderHook(({ doc }) => useReaderSections(doc), {
      initialProps: { doc: document },
    });
    const target = result.current.sections[2];

    rerender({ doc: withProgress(document, { sectionId: "stale-section", textOffset: target.start + 3 }) });
    expect(result.current.activeSection).toBe(target);
  });

  it("keeps the sections across progress writes and rebuilds them when the text changes", () => {
    const build = vi.spyOn(readerDocument, "buildReaderSections");
    const document = longDocument();
    const { result, rerender } = renderHook(({ doc }) => useReaderSections(doc), {
      initialProps: { doc: document },
    });
    const sections = result.current.sections;
    const builds = build.mock.calls.length;

    rerender({ doc: withProgress(document, { positionSec: 12, percent: 3 }) });
    expect(result.current.sections).toBe(sections);
    expect(build).toHaveBeenCalledTimes(builds);

    rerender({ doc: { ...document, text: `${document.text} One more sentence.` } });
    expect(result.current.sections).not.toBe(sections);
    expect(build).toHaveBeenCalledTimes(builds + 1);
    build.mockRestore();
  });
});

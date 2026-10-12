import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AudiobookExport, AudiobookExportState } from "../../hooks/useAudiobookExport";
import { buildReaderSections, createReaderDocument } from "../../lib/readerDocument";
import { planAudiobook } from "../../lib/audiobook/plan";
import { ReaderExportMenu } from "./ReaderExportMenu";

const book = createReaderDocument({
  id: "menu-book",
  title: "Menu Book",
  text: ["# One\n\n" + "First sentence. ".repeat(100), "# Two\n\n" + "Second sentence. ".repeat(100)].join("\n\n"),
});
const sections = buildReaderSections(book.text, book.chapters);

const idle: AudiobookExportState = { status: "idle", progress: null, error: null, result: null, scope: null, format: null };

function controller(state: Partial<AudiobookExportState> = {}): AudiobookExport {
  return {
    state: { ...idle, ...state },
    planFor: (scope) => planAudiobook(book, sections, scope),
    start: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
  };
}

function open(audiobook: AudiobookExport, chapterCount = 2) {
  render(
    <ReaderExportMenu
      audiobook={audiobook}
      chapterId={book.chapters[1].id}
      chapterTitle={book.chapters[1].title}
      chapterCount={chapterCount}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Export audiobook" }));
}

describe("ReaderExportMenu", () => {
  it("estimates the book and exports it as one chapter-marked MP3 by default", () => {
    const audiobook = controller();
    open(audiobook);
    expect(screen.getByText(/2 chapters · about/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create audiobook" }));
    expect(audiobook.start).toHaveBeenCalledWith({ kind: "book" }, "mp3");
  });

  it("exports just the current chapter, or chapter files in a zip, when asked", () => {
    const audiobook = controller();
    open(audiobook);
    fireEvent.click(screen.getByRole("button", { name: "This chapter" }));
    expect(screen.getByText(/1 chapter · about/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chapter files" }));
    fireEvent.click(screen.getByRole("button", { name: "Create audiobook" }));
    expect(audiobook.start).toHaveBeenCalledWith({ kind: "chapter", chapterId: book.chapters[1].id }, "zip");
  });

  it("offers no scope for a single-chapter book", () => {
    open(controller(), 1);
    expect(screen.queryByRole("button", { name: "Whole book" })).not.toBeInTheDocument();
  });

  it("shows progress while it runs and cancels on request", () => {
    const audiobook = controller({
      status: "running",
      progress: { phase: "rendering", chapter: 1, chapterCount: 2, fraction: 0.4, reusedSections: 3, renderedSections: 2 },
    });
    render(
      <ReaderExportMenu audiobook={audiobook} chapterId={null} chapterTitle={null} chapterCount={2} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Audiobook export, in progress" }));
    expect(screen.getByRole("progressbar", { name: "Audiobook export progress" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText(/Rendering chapter 1 of 2/)).toBeInTheDocument();
    expect(screen.getByText(/3 reused, 2 rendered/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    expect(audiobook.cancel).toHaveBeenCalledTimes(1);
  });

  it("reports a failure with a way to try again that keeps finished chapters", () => {
    const audiobook = controller({ status: "failed", error: "engine fell over", scope: { kind: "book" }, format: "mp3" });
    open(audiobook);
    expect(screen.getByRole("alert")).toHaveTextContent("engine fell over");
    expect(screen.getByRole("alert")).toHaveTextContent("kept");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(audiobook.start).toHaveBeenCalledWith({ kind: "book" }, "mp3");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(audiobook.dismiss).toHaveBeenCalled();
  });

  it("confirms a finished export", () => {
    open(controller({
      status: "done",
      result: { fileName: "Menu Book.mp3", durationSec: 3600, chapters: 2, reusedSections: 1, renderedSections: 1, reusedChapters: 0 },
    }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved Menu Book.mp3: 2 chapters, 1 h 00 min.");
  });
});

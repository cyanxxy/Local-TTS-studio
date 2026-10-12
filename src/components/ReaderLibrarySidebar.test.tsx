import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { PlaybackClock } from "../lib/playbackClock";
import { createReaderDocument, type ReaderDocumentRecord } from "../lib/readerDocument";
import { findDocumentMatches } from "../lib/readerSearch";
import {
  ReaderLibrarySidebar,
  type ReaderSidebarTab,
} from "./ReaderLibrarySidebar";

const readerDocument = createReaderDocument({
  id: "reader-document",
  title: "Reader document",
  text: "A short document.",
});

function SidebarHarness({
  withDocument = true,
  onUpdateMetadata = vi.fn(),
}: {
  withDocument?: boolean;
  onUpdateMetadata?: (patch: { title?: string; author?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ReaderSidebarTab>("library");

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open library</button>
      <ReaderLibrarySidebar
        open={open}
        documents={[readerDocument]}
        activeDocument={withDocument ? readerDocument : null}
        currentTextOffset={0}
        clock={new PlaybackClock()}
        onClose={() => setOpen(false)}
        onOpenDocument={vi.fn()}
        onNewDocument={vi.fn()}
        onDeleteDocument={vi.fn()}
        onUpdateMetadata={onUpdateMetadata}
        onJumpToOffset={vi.fn()}
        onAddBookmark={vi.fn()}
        onRemoveBookmark={vi.fn()}
        onAddNote={vi.fn()}
        onUpdateNote={vi.fn()}
        onRemoveNote={vi.fn()}
        tab={tab}
        onTabChange={setTab}
      />
    </>
  );
}

describe("ReaderLibrarySidebar", () => {
  it("shows each book's current chapter and estimated listening time left", () => {
    const book = createReaderDocument({
      id: "long-book",
      title: "Long book",
      text: `# Opening\n${"Words to listen to. ".repeat(100)}\n\n# Ending\n${"More words to hear. ".repeat(100)}`,
    });
    const midway = { ...book, progress: { ...book.progress, textOffset: book.chapters[1].start + 5 } };
    render(
      <ReaderLibrarySidebar
        open
        documents={[midway]}
        activeDocument={null}
        currentTextOffset={0}
        clock={new PlaybackClock()}
        onClose={vi.fn()}
        onOpenDocument={vi.fn()}
        onNewDocument={vi.fn()}
        onDeleteDocument={vi.fn()}
        onUpdateMetadata={vi.fn()}
        onJumpToOffset={vi.fn()}
        onAddBookmark={vi.fn()}
        onRemoveBookmark={vi.fn()}
        onAddNote={vi.fn()}
        onUpdateNote={vi.fn()}
        onRemoveNote={vi.fn()}
        tab="library"
        onTabChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Ending")).toBeInTheDocument();
    expect(screen.getByText(/^≈\d+m left · Opened/)).toBeInTheDocument();
  });

  it("lays out all five tabs in one row", () => {
    render(<SidebarHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open library" }));

    expect(screen.getByRole("tab", { name: "Library" }).parentElement).toHaveClass("grid-cols-5");
  });

  it("uses modal drawer semantics and restores focus on close", async () => {
    render(<SidebarHarness />);
    const trigger = screen.getByRole("button", { name: "Open library" });
    trigger.focus();
    fireEvent.click(trigger);

    const drawer = screen.getByRole("dialog", { name: "Reader library" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("flushes a pending metadata edit before Escape closes the drawer", () => {
    const onUpdateMetadata = vi.fn();
    render(<SidebarHarness onUpdateMetadata={onUpdateMetadata} />);
    fireEvent.click(screen.getByRole("button", { name: "Open library" }));
    fireEvent.click(screen.getByRole("tab", { name: "Contents" }));

    const title = screen.getByDisplayValue("Reader document");
    fireEvent.change(title, { target: { value: "Updated reader title" } });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onUpdateMetadata).toHaveBeenCalledWith({ title: "Updated reader title" });
  });

  it("keeps Tab inside the drawer", () => {
    render(<SidebarHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open library" }));

    const drawer = screen.getByRole("dialog", { name: "Reader library" });
    const focusable = [...drawer.querySelectorAll<HTMLElement>("button, input, textarea")];
    const first = focusable[0];
    const last = focusable.at(-1)!;

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("moves between tabs with the arrow keys", () => {
    render(<SidebarHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open library" }));

    const libraryTab = screen.getByRole("tab", { name: "Library" });
    expect(libraryTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(libraryTab, { key: "ArrowRight" });

    expect(screen.getByRole("tab", { name: "Contents" })).toHaveAttribute("aria-selected", "true");
    expect(libraryTab).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Contents" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
  });

  it("explains why a document tab is empty when nothing is open", () => {
    render(<SidebarHarness withDocument={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open library" }));
    fireEvent.click(screen.getByRole("tab", { name: "Bookmarks" }));

    expect(screen.getByText("No document open")).toBeInTheDocument();
  });

  it("focuses search when reopening with the Search tab selected", async () => {
    render(<SidebarHarness />);
    const trigger = screen.getByRole("button", { name: "Open library" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("tab", { name: "Search" }));
    await waitFor(() => expect(screen.getByPlaceholderText("Search this document")).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Close Reader library" }));
    fireEvent.click(trigger);

    await waitFor(() => expect(screen.getByPlaceholderText("Search this document")).toHaveFocus());
  });

  it("debounces the query before searching the full text", () => {
    vi.useFakeTimers();
    try {
      render(<SidebarHarness />);
      fireEvent.click(screen.getByRole("button", { name: "Open library" }));
      fireEvent.click(screen.getByRole("tab", { name: "Search" }));

      const input = screen.getByPlaceholderText("Search this document");
      fireEvent.change(input, { target: { value: "short" } });

      expect(input).toHaveValue("short");
      expect(screen.getByText(/Type at least two characters/)).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(screen.getByText("short")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps source offsets aligned when Unicode case folding changes length", () => {
    expect(findDocumentMatches("İaİa", "İa")).toEqual([
      expect.objectContaining({ offset: 0, match: "İa" }),
      expect.objectContaining({ offset: 2, match: "İa" }),
    ]);
  });

  describe("annotations", () => {
    const text = "Call me Ishmael. Some years ago I went to sea.";
    const annotated: ReaderDocumentRecord = {
      ...createReaderDocument({ id: "annotated", title: "Moby Dick", text }),
      highlights: [
        { id: "hl-1", start: 0, end: 15, color: "yellow", quote: "Call me Ishmael", createdAt: 1, updatedAt: 1 },
        { id: "hl-2", start: 33, end: 44, color: "blue", quote: "sailed away", createdAt: 1, updatedAt: 1 },
      ],
    };

    function renderAnnotated(overrides: Partial<ComponentProps<typeof ReaderLibrarySidebar>> = {}) {
      const props: ComponentProps<typeof ReaderLibrarySidebar> = {
        open: true,
        documents: [annotated],
        activeDocument: annotated,
        currentTextOffset: 0,
        clock: new PlaybackClock(),
        onClose: vi.fn(),
        onOpenDocument: vi.fn(),
        onNewDocument: vi.fn(),
        onDeleteDocument: vi.fn(),
        onUpdateMetadata: vi.fn(),
        onJumpToOffset: vi.fn(),
        onAddBookmark: vi.fn(),
        onRemoveBookmark: vi.fn(),
        onAddNote: vi.fn(),
        onUpdateNote: vi.fn(),
        onRemoveNote: vi.fn(),
        tab: "notes",
        onTabChange: vi.fn(),
        ...overrides,
      };
      render(<ReaderLibrarySidebar {...props} />);
      return props;
    }

    it("lists highlights in the Notes tab with jump, recolour and remove", () => {
      const onUpdateHighlight = vi.fn();
      const onRemoveHighlight = vi.fn();
      const props = renderAnnotated({ onUpdateHighlight, onRemoveHighlight });
      const list = within(screen.getByRole("region", { name: "Highlights" }));

      fireEvent.click(list.getByRole("button", { name: "Call me Ishmael" }));
      expect(props.onJumpToOffset).toHaveBeenCalledWith(0);
      // A highlight whose words were edited away stays listed without a jump.
      expect(list.getByText("This passage was edited away.")).toBeInTheDocument();
      expect(list.queryByRole("button", { name: /sailed away/ })).toBeNull();

      const [firstPink] = list.getAllByRole("button", { name: "Pink highlight" });
      fireEvent.click(firstPink);
      expect(onUpdateHighlight).toHaveBeenCalledWith("hl-1", { color: "pink" });
      fireEvent.click(list.getAllByRole("button", { name: "Yellow highlight" })[0]);
      expect(onUpdateHighlight).toHaveBeenCalledTimes(1);

      fireEvent.click(list.getAllByRole("button", { name: "Remove" })[1]);
      expect(onRemoveHighlight).toHaveBeenCalledWith("hl-2");
    });

    it("lists highlights read-only when they cannot be changed", () => {
      renderAnnotated();
      const list = within(screen.getByRole("region", { name: "Highlights" }));

      expect(list.queryByRole("button", { name: "Pink highlight" })).toBeNull();
      expect(list.queryByRole("button", { name: "Remove" })).toBeNull();
    });

    it("downloads the annotations as a file from the Bookmarks tab", () => {
      const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:annotations");
      const revokeObjectURL = vi.fn();
      vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }));
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        renderAnnotated({ tab: "bookmarks" });
        fireEvent.click(screen.getByRole("button", { name: "Export notes, highlights and bookmarks as JSON" }));

        expect(click).toHaveBeenCalledTimes(1);
        const anchor = click.mock.contexts[0] as HTMLAnchorElement;
        expect(anchor.download).toBe("Moby-Dick-annotations.json");
        expect(createObjectURL.mock.calls[0][0].type).toBe("application/json;charset=utf-8");
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:annotations");
        expect(anchor.isConnected).toBe(false);
      } finally {
        vi.useRealTimers();
        click.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it("offers no export for a book without annotations", () => {
      renderAnnotated({ activeDocument: readerDocument, documents: [readerDocument] });

      expect(screen.queryByRole("group", { name: "Export annotations" })).toBeNull();
    });

    it("shows a book's cover on its library card", () => {
      const cover = { dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
      const { container } = render(
        <ReaderLibrarySidebar
          open
          documents={[{ ...annotated, cover }, readerDocument]}
          activeDocument={null}
          currentTextOffset={0}
          clock={new PlaybackClock()}
          onClose={vi.fn()}
          onOpenDocument={vi.fn()}
          onNewDocument={vi.fn()}
          onDeleteDocument={vi.fn()}
          onUpdateMetadata={vi.fn()}
          onJumpToOffset={vi.fn()}
          onAddBookmark={vi.fn()}
          onRemoveBookmark={vi.fn()}
          onAddNote={vi.fn()}
          onUpdateNote={vi.fn()}
          onRemoveNote={vi.fn()}
          tab="library"
          onTabChange={vi.fn()}
        />,
      );

      const images = container.querySelectorAll("img");
      expect(images).toHaveLength(1);
      expect(images[0]).toHaveAttribute("src", cover.dataUrl);
      expect(images[0]).toHaveAttribute("alt", "");
    });
  });

  it("exports a single chapter's audio from the table of contents, when exporting is available", () => {
    const book = createReaderDocument({
      id: "export-book",
      title: "Export book",
      text: `# Opening\n${"Words to listen to. ".repeat(50)}\n\n# Ending\n${"More words to hear. ".repeat(50)}`,
    });
    const onExportChapter = vi.fn();
    const props = {
      open: true,
      documents: [book],
      activeDocument: book,
      currentTextOffset: 0,
      clock: new PlaybackClock(),
      onClose: vi.fn(),
      onOpenDocument: vi.fn(),
      onNewDocument: vi.fn(),
      onDeleteDocument: vi.fn(),
      onUpdateMetadata: vi.fn(),
      onJumpToOffset: vi.fn(),
      onAddBookmark: vi.fn(),
      onRemoveBookmark: vi.fn(),
      onAddNote: vi.fn(),
      onUpdateNote: vi.fn(),
      onRemoveNote: vi.fn(),
      tab: "contents" as const,
      onTabChange: vi.fn(),
    };
    const { unmount } = render(<ReaderLibrarySidebar {...props} />);
    expect(screen.queryByRole("button", { name: /Export audio for/ })).not.toBeInTheDocument();
    unmount();

    render(<ReaderLibrarySidebar {...props} onExportChapter={onExportChapter} />);
    fireEvent.click(screen.getByRole("button", { name: "Export audio for Ending" }));
    expect(onExportChapter).toHaveBeenCalledWith(book.chapters[1].id);
    expect(props.onJumpToOffset).not.toHaveBeenCalled();
  });
});

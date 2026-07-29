import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PlaybackClock } from "../lib/playbackClock";
import { createReaderDocument } from "../lib/readerDocument";
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
});

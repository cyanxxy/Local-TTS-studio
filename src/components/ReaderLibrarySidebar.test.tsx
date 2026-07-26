import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function SidebarHarness() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ReaderSidebarTab>("library");

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open library</button>
      <ReaderLibrarySidebar
        open={open}
        documents={[readerDocument]}
        activeDocument={readerDocument}
        currentTextOffset={0}
        clock={new PlaybackClock()}
        onClose={() => setOpen(false)}
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

    expect(screen.getByRole("button", { name: "Library" }).parentElement).toHaveClass("grid-cols-5");
  });

  it("uses non-modal drawer semantics and restores focus on close", async () => {
    render(<SidebarHarness />);
    const trigger = screen.getByRole("button", { name: "Open library" });
    trigger.focus();
    fireEvent.click(trigger);

    const drawer = screen.getByRole("dialog", { name: "Reader library" });
    expect(drawer).not.toHaveAttribute("aria-modal");
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("focuses search when reopening with the Search tab selected", async () => {
    render(<SidebarHarness />);
    const trigger = screen.getByRole("button", { name: "Open library" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByPlaceholderText("Search this document")).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Close Reader library" }));
    fireEvent.click(trigger);

    await waitFor(() => expect(screen.getByPlaceholderText("Search this document")).toHaveFocus());
  });

  it("keeps source offsets aligned when Unicode case folding changes length", () => {
    expect(findDocumentMatches("İaİa", "İa")).toEqual([
      expect.objectContaining({ offset: 0, match: "İa" }),
      expect.objectContaining({ offset: 2, match: "İa" }),
    ]);
  });
});

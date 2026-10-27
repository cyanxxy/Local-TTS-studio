import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReaderShortcutsDialog } from "./ReaderShortcutsDialog";

describe("ReaderShortcutsDialog", () => {
  it("stays open when a drag that starts inside ends over the backdrop", () => {
    const onClose = vi.fn();
    render(<ReaderShortcutsDialog onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const backdrop = dialog.parentElement!;

    // Selecting text inside and releasing outside: the click lands on the
    // backdrop, the common ancestor, but the press did not.
    fireEvent.pointerDown(dialog);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a press on the backdrop itself", () => {
    const onClose = vi.fn();
    render(<ReaderShortcutsDialog onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole("dialog", { name: "Keyboard shortcuts" }).parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

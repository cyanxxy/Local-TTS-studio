import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ViewportPopover } from "./ViewportPopover";

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => setOpen((value) => !value)}>Anchor</button>
      <p>Page text</p>
      <div data-portal-menu>
        <button type="button">Portaled option</button>
      </div>
      {open && (
        <ViewportPopover
          anchorRef={anchorRef}
          popoverRef={popoverRef}
          maxWidth={320}
          className="popover"
          ariaLabel="Settings"
          keepOpenWithin="[data-portal-menu]"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <button type="button">Inside</button>
        </ViewportPopover>
      )}
    </>
  );
}

describe("ViewportPopover", () => {
  it("renders a labelled modal dialog sized to the viewport", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Settings" });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.style.width).toBe("320px");
  });

  it("closes on a press outside itself and its anchor", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "Inside" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Anchor" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Portaled option" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByText("Page text"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hangs below the anchor from its top edge, growing out of the anchor's corner", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.style.bottom).toBe("");
    expect(dialog.style.transformOrigin).toBe("top right");
  });

  it("opening above the anchor sits on its bottom edge, with no gap for unused height", () => {
    // An anchor near the bottom of a 768px window: no room below.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 700, bottom: 740, left: 600, right: 640, width: 40, height: 40, x: 600, y: 700, toJSON: () => ({}),
    });
    const clientHeight = vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Settings" });

    // 8px above the anchor's top, however short the content turns out to be.
    expect(dialog.style.top).toBe("");
    expect(dialog.style.bottom).toBe(`${768 - (700 - 8)}px`);
    expect(dialog.style.transformOrigin).toBe("bottom right");
    rect.mockRestore();
    clientHeight.mockRestore();
  });
});


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
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { focusableWithin, useFocusTrap } from "./useFocusTrap";

function Harness({
  onEscape = vi.fn(),
  autoFocus,
  empty = false,
  returnToAnchor = false,
}: {
  onEscape?: () => void;
  autoFocus?: boolean;
  empty?: boolean;
  returnToAnchor?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(containerRef, {
    active: open,
    onEscape,
    autoFocus,
    returnFocusRef: returnToAnchor ? anchorRef : undefined,
  });
  return (
    <>
      <button ref={anchorRef} type="button">Anchor</button>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <button type="button" onClick={() => setOpen(false)}>Close outside</button>
      {open && (
        <div ref={containerRef} tabIndex={-1} data-testid="trap">
          {!empty && (
            <>
              <button type="button">First</button>
              <button type="button" disabled>Disabled</button>
              <input aria-label="Middle" />
              <button type="button">Last</button>
            </>
          )}
        </div>
      )}
    </>
  );
}

function flushFrame() {
  return act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
}

describe("focusableWithin", () => {
  it("lists enabled keyboard-reachable controls in DOM order", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <button>One</button><button disabled>Off</button><a href="#x">Link</a>
      <span tabindex="0">Tab stop</span><span tabindex="-1">Skipped</span><textarea></textarea>
    `;
    expect(focusableWithin(container).map((element) => element.textContent || element.tagName))
      .toEqual(["One", "Link", "Tab stop", "TEXTAREA"]);
  });
});

describe("useFocusTrap", () => {
  it("moves focus into the container and cycles Tab inside it", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await flushFrame();

    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("pulls focus back in when it escaped to the page behind", () => {
    render(<Harness autoFocus={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    screen.getByRole("button", { name: "Anchor" }).focus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();

    screen.getByRole("button", { name: "Anchor" }).focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
  });

  it("keeps focus on an empty container", async () => {
    render(<Harness empty />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await flushFrame();

    const trap = screen.getByTestId("trap");
    expect(trap).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(trap).toHaveFocus();
  });

  it("dismisses on Escape and returns focus to where it came from", () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    const open = screen.getByRole("button", { name: "Open" });
    open.focus();
    fireEvent.click(open);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close outside" }));
    expect(open).toHaveFocus();
  });

  it("returns focus to an explicit anchor when given one", () => {
    render(<Harness returnToAnchor />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Close outside" }));

    expect(screen.getByRole("button", { name: "Anchor" })).toHaveFocus();
  });

  it("ignores keys while inactive", () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(onEscape).not.toHaveBeenCalled();
  });
});

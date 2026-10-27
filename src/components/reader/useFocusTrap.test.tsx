import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { focusableWithin, isTopFocusTrap, useFocusTrap } from "./useFocusTrap";

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

describe("focusableWithin and hidden controls (F4)", () => {
  it("skips controls that are not rendered: closed details, hidden and inert subtrees", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <button>Visible</button>
      <details><summary>Advanced</summary><input aria-label="Inside closed details" /></details>
      <details open><summary>Open</summary><input aria-label="Inside open details" /></details>
      <div hidden><button>Hidden</button></div>
      <div inert><button>Inert</button></div>
      <button>Last visible</button>
    `;
    expect(focusableWithin(container).map((element) => element.textContent || element.getAttribute("aria-label")))
      .toEqual(["Visible", "Advanced", "Open", "Inside open details", "Last visible"]);
  });

  it("wraps Tab from the last visible control instead of stalling on a hidden one", async () => {
    function Trap() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, { active: true, onEscape: vi.fn() });
      return (
        <div ref={ref}>
          <button type="button">First</button>
          <button type="button">Last</button>
          <details><summary>More</summary><input aria-label="Hidden field" /></details>
        </div>
      );
    }
    render(<Trap />);
    await flushFrame();
    screen.getByText("More").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
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

  it("lets only the innermost of two open traps handle Escape and Tab", async () => {
    const outerEscape = vi.fn();
    const innerEscape = vi.fn();
    function Nested() {
      const outerRef = useRef<HTMLDivElement>(null);
      const innerRef = useRef<HTMLDivElement>(null);
      const [innerOpen, setInnerOpen] = useState(true);
      useFocusTrap(outerRef, { active: true, onEscape: outerEscape });
      useFocusTrap(innerRef, {
        active: innerOpen,
        onEscape: () => {
          innerEscape();
          setInnerOpen(false);
        },
      });
      return (
        <>
          <div ref={outerRef}><button type="button">Outer</button></div>
          {innerOpen && <div ref={innerRef}><button type="button">Inner</button></div>}
        </>
      );
    }
    render(<Nested />);
    await flushFrame();

    const inner = screen.getByRole("button", { name: "Inner" });
    inner.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(inner).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(innerEscape).toHaveBeenCalledTimes(1);
    expect(outerEscape).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(outerEscape).toHaveBeenCalledTimes(1);
    expect(innerEscape).toHaveBeenCalledTimes(1);
  });

  it("leaves an Escape that a control inside already handled to that control", () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const first = screen.getByRole("button", { name: "First" });
    first.addEventListener("keydown", (event) => event.preventDefault());

    fireEvent.keyDown(first, { key: "Escape" });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("does not pull focus out of a surface on top when the one beneath closes (U2)", async () => {
    function Stacked() {
      const lowerRef = useRef<HTMLDivElement>(null);
      const upperRef = useRef<HTMLDivElement>(null);
      const [lowerOpen, setLowerOpen] = useState(true);
      useFocusTrap(lowerRef, { active: lowerOpen, onEscape: vi.fn() });
      useFocusTrap(upperRef, { active: true, onEscape: vi.fn(), autoFocus: false });
      return (
        <>
          <button type="button">Origin</button>
          {lowerOpen && <div ref={lowerRef}><button type="button" onClick={() => setLowerOpen(false)}>Lower</button></div>}
          <div ref={upperRef}><button type="button">Upper</button></div>
        </>
      );
    }
    render(<Stacked />);
    await flushFrame();
    const upper = screen.getByRole("button", { name: "Upper" });
    expect(isTopFocusTrap(upper.parentElement)).toBe(true);
    expect(isTopFocusTrap(screen.getByRole("button", { name: "Lower" }).parentElement)).toBe(false);

    upper.focus();
    fireEvent.click(screen.getByRole("button", { name: "Lower" }));
    expect(upper).toHaveFocus();
  });

  it("ignores keys while inactive", () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(onEscape).not.toHaveBeenCalled();
  });
});

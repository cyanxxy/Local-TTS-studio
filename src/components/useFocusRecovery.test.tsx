import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { useFocusRecovery } from "./useFocusRecovery";

function Swap({ withFallback = true }: { withFallback?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  useFocusRecovery(containerRef, withFallback ? () => keepRef.current : undefined);
  return (
    <>
      <button type="button">Outside</button>
      <div ref={containerRef}>
        <button type="button">First</button>
        {confirming
          // A different element shape, so React replaces the node rather than
          // reusing it (a reused node would simply keep focus).
          ? <span><button ref={keepRef} type="button" onClick={() => setConfirming(false)}>Keep</button></span>
          : <button type="button" onClick={() => setConfirming(true)}>Delete</button>}
        <button type="button" disabled={busy} onClick={() => setBusy(true)}>Start</button>
      </div>
    </>
  );
}

describe("useFocusRecovery", () => {
  it("moves focus to the named fallback when the focused control unmounts", () => {
    render(<Swap />);
    const deleteButton = screen.getByRole("button", { name: "Delete" });
    deleteButton.focus();
    fireEvent.click(deleteButton);
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
  });

  it("falls back to the container's first control", () => {
    render(<Swap />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const keep = screen.getByRole("button", { name: "Keep" });
    keep.focus();
    fireEvent.click(keep);
    // Keep is gone and its fallback with it.
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("leaves focus alone when something else already has it", () => {
    render(<Swap />);
    const deleteButton = screen.getByRole("button", { name: "Delete" });
    deleteButton.focus();
    screen.getByRole("button", { name: "Outside" }).focus();
    fireEvent.click(deleteButton);
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  });

  it("keeps a control that is only disabled for now when no fallback is named", () => {
    render(<Swap withFallback={false} />);
    const start = screen.getByRole("button", { name: "Start" });
    start.focus();
    fireEvent.click(start);
    expect(start).toBeDisabled();
    expect(screen.getByRole("button", { name: "First" })).not.toHaveFocus();
  });
});

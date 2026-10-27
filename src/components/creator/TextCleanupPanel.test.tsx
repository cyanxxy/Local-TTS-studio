import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TextCleanupPanel } from "./TextCleanupPanel";

const MESSY = "The **launch** went well [1]. See https://example.com/page 😀 !!!";

describe("TextCleanupPanel", () => {
  it("previews every change before touching the script", () => {
    const onTextChange = vi.fn();
    render(<TextCleanupPanel text={MESSY} onTextChange={onTextChange} />);

    const preview = screen.getByTestId("cleanup-preview");
    expect(preview).toHaveTextContent("Removed: **");
    expect(screen.getByText(/changes:/)).toHaveTextContent(/markdown/);
    expect(preview.querySelectorAll("del").length).toBeGreaterThan(2);
    expect(onTextChange).not.toHaveBeenCalled();
  });

  it("applies the cleanup once and offers to undo it", () => {
    const onTextChange = vi.fn();
    const { rerender } = render(<TextCleanupPanel text={MESSY} onTextChange={onTextChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Clean up script" }));
    expect(onTextChange).toHaveBeenCalledTimes(1);
    const cleaned = onTextChange.mock.calls[0][0] as string;
    expect(cleaned).toContain("The launch went well.");
    expect(cleaned).not.toContain("**");
    expect(cleaned).not.toContain("[1]");
    rerender(<TextCleanupPanel text={cleaned} onTextChange={onTextChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Undo cleanup" }));
    expect(onTextChange).toHaveBeenLastCalledWith(MESSY);
    rerender(<TextCleanupPanel text={MESSY} onTextChange={onTextChange} />);
    expect(screen.queryByRole("button", { name: "Undo cleanup" })).not.toBeInTheDocument();
  });

  it("stops offering undo once the script has been edited since the cleanup", () => {
    const onTextChange = vi.fn();
    const { rerender } = render(<TextCleanupPanel text={MESSY} onTextChange={onTextChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clean up script" }));
    const cleaned = onTextChange.mock.calls[0][0] as string;

    rerender(<TextCleanupPanel text={cleaned} onTextChange={onTextChange} />);
    expect(screen.getByRole("button", { name: "Undo cleanup" })).toBeInTheDocument();

    rerender(<TextCleanupPanel text={`${cleaned} And a new sentence.`} onTextChange={onTextChange} />);
    expect(screen.queryByRole("button", { name: "Undo cleanup" })).not.toBeInTheDocument();
    // Editing back to the cleaned text makes the undo safe again.
    rerender(<TextCleanupPanel text={cleaned} onTextChange={onTextChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo cleanup" }));
    expect(onTextChange).toHaveBeenLastCalledWith(MESSY);
  });

  it("only runs the actions that are ticked", () => {
    const onTextChange = vi.fn();
    render(<TextCleanupPanel text={MESSY} onTextChange={onTextChange} />);

    for (const label of ["Markdown", "Links", "Emoji", "Repeated punctuation", "Extra spaces", "Footnote marks", "HTML entities"]) {
      fireEvent.click(screen.getByRole("checkbox", { name: label }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Clean up script" }));

    expect(onTextChange).toHaveBeenCalledWith("The **launch** went well. See https://example.com/page 😀 !!!");
    expect(screen.queryByLabelText("Links", { selector: "select" })).not.toBeInTheDocument();
  });

  it("can drop links completely instead of keeping the site name", () => {
    const onTextChange = vi.fn();
    render(<TextCleanupPanel text="Visit https://example.com/page today." onTextChange={onTextChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Clean up script" }));
    expect(onTextChange).toHaveBeenLastCalledWith("Visit example.com today.");

    fireEvent.change(screen.getByLabelText("Links", { selector: "select" }), { target: { value: "remove" } });
    fireEvent.click(screen.getByRole("button", { name: "Clean up script" }));
    expect(onTextChange).toHaveBeenLastCalledWith("Visit today.");
  });

  it("says when there is nothing to do, and disables the button", () => {
    const { rerender } = render(<TextCleanupPanel text="Already clean." onTextChange={() => {}} />);
    expect(screen.getByText("Nothing to clean up with these options.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clean up script" })).toBeDisabled();

    rerender(<TextCleanupPanel text="" onTextChange={() => {}} />);
    expect(screen.getByText("Write or paste a script to clean it.")).toBeInTheDocument();
  });

  it("counts a single change in the singular and the PDF option reflows lines", () => {
    render(<TextCleanupPanel text={"One line wrapped\nacross lines"} onTextChange={() => {}} />);
    expect(screen.queryByText(/1 change:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "PDF line wrapping" }));
    expect(screen.getByText(/change/)).toBeInTheDocument();

    render(<TextCleanupPanel text="Just [1] one." onTextChange={() => {}} />);
    expect(screen.getByText(/1 change: 1 citations\./)).toBeInTheDocument();
  });

  it("announces only the one-line summary, once typing pauses", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<TextCleanupPanel text={MESSY} onTextChange={vi.fn()} />);
      // The diff itself is not live: it would be re-read on every keystroke.
      expect(screen.getByTestId("cleanup-preview").closest("[aria-live]")).toBeNull();
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent("");

      rerender(<TextCleanupPanel text={`${MESSY} [2]`} onTextChange={vi.fn()} />);
      rerender(<TextCleanupPanel text={`${MESSY} [2] [3]`} onTextChange={vi.fn()} />);
      expect(status).toHaveTextContent("");
      act(() => vi.advanceTimersByTime(1000));
      expect(status.textContent).toMatch(/^\d+ changes: .*citations/);
      expect(status.textContent).not.toMatch(/Removed:/);
    } finally {
      vi.useRealTimers();
    }
  });
});

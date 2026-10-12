import { fireEvent, render, screen } from "@testing-library/react";
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
    render(<TextCleanupPanel text={MESSY} onTextChange={onTextChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Clean up script" }));
    expect(onTextChange).toHaveBeenCalledTimes(1);
    const cleaned = onTextChange.mock.calls[0][0] as string;
    expect(cleaned).toContain("The launch went well.");
    expect(cleaned).not.toContain("**");
    expect(cleaned).not.toContain("[1]");

    fireEvent.click(screen.getByRole("button", { name: "Undo cleanup" }));
    expect(onTextChange).toHaveBeenLastCalledWith(MESSY);
    expect(screen.queryByRole("button", { name: "Undo cleanup" })).not.toBeInTheDocument();
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
});

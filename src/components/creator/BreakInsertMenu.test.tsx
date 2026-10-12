import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BreakInsertMenu } from "./BreakInsertMenu";

function open() {
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
}

describe("BreakInsertMenu", () => {
  it("opens a menu of preset pauses and inserts the chosen one", () => {
    const onInsert = vi.fn();
    render(<BreakInsertMenu onInsert={onInsert} />);
    const trigger = screen.getByRole("button", { name: "Pause" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    open();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Insert a pause" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "2 s" }));

    expect(onInsert).toHaveBeenCalledWith(2);
    expect(screen.queryByRole("group", { name: "Insert a pause" })).not.toBeInTheDocument();
  });

  it("inserts a custom length and refuses lengths the tag cannot carry", () => {
    const onInsert = vi.fn();
    render(<BreakInsertMenu onInsert={onInsert} />);
    open();

    const input = screen.getByLabelText("Custom (seconds)");
    fireEvent.change(input, { target: { value: "3.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(onInsert).toHaveBeenCalledWith(3.5);

    open();
    fireEvent.change(screen.getByLabelText("Custom (seconds)"), { target: { value: "11" } });
    expect(screen.getByRole("button", { name: "Insert" })).toBeDisabled();
    expect(screen.getByLabelText("Custom (seconds)")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Use 0.1 to 10 seconds.");
    fireEvent.submit(screen.getByLabelText("Custom (seconds)").closest("form")!);
    expect(onInsert).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Custom (seconds)"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Insert" })).toBeDisabled();
  });

  it("closes on Escape and on a click elsewhere", () => {
    render(
      <div>
        <BreakInsertMenu onInsert={() => {}} />
        <button type="button">Elsewhere</button>
      </div>,
    );
    open();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByRole("group", { name: "Insert a pause" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Insert a pause" })).not.toBeInTheDocument();

    open();
    fireEvent.pointerDown(screen.getByRole("group", { name: "Insert a pause" }));
    expect(screen.getByRole("group", { name: "Insert a pause" })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("group", { name: "Insert a pause" })).not.toBeInTheDocument();
  });
});

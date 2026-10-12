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
    fireEvent.click(screen.getByRole("button", { name: "Insert a 2 seconds pause" }));

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

  it("moves focus into the menu, steps through the presets with the arrow keys and returns focus on Escape", () => {
    render(<BreakInsertMenu onInsert={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Pause" });
    open();
    const presets = screen.getAllByRole("button", { name: /^Insert a .* pause$/ });
    expect(presets.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Insert a 300 milliseconds pause",
      "Insert a 500 milliseconds pause",
      "Insert a 1 second pause",
      "Insert a 2 seconds pause",
    ]);
    expect(trigger).toHaveAttribute("aria-controls", screen.getByRole("group", { name: "Insert a pause" }).id);
    expect(presets[0]).toHaveFocus();

    const toolbar = screen.getByRole("toolbar", { name: "Preset pauses" });
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(presets[1]).toHaveFocus();
    fireEvent.keyDown(toolbar, { key: "ArrowDown" });
    expect(presets[2]).toHaveFocus();
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(presets[3]).toHaveFocus();
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(presets[0]).toHaveFocus();
    fireEvent.keyDown(toolbar, { key: "ArrowLeft" });
    expect(presets[3]).toHaveFocus();
    fireEvent.keyDown(toolbar, { key: "ArrowUp" });
    expect(presets[2]).toHaveFocus();
    fireEvent.keyDown(toolbar, { key: "Home" });
    expect(presets[0]).toHaveFocus();
    fireEvent.keyDown(toolbar, { key: "a" });
    expect(presets[0]).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
  });

  it("ties the custom field to its error message", () => {
    render(<BreakInsertMenu onInsert={() => {}} />);
    open();
    const input = screen.getByLabelText("Custom (seconds)");
    expect(input).not.toHaveAttribute("aria-describedby");
    fireEvent.change(input, { target: { value: "0" } });
    expect(input).toHaveAccessibleDescription("Use 0.1 to 10 seconds.");
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TextInput } from "./TextInput";

describe("TextInput", () => {
  it("renders textarea with placeholder", () => {
    render(<TextInput text="" onTextChange={() => {}} />);
    expect(screen.getByPlaceholderText(/type or paste/i)).toBeInTheDocument();
  });

  it("displays current text", () => {
    render(<TextInput text="Hello world" onTextChange={() => {}} />);
    expect(screen.getByDisplayValue("Hello world")).toBeInTheDocument();
  });

  it("shows char count", () => {
    render(<TextInput text="Hello" onTextChange={() => {}} />);
    expect(screen.getByText(/5 chars/)).toBeInTheDocument();
  });

  it("calls onTextChange when typing", () => {
    const onTextChange = vi.fn();
    render(<TextInput text="" onTextChange={onTextChange} />);
    fireEvent.change(screen.getByPlaceholderText(/type or paste/i), {
      target: { value: "New text" },
    });
    expect(onTextChange).toHaveBeenCalledWith("New text");
  });

});

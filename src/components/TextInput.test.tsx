import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
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

  it("offers document import and reflects its busy state", () => {
    const onImportDocument = vi.fn();
    const { rerender } = render(
      <TextInput text="" onTextChange={() => {}} onImportDocument={onImportDocument} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import document" }));
    expect(onImportDocument).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Import")).toBeInTheDocument();

    rerender(
      <TextInput
        text=""
        onTextChange={() => {}}
        onImportDocument={onImportDocument}
        isImportingDocument
      />,
    );
    expect(screen.getByRole("button", { name: "Import document" })).toBeDisabled();
    expect(screen.getByText("Importing…")).toBeInTheDocument();
  });

  describe("inserting a pause", () => {
    function Harness({ initial }: { initial: string }) {
      const [text, setText] = useState(initial);
      return <TextInput text={text} onTextChange={setText} />;
    }
    const textarea = () => screen.getByLabelText("Text to synthesize") as HTMLTextAreaElement;

    it("inserts a break tag at the caret and puts the caret after it", () => {
      render(<Harness initial="Hello world" />);
      textarea().setSelectionRange(5, 5);

      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.click(screen.getByRole("button", { name: "1 s" }));

      expect(textarea().value).toBe('Hello <break time="1s"/> world');
      expect(textarea().selectionStart).toBe('Hello <break time="1s"/>'.length);
      expect(textarea()).toHaveFocus();
    });

    it("replaces the selected text", () => {
      render(<Harness initial="one two three" />);
      textarea().setSelectionRange(4, 7);

      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      fireEvent.click(screen.getByRole("button", { name: "500 ms" }));

      expect(textarea().value).toBe('one <break time="500ms"/> three');
    });

    it("leaves the caret alone when the text changes for any other reason", () => {
      const { rerender } = render(<TextInput text="abc" onTextChange={() => {}} />);
      textarea().focus();
      rerender(<TextInput text="abcd" onTextChange={() => {}} />);
      expect(textarea().value).toBe("abcd");
    });
  });
});

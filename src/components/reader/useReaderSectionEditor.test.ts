import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_EDIT_COMMIT_DELAY_MS, useReaderSectionEditor } from "./useReaderSectionEditor";

interface Props {
  documentId: string | null;
  text: string;
}

function setup(initial: Props = { documentId: "book-1", text: "Section text." }) {
  const onTextChange = vi.fn();
  const onEditStart = vi.fn();
  const onEditEnd = vi.fn();
  const view = renderHook((props: Props) => useReaderSectionEditor({
    ...props,
    onTextChange,
    onEditStart,
    onEditEnd,
  }), { initialProps: initial });
  return { ...view, onTextChange, onEditStart, onEditEnd };
}

describe("useReaderSectionEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds the draft from the section and commits it when finished", () => {
    const { result, onTextChange, onEditStart, onEditEnd } = setup();

    act(() => result.current.startEditing());
    expect(result.current.editing).toBe(true);
    expect(result.current.draft).toBe("Section text.");
    expect(onEditStart).toHaveBeenCalledTimes(1);

    act(() => result.current.changeDraft("Edited text."));
    act(() => result.current.finishEditing());

    expect(onTextChange).toHaveBeenCalledTimes(1);
    expect(onTextChange).toHaveBeenCalledWith("Edited text.");
    expect(onEditEnd).toHaveBeenCalledTimes(1);
    expect(result.current.editing).toBe(false);

    act(() => vi.advanceTimersByTime(READER_EDIT_COMMIT_DELAY_MS));
    expect(onTextChange).toHaveBeenCalledTimes(1);
  });

  it("debounces upstream commits while typing", () => {
    const { result, onTextChange } = setup();
    act(() => result.current.startEditing());

    act(() => result.current.changeDraft("A"));
    act(() => vi.advanceTimersByTime(READER_EDIT_COMMIT_DELAY_MS - 1));
    act(() => result.current.changeDraft("AB"));
    act(() => vi.advanceTimersByTime(READER_EDIT_COMMIT_DELAY_MS - 1));
    expect(onTextChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onTextChange).toHaveBeenCalledTimes(1);
    expect(onTextChange).toHaveBeenCalledWith("AB");
  });

  it("commits immediately on blur without leaving the editor", () => {
    const { result, onTextChange, onEditEnd } = setup();
    act(() => result.current.startEditing());
    act(() => result.current.changeDraft("Blurred."));

    act(() => result.current.commitDraft());

    expect(onTextChange).toHaveBeenCalledWith("Blurred.");
    expect(onEditEnd).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(true);
    act(() => vi.advanceTimersByTime(READER_EDIT_COMMIT_DELAY_MS));
    expect(onTextChange).toHaveBeenCalledTimes(1);
  });

  it("ignores finish and blur when nothing is being edited", () => {
    const { result, onTextChange, onEditEnd } = setup();

    act(() => {
      result.current.finishEditing();
      result.current.commitDraft();
    });

    expect(onTextChange).not.toHaveBeenCalled();
    expect(onEditEnd).not.toHaveBeenCalled();
    expect(result.current.draft).toBe("");
  });

  it("keeps an edit open while re-sectioning changes the section text", () => {
    const { result, rerender } = setup();
    act(() => result.current.startEditing());
    act(() => result.current.changeDraft("CHAPTER TWO "));

    rerender({ documentId: "book-1", text: "CHAPTER TWO" });

    expect(result.current.editing).toBe(true);
    expect(result.current.draft).toBe("CHAPTER TWO ");
  });

  it("ends an edit when another document opens without writing into it", () => {
    const { result, rerender, onTextChange, onEditEnd } = setup();
    act(() => result.current.startEditing());
    act(() => result.current.changeDraft("Half-typed"));

    rerender({ documentId: "book-2", text: "Another book." });
    act(() => vi.advanceTimersByTime(READER_EDIT_COMMIT_DELAY_MS));

    expect(result.current.editing).toBe(false);
    expect(onTextChange).not.toHaveBeenCalled();
    expect(onEditEnd).toHaveBeenCalledTimes(1);
  });

  it("does not revive an abandoned edit when the reader returns to its document", () => {
    const { result, rerender, onTextChange, onEditEnd } = setup();
    act(() => result.current.startEditing());
    act(() => result.current.changeDraft("Half-typed"));

    rerender({ documentId: "book-2", text: "Another book." });
    rerender({ documentId: "book-1", text: "Section text." });

    expect(result.current.editing).toBe(false);
    expect(result.current.draft).toBe("");
    act(() => result.current.finishEditing());
    expect(onTextChange).not.toHaveBeenCalled();
    expect(onEditEnd).toHaveBeenCalledTimes(1);
  });

  it("does not end an edit twice when it was finished before the switch", () => {
    const { result, rerender, onEditEnd } = setup();
    act(() => result.current.startEditing());

    act(() => result.current.finishEditing());
    rerender({ documentId: "book-2", text: "Another book." });

    expect(onEditEnd).toHaveBeenCalledTimes(1);
  });

  it("flushes the pending commit when the Reader unmounts mid-edit", () => {
    const { result, unmount, onTextChange, onEditEnd } = setup();
    act(() => result.current.startEditing());
    act(() => result.current.changeDraft("Unsaved words"));

    unmount();

    expect(onTextChange).toHaveBeenCalledWith("Unsaved words");
    expect(onEditEnd).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(READER_EDIT_COMMIT_DELAY_MS));
    expect(onTextChange).toHaveBeenCalledTimes(1);
  });

  it("only ends the edit on unmount when no commit is pending", () => {
    const { result, unmount, onTextChange, onEditEnd } = setup();
    act(() => result.current.startEditing());

    unmount();

    expect(onTextChange).not.toHaveBeenCalled();
    expect(onEditEnd).toHaveBeenCalledTimes(1);
  });
});

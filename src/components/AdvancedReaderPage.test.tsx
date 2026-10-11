import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { AdvancedReaderPage } from "./AdvancedReaderPage";
import type { AudioSegment } from "../hooks/useAudioPlayer";
import type { GenerationStats, ModelState } from "../types";
import {
  buildReaderSections,
  createReaderDocument,
  getReaderSectionText,
} from "../lib/readerDocument";
import { DEFAULT_READER_VIEW_PREFERENCES } from "../lib/readerPreferences";
import { buildQwen3RequestSections, buildQwen3TextUnits } from "../lib/qwenChunking";
import { chunkTextForModelDetailed } from "../lib/chunking";
import { PlaybackClock } from "../lib/playbackClock";
import { estimateSegmentWords } from "./reader/readerSegments";
import { READER_SHORTCUTS_DIALOG_ATTRIBUTE } from "./reader/readerShortcuts";

function clockAt(seconds: number): PlaybackClock {
  const clock = new PlaybackClock();
  clock.set(seconds);
  return clock;
}


vi.mock("./ModelToggle", () => ({
  ModelToggle: ({ desktopModelOptions = [] }: {
    desktopModelOptions?: Array<{ key: string; label: string; onSelect: () => void }>;
  }) => (
    <div data-testid="model-toggle">
      {desktopModelOptions.map((option) => (
        <button key={option.key} type="button" onClick={option.onSelect}>{option.label}</button>
      ))}
    </div>
  ),
}));

vi.mock("./VoiceSelector", () => ({
  VoiceSelector: () => <div data-testid="voice-selector" />,
}));

vi.mock("./ControlsContext", () => ({
  ControlsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./Controls", () => ({
  Controls: () => <div data-testid="controls" />,
}));

const audioPlayerMock = vi.hoisted(() => vi.fn());

vi.mock("./AudioPlayer", () => ({
  AudioPlayer: (props: Record<string, unknown>) => {
    audioPlayerMock(props);
    return <div data-testid="audio-player" />;
  },
}));

// The toolbar is not memoised, so it renders exactly when the page does.
const toolbarRenderMock = vi.hoisted(() => vi.fn());

vi.mock("./reader/ReaderToolbar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reader/ReaderToolbar")>();
  return {
    ReaderToolbar: (props: ComponentProps<typeof actual.ReaderToolbar>) => {
      toolbarRenderMock();
      return <actual.ReaderToolbar {...props} />;
    },
  };
});

const readyState: ModelState = {
  loading: false,
  ready: true,
  downloadProgress: 100,
  error: null,
  backend: "webgpu",
};

const defaultStats: GenerationStats = {
  firstLatency: null,
  processingTime: 0,
  charsPerSec: 0,
  rtf: 0,
  totalDuration: 0,
  currentDuration: 0,
};

function createSegment(overrides: Partial<AudioSegment> = {}): AudioSegment {
  return {
    id: "segment-1",
    text: "Hello world.",
    startSec: 0,
    endSec: 1.25,
    index: 1,
    total: 2,
    textStart: 0,
    textEnd: 12,
    ...overrides,
  };
}

function renderReader(overrides: Partial<ComponentProps<typeof AdvancedReaderPage>> = {}) {
  const props: ComponentProps<typeof AdvancedReaderPage> = {
    text: "Hello world. Second sentence.",
    onTextChange: vi.fn(),
    activeModel: "kokoro",
    onModelChange: vi.fn(),
    kokoroState: readyState,
    supertonicState: readyState,
    kokoroVoices: ["af_sarah"],
    voice: "af_sarah",
    onVoiceChange: vi.fn(),
    quality: 5,
    onQualityChange: vi.fn(),
    canGenerate: true,
    modelReady: true,
    modelError: null,
    loadingProgress: 100,
    generationProgress: 0,
    isGenerating: false,
    onGenerate: vi.fn(),
    onRetryLoad: vi.fn(),
    onStop: vi.fn(),
    stats: defaultStats,
    isPlaying: false,
    clock: clockAt(0),
    totalDuration: 0,
    segments: [],
    activeSegmentId: null,
    onTogglePlay: vi.fn(),
    onSeek: vi.fn(),
    onSkipBackward: vi.fn(),
    onSkipForward: vi.fn(),
    onDownload: vi.fn(),
    isRetaking: false,
    onRetakeSegment: vi.fn(),
    onJumpToSegment: vi.fn(),
    ...overrides,
  };

  return { ...render(<AdvancedReaderPage {...props} />), props };
}

describe("AdvancedReaderPage", () => {
  beforeEach(() => {
    audioPlayerMock.mockClear();
  });

  it("uses a selectable document by default and keeps editing explicit", () => {
    const onEditStart = vi.fn();
    const onEditEnd = vi.fn();
    renderReader({ onEditStart, onEditEnd });

    expect(screen.getByRole("document", { name: "Reading Text" })).toHaveTextContent("Hello world");
    fireEvent.click(screen.getByRole("button", { name: "Edit current section" }));
    expect(screen.getByLabelText("Reading Text")).toHaveAttribute(
      "placeholder",
      "Type or paste text for this reading section…",
    );
    expect(onEditStart).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Finish editing section" }));
    expect(onEditEnd).toHaveBeenCalledTimes(1);
  });

  it("renders Reader text as semantic selectable content", () => {
    const { container } = renderReader();
    const article = container.querySelector("article");

    expect(article).toBeInTheDocument();
    expect(article).not.toHaveClass("pointer-events-none");
  });

  it("keeps an in-progress edit mounted when re-chaptering changes the section id", () => {
    const document = createReaderDocument({
      id: "editing-reader",
      title: "Editing Reader",
      text: "An ordinary opening line.",
    });
    const section = buildReaderSections(document.text, document.chapters)[0];
    const view = renderReader({
      text: document.text,
      documents: [document],
      activeDocument: document,
      activeSection: section,
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit current section" }));
    fireEvent.change(screen.getByLabelText("Reading Text"), {
      target: { value: "CHAPTER TWO " },
    });

    view.rerender(
      <AdvancedReaderPage
        {...view.props}
        text="CHAPTER TWO"
        activeSection={{ ...section, id: "chapter-2:section-1" }}
      />,
    );

    expect(screen.getByLabelText("Reading Text")).toHaveValue("CHAPTER TWO ");
    fireEvent.click(screen.getByRole("button", { name: "Finish editing section" }));

    expect(view.props.onTextChange).toHaveBeenCalledWith("CHAPTER TWO ");
  });

  it("commits the last keystrokes to the open book before switching books mid-edit", () => {
    const first = createReaderDocument({ id: "switch-one", title: "One", text: "First book." });
    const second = createReaderDocument({ id: "switch-two", title: "Two", text: "Second book." });
    const onEditEnd = vi.fn();
    const onOpenDocument = vi.fn();
    const view = renderReader({
      text: first.text,
      documents: [first, second],
      activeDocument: first,
      onEditEnd,
      onOpenDocument,
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit current section" }));
    fireEvent.change(screen.getByLabelText("Reading Text"), { target: { value: "First book, revised." } });

    fireEvent.click(screen.getByRole("button", { name: "Open Reader library" }));
    fireEvent.click(screen.getByRole("button", { name: /^Two/ }));

    expect(view.props.onTextChange).toHaveBeenCalledWith("First book, revised.");
    expect(onEditEnd).toHaveBeenCalledTimes(1);
    expect(onOpenDocument).toHaveBeenCalledWith("switch-two");
    const commitOrder = vi.mocked(view.props.onTextChange).mock.invocationCallOrder[0];
    expect(commitOrder).toBeLessThan(onOpenDocument.mock.invocationCallOrder[0]);
  });

  it("drops the selection toolbar in the same render that shows another book", () => {
    const first = createReaderDocument({ id: "scope-one", title: "One", text: "A memorable first passage." });
    const second = createReaderDocument({ id: "scope-two", title: "Two", text: "A different second passage." });
    const view = renderReader({ text: first.text, documents: [first, second], activeDocument: first });
    const textNode = view.container.querySelector("article span")!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 12);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(view.container.querySelector("article")!);
    expect(screen.getByRole("toolbar", { name: "Selected passage" })).toBeInTheDocument();

    view.rerender(<AdvancedReaderPage {...view.props} text={second.text} activeDocument={second} />);

    expect(screen.queryByRole("toolbar", { name: "Selected passage" })).toBeNull();
    window.getSelection()?.removeAllRanges();
  });

  it("closes popovers with Escape and restores focus to their trigger", () => {
    renderReader();
    const trigger = screen.getByRole("button", { name: "Reading appearance" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Reading appearance" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Reading appearance" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("treats the library as an Escape-dismissable dialog", () => {
    renderReader();
    const trigger = screen.getByRole("button", { name: "Open Reader library" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Reader library" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Reader library" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("preserves a new-note draft per document while switching books", () => {
    const first = createReaderDocument({ id: "draft-one", title: "One", text: "First book." });
    const second = createReaderDocument({ id: "draft-two", title: "Two", text: "Second book." });
    const view = renderReader({
      text: first.text,
      documents: [first, second],
      activeDocument: first,
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Reader library" }));
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    const draft = screen.getByPlaceholderText("Capture a thought about this passage…");
    fireEvent.change(draft, { target: { value: "A thought for book one" } });

    view.rerender(<AdvancedReaderPage {...view.props} text={second.text} activeDocument={second} />);
    expect(screen.getByPlaceholderText("Capture a thought about this passage…")).toHaveValue("");

    view.rerender(<AdvancedReaderPage {...view.props} text={first.text} activeDocument={first} />);
    expect(screen.getByPlaceholderText("Capture a thought about this passage…"))
      .toHaveValue("A thought for book one");
  });

  it("keeps trailing note whitespace while typing and trims it on blur", () => {
    const base = createReaderDocument({ id: "note-edit", text: "A noted passage." });
    const document = {
      ...base,
      notes: [{
        id: "note-1",
        text: "Draft",
        quote: "noted passage",
        textOffset: 2,
        chapterId: base.chapters[0].id,
        sectionId: base.progress.sectionId,
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    const onUpdateNote = vi.fn();
    renderReader({ text: document.text, documents: [document], activeDocument: document, onUpdateNote });
    fireEvent.click(screen.getByRole("button", { name: "Open Reader library" }));
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    const note = screen.getByRole("textbox", { name: "Edit note" });

    fireEvent.change(note, { target: { value: "great " } });
    expect(onUpdateNote).not.toHaveBeenCalled();
    fireEvent.blur(note, { target: { value: "great " } });
    expect(onUpdateNote).toHaveBeenLastCalledWith("note-1", "great");
  });

  it("seeks with double-click while a plain click leaves playback alone", () => {
    const onJumpToSegment = vi.fn();
    const { container } = renderReader({
      segments: [createSegment({ textStart: 0, textEnd: 12 })],
      onJumpToSegment,
    });
    const article = container.querySelector("article")!;
    const textNode = article.querySelector("span")!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(article);
    expect(onJumpToSegment).not.toHaveBeenCalled();

    selection.removeAllRanges();
    selection.addRange(range.cloneRange());
    fireEvent.doubleClick(article);
    expect(onJumpToSegment).toHaveBeenCalledWith("segment-1");
    selection.removeAllRanges();
  });

  describe("exact seeking and sentence steps", () => {
    const text = "First sentence here. Second one follows.\nA new paragraph starts. It ends.";
    const segment = createSegment({ text, textStart: 0, textEnd: text.length, startSec: 0, endSec: 8 });
    const words = estimateSegmentWords(segment);
    const wordAt = (needle: string) => words.find((word) => word.start === text.indexOf(needle))!;

    function renderTimed(timeSec: number, overrides: Partial<ComponentProps<typeof AdvancedReaderPage>> = {}) {
      return renderReader({
        text,
        segments: [segment],
        activeSegmentId: segment.id,
        totalDuration: 8,
        clock: clockAt(timeSec),
        ...overrides,
      });
    }

    it("listens from the exact double-clicked word, not the start of its passage", () => {
      const { container, props } = renderTimed(0);
      const offset = text.indexOf("Second") + 2;
      selectArticleText(container, offset, offset);

      fireEvent.doubleClick(container.querySelector("article")!);

      expect(props.onSeek).toHaveBeenCalledWith(wordAt("Second").startSec / 8);
      expect(props.onJumpToSegment).not.toHaveBeenCalled();
    });

    it("steps to the next sentence or paragraph from the spoken word", () => {
      const { props } = renderTimed(wordAt("here.").startSec);

      fireEvent.click(screen.getByRole("button", { name: "Next sentence" }));
      expect(props.onSeek).toHaveBeenLastCalledWith(wordAt("Second").startSec / 8);

      fireEvent.click(screen.getByRole("button", { name: "Next paragraph" }));
      expect(props.onSeek).toHaveBeenLastCalledWith(wordAt("A new").startSec / 8);
    });

    it("restarts the spoken sentence, and goes to the one before from its first word", () => {
      const midSentence = renderTimed(wordAt("follows.").startSec);
      fireEvent.click(screen.getByRole("button", { name: "Previous sentence" }));
      expect(midSentence.props.onSeek).toHaveBeenLastCalledWith(wordAt("Second").startSec / 8);
      midSentence.unmount();

      const firstWord = renderTimed(wordAt("Second").startSec);
      fireEvent.click(screen.getByRole("button", { name: "Previous sentence" }));
      expect(firstWord.props.onSeek).toHaveBeenLastCalledWith(0);
    });

    it("steps with Shift+arrow keys", () => {
      const { props } = renderTimed(wordAt("Second").startSec);

      fireEvent.keyDown(document.body, { key: "ArrowDown", shiftKey: true });
      expect(props.onSeek).toHaveBeenLastCalledWith(wordAt("A new").startSec / 8);
    });

    it("turns the page when a step leaves the section", () => {
      const book = createReaderDocument({
        id: "stepping",
        text: "A paragraph with enough words for a reading section. ".repeat(700),
      });
      const sections = buildReaderSections(book.text, book.chapters);
      const onNavigateToOffset = vi.fn();
      renderReader({
        text: getReaderSectionText(book.text, sections[1]),
        documents: [book],
        activeDocument: { ...book, progress: { ...book.progress, textOffset: sections[1].start } },
        activeChapter: book.chapters[0],
        activeSection: sections[1],
        previousSection: sections[0],
        nextSection: sections[2] ?? null,
        onNavigateToOffset,
      });

      fireEvent.click(screen.getByRole("button", { name: "Previous paragraph" }));
      expect(onNavigateToOffset).toHaveBeenLastCalledWith(sections[0].start, undefined);
    });

    it("moves the reading position without audio", () => {
      const onNavigateToOffset = vi.fn();
      renderReader({ text, onNavigateToOffset });

      fireEvent.click(screen.getByRole("button", { name: "Next sentence" }));
      expect(onNavigateToOffset).toHaveBeenLastCalledWith(text.indexOf("Second"), undefined);
      fireEvent.click(screen.getByRole("button", { name: "Next sentence" }));
      expect(onNavigateToOffset).toHaveBeenLastCalledWith(text.indexOf("A new"), undefined);
    });
  });

  describe("keyboard and screen-reader access", () => {
    const text = "First paragraph to read.\nSecond paragraph follows.";

    it("keeps one paragraph in the tab order and listens from it with Enter", () => {
      const onNavigateToOffset = vi.fn();
      const { container } = renderReader({ text, onNavigateToOffset });
      const paragraphs = [...container.querySelectorAll<HTMLElement>("article [data-block-start]")];

      expect(paragraphs.map((paragraph) => paragraph.tabIndex)).toEqual([0, -1]);
      expect(paragraphs[0]).toHaveAccessibleDescription(/Press Enter to listen from this paragraph/);

      paragraphs[0].focus();
      fireEvent.keyDown(paragraphs[0], { key: "ArrowDown" });
      expect(paragraphs[1]).toHaveFocus();
      expect(paragraphs.map((paragraph) => paragraph.tabIndex)).toEqual([-1, 0]);

      fireEvent.keyDown(paragraphs[1], { key: "Enter" });
      expect(onNavigateToOffset).toHaveBeenCalledWith(text.indexOf("Second"), undefined);

      fireEvent.keyDown(paragraphs[1], { key: "ArrowUp" });
      expect(paragraphs[0]).toHaveFocus();
    });

    it("selects a paragraph with Shift+Enter so the toolbar can bookmark it", () => {
      const book = createReaderDocument({ id: "keyboard-bookmark", text });
      const onAddBookmark = vi.fn();
      const { container } = renderReader({ text, documents: [book], activeDocument: book, onAddBookmark });
      const second = container.querySelectorAll<HTMLElement>("article [data-block-start]")[1];

      second.focus();
      fireEvent.keyDown(second, { key: "Enter", shiftKey: true });

      expect(window.getSelection()?.toString()).toBe("Second paragraph follows.");
      fireEvent.click(screen.getByRole("button", { name: "Bookmark" }));
      expect(onAddBookmark).toHaveBeenCalledWith(expect.objectContaining({
        label: "Second paragraph follows.",
        textOffset: text.indexOf("Second"),
      }));
    });

    it("opens the selection toolbar for a selection made without the mouse", () => {
      vi.useFakeTimers();
      try {
        const { container } = renderReader({ text });
        const textNode = container.querySelector("article span")!.firstChild!;
        const range = document.createRange();
        range.setStart(textNode, 6);
        range.setEnd(textNode, 15);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        act(() => {
          document.dispatchEvent(new Event("selectionchange"));
        });
        expect(screen.queryByRole("toolbar", { name: "Selected passage" })).toBeNull();

        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(screen.getByRole("toolbar", { name: "Selected passage" })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
        window.getSelection()?.removeAllRanges();
      }
    });

    it("waits for the mouseup while a pointer drag is still selecting", () => {
      vi.useFakeTimers();
      try {
        const { container } = renderReader({ text });
        const article = container.querySelector("article")!;
        const textNode = article.querySelector("span")!.firstChild!;
        fireEvent.pointerDown(article);
        const range = document.createRange();
        range.setStart(textNode, 6);
        range.setEnd(textNode, 15);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        act(() => {
          document.dispatchEvent(new Event("selectionchange"));
          vi.advanceTimersByTime(250);
        });

        expect(screen.queryByRole("toolbar", { name: "Selected passage" })).toBeNull();
      } finally {
        vi.useRealTimers();
        window.getSelection()?.removeAllRanges();
      }
    });

    it("marks the text with the book's language", () => {
      const book = createReaderDocument({ id: "french", text: "Bonjour tout le monde.", language: "fr" });
      const { container } = renderReader({ text: book.text, documents: [book], activeDocument: book });

      expect(container.querySelector("article")).toHaveAttribute("lang", "fr");
      fireEvent.click(screen.getByRole("button", { name: "Edit current section" }));
      expect(screen.getByLabelText("Reading Text")).toHaveAttribute("lang", "fr");
    });
  });

  it("pages between reading sections with the arrow keys", () => {
    const book = createReaderDocument({
      id: "keyboard-reader",
      title: "Keyboard Reader",
      text: "A paragraph with enough words for a reading section. ".repeat(700),
    });
    const sections = buildReaderSections(book.text, book.chapters);
    const onNavigateToOffset = vi.fn();
    renderReader({
      text: getReaderSectionText(book.text, sections[0]),
      documents: [book],
      activeDocument: book,
      activeSection: sections[0],
      nextSection: sections[1],
      onNavigateToOffset,
    });

    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(onNavigateToOffset).toHaveBeenCalledWith(sections[1].start, undefined);

    onNavigateToOffset.mockClear();
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(onNavigateToOffset).not.toHaveBeenCalled();
  });

  it("renders blank-line separated text as spaced paragraph blocks", () => {
    const { container } = renderReader({
      text: "First paragraph.\n\nSecond paragraph.",
    });

    const blocks = [...container.querySelectorAll("article p")];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveTextContent("First paragraph.");
    expect(blocks[1]).toHaveTextContent("Second paragraph.");
    expect(blocks[1]).toHaveClass("reader-paragraph-spaced");
    expect(blocks[1]).toHaveAttribute("data-block-start", "18");
  });

  it("exposes persistent long-reading typography controls", () => {
    const onViewPreferencesChange = vi.fn();
    renderReader({
      viewPreferences: DEFAULT_READER_VIEW_PREFERENCES,
      onViewPreferencesChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "Reading appearance" }));
    fireEvent.change(screen.getByLabelText("Text size"), { target: { value: "22" } });
    fireEvent.change(screen.getByLabelText("Line spacing"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "wide" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Continue automatically" }));

    expect(onViewPreferencesChange).toHaveBeenCalledWith({ fontSize: 22 });
    expect(onViewPreferencesChange).toHaveBeenCalledWith({ lineHeight: 2 });
    expect(onViewPreferencesChange).toHaveBeenCalledWith({ columnWidth: "wide" });
    // Auto-advance defaults on, so toggling the checkbox opts out.
    expect(onViewPreferencesChange).toHaveBeenCalledWith({ autoAdvance: false });
  });

  it("navigates between bounded reading sections without seeking stale audio", () => {
    const document = createReaderDocument({
      id: "long-reader",
      title: "Long Reader",
      text: "A paragraph with enough words for a reading section. ".repeat(700),
    });
    const sections = buildReaderSections(document.text, document.chapters);
    const onNavigateToOffset = vi.fn();
    const onJumpToSegment = vi.fn();

    renderReader({
      text: getReaderSectionText(document.text, sections[0]),
      documents: [document],
      activeDocument: document,
      activeChapter: document.chapters[0],
      activeSection: sections[0],
      previousSection: null,
      nextSection: sections[1],
      onNavigateToOffset,
      onJumpToSegment,
      segments: [createSegment({
        textEnd: sections[0].end - sections[0].start,
      })],
    });

    // Both sections belong to the same chapter, so the rail offers a page turn
    // inside it rather than claiming the next chapter.
    fireEvent.click(screen.getByRole("button", { name: "Next part of this chapter" }));

    expect(onNavigateToOffset).toHaveBeenCalledWith(sections[1].start, undefined);
    expect(onJumpToSegment).not.toHaveBeenCalled();
  });

  it("turns selected reading text into an anchored quoted note", () => {
    const book = createReaderDocument({
      id: "quoted-note-reader",
      text: "A memorable passage belongs with its note.",
    });
    const onAddNote = vi.fn();
    const { container } = renderReader({
      text: book.text,
      documents: [book],
      activeDocument: book,
      onAddNote,
    });
    const article = container.querySelector("article");
    const textNode = article?.querySelector("span")?.firstChild;
    expect(article).not.toBeNull();
    expect(textNode).not.toBeNull();

    const range = document.createRange();
    range.setStart(textNode!, 2);
    range.setEnd(textNode!, 20);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(article!);

    fireEvent.click(screen.getByRole("button", { name: "Add note to selection" }));
    expect(screen.getByText("New note for selected passage")).toBeInTheDocument();
    expect(screen.getByText("“memorable passage”")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Capture a thought about this passage…"), {
      target: { value: "Worth revisiting" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    expect(onAddNote).toHaveBeenCalledWith({
      text: "Worth revisiting",
      quote: "memorable passage",
      textOffset: 2,
    });
    selection?.removeAllRanges();
  });

  it("keeps play/pause usable while later chunks are still generating", () => {
    const onTogglePlay = vi.fn();
    renderReader({
      totalDuration: 4,
      isGenerating: true,
      isPlaying: true,
      onTogglePlay,
      segments: [createSegment()],
    });

    expect(screen.getByTestId("audio-player")).toBeInTheDocument();
    const props = audioPlayerMock.mock.lastCall?.[0] as {
      allowPlaybackDuringGeneration?: boolean;
      isGenerating?: boolean;
      onTogglePlay?: () => void;
    };

    expect(props.allowPlaybackDuringGeneration).toBe(true);
    expect(props.isGenerating).toBe(true);
    props.onTogglePlay?.();
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("passes playback speed through the shared audio player", () => {
    const onPlaybackRateChange = vi.fn();
    renderReader({
      totalDuration: 4,
      playbackRate: 1,
      onPlaybackRateChange,
      segments: [createSegment()],
    });

    const props = audioPlayerMock.mock.lastCall?.[0] as {
      playbackRate?: number;
      onPlaybackRateChange?: (rate: number) => void;
    };

    expect(props.playbackRate).toBe(1);
    props.onPlaybackRateChange?.(1.25);
    expect(onPlaybackRateChange).toHaveBeenCalledWith(1.25);
  });

  it("passes reader segment navigation to the shared audio player", () => {
    const onJumpToSegment = vi.fn();
    renderReader({
      segments: [createSegment(), createSegment({
        id: "segment-2",
        text: "Second sentence.",
        index: 2,
        textStart: 13,
        textEnd: 29,
      })],
      activeSegmentId: "segment-1",
      onJumpToSegment,
    });

    const props = audioPlayerMock.mock.lastCall?.[0] as {
      canPreviousSegment?: boolean;
      canNextSegment?: boolean;
      onNextSegment?: () => void;
    };

    expect(props.canPreviousSegment).toBe(false);
    expect(props.canNextSegment).toBe(true);
    props.onNextSegment?.();
    expect(onJumpToSegment).toHaveBeenCalledWith("segment-2");
  });

  it("offers Electron desktop model options from the reader settings", () => {
    const onSelectQwen3 = vi.fn();
    renderReader({
      desktopModelOptions: [{
        key: "qwen3",
        label: "Qwen3-TTS",
        badge: "Electron",
        detail: "0.6B CustomVoice MLX",
        onSelect: onSelectQwen3,
      }],
    });

    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Qwen3-TTS/i }));

    expect(onSelectQwen3).toHaveBeenCalledTimes(1);
  });

  it("uses request-sized preview sections for Qwen voice cloning", () => {
    const text = "A sentence for local voice cloning. ".repeat(420);
    renderReader({
      text,
      desktopQwenMode: "voiceClone",
      desktopModelOptions: [{
        key: "qwen3",
        label: "Qwen3-TTS",
        badge: "Electron",
        detail: "0.6B Base MLX",
        selected: true,
        onSelect: vi.fn(),
      }],
    });

    const props = audioPlayerMock.mock.lastCall?.[0] as { sectionPreviewCount?: number };
    expect(props.sectionPreviewCount).toBe(buildQwen3RequestSections(text).length);
    expect(props.sectionPreviewCount).toBeLessThan(buildQwen3TextUnits(text).length);
  });

  it("uses Supertonic chunking when Supertonic 3 is selected", () => {
    const text = "A compact sentence for a long Reader section. ".repeat(80);
    renderReader({
      text,
      activeModel: "kokoro",
      desktopModelOptions: [{
        key: "supertonic3",
        label: "Supertonic 3",
        badge: "Electron",
        detail: "99M · EN · M1",
        selected: true,
        onSelect: vi.fn(),
      }],
    });

    const props = audioPlayerMock.mock.lastCall?.[0] as { sectionPreviewCount?: number };
    expect(props.sectionPreviewCount).toBe(chunkTextForModelDetailed(text, "supertonic", {
      runtime: { backend: readyState.backend, quality: 5 },
    }).length);
  });

  it("keeps every Qwen preview section visible while audio is still streaming", () => {
    const text = "Reader section with a natural boundary. ".repeat(45);
    const units = buildQwen3TextUnits(text);
    const first = units[0];
    const { container } = renderReader({
      text,
      isGenerating: true,
      segments: [createSegment({
        text: first.text,
        textStart: first.start,
        textEnd: first.end,
        endSec: 2,
      })],
      desktopModelOptions: [{
        key: "qwen3",
        label: "Qwen3-TTS",
        badge: "Electron",
        detail: "0.6B CustomVoice MLX",
        selected: true,
        onSelect: vi.fn(),
      }],
    });

    const sectionText = [...container.querySelectorAll("[data-block-start]")]
      .map((element) => element.textContent ?? "")
      .join("");
    expect(units.length).toBeGreaterThan(1);
    expect(sectionText).toBe(text);
  });

  it("waits for Qwen streaming to finish before estimating word timing", () => {
    const clock = clockAt(1.5);
    const segment = createSegment({
      text: "Hello extraordinary world.",
      startSec: 0,
      endSec: 3,
      textStart: 0,
      textEnd: 26,
    });
    const view = renderReader({
      text: "Hello extraordinary world.",
      totalDuration: 3,
      clock,
      isPlaying: true,
      isGenerating: true,
      activeSegmentId: "segment-1",
      segments: [segment],
      estimatedWordTrackingStable: false,
    });

    expect(view.container.querySelector("[data-reader-active-word='true']")).toBeNull();
    expect(view.container.querySelector(".reader-chunk-highlight-active")).toHaveTextContent(
      "Hello extraordinary world.",
    );

    view.rerender(
      <AdvancedReaderPage
        {...view.props}
        text="Hello extraordinary world."
        totalDuration={3}
        clock={clock}
        isPlaying
        isGenerating={false}
        activeSegmentId="segment-1"
        segments={[segment]}
        estimatedWordTrackingStable
      />,
    );

    expect(view.container.querySelector("[data-reader-active-word='true']")).toHaveTextContent(
      "extraordinary",
    );
  });

  it("seeks by generated audio ranges without coupling them to preview boundaries", () => {
    const onJumpToSegment = vi.fn();
    renderReader({
      text: "First sentence. Second sentence.",
      segments: [
        createSegment({ text: "First sentence.", textStart: 0, textEnd: 15 }),
        createSegment({
          id: "segment-2",
          text: " Second sentence.",
          index: 2,
          textStart: 15,
          textEnd: 32,
        }),
      ],
      onJumpToSegment,
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit current section" }));
    const textarea = screen.getByLabelText("Reading Text") as HTMLTextAreaElement;
    textarea.setSelectionRange(20, 20);
    fireEvent.doubleClick(textarea);
    expect(onJumpToSegment).toHaveBeenCalledWith("segment-2");
  });

  it("highlights the estimated current word inside the active audio segment", () => {
    const { container } = renderReader({
      text: "Hello extraordinary world.",
      totalDuration: 3,
      clock: clockAt(1.5),
      isPlaying: true,
      activeSegmentId: "segment-1",
      segments: [createSegment({
        text: "Hello extraordinary world.",
        startSec: 0,
        endSec: 3,
        textStart: 0,
        textEnd: 26,
      })],
    });

    expect(container.querySelector("[data-reader-active-word='true']")).toHaveTextContent("extraordinary");
  });

  it("follows the spoken word from the playback clock without a re-render", () => {
    const clock = clockAt(0.2);
    const { container } = renderReader({
      text: "Hello extraordinary world.",
      totalDuration: 3,
      clock,
      isPlaying: true,
      activeSegmentId: "segment-1",
      segments: [createSegment({
        text: "Hello extraordinary world.",
        startSec: 0,
        endSec: 3,
        textStart: 0,
        textEnd: 26,
      })],
    });

    const activeWord = () => container.querySelector("[data-reader-active-word='true']")?.textContent;
    expect(activeWord()).toBe("Hello");

    // No prop change and no rerender() — advancing the clock alone must move the
    // highlight, which is what keeps the position off the render path.
    act(() => clock.set(1.5));
    expect(activeWord()).toBe("extraordinary");

    act(() => clock.set(2.8));
    expect(activeWord()).toBe("world.");
  });

  it("re-renders only the reading pane as the spoken word advances", () => {
    const clock = clockAt(0.2);
    const { container } = renderReader({
      text: "Hello extraordinary world.",
      totalDuration: 3,
      clock,
      isPlaying: true,
      activeSegmentId: "segment-1",
      segments: [createSegment({
        text: "Hello extraordinary world.",
        startSec: 0,
        endSec: 3,
        textStart: 0,
        textEnd: 26,
      })],
    });
    const pageRenders = toolbarRenderMock.mock.calls.length;
    const dockRenders = audioPlayerMock.mock.calls.length;

    act(() => clock.set(1.5));
    act(() => clock.set(2.8));

    expect(container.querySelector("[data-reader-active-word='true']")).toHaveTextContent("world.");
    expect(toolbarRenderMock).toHaveBeenCalledTimes(pageRenders);
    expect(audioPlayerMock).toHaveBeenCalledTimes(dockRenders);
  });

  it("auto-scrolls again when the playback clock advances within one sentence", () => {
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(200);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const wordTop = this.matches(".reader-word-highlight-active")
          ? this.textContent === "Hello"
            ? 80
            : this.textContent === "extraordinary"
              ? 260
              : 440
          : 0;
        return {
          x: 0,
          y: wordTop,
          top: wordTop,
          right: 0,
          bottom: wordTop,
          left: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        };
      });
    const clock = clockAt(0.2);

    try {
      renderReader({
        text: "Hello extraordinary world.",
        totalDuration: 3,
        clock,
        isPlaying: true,
        activeSegmentId: "segment-1",
        segments: [createSegment({
          text: "Hello extraordinary world.",
          startSec: 0,
          endSec: 3,
          textStart: 0,
          textEnd: 26,
        })],
      });
      const scroller = screen.getByRole("document", { name: "Reading Text" });
      const firstWordTop = scroller.scrollTop;

      // The sentence range does not change. Auto-follow must be driven by the
      // word index published by the clock, or the accent can walk off-screen.
      act(() => clock.set(1.5));
      expect(scroller.scrollTop).toBeGreaterThan(firstWordTop);
      const secondWordTop = scroller.scrollTop;

      act(() => clock.set(2.8));
      expect(scroller.scrollTop).toBeGreaterThan(secondWordTop);
    } finally {
      rect.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it("opens the local library, navigates the table of contents, and creates bookmarks", () => {
    const onJumpToSegment = vi.fn();
    const onAddBookmark = vi.fn();
    const document = createReaderDocument({
      id: "doc-1",
      title: "Structured book",
      author: "Local Author",
      text: "# Opening\nFirst text.\n\n# Ending\nFinal text.",
    });
    const { props } = renderReader({
      text: document.text,
      documents: [document],
      activeDocument: document,
      onOpenDocument: vi.fn(),
      onNewDocument: vi.fn(),
      onDeleteDocument: vi.fn(),
      onUpdateDocumentMetadata: vi.fn(),
      onAddBookmark,
      onRemoveBookmark: vi.fn(),
      onAddNote: vi.fn(),
      onUpdateNote: vi.fn(),
      onRemoveNote: vi.fn(),
      onJumpToSegment,
      totalDuration: 4,
      activeSegmentId: "segment-1",
      segments: [createSegment({
        text: "# Opening\nFirst text.",
        textStart: 0,
        textEnd: document.chapters[1]?.start ?? document.text.length,
      }), createSegment({
        id: "segment-2",
        text: "# Ending\nFinal text.",
        startSec: 2,
        endSec: 4,
        textStart: document.chapters[1]?.start ?? 0,
        textEnd: document.text.length,
      })],
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Reader library" }));
    fireEvent.click(screen.getByRole("tab", { name: "Contents" }));
    fireEvent.click(screen.getByRole("button", { name: /Ending/ }));
    // The chapter's first word starts its passage, two seconds in.
    expect(props.onSeek).toHaveBeenCalledWith(0.5);
    expect(onJumpToSegment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Bookmarks" }));
    fireEvent.click(screen.getByRole("button", { name: "Bookmark this position" }));
    expect(onAddBookmark).toHaveBeenCalledWith(expect.objectContaining({ positionSec: 0 }));
  });

  it("updates the visible chapter when navigating a document before audio exists", () => {
    const document = createReaderDocument({
      id: "doc-no-audio",
      title: "Quiet chapters",
      text: "# Opening\nFirst text.\n\n# Ending\nFinal text.",
    });
    renderReader({
      text: document.text,
      documents: [document],
      activeDocument: document,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Reader library" }));
    fireEvent.click(screen.getByRole("tab", { name: "Contents" }));
    fireEvent.click(screen.getByRole("button", { name: /Ending/ }));

    expect(screen.getByRole("button", { name: "Contents · Chapter 2 of 2: Ending" })).toBeInTheDocument();
  });

  it("names chapter rail page turns by where they land", () => {
    const document = createReaderDocument({
      id: "doc-chapter-steps",
      title: "Two chapters",
      text: `# Opening\n${"A paragraph with enough words for a reading section. ".repeat(700)}\n\n# Ending\nFinal text.`,
    });
    const sections = buildReaderSections(document.text, document.chapters);
    const crossing = sections.findIndex((section) => section.chapterId === document.chapters[1].id);
    const onNavigateToOffset = vi.fn();

    renderReader({
      text: getReaderSectionText(document.text, sections[crossing - 1]),
      documents: [document],
      activeDocument: document,
      activeChapter: document.chapters[0],
      activeSection: sections[crossing - 1],
      previousSection: sections[crossing - 2] ?? null,
      nextSection: sections[crossing],
      onNavigateToOffset,
    });

    fireEvent.click(screen.getByRole("button", { name: "Next chapter: Ending" }));
    expect(onNavigateToOffset).toHaveBeenCalledWith(sections[crossing].start, undefined);
  });

  it("opens the contents straight from the chapter rail", () => {
    const document = createReaderDocument({
      id: "doc-rail-contents",
      title: "Quiet chapters",
      text: "# Opening\nFirst text.\n\n# Ending\nFinal text.",
    });
    renderReader({ text: document.text, documents: [document], activeDocument: document });

    fireEvent.click(screen.getByRole("button", { name: /^Contents · Chapter 1 of 2/ }));

    expect(screen.getByRole("tab", { name: "Contents" })).toHaveAttribute("aria-selected", "true");
  });

  it("draws a chapter's own title line as its heading instead of repeating it", () => {
    const book = createReaderDocument({
      id: "heading-once",
      title: "Two chapters",
      text: "# Opening\nFirst text.\n\n# Ending\nFinal text.",
    });
    const sections = buildReaderSections(book.text, book.chapters);
    renderReader({
      text: getReaderSectionText(book.text, sections[0]),
      documents: [book],
      activeDocument: book,
      activeChapter: book.chapters[0],
      activeSection: sections[0],
    });

    const reading = screen.getByRole("document", { name: "Reading Text" });
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("# Opening");
    expect(reading.querySelectorAll("header")).toHaveLength(0);
  });

  it("gives a plain one-chapter document no chapter heading", () => {
    const book = createReaderDocument({ id: "plain", text: "Just some prose to read aloud here." });
    renderReader({ text: book.text, documents: [book], activeDocument: book });

    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.getByRole("button", { name: /^Contents/ })).toHaveTextContent("Contents");
  });

  it("bookmarks a selected passage from the selection toolbar", () => {
    const book = createReaderDocument({ id: "select-bookmark", text: "A memorable passage belongs with its note." });
    const onAddBookmark = vi.fn();
    const { container } = renderReader({
      text: book.text,
      documents: [book],
      activeDocument: book,
      onAddBookmark,
    });
    const textNode = container.querySelector("article span")?.firstChild;
    const range = document.createRange();
    range.setStart(textNode!, 2);
    range.setEnd(textNode!, 19);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(container.querySelector("article")!);

    expect(screen.getByRole("toolbar", { name: "Selected passage" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bookmark" }));
    expect(onAddBookmark).toHaveBeenCalledWith({ label: "memorable passage", textOffset: 2, positionSec: 0 });
    expect(screen.queryByRole("toolbar", { name: "Selected passage" })).toBeNull();
  });

  /** Selects `[start, end)` of the first paragraph, across however many spans it is split into. */
  function selectArticleText(container: HTMLElement, start: number, end: number) {
    const paragraph = container.querySelector("article [data-block-start]")!;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let seen = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent!.length;
      if (start >= seen && start <= seen + length) range.setStart(node, start - seen);
      if (end >= seen && end <= seen + length) {
        range.setEnd(node, end - seen);
        break;
      }
      seen += length;
    }
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(container.querySelector("article")!);
  }

  it("highlights a selected passage over its whole range in the picked colour", () => {
    const book = createReaderDocument({ id: "select-highlight", text: "A memorable passage belongs with its note." });
    const onAddHighlight = vi.fn();
    const { container } = renderReader({ text: book.text, documents: [book], activeDocument: book, onAddHighlight });

    selectArticleText(container, 2, 19);
    expect(screen.getByRole("group", { name: "Highlight" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove highlight" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Green highlight" }));

    expect(onAddHighlight).toHaveBeenCalledWith({ start: 2, end: 19, color: "green" });
    expect(screen.queryByRole("toolbar", { name: "Selected passage" })).toBeNull();
  });

  it("hides the highlight colours when highlights cannot be saved", () => {
    const book = createReaderDocument({ id: "no-highlight", text: "A memorable passage belongs with its note." });
    const { container } = renderReader({ text: book.text, documents: [book], activeDocument: book });

    selectArticleText(container, 2, 19);
    expect(screen.getByRole("toolbar", { name: "Selected passage" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Highlight" })).toBeNull();
  });

  it("paints saved highlights and recolours or removes the one a selection lies in", () => {
    const text = "A memorable passage belongs with its note.";
    const book = {
      ...createReaderDocument({ id: "painted", text }),
      highlights: [
        { id: "hl-1", start: 2, end: 19, color: "pink" as const, quote: "memorable passage", createdAt: 1, updatedAt: 1 },
        // Its words moved away in an edit, so it must not colour what is there now.
        { id: "hl-2", start: 28, end: 32, color: "blue" as const, quote: "gone", createdAt: 1, updatedAt: 1 },
      ],
    };
    const onAddHighlight = vi.fn();
    const onUpdateHighlight = vi.fn();
    const onRemoveHighlight = vi.fn();
    const { container } = renderReader({
      text,
      documents: [book],
      activeDocument: book,
      onAddHighlight,
      onUpdateHighlight,
      onRemoveHighlight,
    });

    const painted = [...container.querySelectorAll<HTMLElement>("article [data-highlight]")];
    expect(painted.map((span) => [span.textContent, span.dataset.highlight])).toEqual([["memorable passage", "pink"]]);

    selectArticleText(container, 2, 11);
    expect(screen.getByRole("group", { name: "Change highlight colour" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pink highlight" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Purple highlight" }));
    expect(onUpdateHighlight).toHaveBeenCalledWith("hl-1", { color: "purple" });
    expect(onAddHighlight).not.toHaveBeenCalled();

    selectArticleText(container, 2, 11);
    fireEvent.click(screen.getByRole("button", { name: "Remove highlight" }));
    expect(onRemoveHighlight).toHaveBeenCalledWith("hl-1");
  });

  it("reports a failed generation in the dock instead of reading as ready", () => {
    renderReader({ generationError: "Invalid language identifier" });
    const props = audioPlayerMock.mock.calls.at(-1)?.[0] as {
      statusLabel: string;
      primaryAction: { label: string; tone: string };
    };
    expect(props.statusLabel).toBe("Generation failed · try again");
    expect(props.primaryAction).toMatchObject({ label: "Try generating again", tone: "danger" });
  });

  it("opens the shortcut list with ? and toggles the focus layout with F", () => {
    const onImmersiveChange = vi.fn();
    renderReader({ onImmersiveChange });

    fireEvent.keyDown(document.body, { key: "?" });
    const shortcuts = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(shortcuts).toHaveAttribute(READER_SHORTCUTS_DIALOG_ATTRIBUTE);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();

    fireEvent.keyDown(document.body, { key: "f" });
    expect(onImmersiveChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Focus layout" }));
    expect(onImmersiveChange).toHaveBeenCalledTimes(2);
  });

  it("paints the reading panel in the chosen page tone", () => {
    const onViewPreferencesChange = vi.fn();
    const { container } = renderReader({
      viewPreferences: { ...DEFAULT_READER_VIEW_PREFERENCES, tone: "sepia" },
      onViewPreferencesChange,
    });
    expect(container.querySelector("section.reader-tone-sepia")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reading appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Night" }));
    expect(onViewPreferencesChange).toHaveBeenCalledWith({ tone: "night" });
  });

  it("pauses playback when the sleep timer runs out", () => {
    vi.useFakeTimers();
    try {
      const onTogglePlay = vi.fn();
      const book = createReaderDocument({ id: "sleepy", text: "Bedtime reading, one quiet page at a time." });
      renderReader({ text: book.text, documents: [book], activeDocument: book, isPlaying: true, onTogglePlay });
      fireEvent.click(screen.getByRole("button", { name: "Reading appearance" }));
      fireEvent.click(screen.getByRole("button", { name: "15m" }));
      expect(screen.getByRole("button", { name: "Sleep timer: 15m. Cancel" })).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(15 * 60_000);
      });
      expect(onTogglePlay).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: /^Sleep timer/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds auto-continuation at the chapter's end when the sleep timer is set to Chapter", () => {
    const document = createReaderDocument({
      id: "sleepy-chapters",
      title: "Two chapters",
      text: `# Opening\n${"A paragraph with enough words for a reading section. ".repeat(700)}\n\n# Ending\nFinal text.`,
    });
    const sections = buildReaderSections(document.text, document.chapters);
    const crossing = sections.findIndex((section) => section.chapterId === document.chapters[1].id);
    const onAutoAdvanceHoldChange = vi.fn();
    const clock = clockAt(0);
    const segment = createSegment({ endSec: 30, textEnd: sections[crossing - 1].end - sections[crossing - 1].start });
    const props = {
      text: getReaderSectionText(document.text, sections[crossing - 1]),
      documents: [document],
      activeDocument: document,
      activeChapter: document.chapters[0],
      activeSection: sections[crossing - 1],
      previousSection: sections[crossing - 2] ?? null,
      nextSection: sections[crossing],
      isPlaying: true,
      clock,
      totalDuration: 30,
      segments: [segment],
      activeSegmentId: segment.id,
      onAutoAdvanceHoldChange,
    };
    const view = renderReader(props);

    fireEvent.click(screen.getByRole("button", { name: "Reading appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Chapter" }));
    expect(screen.getByRole("button", { name: "Sleep timer: End of chapter. Cancel" })).toBeInTheDocument();
    expect(onAutoAdvanceHoldChange).toHaveBeenLastCalledWith(true);

    // The section plays out: the timer has fired, yet the hold stays until
    // the parent turns the page.
    act(() => clock.set(30));
    view.rerender(<AdvancedReaderPage {...view.props} {...props} isPlaying={false} />);
    expect(screen.queryByRole("button", { name: /^Sleep timer/ })).toBeNull();
    expect(onAutoAdvanceHoldChange).toHaveBeenLastCalledWith(true);
    expect(view.props.onTogglePlay).not.toHaveBeenCalled();

    view.rerender(
      <AdvancedReaderPage
        {...view.props}
        {...props}
        text={getReaderSectionText(document.text, sections[crossing])}
        activeChapter={document.chapters[1]}
        activeSection={sections[crossing]}
        previousSection={sections[crossing - 1]}
        nextSection={null}
        isPlaying={false}
        totalDuration={0}
        segments={[]}
        activeSegmentId={null}
      />,
    );
    expect(onAutoAdvanceHoldChange).toHaveBeenLastCalledWith(false);
  });

  it("imports article URLs from the toolbar", async () => {
    const onImportUrl = vi.fn(async () => {});
    renderReader({ onImportUrl });
    fireEvent.click(screen.getByRole("button", { name: "Import document" }));
    fireEvent.change(screen.getByPlaceholderText("https://example.com/article"), {
      target: { value: "https://example.com/story" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import article" }));
    await waitFor(() => expect(onImportUrl).toHaveBeenCalledWith("https://example.com/story"));
  });
});

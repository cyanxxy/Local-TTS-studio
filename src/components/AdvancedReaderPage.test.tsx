import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    currentTime: 0,
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
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
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
      totalSectionCount: sections.length,
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
      totalSectionCount: sections.length,
      onNavigateToOffset,
      onJumpToSegment,
      segments: [createSegment({
        textEnd: sections[0].end - sections[0].start,
      })],
    });

    fireEvent.click(screen.getByRole("button", { name: "Next reading section" }));

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

    const sectionText = [...container.querySelectorAll("[data-section-index]")]
      .map((element) => element.textContent ?? "")
      .join("");
    expect(units.length).toBeGreaterThan(1);
    expect(sectionText).toBe(text.trim());
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
      currentTime: 1.5,
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

  it("opens the local library, navigates the table of contents, and creates bookmarks", () => {
    const onJumpToSegment = vi.fn();
    const onAddBookmark = vi.fn();
    const document = createReaderDocument({
      id: "doc-1",
      title: "Structured book",
      author: "Local Author",
      text: "# Opening\nFirst text.\n\n# Ending\nFinal text.",
    });
    renderReader({
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
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    fireEvent.click(screen.getByRole("button", { name: /Ending/ }));
    expect(onJumpToSegment).toHaveBeenCalledWith("segment-2");

    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    fireEvent.click(screen.getByRole("button", { name: /Ending/ }));

    expect(screen.getByRole("button", { name: "Chapter 2 of 2: Ending" })).toBeInTheDocument();
  });

  it("imports article URLs from the toolbar", async () => {
    const onImportUrl = vi.fn(async () => {});
    renderReader({ onImportUrl });
    fireEvent.click(screen.getByRole("button", { name: "Import from URL" }));
    fireEvent.change(screen.getByPlaceholderText("https://example.com/article"), {
      target: { value: "https://example.com/story" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import article" }));
    await waitFor(() => expect(onImportUrl).toHaveBeenCalledWith("https://example.com/story"));
  });
});

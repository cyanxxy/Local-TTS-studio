import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReaderDocument, buildReaderSections } from "../lib/readerDocument";
import { PlaybackClock } from "../lib/playbackClock";
import type { MediaSessionTransport } from "./useMediaSession";
import { useReaderMediaSession } from "./useReaderMediaSession";

const mediaSession = vi.hoisted(() => ({ options: null as null | {
  enabled: boolean;
  nowPlaying: { title: string; artist: string; album: string; artwork: Array<{ src: string; type?: string }> } | null;
  transport: MediaSessionTransport;
} }));

vi.mock("./useMediaSession", () => ({
  useMediaSession: (options: NonNullable<typeof mediaSession.options>) => {
    mediaSession.options = options;
  },
}));

const book = createReaderDocument({
  id: "media-book",
  title: "A Long Book",
  text: "A paragraph long enough to fill several sections. ".repeat(900),
});
const sections = buildReaderSections(book.text, book.chapters);

function setup(
  overrides: Partial<Parameters<typeof useReaderMediaSession>[0]> = {},
  position = 0,
  totalDuration = 60,
) {
  const player = {
    clock: new PlaybackClock(),
    getCurrentTime: vi.fn(() => position),
    isPlaying: false,
    playbackRate: 1,
    seekTo: vi.fn(),
    skip: vi.fn(),
    togglePlay: vi.fn(),
    totalDuration,
  };
  const playSection = vi.fn();
  renderHook(() => useReaderMediaSession({
    active: true,
    document: book,
    chapter: book.chapters[0],
    section: sections[1],
    previousSection: sections[0],
    nextSection: sections[2],
    player,
    playSection,
    ...overrides,
  }));
  return { player, playSection, transport: mediaSession.options!.transport };
}

describe("useReaderMediaSession", () => {
  beforeEach(() => {
    // jsdom has no canvas; the generated cover is then simply absent.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  it("describes the part of the chapter being played, and falls back to a generated cover", () => {
    setup();
    const { nowPlaying } = mediaSession.options!;
    expect(nowPlaying?.album).toBe("A Long Book");
    expect(nowPlaying?.title).toMatch(/part 2 of \d+$/);
  });

  it("uses the book's own cover when it has one", () => {
    const cover = "data:image/jpeg;base64,/9j/4AAQ";
    setup({ document: { ...book, cover: { dataUrl: cover } } });
    expect(mediaSession.options!.nowPlaying?.artwork).toEqual([{ src: cover, type: "image/jpeg" }]);
  });

  it("is on only while the Reader shows a book with audio", () => {
    setup();
    expect(mediaSession.options!.enabled).toBe(true);
    setup({ active: false });
    expect(mediaSession.options!.enabled).toBe(false);
    setup({}, 0, 0);
    expect(mediaSession.options!.enabled).toBe(false);
  });

  it("plays or pauses only when the state differs, so a key press never toggles the wrong way", () => {
    const stopped = setup();
    stopped.transport.pause();
    expect(stopped.player.togglePlay).not.toHaveBeenCalled();
    stopped.transport.play();
    expect(stopped.player.togglePlay).toHaveBeenCalledTimes(1);
  });

  it("goes to the previous section early in a section and restarts it later in one", () => {
    const early = setup({}, 1);
    early.transport.previous?.();
    expect(early.playSection).toHaveBeenCalledWith(sections[0]);

    const late = setup({}, 30);
    late.transport.previous?.();
    expect(late.player.seekTo).toHaveBeenCalledWith(0);
    expect(late.playSection).not.toHaveBeenCalled();
  });

  it("plays the next section, and offers no next key on the last one", () => {
    const { transport, playSection } = setup();
    transport.next?.();
    expect(playSection).toHaveBeenCalledWith(sections[2]);

    setup({ nextSection: null });
    expect(mediaSession.options!.transport.next).toBeUndefined();
  });

  it("restarts the first section instead of going nowhere", () => {
    const { transport, player, playSection } = setup({ previousSection: null }, 1);
    transport.previous?.();
    expect(player.seekTo).toHaveBeenCalledWith(0);
    expect(playSection).not.toHaveBeenCalled();
  });
});

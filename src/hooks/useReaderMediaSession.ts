import { useMemo } from "react";
import type { ReaderChapter, ReaderDocumentRecord, ReaderSection } from "../lib/readerDocument";
import {
  describeNowPlaying,
  MEDIA_SESSION_RESTART_AFTER_SECONDS,
  renderPlaceholderCover,
} from "../lib/mediaSession";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useMediaSession, type MediaSessionTransport } from "./useMediaSession";

interface Options {
  /** The Reader page is on screen. */
  active: boolean;
  document: ReaderDocumentRecord | null;
  chapter: ReaderChapter | null;
  section: ReaderSection | null;
  previousSection: ReaderSection | null;
  nextSection: ReaderSection | null;
  player: Pick<
    UseAudioPlayerReturn,
    "clock" | "getCurrentTime" | "isPlaying" | "playbackRate" | "seekTo" | "skip" | "togglePlay" | "totalDuration"
  >;
  /** Turns to a section and plays it. */
  playSection: (section: ReaderSection) => void;
}

function coverType(dataUrl: string): string | undefined {
  return /^data:(image\/[a-z]+);/.exec(dataUrl)?.[1];
}

/**
 * The Reader's part in the OS media controls: the book, chapter and cover as
 * Now Playing, and the media keys as play, pause, seek, and the previous and
 * next section.
 */
export function useReaderMediaSession({
  active,
  document,
  chapter,
  section,
  previousSection,
  nextSection,
  player,
  playSection,
}: Options): void {
  const { clock, getCurrentTime, isPlaying, playbackRate, seekTo, skip, togglePlay, totalDuration } = player;
  const title = document?.title ?? "";
  const author = document?.author ?? "";
  const cover = document?.cover?.dataUrl ?? null;
  const chapterTitle = chapter?.title ?? null;
  const partIndex = section?.chapterSectionIndex ?? 0;
  const partCount = section?.chapterSectionCount ?? 1;

  const nowPlaying = useMemo(() => {
    if (!title) return null;
    // The EPUB's own cover when it has one; otherwise a generated tile, so the
    // widget never shows a blank square.
    const artworkUrl = cover ?? renderPlaceholderCover(title);
    return describeNowPlaying({
      chapterTitle,
      bookTitle: title,
      author,
      partIndex,
      partCount,
      artwork: artworkUrl
        ? [{ src: artworkUrl, ...(cover ? { type: coverType(cover) } : { sizes: "256x256", type: "image/png" }) }]
        : [],
    });
  }, [author, chapterTitle, cover, partCount, partIndex, title]);

  const transport: MediaSessionTransport = {
    play: () => {
      if (!isPlaying) void togglePlay();
    },
    pause: () => {
      if (isPlaying) void togglePlay();
    },
    seekBy: skip,
    seekTo,
    previous: section
      ? () => {
        if (!previousSection || getCurrentTime() > MEDIA_SESSION_RESTART_AFTER_SECONDS) seekTo(0);
        else playSection(previousSection);
      }
      : undefined,
    next: nextSection ? () => playSection(nextSection) : undefined,
  };

  useMediaSession({
    enabled: active && document !== null && totalDuration > 0,
    nowPlaying,
    isPlaying,
    duration: totalDuration,
    playbackRate,
    clock,
    getCurrentTime,
    transport,
  });
}

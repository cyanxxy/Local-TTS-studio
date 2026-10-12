/**
 * Helpers for the browser Media Session API: the OS media keys, the macOS Now
 * Playing widget, Bluetooth headset buttons and lock screens. Everything here
 * is feature-detected, because the API is absent in some embedders and
 * rejects out-of-range values with exceptions that must never reach playback.
 */

export type MediaSessionActionName = Extract<
  MediaSessionAction,
  "play" | "pause" | "stop" | "seekbackward" | "seekforward" | "seekto" | "previoustrack" | "nexttrack"
>;

/** How far the seek keys jump when the OS does not say. */
export const MEDIA_SESSION_SEEK_SECONDS = 15;

/** A previous-track press restarts the section when it is further in than this. */
export const MEDIA_SESSION_RESTART_AFTER_SECONDS = 3;

export function getMediaSession(): MediaSession | null {
  return typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null;
}

export interface NowPlaying {
  /** The chapter, with the part when the chapter is split ("Chapter 3 · part 2 of 4"). */
  title: string;
  /** The author. */
  artist: string;
  /** The book. */
  album: string;
  /** Image URLs, largest last. */
  artwork: readonly { src: string; sizes?: string; type?: string }[];
}

export function describeNowPlaying(input: {
  chapterTitle: string | null;
  bookTitle: string;
  author: string;
  partIndex: number;
  partCount: number;
  artwork: NowPlaying["artwork"];
}): NowPlaying {
  const chapter = input.chapterTitle?.trim() || input.bookTitle;
  return {
    title: input.partCount > 1 ? `${chapter} · part ${input.partIndex + 1} of ${input.partCount}` : chapter,
    artist: input.author.trim(),
    album: input.bookTitle,
    artwork: input.artwork,
  };
}

export function setNowPlaying(nowPlaying: NowPlaying | null): void {
  const session = getMediaSession();
  if (!session) return;
  try {
    session.metadata = nowPlaying && typeof MediaMetadata !== "undefined"
      ? new MediaMetadata({
        title: nowPlaying.title,
        artist: nowPlaying.artist,
        album: nowPlaying.album,
        artwork: nowPlaying.artwork.map((image) => ({ ...image })),
      })
      : null;
  } catch {
    // An unsupported artwork type must not break playback.
  }
}

export function setPlaybackState(state: MediaSessionPlaybackState): void {
  const session = getMediaSession();
  if (!session) return;
  try {
    session.playbackState = state;
  } catch { /* unsupported */ }
}

/** Reports the position, clamping what the API would reject. */
export function setPositionState(state: { duration: number; position: number; playbackRate: number } | null): void {
  const session = getMediaSession();
  if (!session) return;
  try {
    if (!state || !Number.isFinite(state.duration) || state.duration <= 0) {
      session.setPositionState();
      return;
    }
    session.setPositionState({
      duration: state.duration,
      position: Math.max(0, Math.min(state.duration, Number.isFinite(state.position) ? state.position : 0)),
      playbackRate: Number.isFinite(state.playbackRate) && state.playbackRate > 0 ? state.playbackRate : 1,
    });
  } catch { /* unsupported */ }
}

/**
 * Installs handlers for the given actions and returns a function that removes
 * them. An action the platform does not know is skipped.
 */
export function setActionHandlers(
  handlers: Partial<Record<MediaSessionActionName, MediaSessionActionHandler>>,
): () => void {
  const session = getMediaSession();
  if (!session) return () => undefined;
  const installed: MediaSessionActionName[] = [];
  for (const [action, handler] of Object.entries(handlers) as Array<[MediaSessionActionName, MediaSessionActionHandler | undefined]>) {
    if (!handler) continue;
    try {
      session.setActionHandler(action, handler);
      installed.push(action);
    } catch { /* this platform does not support the action */ }
  }
  return () => {
    for (const action of installed) {
      try {
        session.setActionHandler(action, null);
      } catch { /* unsupported */ }
    }
  };
}

const SILENT_SAMPLE_RATE = 8_000;

/**
 * A one second silent mono WAV. Chromium only lists a page in the OS media
 * controls while an HTMLMediaElement plays, and Reader audio is Web Audio, so
 * a silent looping element stands in for it.
 */
export function createSilentWav(): Uint8Array<ArrayBuffer> {
  const samples = SILENT_SAMPLE_RATE;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SILENT_SAMPLE_RATE, true);
  view.setUint32(28, SILENT_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

/**
 * A square cover for a book that has none: its initial on a flat colour taken
 * from the title, as a PNG data URL. Returns null where there is no canvas.
 */
export function renderPlaceholderCover(title: string, size = 256): string | null {
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;
    let hash = 0;
    for (const character of title) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
    context.fillStyle = `hsl(${hash % 360} 38% 32%)`;
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#ffffff";
    context.font = `600 ${Math.round(size * 0.5)}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText((Array.from(title.trim())[0] ?? "?").toUpperCase(), size / 2, size / 2);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

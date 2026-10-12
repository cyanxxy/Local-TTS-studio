import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackClock } from "../lib/playbackClock";
import type { NowPlaying } from "../lib/mediaSession";
import { useMediaSession, type MediaSessionTransport } from "./useMediaSession";

type Handler = ((details: MediaSessionActionDetails) => void) | null;

class FakeMediaMetadata {
  readonly init: MediaMetadataInit;

  constructor(init: MediaMetadataInit) {
    this.init = init;
  }
}

function installMediaSession() {
  const handlers = new Map<string, Handler>();
  const session = {
    metadata: null as unknown,
    playbackState: "none" as MediaSessionPlaybackState,
    setActionHandler: vi.fn((action: string, handler: Handler) => {
      handlers.set(action, handler);
    }),
    setPositionState: vi.fn(),
  };
  Object.defineProperty(navigator, "mediaSession", { value: session, configurable: true });
  vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
  return { session, handlers };
}

const nowPlaying: NowPlaying = {
  title: "Chapter One · part 1 of 2",
  artist: "An Author",
  album: "A Book",
  artwork: [{ src: "data:image/png;base64,AAAA", type: "image/png" }],
};

function transportMock(overrides: Partial<MediaSessionTransport> = {}): MediaSessionTransport {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    seekBy: vi.fn(),
    seekTo: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
    ...overrides,
  };
}

describe("useMediaSession", () => {
  let play: ReturnType<typeof vi.fn>;
  let pause: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    play = vi.fn(async () => undefined);
    pause = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as never);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause as never);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    URL.createObjectURL = vi.fn(() => "blob:silent");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "mediaSession");
  });

  function setup(overrides: Partial<Parameters<typeof useMediaSession>[0]> = {}) {
    const clock = new PlaybackClock();
    const transport = transportMock();
    const options = {
      enabled: true,
      nowPlaying,
      isPlaying: false,
      duration: 120,
      playbackRate: 1,
      clock,
      getCurrentTime: () => clock.getTime(),
      transport,
      ...overrides,
    };
    const view = renderHook((props: typeof options) => useMediaSession(props), { initialProps: options });
    return { ...view, options, clock, transport };
  }

  it("publishes the book, chapter and artwork as Now Playing", () => {
    const { session } = installMediaSession();
    setup();
    const metadata = session.metadata as FakeMediaMetadata;
    expect(metadata.init).toMatchObject({
      title: "Chapter One · part 1 of 2",
      artist: "An Author",
      album: "A Book",
      artwork: [{ src: "data:image/png;base64,AAAA", type: "image/png" }],
    });
    expect(session.playbackState).toBe("paused");
    expect(session.setPositionState).toHaveBeenCalledWith({ duration: 120, position: 0, playbackRate: 1 });
  });

  it("routes each media key to the transport", () => {
    const { handlers } = installMediaSession();
    const { transport } = setup();
    const press = (action: string, details: Partial<MediaSessionActionDetails> = {}) => (
      handlers.get(action)?.({ action, ...details } as MediaSessionActionDetails)
    );
    press("play");
    press("pause");
    press("stop");
    press("seekbackward");
    press("seekforward", { seekOffset: 30 });
    press("seekto", { seekTime: 42 });
    press("previoustrack");
    press("nexttrack");
    expect(transport.play).toHaveBeenCalledTimes(1);
    expect(transport.pause).toHaveBeenCalledTimes(2);
    expect(transport.seekBy).toHaveBeenNthCalledWith(1, -15);
    expect(transport.seekBy).toHaveBeenNthCalledWith(2, 30);
    expect(transport.seekTo).toHaveBeenCalledWith(42);
    expect(transport.previous).toHaveBeenCalledTimes(1);
    expect(transport.next).toHaveBeenCalledTimes(1);
  });

  it("installs no key for a direction with nowhere to go, and a seek without a time does nothing", () => {
    const { handlers } = installMediaSession();
    const { transport } = setup({ transport: transportMock({ next: undefined }) });
    expect(handlers.has("nexttrack")).toBe(false);
    expect(handlers.get("previoustrack")).toBeTypeOf("function");
    handlers.get("seekto")?.({ action: "seekto" });
    expect(transport.seekTo).not.toHaveBeenCalled();
  });

  it("plays the silent element and reports the state while the reader plays, and pauses it after", () => {
    const { session } = installMediaSession();
    const { rerender, options } = setup();
    rerender({ ...options, isPlaying: true });
    expect(play).toHaveBeenCalled();
    expect(session.playbackState).toBe("playing");
    pause.mockClear();
    rerender({ ...options, isPlaying: false });
    expect(pause).toHaveBeenCalled();
    expect(session.playbackState).toBe("paused");
  });

  it("reports a seek, but not ordinary playback", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { session } = installMediaSession();
    const { clock, rerender, options } = setup();
    rerender({ ...options, isPlaying: true });
    session.setPositionState.mockClear();

    act(() => {
      vi.advanceTimersByTime(500);
      clock.set(0.5);
    });
    expect(session.setPositionState).not.toHaveBeenCalled();

    act(() => clock.set(80));
    expect(session.setPositionState).toHaveBeenCalledWith({ duration: 120, position: 80, playbackRate: 1 });
  });

  it("throttles the growing length of a streaming section but settles on the last one", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { session } = installMediaSession();
    const { rerender, options } = setup({ duration: 10 });
    session.setPositionState.mockClear();
    rerender({ ...options, duration: 20 });
    rerender({ ...options, duration: 30 });
    expect(session.setPositionState).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2_000));
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 30, position: 0, playbackRate: 1 });
  });

  it("withdraws everything when disabled or unmounted", () => {
    const { session, handlers } = installMediaSession();
    const { rerender, options, unmount } = setup();
    rerender({ ...options, enabled: false });
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(handlers.get("play")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:silent");
    unmount();
  });

  it("does nothing where the Media Session API does not exist", () => {
    expect(() => setup()).not.toThrow();
  });
});

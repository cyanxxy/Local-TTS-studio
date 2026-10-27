import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CachedReaderAudioChunk } from "../lib/readerDocument";
import { useStudioAudioKeeper } from "./useStudioAudioKeeper";

const chunk = (value: number): CachedReaderAudioChunk => ({
  audio: new Float32Array([value]).buffer,
  samplingRate: 24_000,
  text: "t",
  index: 0,
  total: 1,
});

function setup(initialChunks: CachedReaderAudioChunk[]) {
  let held = initialChunks;
  let epoch = 1;
  const player = {
    getAudioCacheSnapshot: vi.fn(() => held),
    getContentEpoch: vi.fn(() => epoch),
    getCurrentTime: vi.fn(() => 3.5),
    getPlaybackSnapshot: vi.fn(() => ({ playbackRate: 1.25, totalDuration: 9, synthesisComplete: true })),
    restoreAudioCache: vi.fn((chunks: readonly CachedReaderAudioChunk[], options?: object) => {
      void chunks;
      void options;
      epoch += 1;
    }),
  };
  const setShowPlayer = vi.fn();
  const view = renderHook(
    ({ isStudioPage }) => useStudioAudioKeeper({ isStudioPage, player, setShowPlayer }),
    { initialProps: { isStudioPage: true } },
  );
  return {
    ...view,
    player,
    setShowPlayer,
    replaceHeld: (next: CachedReaderAudioChunk[]) => { held = next; },
    replaceContent: () => { epoch += 1; },
  };
}

describe("useStudioAudioKeeper", () => {
  it("puts Studio's audio back, paused where it was, after a visit to the Reader", () => {
    const studio = [chunk(1), chunk(2)];
    const { result, rerender, player, setShowPlayer, replaceHeld } = setup(studio);

    result.current.keepStudioAudio();
    // The Reader takes the player over.
    replaceHeld([chunk(9)]);
    rerender({ isStudioPage: false });
    expect(player.restoreAudioCache).not.toHaveBeenCalled();

    rerender({ isStudioPage: true });
    expect(player.restoreAudioCache).toHaveBeenCalledWith(studio, {
      currentTime: 3.5,
      playbackRate: 1.25,
      synthesisComplete: true,
    });
    expect(setShowPlayer).toHaveBeenCalledWith(true);
  });

  it("keeps only what Studio had, not what the Reader put in the player later", () => {
    const studio = [chunk(1)];
    const { result, rerender, player, replaceHeld } = setup(studio);
    result.current.keepStudioAudio();
    replaceHeld([chunk(9)]);
    // Each Reader section entry asks again; only the first call snapshots.
    result.current.keepStudioAudio();
    result.current.keepStudioAudio();
    rerender({ isStudioPage: false });
    rerender({ isStudioPage: true });
    expect(player.restoreAudioCache.mock.calls[0][0]).toBe(studio);
  });

  it("restores nothing when Studio had no audio, and restores only once per visit", () => {
    const { result, rerender, player } = setup([]);
    result.current.keepStudioAudio();
    rerender({ isStudioPage: false });
    rerender({ isStudioPage: true });
    expect(player.restoreAudioCache).not.toHaveBeenCalled();

    const withAudio = setup([chunk(1)]);
    withAudio.result.current.keepStudioAudio();
    withAudio.rerender({ isStudioPage: false });
    withAudio.rerender({ isStudioPage: true });
    withAudio.rerender({ isStudioPage: false });
    withAudio.rerender({ isStudioPage: true });
    expect(withAudio.player.restoreAudioCache).toHaveBeenCalledTimes(1);
  });

  it("tells the audio it put back apart from a generation that finishes later", () => {
    const { result, rerender, replaceContent } = setup([chunk(1)]);
    expect(result.current.isPutBackStudioAudio()).toBe(false);
    result.current.keepStudioAudio();
    rerender({ isStudioPage: false });
    rerender({ isStudioPage: true });
    expect(result.current.isPutBackStudioAudio()).toBe(true);

    // A new Studio generation empties the player first.
    replaceContent();
    expect(result.current.isPutBackStudioAudio()).toBe(false);
  });

  it("forgets what it kept when Studio's script is replaced while the Reader has the player", () => {
    const { result, rerender, player } = setup([chunk(1)]);
    // Studio still owns the player: nothing kept to drop.
    expect(result.current.dropKeptStudioAudio()).toBe(false);

    result.current.keepStudioAudio();
    expect(result.current.dropKeptStudioAudio()).toBe(true);
    rerender({ isStudioPage: false });
    rerender({ isStudioPage: true });
    expect(player.restoreAudioCache).not.toHaveBeenCalled();
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudition, type AuditionAudio } from "./useAudition";

class FakeAudio implements AuditionAudio {
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event | string) => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
}

describe("useAudition", () => {
  const revoke = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: vi.fn(() => "blob:clip"),
      revokeObjectURL: revoke,
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    revoke.mockClear();
  });

  it("plays one clip at a time and releases the previous clip", async () => {
    const created: FakeAudio[] = [];
    const { result } = renderHook(() => useAudition(() => { const audio = new FakeAudio(); created.push(audio); return audio; }));
    await act(() => result.current.play("a", new Uint8Array([1])));
    expect(result.current.playingKey).toBe("a");
    await act(() => result.current.play("b", new Uint8Array([2])));
    expect(result.current.playingKey).toBe("b");
    expect(created[0].pause).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("clears the playing key when the clip ends and when stopped", async () => {
    const created: FakeAudio[] = [];
    const { result } = renderHook(() => useAudition(() => { const audio = new FakeAudio(); created.push(audio); return audio; }));
    await act(() => result.current.play("a", new Uint8Array([1])));
    act(() => created[0].onended?.(new Event("ended")));
    expect(result.current.playingKey).toBeNull();
    await act(() => result.current.play("b", new Uint8Array([1])));
    act(() => result.current.stop());
    expect(result.current.playingKey).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("surfaces a playback failure and cleans up", async () => {
    const failing = new FakeAudio();
    failing.play.mockRejectedValue(new Error("blocked"));
    const { result } = renderHook(() => useAudition(() => failing));
    await expect(act(() => result.current.play("a", new Uint8Array([1])))).rejects.toThrow("blocked");
    expect(result.current.playingKey).toBeNull();
    expect(revoke).toHaveBeenCalled();
  });

  it("releases the clip on unmount", async () => {
    const audio = new FakeAudio();
    const { result, unmount } = renderHook(() => useAudition(() => audio));
    await act(() => result.current.play("a", new Uint8Array([1])));
    unmount();
    expect(audio.pause).toHaveBeenCalled();
  });

  describe("a clip replaced before its play() starts", () => {
    // Browsers reject a pending play() with AbortError when pause() interrupts it.
    class StartingAudio extends FakeAudio {
      private rejectPlay: (error: unknown) => void = () => undefined;
      override play = vi.fn(() => new Promise<undefined>((_resolve, reject) => { this.rejectPlay = reject; }));
      override pause = vi.fn(() => {
        this.rejectPlay(new DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
      });
    }

    it("is not reported as a failure when another clip replaces it", async () => {
      const { result } = renderHook(() => useAudition(() => new StartingAudio()));
      let first!: Promise<void>;
      act(() => { first = result.current.play("preview-1", new Uint8Array([1])); });
      act(() => { void result.current.play("preview-2", new Uint8Array([2])).catch(() => undefined); });
      await expect(first).resolves.toBeUndefined();
      expect(result.current.playingKey).toBe("preview-2");
    });

    it("is not reported as a failure when stopped", async () => {
      const { result } = renderHook(() => useAudition(() => new StartingAudio()));
      let first!: Promise<void>;
      act(() => { first = result.current.play("preview-1", new Uint8Array([1])); });
      act(() => result.current.stop());
      await expect(first).resolves.toBeUndefined();
      expect(result.current.playingKey).toBeNull();
    });
  });
});

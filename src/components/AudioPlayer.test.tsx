import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AudioPlayer } from "./AudioPlayer";
import { MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE, PLAYBACK_RATES } from "../constants";
import type { GenerationStats } from "../types";
import { PlaybackClock } from "../lib/playbackClock";
import type { UseAudioExportReturn } from "../hooks/useAudioExport";
import { AudioExportContext } from "./AudioExportContext";

function clockAt(seconds: number): PlaybackClock {
  const clock = new PlaybackClock();
  clock.set(seconds);
  return clock;
}


const defaultStats: GenerationStats = {
  firstLatency: null,
  processingTime: 0,
  charsPerSec: 0,
  rtf: 0,
  totalDuration: 0,
  currentDuration: 0,
};

function renderPlayer(overrides: Partial<React.ComponentProps<typeof AudioPlayer>> = {}) {
  return render(
    <AudioPlayer
      isPlaying={false}
      clock={clockAt(0)}
      totalDuration={0}
      segmentCount={0}
      activeSegmentNumber={null}
      stats={defaultStats}
      isGenerating={false}
      onTogglePlay={vi.fn()}
      onSeek={vi.fn()}
      onSkipBackward={vi.fn()}
      onSkipForward={vi.fn()}
      onDownload={vi.fn()}
      {...overrides}
    />,
  );
}

describe("AudioPlayer", () => {
  it("does not render playback rate controls", () => {
    renderPlayer({ totalDuration: 12, segmentCount: 2, activeSegmentNumber: 1 });

    expect(screen.queryByText("Playback rate: 1.00×")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "0.75×" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1×" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1.25×" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1.5×" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "2×" })).not.toBeInTheDocument();
  });

  it("renders reader dock actions from the shared player", () => {
    const onPlaybackRateChange = vi.fn();
    const onNextSegment = vi.fn();
    const onRetakeSegment = vi.fn();
    const onRegenerate = vi.fn();
    const onTogglePlay = vi.fn();

    renderPlayer({
      variant: "dock",
      isPlaying: true,
      isGenerating: true,
      allowPlaybackDuringGeneration: true,
      clock: clockAt(2),
      totalDuration: 10,
      segmentCount: 3,
      activeSegmentNumber: 2,
      playbackRate: 1,
      onPlaybackRateChange,
      canPreviousSegment: false,
      canNextSegment: true,
      onNextSegment,
      canRegenerate: true,
      onRegenerate,
      canRetakeSegment: true,
      onRetakeSegment,
      onTogglePlay,
    });

    const pause = screen.getByRole("button", { name: "Pause" });
    expect(pause).toBeEnabled();
    fireEvent.click(pause);

    expect(screen.getByRole("button", { name: "Previous passage" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next passage" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Playback speed" }), { target: { value: "1.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate speech" }));
    fireEvent.click(screen.getByRole("button", { name: "Retake passage" }));

    expect(onTogglePlay).toHaveBeenCalledOnce();
    expect(onNextSegment).toHaveBeenCalledOnce();
    expect(onPlaybackRateChange).toHaveBeenCalledWith(1.25);
    expect(onRegenerate).toHaveBeenCalledOnce();
    expect(onRetakeSegment).toHaveBeenCalledOnce();
  });

  it("offers exactly the playback speeds the player accepts", () => {
    const onPlaybackRateChange = vi.fn();
    renderPlayer({
      variant: "dock",
      clock: clockAt(2),
      totalDuration: 10,
      segmentCount: 3,
      activeSegmentNumber: 2,
      playbackRate: 1,
      onPlaybackRateChange,
    });

    const picker = screen.getByRole("combobox", { name: "Playback speed" });
    const offered = within(picker).getAllByRole("option").map((option) => Number((option as HTMLOptionElement).value));
    expect(offered).toEqual([...PLAYBACK_RATES]);
    expect(offered[0]).toBe(MIN_PLAYBACK_RATE);
    expect(offered.at(-1)).toBe(MAX_PLAYBACK_RATE);
    fireEvent.change(picker, { target: { value: "0.5" } });
    expect(onPlaybackRateChange).toHaveBeenCalledWith(0.5);
  });

  it("uses the shared player primary action before audio exists", () => {
    const onGenerate = vi.fn();

    renderPlayer({
      variant: "dock",
      primaryAction: {
        label: "Generate speech",
        onClick: onGenerate,
        icon: "generate",
      },
      segmentCount: 0,
      sectionPreviewCount: 2,
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate speech" }));

    expect(onGenerate).toHaveBeenCalledOnce();
    expect(screen.getByText("2 passages")).toBeInTheDocument();
  });

  it("renders disabled empty state controls", () => {
    renderPlayer();

    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back 10 seconds" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward 10 seconds" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download audio" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByText("No audio loaded")).toBeInTheDocument();
  });

  it("renders stats, playback state, stop controls, and segment labels", () => {
    const onTogglePlay = vi.fn();
    const onSkipBackward = vi.fn();
    const onSkipForward = vi.fn();
    const onDownload = vi.fn();
    const onStop = vi.fn();

    renderPlayer({
      compact: true,
      embedded: true,
      isPlaying: true,
      clock: clockAt(65.2),
      totalDuration: 125.6,
      segmentCount: 4,
      activeSegmentNumber: 2,
      stats: {
        firstLatency: 0.42,
        processingTime: 3.2,
        charsPerSec: 123.4,
        rtf: 0.2345,
        totalDuration: 125.6,
        currentDuration: 65.2,
      },
      onTogglePlay,
      onSkipBackward,
      onSkipForward,
      onDownload,
      onStop,
    });

    expect(screen.getByText("0.42s")).toBeInTheDocument();
    expect(screen.getByText("3.20s")).toBeInTheDocument();
    expect(screen.getByText("123")).toBeInTheDocument();
    expect(screen.getByText("0.234×")).toBeInTheDocument();
    expect(screen.getByText("Passage 2 of 4")).toBeInTheDocument();
    expect(screen.getByText("1:05")).toBeInTheDocument();
    expect(screen.getByText("2:05")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    // Pause already holds the position; Stop only appears to cancel generation.
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    fireEvent.click(screen.getByRole("button", { name: "Download audio" }));

    expect(onTogglePlay).toHaveBeenCalledOnce();
    expect(onSkipBackward).toHaveBeenCalledOnce();
    expect(onSkipForward).toHaveBeenCalledOnce();
    expect(onDownload).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("labels stop as generation stop while generating without audio", () => {
    renderPlayer({
      isGenerating: true,
      onStop: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Stop generation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  });

  it("handles pointer and keyboard seeking", () => {
    const onSeek = vi.fn();
    renderPlayer({
      clock: clockAt(50),
      totalDuration: 100,
      segmentCount: 2,
      onSeek,
    });

    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({
      left: 10,
      width: 200,
      top: 0,
      right: 210,
      bottom: 10,
      height: 10,
      x: 10,
      y: 0,
      toJSON: () => ({}),
    }));
    slider.setPointerCapture = vi.fn();
    slider.releasePointerCapture = vi.fn();
    slider.hasPointerCapture = vi.fn(() => true);

    fireEvent.pointerDown(slider, { pointerId: 1, clientX: 110 });
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 160 });
    fireEvent.pointerUp(slider, { pointerId: 1, clientX: 160 });
    fireEvent.pointerCancel(slider);

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowUp" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyDown(slider, { key: "ArrowDown" });
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.keyDown(slider, { key: "End" });
    fireEvent.keyDown(slider, { key: "Tab" });

    expect(onSeek.mock.calls.map(([value]) => value)).toEqual([
      0.5,
      0.75,
      0.55,
      0.55,
      0.45,
      0.45,
      0,
      1,
    ]);
  });

  it("ignores seek gestures when no audio is loaded", () => {
    const onSeek = vi.fn();
    renderPlayer({ onSeek });
    const slider = screen.getByRole("slider", { name: "Seek" });

    fireEvent.pointerDown(slider, { pointerId: 1, clientX: 100 });
    fireEvent.keyDown(slider, { key: "End" });

    expect(onSeek).not.toHaveBeenCalled();
  });

  it("caps visual progress and shows inactive section counts", () => {
    renderPlayer({
      clock: clockAt(200),
      totalDuration: 100,
      segmentCount: 3,
      activeSegmentNumber: null,
    });

    expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("3 passages")).toBeInTheDocument();
  });

  it("carries rounded seconds into the next minute", () => {
    renderPlayer({
      clock: clockAt(59.96),
      totalDuration: 120,
      segmentCount: 1,
    });

    expect(screen.getByText("0:59")).toBeInTheDocument();
    expect(screen.queryByText("0:60")).not.toBeInTheDocument();
  });

  it("uses the singular for a single passage", () => {
    renderPlayer({ totalDuration: 2, segmentCount: 1, activeSegmentNumber: null });
    expect(screen.getByText("1 passage")).toBeInTheDocument();
  });

  it("formats long audio with hours", () => {
    renderPlayer({ clock: clockAt(3725), totalDuration: 4500, segmentCount: 1 });
    expect(screen.getByText("1:02:05")).toBeInTheDocument();
    expect(screen.getByText("1:15:00")).toBeInTheDocument();
  });

  it("keeps benchmark stats out of the reader dock", () => {
    renderPlayer({
      variant: "dock",
      totalDuration: 10,
      segmentCount: 1,
      stats: { firstLatency: 0.42, processingTime: 3.2, charsPerSec: 123, rtf: 0.2, totalDuration: 10, currentDuration: 0 },
    });
    expect(screen.queryByText(/first audio/i)).toBeNull();
    expect(screen.queryByText(/RTF/)).toBeNull();
  });

  it("collects secondary dock actions in an overflow menu for small screens", () => {
    const onDownload = vi.fn();
    const onStop = vi.fn();
    renderPlayer({
      variant: "dock",
      isGenerating: true,
      allowPlaybackDuringGeneration: true,
      totalDuration: 10,
      segmentCount: 2,
      activeSegmentNumber: 1,
      onDownload,
      onStop,
    });

    fireEvent.click(screen.getByRole("button", { name: "More playback options" }));
    const menu = screen.getByRole("menu", { name: "Playback options" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Download audio" }));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More playback options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop generation" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("gives Play the accent while paused", () => {
    renderPlayer({ totalDuration: 10, segmentCount: 1, isPlaying: false });
    expect(screen.getByRole("button", { name: "Play" })).toHaveClass("glass-accent");
  });

  it("seeks safely when a temporarily hidden slider has no width", () => {
    const onSeek = vi.fn();
    renderPlayer({ totalDuration: 10, segmentCount: 1, onSeek });
    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      width: 0,
      top: 0,
      right: 0,
      bottom: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
    slider.setPointerCapture = vi.fn();

    fireEvent.pointerDown(slider, { pointerId: 1, clientX: 20 });

    expect(onSeek).toHaveBeenCalledWith(0);
  });

  describe("while an export runs", () => {
    function renderExporting(variant: "panel" | "dock", exportState: Partial<UseAudioExportReturn> = {}) {
      const audioExport: UseAudioExportReturn = {
        isExporting: true,
        progress: { phase: "encoding", fraction: 0.37 },
        summary: null,
        start: vi.fn(),
        cancel: vi.fn(),
        ...exportState,
      };
      const onDownload = vi.fn();
      render(
        <AudioExportContext.Provider value={audioExport}>
          <AudioPlayer
            variant={variant}
            isPlaying={false}
            clock={clockAt(0)}
            totalDuration={12}
            segmentCount={1}
            activeSegmentNumber={1}
            stats={defaultStats}
            isGenerating={false}
            onTogglePlay={vi.fn()}
            onSeek={vi.fn()}
            onSkipBackward={vi.fn()}
            onSkipForward={vi.fn()}
            onDownload={onDownload}
          />
        </AudioExportContext.Provider>,
      );
      return { audioExport, onDownload };
    }

    it.each(["panel", "dock"] as const)("turns the %s download button into a cancel button with progress", (variant) => {
      const { audioExport, onDownload } = renderExporting(variant);

      expect(screen.queryByRole("button", { name: "Download audio" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel export (37%)" }));

      expect(audioExport.cancel).toHaveBeenCalledOnce();
      expect(onDownload).not.toHaveBeenCalled();
    });

    it("keeps the cancel action in the overflow menu", () => {
      const { audioExport } = renderExporting("dock");
      fireEvent.click(screen.getByRole("button", { name: "More playback options" }));
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Cancel export (37%)" }));
      expect(audioExport.cancel).toHaveBeenCalledOnce();
    });

    it("downloads as before once the export is over, and when no export is provided", () => {
      const { onDownload } = renderExporting("panel", { isExporting: false, progress: null });
      fireEvent.click(screen.getByRole("button", { name: "Download audio" }));
      expect(onDownload).toHaveBeenCalledOnce();
    });

    it("reads zero progress before the first report", () => {
      renderExporting("panel", { progress: null });
      expect(screen.getByRole("button", { name: "Cancel export (0%)" })).toBeInTheDocument();
    });
  });
});

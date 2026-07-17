import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AudioPlayer } from "./AudioPlayer";
import type { GenerationStats } from "../types";

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
      currentTime={0}
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
      currentTime: 2,
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

    expect(screen.getByRole("button", { name: "Previous section" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next section" }));
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 1×" }));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate speech" }));
    fireEvent.click(screen.getByRole("button", { name: "Retake section" }));

    expect(onTogglePlay).toHaveBeenCalledOnce();
    expect(onNextSegment).toHaveBeenCalledOnce();
    expect(onPlaybackRateChange).toHaveBeenCalledWith(1.25);
    expect(onRegenerate).toHaveBeenCalledOnce();
    expect(onRetakeSegment).toHaveBeenCalledOnce();
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
    expect(screen.getByText("2 sections")).toBeInTheDocument();
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
      currentTime: 65.2,
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
    expect(screen.getByText("Section 2 of 4")).toBeInTheDocument();
    expect(screen.getByText("1:05.2")).toBeInTheDocument();
    expect(screen.getByText("2:05.6")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop playback" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    fireEvent.click(screen.getByRole("button", { name: "Download audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));

    expect(onTogglePlay).toHaveBeenCalledOnce();
    expect(onSkipBackward).toHaveBeenCalledOnce();
    expect(onSkipForward).toHaveBeenCalledOnce();
    expect(onDownload).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
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
      currentTime: 50,
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
      currentTime: 200,
      totalDuration: 100,
      segmentCount: 3,
      activeSegmentNumber: null,
    });

    expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("3 sections")).toBeInTheDocument();
  });

  it("carries rounded seconds into the next minute", () => {
    renderPlayer({
      currentTime: 59.96,
      totalDuration: 120,
      segmentCount: 1,
    });

    expect(screen.getByText("1:00.0")).toBeInTheDocument();
    expect(screen.queryByText("0:60.0")).not.toBeInTheDocument();
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
});

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
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AudioExportOptions } from "../types";
import { CreatorToolsPanel } from "./CreatorToolsPanel";

const EXPORT_OPTIONS: AudioExportOptions = {
  format: "mp3",
  sampleRate: 48000,
  bitrateKbps: 192,
  mastering: {
    enabled: true,
    targetLufs: -14,
    truePeakDb: -1,
  },
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof CreatorToolsPanel>> = {}) {
  const props: React.ComponentProps<typeof CreatorToolsPanel> = {
    preset: "youtube-shorts",
    onPresetChange: vi.fn(),
    speed: 1.02,
    onSpeedChange: vi.fn(),
    pauseCommaSec: 0.11,
    onPauseCommaSecChange: vi.fn(),
    pauseSentenceSec: 0.2,
    onPauseSentenceSecChange: vi.fn(),
    pauseParagraphSec: 0.32,
    onPauseParagraphSecChange: vi.fn(),
    pronunciationLexicon: "",
    onPronunciationLexiconChange: vi.fn(),
    exportOptions: EXPORT_OPTIONS,
    onExportFormatChange: vi.fn(),
    onExportSampleRateChange: vi.fn(),
    onExportBitrateKbpsChange: vi.fn(),
    onMasteringEnabledChange: vi.fn(),
    hasAudio: true,
    onDownloadAudio: vi.fn(),
    onDownloadCaptions: vi.fn(),
    ...overrides,
  };

  render(<CreatorToolsPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Creator Toolkit/i }));
  return props;
}

describe("CreatorToolsPanel", () => {
  it("opens creator controls and forwards setting changes", () => {
    const props = renderPanel();
    const selects = screen.getAllByRole("combobox");
    const sliders = screen.getAllByRole("slider");

    fireEvent.change(selects[0], { target: { value: "custom" } });
    fireEvent.change(sliders[0], { target: { value: "1.1" } });
    fireEvent.change(sliders[1], { target: { value: "0.2" } });
    fireEvent.change(sliders[2], { target: { value: "0.3" } });
    fireEvent.change(sliders[3], { target: { value: "0.4" } });
    fireEvent.change(screen.getByPlaceholderText(/route=r-ow-t/i), { target: { value: "GIF=jif" } });
    fireEvent.change(selects[1], { target: { value: "wav-pcm16" } });
    fireEvent.change(selects[2], { target: { value: "44100" } });
    fireEvent.change(selects[3], { target: { value: "320" } });
    fireEvent.click(screen.getByLabelText("Normalize loudness for voiceover"));

    expect(props.onPresetChange).toHaveBeenCalledWith("custom");
    expect(props.onSpeedChange).toHaveBeenCalledWith(1.1);
    expect(props.onPauseCommaSecChange).toHaveBeenCalledWith(0.2);
    expect(props.onPauseSentenceSecChange).toHaveBeenCalledWith(0.3);
    expect(props.onPauseParagraphSecChange).toHaveBeenCalledWith(0.4);
    expect(props.onPronunciationLexiconChange).toHaveBeenCalledWith("GIF=jif");
    expect(props.onExportFormatChange).toHaveBeenCalledWith("wav-pcm16");
    expect(props.onExportSampleRateChange).toHaveBeenCalledWith(44100);
    expect(props.onExportBitrateKbpsChange).toHaveBeenCalledWith(320);
    expect(props.onMasteringEnabledChange).toHaveBeenCalledWith(false);
  });

  it("downloads audio and captions when audio exists", () => {
    const props = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Audio/i }));
    fireEvent.click(screen.getByRole("button", { name: /SRT/i }));
    fireEvent.click(screen.getByRole("button", { name: /VTT/i }));
    fireEvent.click(screen.getByRole("button", { name: /JSON/i }));

    expect(props.onDownloadAudio).toHaveBeenCalledOnce();
    expect(props.onDownloadCaptions).toHaveBeenCalledWith("srt");
    expect(props.onDownloadCaptions).toHaveBeenCalledWith("vtt");
    expect(props.onDownloadCaptions).toHaveBeenCalledWith("json");
  });

  it("shows custom copy, hides bitrate for WAV, and disables downloads without audio", () => {
    renderPanel({
      preset: "custom",
      exportOptions: {
        ...EXPORT_OPTIONS,
        format: "wav-f32",
      },
      hasAudio: false,
    });

    expect(screen.getByText("Manual creator settings.")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Audio/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /SRT/i })).toBeDisabled();
  });
});

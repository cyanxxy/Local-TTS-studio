import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExportSummary, UseAudioExportReturn } from "../../hooks/useAudioExport";
import type { UseCreatorSettingsReturn } from "../../hooks/useCreatorSettings";
import { getCreatorPresetDefaults } from "../../lib/appState";
import { ExportSettings } from "./ExportSettings";

type CreatorProps = React.ComponentProps<typeof ExportSettings>["creator"];

function makeCreator(overrides: Partial<CreatorProps> = {}): CreatorProps {
  return {
    exportOptions: {
      format: "mp3",
      sampleRate: 48000,
      bitrateKbps: 192,
      mastering: { enabled: true, targetLufs: -14, truePeakDb: -1 },
    },
    exportPost: getCreatorPresetDefaults("youtube-shorts").exportPost,
    loudnessPresetId: "streaming",
    captionStyle: "readable",
    onExportFormatChange: vi.fn(),
    onExportSampleRateChange: vi.fn(),
    onExportBitrateChange: vi.fn(),
    onMasteringEnabledChange: vi.fn(),
    onLoudnessPresetChange: vi.fn(),
    onExportPostChange: vi.fn(),
    onCaptionStyleChange: vi.fn(),
    ...overrides,
  } satisfies Pick<UseCreatorSettingsReturn, keyof CreatorProps>;
}

function makeExport(overrides: Partial<UseAudioExportReturn> = {}): UseAudioExportReturn {
  return { isExporting: false, progress: null, summary: null, start: vi.fn(), cancel: vi.fn(), ...overrides };
}

const SUMMARY: ExportSummary = {
  extension: "mp3",
  report: {
    integratedLufs: -14.2,
    loudnessRangeLu: 5.46,
    truePeakDbtp: -1.04,
    samplePeakDbfs: -3.5,
    rmsDbfs: -19.5,
    durationSec: 62,
  },
  gainDb: 2.3,
  limiterReductionDb: 0.8,
  mastered: true,
};

function renderSettings(props: Partial<React.ComponentProps<typeof ExportSettings>> = {}) {
  const full: React.ComponentProps<typeof ExportSettings> = {
    creator: makeCreator(),
    sourceSampleRate: 24000,
    hasAudio: true,
    audioExport: makeExport(),
    onDownloadCaptions: vi.fn(),
    ...props,
  };
  render(<ExportSettings {...full} />);
  return full;
}

describe("ExportSettings", () => {
  it("offers WAV, FLAC and MP3 and forwards the choices", () => {
    const { creator } = renderSettings();
    const format = screen.getByLabelText("Format") as HTMLSelectElement;

    expect(Array.from(format.options).map((option) => option.value)).toEqual([
      "wav-pcm24", "wav-pcm16", "wav-f32", "flac-24", "flac-16", "mp3",
    ]);
    fireEvent.change(format, { target: { value: "flac-24" } });
    fireEvent.change(screen.getByLabelText("Sample Rate"), { target: { value: "44100" } });
    fireEvent.change(screen.getByLabelText("Sample Rate"), { target: { value: "source" } });
    fireEvent.change(screen.getByLabelText("Bitrate"), { target: { value: "256" } });
    fireEvent.click(screen.getByLabelText("Normalize loudness for voiceover"));

    expect(creator.onExportFormatChange).toHaveBeenCalledWith("flac-24");
    expect(creator.onExportSampleRateChange).toHaveBeenNthCalledWith(1, 44100);
    expect(creator.onExportSampleRateChange).toHaveBeenNthCalledWith(2, "source");
    expect(creator.onExportBitrateChange).toHaveBeenCalledWith(256);
    expect(creator.onMasteringEnabledChange).toHaveBeenCalledWith(false);
  });

  it("lists the bitrates the encoder supports, from 64 kbps", () => {
    renderSettings();
    const bitrate = screen.getByLabelText("Bitrate") as HTMLSelectElement;
    expect(Array.from(bitrate.options).map((option) => option.value)).toEqual(["64", "96", "128", "160", "192", "256", "320"]);
    expect(bitrate.value).toBe("192");
    expect(Array.from(bitrate.options).every((option) => !option.disabled)).toBe(true);
    expect(screen.queryByText(/tops out at 160 kbps/)).not.toBeInTheDocument();
  });

  it("caps MP3 at 160 kbps for a low sample rate and says why", () => {
    renderSettings({
      creator: makeCreator({
        exportOptions: {
          format: "mp3",
          sampleRate: "source",
          bitrateKbps: 320,
          mastering: { enabled: false, targetLufs: -14, truePeakDb: -1 },
        },
      }),
      sourceSampleRate: 24000,
    });

    const bitrate = screen.getByLabelText("Bitrate") as HTMLSelectElement;
    expect(bitrate.value).toBe("160");
    const disabled = Array.from(bitrate.options).filter((option) => option.disabled).map((option) => option.value);
    expect(disabled).toEqual(["192", "256", "320"]);
    expect(screen.getByText(/At 24 kHz MP3 tops out at 160 kbps\. Choose 44\.1 or 48 kHz for more\./)).toBeInTheDocument();
  });

  it("does not guess the rate before there is audio", () => {
    renderSettings({
      creator: makeCreator({
        exportOptions: {
          format: "mp3",
          sampleRate: "source",
          bitrateKbps: 320,
          mastering: { enabled: false, targetLufs: -14, truePeakDb: -1 },
        },
      }),
      sourceSampleRate: null,
      hasAudio: false,
    });
    expect((screen.getByLabelText("Bitrate") as HTMLSelectElement).value).toBe("320");
    expect(screen.queryByText(/tops out/)).not.toBeInTheDocument();
  });

  it("hides the bitrate for lossless formats", () => {
    renderSettings({
      creator: makeCreator({
        exportOptions: { format: "flac-16", sampleRate: 48000, bitrateKbps: 192, mastering: { enabled: false, targetLufs: -14, truePeakDb: -1 } },
      }),
    });
    expect(screen.queryByLabelText("Bitrate")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Loudness target")).not.toBeInTheDocument();
  });

  it("picks a loudness target and describes it", () => {
    const { creator } = renderSettings();
    const target = screen.getByLabelText("Loudness target") as HTMLSelectElement;

    expect(target.value).toBe("streaming");
    expect(screen.getByText(/Matches loudness to -14 LUFS with a true-peak limiter at -1 dBTP/)).toBeInTheDocument();
    fireEvent.change(target, { target: { value: "acx" } });
    expect(creator.onLoudnessPresetChange).toHaveBeenCalledWith("acx");
  });

  it("describes the ACX target in RMS and falls back to the first preset for an unknown one", () => {
    const { unmount } = render(
      <ExportSettings
        creator={makeCreator({ loudnessPresetId: "acx" })}
        sourceSampleRate={null}
        hasAudio
        audioExport={makeExport()}
        onDownloadCaptions={vi.fn()}
      />,
    );
    expect(screen.getByText(/Matches RMS to -20 dB with a true-peak limiter at -3 dBTP/)).toBeInTheDocument();
    unmount();
    render(
      <ExportSettings
        creator={makeCreator({ loudnessPresetId: "mystery" })}
        sourceSampleRate={null}
        hasAudio
        audioExport={makeExport()}
        onDownloadCaptions={vi.fn()}
      />,
    );
    expect((screen.getByLabelText("Loudness target") as HTMLSelectElement).value).toBe("streaming");
  });

  it("sets trimming, padding and fades", () => {
    const { creator } = renderSettings();

    fireEvent.click(screen.getByLabelText(/Trim silence/));
    fireEvent.change(screen.getByLabelText("Pad start"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Pad end"), { target: { value: "99" } });
    fireEvent.change(screen.getByLabelText("Fade in"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Fade out"), { target: { value: "-5" } });
    fireEvent.change(screen.getByLabelText("Fade out"), { target: { value: "" } });

    const calls = (creator.onExportPostChange as ReturnType<typeof vi.fn>).mock.calls.map(([patch]) => patch);
    expect(calls).toEqual([
      { trimSilence: true },
      { headSec: 0.5 },
      { tailSec: 10 },
      { fadeInMs: 30 },
      { fadeOutMs: 0 },
      { fadeOutMs: 0 },
    ]);
  });

  it("chooses the caption style", () => {
    const { creator } = renderSettings();
    fireEvent.change(screen.getByLabelText("Caption style"), { target: { value: "short" } });
    expect(creator.onCaptionStyleChange).toHaveBeenCalledWith("short");
  });

  it("starts the export and the caption downloads", () => {
    const props = renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Audio" }));
    fireEvent.click(screen.getByRole("button", { name: "SRT" }));
    fireEvent.click(screen.getByRole("button", { name: "VTT" }));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));

    expect(props.audioExport.start).toHaveBeenCalledOnce();
    expect(props.onDownloadCaptions).toHaveBeenNthCalledWith(1, "srt");
    expect(props.onDownloadCaptions).toHaveBeenNthCalledWith(2, "vtt");
    expect(props.onDownloadCaptions).toHaveBeenNthCalledWith(3, "json");
  });

  it("disables downloads without audio", () => {
    renderSettings({ hasAudio: false });
    for (const name of ["Audio", "SRT", "VTT", "JSON"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByText("Generate audio to enable downloads.")).toBeInTheDocument();
  });

  it("shows export progress and cancels it", () => {
    const audioExport = makeExport({ isExporting: true, progress: { phase: "analyzing", fraction: 0.4 } });
    const { rerender } = render(
      <ExportSettings creator={makeCreator()} sourceSampleRate={24000} hasAudio audioExport={audioExport} onDownloadCaptions={vi.fn()} />,
    );

    expect(screen.getByRole("progressbar", { name: "Export progress" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("Measuring loudness…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    expect(audioExport.cancel).toHaveBeenCalledOnce();
    expect(audioExport.start).not.toHaveBeenCalled();

    rerender(
      <ExportSettings
        creator={makeCreator()}
        sourceSampleRate={24000}
        hasAudio
        audioExport={makeExport({ isExporting: true, progress: { phase: "encoding", fraction: 0.9 } })}
        onDownloadCaptions={vi.fn()}
      />,
    );
    expect(screen.getByText("Encoding…")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
  });

  it("reports the loudness of a finished export", () => {
    renderSettings({ audioExport: makeExport({ summary: SUMMARY }) });

    expect(screen.getByText("Loudness report (MP3)")).toBeInTheDocument();
    expect(screen.getByText("-14.2 LUFS")).toBeInTheDocument();
    expect(screen.getByText("5.5 LU")).toBeInTheDocument();
    expect(screen.getByText("-1.0 dBTP")).toBeInTheDocument();
    expect(screen.getByText("-19.5 dBFS")).toBeInTheDocument();
    expect(screen.getByText("1:02")).toBeInTheDocument();
    expect(screen.getByText("+2.3 dB")).toBeInTheDocument();
    expect(screen.getByText("up to 0.8 dB")).toBeInTheDocument();
    // The streaming target has no ACX verdict.
    expect(screen.queryByText(/ACX loudness|ACX limits/)).not.toBeInTheDocument();
  });

  it("judges an ACX export against the ACX limits", () => {
    renderSettings({
      creator: makeCreator({ loudnessPresetId: "acx" }),
      audioExport: makeExport({ summary: SUMMARY }),
    });
    expect(screen.getByText("Meets the ACX loudness and peak limits.")).toBeInTheDocument();
  });

  it("flags an ACX export outside the limits and handles silent and unmastered reports", () => {
    const { unmount } = render(
      <ExportSettings
        creator={makeCreator({ loudnessPresetId: "acx" })}
        sourceSampleRate={null}
        hasAudio
        audioExport={makeExport({ summary: { ...SUMMARY, report: { ...SUMMARY.report, rmsDbfs: -30 } } })}
        onDownloadCaptions={vi.fn()}
      />,
    );
    expect(screen.getByText(/Outside the ACX limits: RMS −30\.0 dBFS/)).toBeInTheDocument();
    unmount();

    render(
      <ExportSettings
        creator={makeCreator()}
        sourceSampleRate={null}
        hasAudio
        audioExport={makeExport({
          summary: {
            ...SUMMARY,
            mastered: false,
            limiterReductionDb: 0,
            report: { ...SUMMARY.report, integratedLufs: Number.NEGATIVE_INFINITY, truePeakDbtp: Number.NEGATIVE_INFINITY, rmsDbfs: Number.NEGATIVE_INFINITY },
          },
        })}
        onDownloadCaptions={vi.fn()}
      />,
    );
    expect(screen.getAllByText("silent")).toHaveLength(3);
    expect(screen.queryByText("Gain applied")).not.toBeInTheDocument();
  });

  it("shows no limiter reduction when the limiter was not needed", () => {
    renderSettings({ audioExport: makeExport({ summary: { ...SUMMARY, limiterReductionDb: 0 } }) });
    expect(screen.getByText("not needed")).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { chunkForKokoroDetailed } from "../lib/chunking";
import type { UseAudioExportReturn } from "../hooks/useAudioExport";
import type { UseCreatorSettingsReturn } from "../hooks/useCreatorSettings";
import { getCreatorPresetDefaults } from "../lib/appState";
import { createPronunciationDictionary } from "../lib/pronunciation/dictionary";
import { CreatorToolsPanel, type CreatorEngineSupport } from "./CreatorToolsPanel";

const KOKORO: CreatorEngineSupport = {
  engineLabel: "Kokoro",
  speed: true,
  pauses: true,
  speechLanguage: "en-US",
  normalization: true,
  phonemes: false,
  chunkScript: (text) => chunkForKokoroDetailed(text, { backend: "wasm" }),
};

function makeCreator(overrides: Partial<UseCreatorSettingsReturn> = {}): UseCreatorSettingsReturn {
  const defaults = getCreatorPresetDefaults("youtube-shorts");
  const dictionaries = overrides.dictionaries ?? [];
  const speechSettings = overrides.speechSettings ?? { dictionaries, normalize: false, cleanup: false };
  return {
    creatorPreset: "youtube-shorts",
    speed: defaults.speed,
    pauseCommaSec: defaults.pauseCommaSec,
    pauseSentenceSec: defaults.pauseSentenceSec,
    pauseParagraphSec: defaults.pauseParagraphSec,
    dictionaries,
    normalizeSpeech: false,
    cleanupOnSpeak: false,
    speechSettings,
    exportPost: defaults.exportPost,
    loudnessPresetId: "streaming",
    captionStyle: "readable",
    migrationNotice: undefined,
    generationSettings: { speed: defaults.speed, quality: 5, pauseOverridesSec: { comma: 0.11, sentence: 0.2, paragraph: 0.32, none: 0 } },
    exportOptions: {
      format: "mp3",
      sampleRate: 48000,
      bitrateKbps: 192,
      mastering: { enabled: true, targetLufs: -14, truePeakDb: -1 },
    },
    persistedState: {},
    onCreatorPresetChange: vi.fn(),
    onSpeedChange: vi.fn(),
    onPauseCommaChange: vi.fn(),
    onPauseSentenceChange: vi.fn(),
    onPauseParagraphChange: vi.fn(),
    onDictionariesChange: vi.fn(),
    onNormalizeSpeechChange: vi.fn(),
    onCleanupOnSpeakChange: vi.fn(),
    onExportFormatChange: vi.fn(),
    onExportSampleRateChange: vi.fn(),
    onExportBitrateChange: vi.fn(),
    onMasteringEnabledChange: vi.fn(),
    onLoudnessPresetChange: vi.fn(),
    onExportPostChange: vi.fn(),
    onCaptionStyleChange: vi.fn(),
    ...overrides,
  };
}

function makeExport(overrides: Partial<UseAudioExportReturn> = {}): UseAudioExportReturn {
  return { isExporting: false, progress: null, summary: null, start: vi.fn(), cancel: vi.fn(), ...overrides };
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof CreatorToolsPanel>> = {},
) {
  const full: React.ComponentProps<typeof CreatorToolsPanel> = {
    creator: makeCreator(),
    engineSupport: KOKORO,
    script: "Dr. Smith paid $5.",
    onScriptChange: vi.fn(),
    sourceSampleRate: 24000,
    hasAudio: true,
    audioExport: makeExport(),
    onDownloadCaptions: vi.fn(),
    ...props,
  };
  render(<CreatorToolsPanel {...full} />);
  fireEvent.click(screen.getByRole("button", { name: /Creator Toolkit/i }));
  return full;
}

describe("CreatorToolsPanel", () => {
  it("opens creator controls and forwards timing changes", () => {
    const props = renderPanel();
    const creator = props.creator;

    expect(screen.getByRole("button", { name: /Creator Toolkit/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Base Speed")).toHaveAttribute("step", "0.01");
    expect(screen.getByLabelText("Comma pause")).toHaveValue("0.11");

    fireEvent.change(screen.getByLabelText("Platform Preset"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Base Speed"), { target: { value: "1.1" } });
    fireEvent.change(screen.getByLabelText("Comma pause"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("Sentence pause"), { target: { value: "0.3" } });
    fireEvent.change(screen.getByLabelText("Paragraph pause"), { target: { value: "0.4" } });

    expect(creator.onCreatorPresetChange).toHaveBeenCalledWith("custom");
    expect(creator.onSpeedChange).toHaveBeenCalledWith(1.1);
    expect(creator.onPauseCommaChange).toHaveBeenCalledWith(0.2);
    expect(creator.onPauseSentenceChange).toHaveBeenCalledWith(0.3);
    expect(creator.onPauseParagraphChange).toHaveBeenCalledWith(0.4);
    expect(screen.getByText(/Crisp short-form voiceover/)).toBeInTheDocument();
  });

  it("shows custom copy for the custom preset", () => {
    renderPanel({ creator: makeCreator({ creatorPreset: "custom" }) });
    expect(screen.getByText("Manual creator settings.")).toBeInTheDocument();
  });

  it("disables the speed control when the selected model has a fixed speaking rate", () => {
    renderPanel({ engineSupport: { ...KOKORO, engineLabel: "Audio8 TTS", speed: false } });

    const speed = screen.getByLabelText("Base Speed");
    expect(speed).toBeDisabled();
    expect(speed).toHaveAccessibleDescription("Audio8 TTS uses its model-native speaking rate.");
    expect(screen.getByLabelText("Comma pause")).toBeEnabled();
  });

  it("explains the controls an engine ignores while pauses written into the script still work", () => {
    renderPanel({ engineSupport: { ...KOKORO, engineLabel: "Qwen3-TTS", speed: false, pauses: false } });

    for (const label of ["Comma pause", "Sentence pause", "Paragraph pause"]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
      expect(screen.getByLabelText(label)).toHaveAccessibleDescription(
        /Qwen3-TTS paces its own pauses, so these lengths are not applied\. Pauses you write into the script/,
      );
    }
    // The pronunciation dictionary, presets and exports apply to every engine.
    expect(screen.getByRole("button", { name: "New dictionary" })).toBeEnabled();
    expect(screen.getByLabelText("Platform Preset")).toBeEnabled();
  });

  it("enables every Creator control for an engine that reads them all", () => {
    renderPanel();
    expect(screen.getByLabelText("Base Speed")).toBeEnabled();
    expect(screen.getByLabelText("Paragraph pause")).toBeEnabled();
    expect(screen.queryByText(/not applied|model-native/)).not.toBeInTheDocument();
  });

  describe("script tools", () => {
    it("toggles normalization and cleanup-on-speak", () => {
      const creator = makeCreator();
      renderPanel({ creator });

      fireEvent.click(screen.getByLabelText(/Read numbers, dates, prices and abbreviations as words/));
      fireEvent.click(screen.getByLabelText(/Skip citations, links, emoji and Markdown/));

      expect(creator.onNormalizeSpeechChange).toHaveBeenCalledWith(true);
      expect(creator.onCleanupOnSpeakChange).toHaveBeenCalledWith(true);
      expect(screen.getByText(/English only\. Turn it off/)).toBeInTheDocument();
    });

    it("says why normalization is unavailable for an engine speaking another language", () => {
      renderPanel({ engineSupport: { ...KOKORO, speechLanguage: "fr", normalization: false } });

      const toggle = screen.getByLabelText(/Read numbers, dates, prices and abbreviations as words/);
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveAccessibleDescription("This works for English only, and Kokoro is set to another language.");
    });

    it("previews a cleanup before applying it to the script", () => {
      const props = renderPanel({ script: "A fact [1] with *style*." });
      expect(screen.queryByRole("button", { name: "Clean up script" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Clean up the script" }));
      expect(screen.getByTestId("cleanup-preview")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Clean up script" }));

      expect(props.onScriptChange).toHaveBeenCalledWith("A fact with style.");
      fireEvent.click(screen.getByRole("button", { name: "Clean up the script" }));
      expect(screen.queryByTestId("cleanup-preview")).not.toBeInTheDocument();
    });

    it("explains the pause syntax and previews the script for the active engine", () => {
      renderPanel({
        script: 'Hello there.<break time="2s"/>GIF files.',
        creator: makeCreator({
          dictionaries: [createPronunciationDictionary({ name: "Q", rules: [{ type: "alias", from: "GIF", to: "jif" }] })],
        }),
      });

      expect(screen.getByText(/or use the Pause button under the script/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Script preflight/ }));
      const items = within(screen.getByRole("img", { name: /Map of/ }).parentElement!).getAllByRole("listitem");
      expect(items).toHaveLength(2);
      expect(items[1]).toHaveTextContent("jif files.");
      expect(screen.getByText(/An estimate for Kokoro/)).toBeInTheDocument();
    });
  });

  describe("pronunciation", () => {
    it("previews the spoken form with the dictionary, normalization and the engine's language", () => {
      const dictionary = createPronunciationDictionary({
        name: "Brand",
        rules: [{ type: "alias", from: "GIF", to: "jif" }, { type: "alias", from: "SQL", to: "sequel" }],
      });
      renderPanel({
        creator: makeCreator({
          dictionaries: [dictionary],
          speechSettings: { dictionaries: [dictionary], normalize: true, cleanup: false },
        }),
      });

      expect(screen.queryByText("Spoken as")).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Test pronunciation rules"), { target: { value: "GIF and SQL cost $5" } });

      expect(screen.getByText("jif and sequel cost five dollars")).toBeInTheDocument();
    });

    it("manages the dictionaries through the creator settings", () => {
      const creator = makeCreator();
      renderPanel({ creator });

      fireEvent.click(screen.getByRole("button", { name: "New dictionary" }));

      expect(creator.onDictionariesChange).toHaveBeenCalledWith([expect.objectContaining({ name: "Dictionary 1" })]);
    });
  });

  it("tells the user once which saved pronunciation rules the upgrade left out", () => {
    renderPanel({ creator: makeCreator({ migrationNotice: "2 of your 3 saved pronunciation rules were left out." }) });
    expect(screen.getByText("2 of your 3 saved pronunciation rules were left out.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/left out/)).not.toBeInTheDocument();
  });

  describe("export", () => {
    it("downloads audio and captions when audio exists", () => {
      const props = renderPanel();

      fireEvent.click(screen.getByRole("button", { name: "Audio" }));
      fireEvent.click(screen.getByRole("button", { name: "SRT" }));
      fireEvent.click(screen.getByRole("button", { name: "VTT" }));
      fireEvent.click(screen.getByRole("button", { name: "JSON" }));

      expect(props.audioExport.start).toHaveBeenCalledOnce();
      expect(props.onDownloadCaptions).toHaveBeenCalledWith("srt");
      expect(props.onDownloadCaptions).toHaveBeenCalledWith("vtt");
      expect(props.onDownloadCaptions).toHaveBeenCalledWith("json");
    });

    it("disables downloads without audio", () => {
      renderPanel({ hasAudio: false });

      expect(screen.getByRole("button", { name: "Audio" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "SRT" })).toBeDisabled();
      expect(screen.getByText("Generate audio to enable downloads.")).toBeInTheDocument();
    });
  });
});

import { useId, useMemo, useState } from "react";
import { ChevronDown, Download, FileCode2, FileJson, Subtitles, X } from "lucide-react";
import {
  CREATOR_PRESETS,
  PAUSE_MAX,
  PAUSE_MIN,
  PAUSE_STEP,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
} from "../constants";
import { analyzePronunciationLexicon } from "../lib/appState";
import { applyPronunciationRules } from "../lib/textTuning";
import type {
  AudioExportOptions,
  CaptionExportFormat,
  CreatorPresetId,
  ExportAudioFormat,
  ExportSampleRate,
} from "../types";

interface CreatorToolsPanelProps {
  preset: CreatorPresetId;
  onPresetChange: (preset: CreatorPresetId) => void;
  speed: number;
  onSpeedChange: (value: number) => void;
  pauseCommaSec: number;
  onPauseCommaSecChange: (value: number) => void;
  pauseSentenceSec: number;
  onPauseSentenceSecChange: (value: number) => void;
  pauseParagraphSec: number;
  onPauseParagraphSecChange: (value: number) => void;
  pronunciationLexicon: string;
  onPronunciationLexiconChange: (value: string) => void;
  exportOptions: AudioExportOptions;
  onExportFormatChange: (format: ExportAudioFormat) => void;
  onExportSampleRateChange: (rate: ExportSampleRate) => void;
  onExportBitrateKbpsChange: (bitrate: number) => void;
  onMasteringEnabledChange: (enabled: boolean) => void;
  hasAudio: boolean;
  onDownloadAudio: () => void;
  onDownloadCaptions: (format: CaptionExportFormat) => void;
}

const EXPORT_FORMAT_OPTIONS: Array<{ value: ExportAudioFormat; label: string }> = [
  { value: "wav-pcm24", label: "WAV 24-bit" },
  { value: "wav-pcm16", label: "WAV 16-bit" },
  { value: "wav-f32", label: "WAV 32-bit float" },
  { value: "mp3", label: "MP3" },
];

const EXPORT_SAMPLE_RATE_OPTIONS: Array<{ value: ExportSampleRate; label: string }> = [
  { value: "source", label: "Source" },
  { value: 44100, label: "44.1 kHz" },
  { value: 48000, label: "48 kHz" },
];

const BITRATE_OPTIONS = [128, 192, 256, 320] as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-2xs font-semibold uppercase tracking-[0.15em] text-text-muted mb-2">
      {children}
    </div>
  );
}

export function CreatorToolsPanel({
  preset,
  onPresetChange,
  speed,
  onSpeedChange,
  pauseCommaSec,
  onPauseCommaSecChange,
  pauseSentenceSec,
  onPauseSentenceSecChange,
  pauseParagraphSec,
  onPauseParagraphSecChange,
  pronunciationLexicon,
  onPronunciationLexiconChange,
  exportOptions,
  onExportFormatChange,
  onExportSampleRateChange,
  onExportBitrateKbpsChange,
  onMasteringEnabledChange,
  hasAudio,
  onDownloadAudio,
  onDownloadCaptions,
}: CreatorToolsPanelProps) {
  const [open, setOpen] = useState(false);
  const [pronunciationPreviewText, setPronunciationPreviewText] = useState("");
  const controlId = useId();
  const panelId = `${controlId}-panel`;
  const presetId = `${controlId}-preset`;
  const speedId = `${controlId}-speed`;
  const commaPauseId = `${controlId}-comma-pause`;
  const sentencePauseId = `${controlId}-sentence-pause`;
  const paragraphPauseId = `${controlId}-paragraph-pause`;
  const lexiconId = `${controlId}-lexicon`;
  const lexiconStatusId = `${controlId}-lexicon-status`;
  const previewId = `${controlId}-pronunciation-preview`;
  const formatId = `${controlId}-format`;
  const sampleRateId = `${controlId}-sample-rate`;
  const bitrateId = `${controlId}-bitrate`;
  const masteringId = `${controlId}-mastering`;
  const downloadStatusId = `${controlId}-download-status`;
  const lexiconDiagnostics = useMemo(
    () => analyzePronunciationLexicon(pronunciationLexicon),
    [pronunciationLexicon],
  );
  const pronunciationPreview = useMemo(
    () => applyPronunciationRules(pronunciationPreviewText, lexiconDiagnostics.rules),
    [lexiconDiagnostics.rules, pronunciationPreviewText],
  );

  return (
    <div className="glass rounded-[20px] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/40 transition-colors"
      >
        <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">
          Creator Toolkit
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`text-text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          id={panelId}
          className="flex flex-col gap-4 border-t border-black/5 px-4 pb-4 animate-fade-up sm:gap-5"
        >
          {/* Preset */}
          <div className="pt-3">
            <label
              htmlFor={presetId}
              className="text-xs font-semibold uppercase tracking-widest text-text-muted"
            >
              Platform Preset
            </label>
            <select
              id={presetId}
              className="mt-2 w-full rounded-lg border border-black/10 bg-white/60 backdrop-blur-sm px-2.5 py-2 text-xs text-text-primary"
              value={preset}
              onChange={(event) => onPresetChange(event.target.value as CreatorPresetId)}
            >
              <option value="custom">Custom</option>
              {Object.values(CREATOR_PRESETS).map((presetItem) => (
                <option key={presetItem.id} value={presetItem.id}>
                  {presetItem.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-text-muted">
              {preset === "custom" ? "Manual creator settings." : CREATOR_PRESETS[preset].description}
            </p>
          </div>

          {/* Timing */}
          <div className="space-y-3">
            <SectionLabel>Timing</SectionLabel>

            <div>
              <div className="flex items-baseline justify-between mb-1">
                <label htmlFor={speedId} className="text-xs font-medium text-text-secondary">
                  Base Speed
                </label>
                <span aria-hidden="true" className="font-mono text-sm text-text-primary">
                  {speed.toFixed(2)}×
                </span>
              </div>
              <input
                id={speedId}
                type="range"
                min={SPEED_MIN}
                max={SPEED_MAX}
                step={SPEED_STEP}
                value={speed}
                aria-valuetext={`${speed.toFixed(2)} times`}
                onChange={(event) => onSpeedChange(parseFloat(event.target.value))}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label htmlFor={commaPauseId} className="text-xs font-medium text-text-secondary">
                    Comma pause
                  </label>
                  <span aria-hidden="true" className="font-mono text-xs text-text-muted">
                    {pauseCommaSec.toFixed(2)}s
                  </span>
                </div>
                <input
                  id={commaPauseId}
                  type="range"
                  min={PAUSE_MIN}
                  max={PAUSE_MAX}
                  step={PAUSE_STEP}
                  value={pauseCommaSec}
                  aria-valuetext={`${pauseCommaSec.toFixed(2)} seconds`}
                  onChange={(event) => onPauseCommaSecChange(parseFloat(event.target.value))}
                />
              </div>
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label htmlFor={sentencePauseId} className="text-xs font-medium text-text-secondary">
                    Sentence pause
                  </label>
                  <span aria-hidden="true" className="font-mono text-xs text-text-muted">
                    {pauseSentenceSec.toFixed(2)}s
                  </span>
                </div>
                <input
                  id={sentencePauseId}
                  type="range"
                  min={PAUSE_MIN}
                  max={PAUSE_MAX}
                  step={PAUSE_STEP}
                  value={pauseSentenceSec}
                  aria-valuetext={`${pauseSentenceSec.toFixed(2)} seconds`}
                  onChange={(event) => onPauseSentenceSecChange(parseFloat(event.target.value))}
                />
              </div>
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label htmlFor={paragraphPauseId} className="text-xs font-medium text-text-secondary">
                    Paragraph pause
                  </label>
                  <span aria-hidden="true" className="font-mono text-xs text-text-muted">
                    {pauseParagraphSec.toFixed(2)}s
                  </span>
                </div>
                <input
                  id={paragraphPauseId}
                  type="range"
                  min={PAUSE_MIN}
                  max={PAUSE_MAX}
                  step={PAUSE_STEP}
                  value={pauseParagraphSec}
                  aria-valuetext={`${pauseParagraphSec.toFixed(2)} seconds`}
                  onChange={(event) => onPauseParagraphSecChange(parseFloat(event.target.value))}
                />
              </div>
            </div>
          </div>

          {/* Pronunciation */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label
                htmlFor={lexiconId}
                className="text-2xs font-semibold uppercase tracking-[0.15em] text-text-muted"
              >
                Pronunciation
              </label>
              {pronunciationLexicon.length > 0 && (
                <button
                  type="button"
                  onClick={() => onPronunciationLexiconChange("")}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-2xs font-medium text-text-muted transition-colors hover:bg-white/40 hover:text-text-primary active:scale-[0.98]"
                >
                  <X size={11} aria-hidden="true" />
                  Clear rules
                </button>
              )}
            </div>
            <textarea
              id={lexiconId}
              className="w-full min-h-16 rounded-lg border border-black/10 bg-white/60 backdrop-blur-sm px-2.5 py-2 text-sm text-text-primary resize-y placeholder:text-text-muted/50"
              placeholder={`route=root\nGIF=jiff\nSQL=sequel`}
              value={pronunciationLexicon}
              aria-invalid={lexiconDiagnostics.issues.length > 0}
              aria-describedby={lexiconStatusId}
              onChange={(event) => onPronunciationLexiconChange(event.target.value)}
            />
            <div id={lexiconStatusId} className="mt-1" aria-live="polite">
              {lexiconDiagnostics.issues.length > 0 ? (
                <p className="text-xs text-danger">
                  {lexiconDiagnostics.issues.length === 1 ? "Invalid rule" : "Invalid rules"} on {" "}
                  {lexiconDiagnostics.issues.map((issue) => `line ${issue.line}`).join(", ")}.
                  {" "}Use word=replacement.
                </p>
              ) : (
                <p className="text-xs text-text-muted">
                  {lexiconDiagnostics.rules.length > 0
                    ? `${lexiconDiagnostics.rules.length} active ${lexiconDiagnostics.rules.length === 1 ? "rule" : "rules"}.`
                    : "One rule per line: word=replacement"}
                </p>
              )}
            </div>

            <div className="mt-3 rounded-xl border border-white/45 bg-white/25 p-3 backdrop-blur-sm">
              <label htmlFor={previewId} className="text-xs font-medium text-text-secondary">
                Test pronunciation rules
              </label>
              <input
                id={previewId}
                type="text"
                value={pronunciationPreviewText}
                onChange={(event) => setPronunciationPreviewText(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-black/10 bg-white/60 px-2.5 py-2 text-sm text-text-primary placeholder:text-text-muted/50"
                placeholder="Try a phrase before generating audio"
              />
              {pronunciationPreviewText.trim().length > 0 && (
                <div className="mt-2" aria-live="polite">
                  <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-text-muted">
                    Spoken as
                  </div>
                  <p className="mt-0.5 break-words text-sm text-text-primary">
                    {pronunciationPreview}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Export */}
          <div className="border-t border-black/5 pt-4 space-y-3">
            <SectionLabel>Export</SectionLabel>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor={formatId} className="text-xs font-medium text-text-secondary">
                  Format
                </label>
                <select
                  id={formatId}
                  className="mt-1 w-full rounded-lg border border-black/10 bg-white/60 backdrop-blur-sm px-2.5 py-2 text-xs text-text-primary"
                  value={exportOptions.format}
                  onChange={(event) => onExportFormatChange(event.target.value as ExportAudioFormat)}
                >
                  {EXPORT_FORMAT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor={sampleRateId} className="text-xs font-medium text-text-secondary">
                  Sample Rate
                </label>
                <select
                  id={sampleRateId}
                  className="mt-1 w-full rounded-lg border border-black/10 bg-white/60 backdrop-blur-sm px-2.5 py-2 text-xs text-text-primary"
                  value={String(exportOptions.sampleRate)}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const parsed = raw === "source" ? "source" : Number(raw);
                    onExportSampleRateChange(parsed as ExportSampleRate);
                  }}
                >
                  {EXPORT_SAMPLE_RATE_OPTIONS.map((option) => (
                    <option key={String(option.value)} value={String(option.value)}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {exportOptions.format === "mp3" && (
              <div className="max-w-full sm:max-w-[50%]">
                <label htmlFor={bitrateId} className="text-xs font-medium text-text-secondary">
                  Bitrate
                </label>
                <select
                  id={bitrateId}
                  className="mt-1 w-full rounded-lg border border-black/10 bg-white/60 backdrop-blur-sm px-2.5 py-2 text-xs text-text-primary"
                  value={exportOptions.bitrateKbps}
                  onChange={(event) => onExportBitrateKbpsChange(parseInt(event.target.value, 10))}
                >
                  {BITRATE_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value} kbps
                    </option>
                  ))}
                </select>
              </div>
            )}

            <label
              htmlFor={masteringId}
              className="flex cursor-pointer items-start gap-2 text-sm text-text-secondary select-none"
            >
              <input
                id={masteringId}
                type="checkbox"
                checked={exportOptions.mastering.enabled}
                onChange={(event) => onMasteringEnabledChange(event.target.checked)}
                className="accent-accent"
              />
              Normalize loudness for voiceover
            </label>

            <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-4">
              <button
                type="button"
                onClick={onDownloadAudio}
                disabled={!hasAudio}
                aria-describedby={!hasAudio ? downloadStatusId : undefined}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${
                  hasAudio
                    ? "glass-accent text-white"
                    : "bg-border text-text-muted cursor-not-allowed"
                }`}
              >
                <Download size={12} aria-hidden="true" />
                Audio
              </button>
              <button
                type="button"
                onClick={() => onDownloadCaptions("srt")}
                disabled={!hasAudio}
                aria-describedby={!hasAudio ? downloadStatusId : undefined}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium border transition-colors ${
                  hasAudio
                    ? "border-white/55 bg-white/40 backdrop-blur-sm text-text-secondary hover:bg-white/60 hover:text-text-primary"
                    : "border-border text-text-muted cursor-not-allowed"
                }`}
              >
                <Subtitles size={12} aria-hidden="true" />
                SRT
              </button>
              <button
                type="button"
                onClick={() => onDownloadCaptions("vtt")}
                disabled={!hasAudio}
                aria-describedby={!hasAudio ? downloadStatusId : undefined}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium border transition-colors ${
                  hasAudio
                    ? "border-white/55 bg-white/40 backdrop-blur-sm text-text-secondary hover:bg-white/60 hover:text-text-primary"
                    : "border-border text-text-muted cursor-not-allowed"
                }`}
              >
                <FileCode2 size={12} aria-hidden="true" />
                VTT
              </button>
              <button
                type="button"
                onClick={() => onDownloadCaptions("json")}
                disabled={!hasAudio}
                aria-describedby={!hasAudio ? downloadStatusId : undefined}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium border transition-colors ${
                  hasAudio
                    ? "border-white/55 bg-white/40 backdrop-blur-sm text-text-secondary hover:bg-white/60 hover:text-text-primary"
                    : "border-border text-text-muted cursor-not-allowed"
                }`}
              >
                <FileJson size={12} aria-hidden="true" />
                JSON
              </button>
            </div>
            {!hasAudio && (
              <p id={downloadStatusId} className="text-xs text-text-muted" aria-live="polite">
                Generate audio to enable downloads.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

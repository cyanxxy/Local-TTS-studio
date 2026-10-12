import { useId, useState } from "react";
import { Download, FileCode2, FileJson, Loader2, Subtitles, X } from "lucide-react";
import {
  EXPORT_BITRATE_OPTIONS,
  MAX_EXPORT_FADE_MS,
  MAX_EXPORT_PADDING_SEC,
  type CaptionStyle,
} from "../../lib/appState";
import { LOUDNESS_PRESETS, resolveMp3Bitrate, type ExportFormat } from "../../lib/exportAudio";
import type { UseAudioExportReturn } from "../../hooks/useAudioExport";
import type { UseCreatorSettingsReturn } from "../../hooks/useCreatorSettings";
import type { CaptionExportFormat, ExportSampleRate } from "../../types";
import { acxCompliance, formatDb, formatEstimate } from "../../lib/creator/display";
import {
  accentButtonClass,
  checkboxLabelClass,
  fieldClass,
  selectClass,
  subtleButtonClass,
} from "./creatorStyles";

interface ExportSettingsProps {
  creator: Pick<
    UseCreatorSettingsReturn,
    | "exportOptions"
    | "exportPost"
    | "loudnessPresetId"
    | "captionStyle"
    | "onExportFormatChange"
    | "onExportSampleRateChange"
    | "onExportBitrateChange"
    | "onMasteringEnabledChange"
    | "onLoudnessPresetChange"
    | "onExportPostChange"
    | "onCaptionStyleChange"
  >;
  /** The sample rate of the generated audio, or null while there is none. */
  sourceSampleRate: number | null;
  hasAudio: boolean;
  audioExport: UseAudioExportReturn;
  onDownloadCaptions: (format: CaptionExportFormat) => void;
}

const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string }> = [
  { value: "wav-pcm24", label: "WAV 24-bit" },
  { value: "wav-pcm16", label: "WAV 16-bit" },
  { value: "wav-f32", label: "WAV 32-bit float" },
  { value: "flac-24", label: "FLAC 24-bit (lossless)" },
  { value: "flac-16", label: "FLAC 16-bit (lossless)" },
  { value: "mp3", label: "MP3" },
];

const SAMPLE_RATE_OPTIONS: Array<{ value: ExportSampleRate; label: string }> = [
  { value: "source", label: "Source" },
  { value: 44100, label: "44.1 kHz" },
  { value: 48000, label: "48 kHz" },
];

const CAPTION_STYLE_OPTIONS: Array<{ value: CaptionStyle; label: string }> = [
  { value: "readable", label: "Readable (2 lines, 42 characters)" },
  { value: "short", label: "Short-form (3 words per caption)" },
  { value: "passage", label: "One caption per passage" },
];

/** MPEG-2 MP3 (below 32 kHz) stops at 160 kbps. */
const MPEG2_MAX_BITRATE_KBPS = 160;

function formatKilohertz(rate: number): string {
  return `${Math.round(rate / 100) / 10} kHz`;
}

function NumberField({
  id,
  label,
  value,
  max,
  step,
  suffix,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  // What is typed stays as typed (even empty) until the field loses focus.
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">{label}</label>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          max={max}
          step={step}
          value={typed ?? value}
          className={fieldClass}
          onChange={(event) => {
            setTyped(event.target.value);
            const parsed = event.target.valueAsNumber;
            if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(0, parsed)));
          }}
          onBlur={() => setTyped(null)}
        />
        <span className="text-xs text-text-muted">{suffix}</span>
      </div>
    </div>
  );
}

/** Format, loudness mastering, finishing and caption options, the export button with its progress, and the loudness report. */
export function ExportSettings({
  creator,
  sourceSampleRate,
  hasAudio,
  audioExport,
  onDownloadCaptions,
}: ExportSettingsProps) {
  const ids = useId();
  const { exportOptions, exportPost, loudnessPresetId } = creator;
  const mastering = exportOptions.mastering;
  const preset = LOUDNESS_PRESETS.find((candidate) => candidate.id === loudnessPresetId) ?? LOUDNESS_PRESETS[0];
  const isMp3 = exportOptions.format === "mp3";

  const outputRate = exportOptions.sampleRate === "source" ? sourceSampleRate : exportOptions.sampleRate;
  const mpeg2 = outputRate !== null && outputRate < 32000;
  const effectiveBitrate = outputRate === null
    ? exportOptions.bitrateKbps
    : resolveMp3Bitrate(outputRate, exportOptions.bitrateKbps);

  const { isExporting, progress, summary } = audioExport;
  const downloadStatusId = `${ids}-download-status`;
  const percent = Math.round((progress?.fraction ?? 0) * 100);
  const compliance = summary?.mastered && summary.presetId === "acx" ? acxCompliance(summary.report) : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={`${ids}-format`} className="text-xs font-medium text-text-secondary">Format</label>
          <select
            id={`${ids}-format`}
            className={`${selectClass} mt-1`}
            value={exportOptions.format}
            onChange={(event) => creator.onExportFormatChange(event.target.value as ExportFormat)}
          >
            {FORMAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-rate`} className="text-xs font-medium text-text-secondary">Sample Rate</label>
          <select
            id={`${ids}-rate`}
            className={`${selectClass} mt-1`}
            value={String(exportOptions.sampleRate)}
            onChange={(event) => {
              const raw = event.target.value;
              creator.onExportSampleRateChange((raw === "source" ? "source" : Number(raw)) as ExportSampleRate);
            }}
          >
            {SAMPLE_RATE_OPTIONS.map((option) => (
              <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      {isMp3 && (
        <div className="max-w-full sm:max-w-[50%]">
          <label htmlFor={`${ids}-bitrate`} className="text-xs font-medium text-text-secondary">Bitrate</label>
          <select
            id={`${ids}-bitrate`}
            className={`${selectClass} mt-1`}
            value={mpeg2 ? effectiveBitrate : exportOptions.bitrateKbps}
            onChange={(event) => creator.onExportBitrateChange(parseInt(event.target.value, 10))}
          >
            {EXPORT_BITRATE_OPTIONS.map((value) => (
              <option key={value} value={value} disabled={mpeg2 && value > MPEG2_MAX_BITRATE_KBPS}>
                {value} kbps
              </option>
            ))}
          </select>
          {mpeg2 && outputRate !== null && (
            <p className="mt-1 text-xs text-text-muted">
              At {formatKilohertz(outputRate)} MP3 tops out at {MPEG2_MAX_BITRATE_KBPS} kbps. Choose 44.1 or 48 kHz for more.
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <label className={checkboxLabelClass}>
          <input
            type="checkbox"
            checked={mastering.enabled}
            onChange={(event) => creator.onMasteringEnabledChange(event.target.checked)}
            className="mt-0.5 accent-accent"
          />
          Normalize loudness for voiceover
        </label>
        {mastering.enabled && (
          <div>
            <label htmlFor={`${ids}-loudness`} className="text-xs font-medium text-text-secondary">Loudness target</label>
            <select
              id={`${ids}-loudness`}
              className={`${selectClass} mt-1`}
              value={preset.id}
              onChange={(event) => creator.onLoudnessPresetChange(event.target.value)}
            >
              {LOUDNESS_PRESETS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-text-muted">
              {preset.mastering.measure === "rms"
                ? `Matches RMS to ${preset.mastering.targetLufs} dB`
                : `Matches loudness to ${preset.mastering.targetLufs} LUFS`}
              {" "}with a true-peak limiter at {preset.mastering.truePeakDb} dBTP. It can take a little longer to export.
            </p>
          </div>
        )}
      </div>

      <fieldset className="space-y-2 rounded-xl border border-border bg-text-primary/[0.03] p-3">
        <legend className="px-1 text-xs font-semibold text-text-secondary">Finishing</legend>
        <label className={checkboxLabelClass}>
          <input
            type="checkbox"
            checked={exportPost.trimSilence}
            onChange={(event) => creator.onExportPostChange({ trimSilence: event.target.checked })}
            className="mt-0.5 accent-accent"
          />
          Trim silence the model leaves at the edges of each passage
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <NumberField
            id={`${ids}-head`}
            label="Pad start"
            value={exportPost.headSec}
            max={MAX_EXPORT_PADDING_SEC}
            step={0.1}
            suffix="s"
            onChange={(headSec) => creator.onExportPostChange({ headSec })}
          />
          <NumberField
            id={`${ids}-tail`}
            label="Pad end"
            value={exportPost.tailSec}
            max={MAX_EXPORT_PADDING_SEC}
            step={0.1}
            suffix="s"
            onChange={(tailSec) => creator.onExportPostChange({ tailSec })}
          />
          <NumberField
            id={`${ids}-fade-in`}
            label="Fade in"
            value={exportPost.fadeInMs}
            max={MAX_EXPORT_FADE_MS}
            step={10}
            suffix="ms"
            onChange={(fadeInMs) => creator.onExportPostChange({ fadeInMs })}
          />
          <NumberField
            id={`${ids}-fade-out`}
            label="Fade out"
            value={exportPost.fadeOutMs}
            max={MAX_EXPORT_FADE_MS}
            step={10}
            suffix="ms"
            onChange={(fadeOutMs) => creator.onExportPostChange({ fadeOutMs })}
          />
        </div>
        <p className="text-xs text-text-muted">
          Pauses between passages stay exactly as set, and captions follow these edits.
        </p>
      </fieldset>

      <div>
        <label htmlFor={`${ids}-captions`} className="text-xs font-medium text-text-secondary">Caption style</label>
        <select
          id={`${ids}-captions`}
          className={`${selectClass} mt-1`}
          value={creator.captionStyle}
          onChange={(event) => creator.onCaptionStyleChange(event.target.value as CaptionStyle)}
        >
          {CAPTION_STYLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button
          type="button"
          onClick={isExporting ? audioExport.cancel : audioExport.start}
          disabled={!hasAudio}
          aria-describedby={!hasAudio ? downloadStatusId : undefined}
          className={hasAudio
            ? `${accentButtonClass} !py-2.5`
            : "flex w-full items-center justify-center gap-2 rounded-lg bg-border px-3 py-2.5 text-xs font-medium text-text-muted cursor-not-allowed"}
        >
          {isExporting
            ? <><X size={12} aria-hidden="true" />Cancel export</>
            : <><Download size={12} aria-hidden="true" />Audio</>}
        </button>
        {([
          { format: "srt", label: "SRT", icon: <Subtitles size={12} aria-hidden="true" /> },
          { format: "vtt", label: "VTT", icon: <FileCode2 size={12} aria-hidden="true" /> },
          { format: "json", label: "JSON", icon: <FileJson size={12} aria-hidden="true" /> },
        ] as const).map(({ format, label, icon }) => (
          <button
            key={format}
            type="button"
            onClick={() => onDownloadCaptions(format)}
            disabled={!hasAudio}
            aria-describedby={!hasAudio ? downloadStatusId : undefined}
            className={`${subtleButtonClass} !py-2.5`}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      {!hasAudio && (
        <p id={downloadStatusId} className="text-xs text-text-muted" aria-live="polite">
          Generate audio to enable downloads.
        </p>
      )}

      {isExporting && progress && (
        <div>
          <div className="flex items-center justify-between text-xs text-text-secondary">
            <span className="flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              {progress.phase === "analyzing" ? "Measuring loudness…" : "Encoding…"}
            </span>
            <span className="font-mono tabular-nums">{percent}%</span>
          </div>
          <div
            role="progressbar"
            aria-label="Export progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-border"
          >
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {summary && !isExporting && (
        <div className="rounded-xl border border-border bg-text-primary/[0.03] p-3" aria-live="polite">
          <div className="text-xs font-semibold text-text-secondary">
            Loudness report ({summary.extension.toUpperCase()})
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            {[
              ["Integrated", Number.isFinite(summary.report.integratedLufs) ? `${summary.report.integratedLufs.toFixed(1)} LUFS` : "silent"],
              ["Range", `${summary.report.loudnessRangeLu.toFixed(1)} LU`],
              ["True peak", Number.isFinite(summary.report.truePeakDbtp) ? `${summary.report.truePeakDbtp.toFixed(1)} dBTP` : "silent"],
              ["RMS", Number.isFinite(summary.report.rmsDbfs) ? `${summary.report.rmsDbfs.toFixed(1)} dBFS` : "silent"],
              ["Length", formatEstimate(summary.report.durationSec)],
              ...(summary.mastered
                ? [["Gain applied", formatDb(summary.gainDb, "dB")], ["Limiter", summary.limiterReductionDb > 0 ? `up to ${summary.limiterReductionDb.toFixed(1)} dB` : "not needed"]]
                : []),
            ].map(([term, value]) => (
              <div key={term} className="flex justify-between gap-2">
                <dt className="text-text-muted">{term}</dt>
                <dd className="font-mono tabular-nums text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
          {compliance && (
            <p className={`mt-2 text-xs ${compliance.ok ? "text-success" : "text-danger"}`}>{compliance.text}</p>
          )}
        </div>
      )}
    </div>
  );
}

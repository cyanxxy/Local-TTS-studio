import { memo, useId, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  CREATOR_PRESETS,
  PAUSE_MAX,
  PAUSE_MIN,
  PAUSE_STEP,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
} from "../constants";
import type { UseAudioExportReturn } from "../hooks/useAudioExport";
import type { UseCreatorSettingsReturn } from "../hooks/useCreatorSettings";
import { buildSpeechPlan } from "../lib/speechPipeline";
import type { BreakAwareChunk } from "../lib/text/speechMarkup";
import { resolveSpeechPipelineSettings } from "../shared/speechPipelineRuntime";
import type { CaptionExportFormat, CreatorPresetId } from "../types";
import { ExportSettings } from "./creator/ExportSettings";
import { PronunciationDictionaryEditor } from "./creator/PronunciationDictionaryEditor";
import { ScriptPreflight } from "./creator/ScriptPreflight";
import { TextCleanupPanel } from "./creator/TextCleanupPanel";
import { checkboxLabelClass, fieldClass } from "./creator/creatorStyles";

/**
 * What the active engine does with the Creator controls. A control the engine
 * ignores stays visible but disabled, with a note naming the engine, so a
 * tweak is never silently dropped.
 */
export interface CreatorEngineSupport {
  engineLabel: string;
  speed: boolean;
  pauses: boolean;
  /** The language the speech pipeline treats the engine as speaking; undefined means English. */
  speechLanguage: string | undefined;
  /** The engine's language has a text normalizer. */
  normalization: boolean;
  /** The engine reads IPA phonemes; when false a phoneme rule speaks its alias. */
  phonemes: boolean;
  /** The engine's chunker, so the preflight splits the script as generation will. */
  chunkScript: (text: string) => BreakAwareChunk[];
}

interface CreatorToolsPanelProps {
  creator: UseCreatorSettingsReturn;
  engineSupport: CreatorEngineSupport;
  /** The Studio script. */
  script: string;
  onScriptChange: (script: string) => void;
  /** The sample rate of the generated audio, or null while there is none. */
  sourceSampleRate: number | null;
  hasAudio: boolean;
  audioExport: UseAudioExportReturn;
  onDownloadCaptions: (format: CaptionExportFormat) => void;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold text-text-secondary mb-2">
      {children}
    </div>
  );
}

export const CreatorToolsPanel = memo(function CreatorToolsPanel({
  creator,
  engineSupport,
  script,
  onScriptChange,
  sourceSampleRate,
  hasAudio,
  audioExport,
  onDownloadCaptions,
}: CreatorToolsPanelProps) {
  const [open, setOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [pronunciationPreviewText, setPronunciationPreviewText] = useState("");
  const controlId = useId();
  const panelId = `${controlId}-panel`;
  const presetId = `${controlId}-preset`;
  const speedId = `${controlId}-speed`;
  const commaPauseId = `${controlId}-comma-pause`;
  const sentencePauseId = `${controlId}-sentence-pause`;
  const paragraphPauseId = `${controlId}-paragraph-pause`;
  const pauseNoteId = `${controlId}-pause-note`;
  const normalizeId = `${controlId}-normalize`;
  const normalizeNoteId = `${controlId}-normalize-note`;
  const cleanupId = `${controlId}-cleanup-on-speak`;
  const previewId = `${controlId}-pronunciation-preview`;
  const {
    creatorPreset: preset,
    speed,
    pauseCommaSec,
    pauseSentenceSec,
    pauseParagraphSec,
    dictionaries,
    normalizeSpeech,
    cleanupOnSpeak,
    generationSettings,
    speechSettings,
  } = creator;
  const speechPipeline = useMemo(
    () => resolveSpeechPipelineSettings(speechSettings, engineSupport.speechLanguage),
    [engineSupport.speechLanguage, speechSettings],
  );
  const pronunciationPreview = useMemo(
    () => (pronunciationPreviewText.trim() ? buildSpeechPlan(pronunciationPreviewText, speechPipeline).spoken : ""),
    [pronunciationPreviewText, speechPipeline],
  );
  const speedDisabled = !engineSupport.speed;
  const pausesDisabled = !engineSupport.pauses;
  const normalizationDisabled = !engineSupport.normalization;
  const engineLabel = engineSupport.engineLabel;

  return (
    <div className="glass rounded-[20px] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-text-primary/[0.07] transition-colors"
      >
        <span className="text-sm font-semibold text-text-secondary">
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
          className="flex flex-col gap-4 border-t border-border/60 px-4 pb-4 animate-fade-up sm:gap-5"
        >
          {/* Preset */}
          <div className="pt-3">
            <label
              htmlFor={presetId}
              className="text-sm font-semibold text-text-secondary"
            >
              Platform Preset
            </label>
            <select
              id={presetId}
              className="mt-2 w-full rounded-lg border border-border bg-text-primary/[0.06] px-2.5 py-2 text-xs text-text-primary"
              value={preset}
              onChange={(event) => creator.onCreatorPresetChange(event.target.value as CreatorPresetId)}
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
                aria-describedby={speedDisabled ? `${speedId}-note` : undefined}
                disabled={speedDisabled}
                className="disabled:cursor-not-allowed disabled:opacity-50"
                onChange={(event) => creator.onSpeedChange(parseFloat(event.target.value))}
              />
              {speedDisabled && (
                <p id={`${speedId}-note`} className="mt-1 text-xs text-text-muted">
                  {engineLabel} uses its model-native speaking rate.
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {([
                { id: commaPauseId, label: "Comma pause", value: pauseCommaSec, onChange: creator.onPauseCommaChange },
                { id: sentencePauseId, label: "Sentence pause", value: pauseSentenceSec, onChange: creator.onPauseSentenceChange },
                { id: paragraphPauseId, label: "Paragraph pause", value: pauseParagraphSec, onChange: creator.onPauseParagraphChange },
              ] as const).map(({ id, label, value, onChange }) => (
                <div key={id}>
                  <div className="flex items-baseline justify-between mb-1">
                    <label htmlFor={id} className="text-xs font-medium text-text-secondary">
                      {label}
                    </label>
                    <span aria-hidden="true" className="font-mono text-xs text-text-muted">
                      {value.toFixed(2)}s
                    </span>
                  </div>
                  <input
                    id={id}
                    type="range"
                    min={PAUSE_MIN}
                    max={PAUSE_MAX}
                    step={PAUSE_STEP}
                    value={value}
                    aria-valuetext={`${value.toFixed(2)} seconds`}
                    aria-describedby={pausesDisabled ? pauseNoteId : undefined}
                    disabled={pausesDisabled}
                    className="disabled:cursor-not-allowed disabled:opacity-50"
                    onChange={(event) => onChange(parseFloat(event.target.value))}
                  />
                </div>
              ))}
            </div>
            {pausesDisabled && (
              <p id={pauseNoteId} className="text-xs text-text-muted">
                {engineLabel} paces its own pauses, so these lengths are not applied. Pauses you write into the script,
                such as <code className="font-mono">{'<break time="1s"/>'}</code>, still are.
              </p>
            )}
          </div>

          {/* Script */}
          <div className="border-t border-border/60 pt-4 space-y-3">
            <SectionLabel>Script</SectionLabel>

            <div>
              <label htmlFor={normalizeId} className={checkboxLabelClass}>
                <input
                  id={normalizeId}
                  type="checkbox"
                  checked={normalizeSpeech}
                  disabled={normalizationDisabled}
                  aria-describedby={normalizationDisabled ? normalizeNoteId : undefined}
                  onChange={(event) => creator.onNormalizeSpeechChange(event.target.checked)}
                  className="mt-0.5 accent-accent disabled:cursor-not-allowed"
                />
                Read numbers, dates, prices and abbreviations as words
              </label>
              <p id={normalizeNoteId} className="mt-1 pl-6 text-xs text-text-muted">
                {normalizationDisabled
                  ? `This works for English only, and ${engineLabel} is set to another language.`
                  : "English only. Turn it off to have the engine read the text exactly as written."}
              </p>
            </div>

            <label htmlFor={cleanupId} className={checkboxLabelClass}>
              <input
                id={cleanupId}
                type="checkbox"
                checked={cleanupOnSpeak}
                onChange={(event) => creator.onCleanupOnSpeakChange(event.target.checked)}
                className="mt-0.5 accent-accent"
              />
              Skip citations, links, emoji and Markdown when speaking
            </label>

            <p className="text-xs text-text-muted">
              Add a pause anywhere with <code className="font-mono">{'<break time="1.5s"/>'}</code> or{" "}
              <code className="font-mono">[pause 500ms]</code>, or use the Pause button under the script. Pauses are
              silent, last up to 10 seconds and are never read aloud.
            </p>

            <div>
              <button
                type="button"
                aria-expanded={cleanupOpen}
                onClick={() => setCleanupOpen((value) => !value)}
                className="flex w-full items-center justify-between rounded-lg border border-border bg-text-primary/[0.04] px-3 py-2 text-left text-xs font-semibold text-text-secondary hover:bg-text-primary/[0.07]"
              >
                Clean up the script
                <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${cleanupOpen ? "rotate-180" : ""}`} />
              </button>
              {cleanupOpen && (
                <div className="mt-2">
                  <TextCleanupPanel text={script} onTextChange={onScriptChange} />
                </div>
              )}
            </div>

            <ScriptPreflight
              text={script}
              chunkScript={engineSupport.chunkScript}
              engineLabel={engineLabel}
              rules={speechPipeline.rules}
              normalize={normalizeSpeech}
              cleanup={cleanupOnSpeak}
              speechLanguage={engineSupport.speechLanguage}
              pauseOverridesSec={generationSettings.pauseOverridesSec ?? {}}
              speed={engineSupport.speed ? speed : 1}
            />
          </div>

          {/* Pronunciation */}
          <div className="border-t border-border/60 pt-4 space-y-3">
            <SectionLabel>Pronunciation</SectionLabel>
            {creator.migrationNotice && !noticeDismissed && (
              <div role="status" className="flex items-start gap-2 rounded-lg border border-border bg-text-primary/[0.04] p-2 text-xs text-text-secondary">
                <p className="flex-1">{creator.migrationNotice}</p>
                <button
                  type="button"
                  className="rounded-md px-1.5 py-0.5 font-medium text-text-muted hover:bg-text-primary/[0.07] hover:text-text-primary"
                  onClick={() => setNoticeDismissed(true)}
                >
                  Dismiss
                </button>
              </div>
            )}
            <PronunciationDictionaryEditor
              dictionaries={dictionaries}
              onChange={creator.onDictionariesChange}
              phonemesSupported={engineSupport.phonemes}
              engineLabel={engineLabel}
            />

            <div className="rounded-xl border border-border bg-text-primary/[0.03] p-3">
              <label htmlFor={previewId} className="text-xs font-medium text-text-secondary">
                Test pronunciation rules
              </label>
              <input
                id={previewId}
                type="text"
                value={pronunciationPreviewText}
                onChange={(event) => setPronunciationPreviewText(event.target.value)}
                className={`${fieldClass} mt-1.5 text-sm`}
                placeholder="Try a phrase before generating audio"
              />
              {pronunciationPreview && (
                <div className="mt-2" aria-live="polite">
                  <div className="text-xs font-semibold text-text-secondary">
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
          <div className="border-t border-border/60 pt-4 space-y-3">
            <SectionLabel>Export</SectionLabel>
            <ExportSettings
              creator={creator}
              sourceSampleRate={sourceSampleRate}
              hasAudio={hasAudio}
              audioExport={audioExport}
              onDownloadCaptions={onDownloadCaptions}
            />
          </div>
        </div>
      )}
    </div>
  );
});

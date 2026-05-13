import { Fragment } from "react";
import type { LocalTtsModel } from "../../electron";
import { KANI_OPTIONS, NEUTTS_OPTIONS } from "./modelOptions";
import { statusClass, type StatusTone } from "./utils";

type StatusMessage = { tone: StatusTone; text: string } | null;

interface LocalRuntimeModelInputsProps {
  model: LocalTtsModel;
  neuttsModel: string;
  onNeuttsModelChange: (value: string) => void;
  referenceText: string;
  onReferenceTextChange: (value: string) => void;
  referenceAudioName: string;
  referenceAudioGuidance: StatusMessage;
  onReferenceAudioChange: (file: File | null) => void;
  kaniModel: string;
  onKaniModelChange: (value: string) => void;
  languageTag: string;
  onLanguageTagChange: (value: string) => void;
  temperature: number;
  onTemperatureChange: (value: number) => void;
  topP: number;
  onTopPChange: (value: number) => void;
  repetitionPenalty: number;
  onRepetitionPenaltyChange: (value: number) => void;
  maxNewTokens: number;
  onMaxNewTokensChange: (value: number) => void;
}

export function LocalRuntimeModelInputs({
  model,
  neuttsModel,
  onNeuttsModelChange,
  referenceText,
  onReferenceTextChange,
  referenceAudioName,
  referenceAudioGuidance,
  onReferenceAudioChange,
  kaniModel,
  onKaniModelChange,
  languageTag,
  onLanguageTagChange,
  temperature,
  onTemperatureChange,
  topP,
  onTopPChange,
  repetitionPenalty,
  onRepetitionPenaltyChange,
  maxNewTokens,
  onMaxNewTokensChange,
}: LocalRuntimeModelInputsProps) {
  if (model === "neutts") {
    return (
      <Fragment key="neutts">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Model Variant
            <select
              value={neuttsModel}
              onChange={(event) => onNeuttsModelChange(event.target.value)}
              className="px-3 py-2 rounded-md border border-border bg-panel text-sm normal-case text-text-primary"
            >
              {NEUTTS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Reference Audio
            <input
              type="file"
              accept=".wav,audio/wav,audio/x-wav"
              onChange={(event) => onReferenceAudioChange(event.target.files?.[0] ?? null)}
              className="px-3 py-2 rounded-md border border-border bg-panel text-sm normal-case text-text-primary"
            />
            <span className="text-[11px] font-normal normal-case text-text-muted">
              {referenceAudioName || "Upload a clean 3-15s WAV reference clip"}
            </span>
            <span className="text-[11px] font-normal normal-case text-text-muted">
              Best results use mono WAV audio with minimal background noise.
            </span>
            {referenceAudioGuidance && (
              <span className={`text-[11px] font-normal normal-case ${statusClass(referenceAudioGuidance.tone)}`}>
                {referenceAudioGuidance.text}
              </span>
            )}
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Reference Transcript (exact)
          <textarea
            value={referenceText}
            onChange={(event) => onReferenceTextChange(event.target.value)}
            className="w-full min-h-20 px-3 py-2 rounded-md border border-border bg-surface text-sm normal-case text-text-primary"
            placeholder="Paste the exact spoken transcript of the uploaded WAV clip"
          />
          <span className="text-[11px] font-normal normal-case text-text-muted">
            This must match the uploaded reference audio exactly. Same-language references work best.
          </span>
        </label>
      </Fragment>
    );
  }

  return (
    <Fragment key="kani">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Model Variant
          <select
            value={kaniModel}
            onChange={(event) => onKaniModelChange(event.target.value)}
            className="px-3 py-2 rounded-md border border-border bg-panel text-sm normal-case text-text-primary"
          >
            {KANI_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Language Tag (optional)
          <input
            type="text"
            value={languageTag}
            onChange={(event) => onLanguageTagChange(event.target.value)}
            placeholder="Example: en_US"
            className="px-3 py-2 rounded-md border border-border bg-panel text-sm normal-case text-text-primary"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs font-semibold uppercase tracking-wider text-text-secondary">
        <label className="flex flex-col gap-1">
          Temperature
          <input
            type="number"
            value={temperature}
            min={0.2}
            max={2}
            step={0.05}
            onChange={(event) => onTemperatureChange(Number(event.target.value))}
            className="px-3 py-2 rounded-md border border-border bg-panel text-sm normal-case text-text-primary"
          />
        </label>
        <label className="flex flex-col gap-1">
          Top-p
          <input
            type="number"
            value={topP}
            min={0.5}
            max={1}
            step={0.01}
            onChange={(event) => onTopPChange(Number(event.target.value))}
            className="px-3 py-2 rounded-md border border-border bg-panel text-sm normal-case text-text-primary"
          />
        </label>
        <label className="flex flex-col gap-1">
          Repetition Penalty
          <input
            type="number"
            value={repetitionPenalty}
            min={1}
            max={2}
            step={0.05}
            onChange={(event) => onRepetitionPenaltyChange(Number(event.target.value))}
            className="px-3 py-2 rounded-md border border-border bg-panel text-sm normal-case text-text-primary"
          />
        </label>
        <label className="flex flex-col gap-1">
          Max Tokens
          <input
            type="number"
            value={maxNewTokens}
            min={64}
            max={4096}
            step={64}
            onChange={(event) => onMaxNewTokensChange(Number(event.target.value))}
            className="px-3 py-2 rounded-md border border-border bg-panel text-sm normal-case text-text-primary"
          />
        </label>
      </div>
    </Fragment>
  );
}

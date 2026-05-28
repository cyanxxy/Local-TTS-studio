import { Fragment } from "react";
import type { LocalTtsModel } from "../../electron";
import {
  KANI_OPTIONS,
  KANI_LANGUAGE_TAG_OPTIONS,
  NEUTTS_OPTIONS,
  QWEN3_ATTENTION_OPTIONS,
  QWEN3_DEVICE_OPTIONS,
  QWEN3_DTYPE_OPTIONS,
  QWEN3_OPTIONS,
  QWEN3_SPEAKER_OPTIONS,
  type LocalRuntimeOption,
} from "./modelOptions";
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
  qwen3Model: string;
  onQwen3ModelChange: (value: string) => void;
  qwen3Speaker: string;
  onQwen3SpeakerChange: (value: string) => void;
  qwen3Language: string;
  qwen3LanguageOptions: LocalRuntimeOption[];
  onQwen3LanguageChange: (value: string) => void;
  qwen3Instruct: string;
  onQwen3InstructChange: (value: string) => void;
  qwen3DeviceMap: string;
  onQwen3DeviceMapChange: (value: string) => void;
  qwen3Dtype: string;
  onQwen3DtypeChange: (value: string) => void;
  qwen3Attention: string;
  onQwen3AttentionChange: (value: string) => void;
  qwen3Temperature: number;
  onQwen3TemperatureChange: (value: number) => void;
  qwen3TopP: number;
  onQwen3TopPChange: (value: number) => void;
  qwen3MaxNewTokens: number;
  onQwen3MaxNewTokensChange: (value: number) => void;
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
  qwen3Model,
  onQwen3ModelChange,
  qwen3Speaker,
  onQwen3SpeakerChange,
  qwen3Language,
  qwen3LanguageOptions,
  onQwen3LanguageChange,
  qwen3Instruct,
  onQwen3InstructChange,
  qwen3DeviceMap,
  onQwen3DeviceMapChange,
  qwen3Dtype,
  onQwen3DtypeChange,
  qwen3Attention,
  onQwen3AttentionChange,
  qwen3Temperature,
  onQwen3TemperatureChange,
  qwen3TopP,
  onQwen3TopPChange,
  qwen3MaxNewTokens,
  onQwen3MaxNewTokensChange,
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
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
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
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            />
            <span className="text-sm font-normal normal-case text-text-muted">
              {referenceAudioName || "Upload a clean 3-15s WAV reference clip"}
            </span>
            <span className="text-sm font-normal normal-case text-text-muted">
              Best results use mono WAV audio with minimal background noise.
            </span>
            {referenceAudioGuidance && (
              <span className={`text-sm font-normal normal-case ${statusClass(referenceAudioGuidance.tone)}`}>
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
            className="w-full min-h-20 px-3 py-2 rounded-lg border border-black/10 bg-surface/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            placeholder="Paste the exact spoken transcript of the uploaded WAV clip"
          />
          <span className="text-sm font-normal normal-case text-text-muted">
            This must match the uploaded reference audio exactly. Same-language references work best.
          </span>
        </label>
      </Fragment>
    );
  }

  if (model === "qwen3") {
    return (
      <Fragment key="qwen3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Model Variant
            <select
              value={qwen3Model}
              onChange={(event) => onQwen3ModelChange(event.target.value)}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            >
              {QWEN3_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Speaker
            <select
              value={qwen3Speaker}
              onChange={(event) => onQwen3SpeakerChange(event.target.value)}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            >
              {QWEN3_SPEAKER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Language
            <select
              value={qwen3Language}
              onChange={(event) => onQwen3LanguageChange(event.target.value)}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            >
              {qwen3LanguageOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Device Map
            <select
              value={qwen3DeviceMap}
              onChange={(event) => onQwen3DeviceMapChange(event.target.value)}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            >
              {QWEN3_DEVICE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Instruction (optional)
          <textarea
            value={qwen3Instruct}
            onChange={(event) => onQwen3InstructChange(event.target.value)}
            className="w-full min-h-20 px-3 py-2 rounded-lg border border-black/10 bg-surface/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            placeholder="Example: Speak warmly with a calm documentary narration style."
          />
        </label>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Dtype
            <select
              value={qwen3Dtype}
              onChange={(event) => onQwen3DtypeChange(event.target.value)}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            >
              {QWEN3_DTYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Attention
            <select
              value={qwen3Attention}
              onChange={(event) => onQwen3AttentionChange(event.target.value)}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            >
              {QWEN3_ATTENTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Max Tokens
            <input
              type="number"
              value={qwen3MaxNewTokens}
              min={64}
              max={8192}
              step={64}
              onChange={(event) => onQwen3MaxNewTokensChange(Number(event.target.value))}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          <label className="flex flex-col gap-1">
            Temperature
            <input
              type="number"
              value={qwen3Temperature}
              min={0.2}
              max={2}
              step={0.05}
              onChange={(event) => onQwen3TemperatureChange(Number(event.target.value))}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            />
          </label>
          <label className="flex flex-col gap-1">
            Top-p
            <input
              type="number"
              value={qwen3TopP}
              min={0.5}
              max={1}
              step={0.01}
              onChange={(event) => onQwen3TopPChange(Number(event.target.value))}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            />
          </label>
        </div>
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
            className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
          >
            {KANI_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Accent / Voice Tag
          <select
            value={languageTag}
            onChange={(event) => onLanguageTagChange(event.target.value)}
            className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
          >
            {KANI_LANGUAGE_TAG_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
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
            className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
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
            className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
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
            className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
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
            className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
          />
        </label>
      </div>
    </Fragment>
  );
}

import type {
  LocalTtsModel,
  LocalTtsQwen3DownloadProgress,
} from "../../electron";
import type { Qwen3Profile } from "../../../electron/qwen3Profiles";
import { QWEN3_LANGUAGE_OPTIONS, QWEN3_SPEAKER_OPTIONS, NEUTTS_OPTIONS } from "./modelOptions";
import type { StatusTone } from "./utils";

type StatusMessage = { tone: StatusTone; text: string } | null;

function statusClass(tone: StatusTone): string {
  if (tone === "success") return "text-success";
  if (tone === "error") return "text-danger";
  return "text-text-muted";
}

function downloadLabel(progress: LocalTtsQwen3DownloadProgress): string {
  const downloaded = (progress.downloadedBytes / (1024 * 1024)).toFixed(1);
  const total = progress.totalBytes ? ` / ${(progress.totalBytes / (1024 * 1024)).toFixed(1)} MB` : " MB";
  return `${progress.fileName} (${progress.fileIndex}/${progress.totalFiles}) · ${downloaded}${total}`;
}

interface Props {
  model: LocalTtsModel;
  neuttsModel: string;
  onNeuttsModelChange: (value: string) => void;
  referenceText: string;
  onReferenceTextChange: (value: string) => void;
  referenceAudioName: string;
  referenceAudioGuidance: StatusMessage;
  onReferenceAudioChange: (file: File | null) => void;
  qwen3Profile: Qwen3Profile;
  qwen3Profiles: readonly Qwen3Profile[];
  onQwen3ProfileChange: (repo: string) => void;
  qwen3ModelPath: string;
  onQwen3ModelPathChange: (value: string) => void;
  qwen3Readiness: "missing" | "structural" | "verified";
  qwen3SetupBusy: boolean;
  qwen3DownloadBusy: boolean;
  qwen3DownloadProgress: LocalTtsQwen3DownloadProgress | null;
  onQwen3RefreshSetup: () => void;
  onQwen3DownloadModel: () => void;
  onQwen3ChooseModelPath: () => void;
  qwen3ReferenceAudioName: string;
  qwen3ReferenceAudioGuidance: StatusMessage;
  onQwen3ReferenceAudioChange: (file: File | null) => void;
  qwen3ReferenceText: string;
  onQwen3ReferenceTextChange: (value: string) => void;
  qwen3Speaker: string;
  onQwen3SpeakerChange: (value: string) => void;
  qwen3Language: string;
  onQwen3LanguageChange: (value: string) => void;
  qwen3Instruct: string;
  onQwen3InstructChange: (value: string) => void;
  qwen3Temperature: number;
  onQwen3TemperatureChange: (value: number) => void;
  qwen3TopK: number;
  onQwen3TopKChange: (value: number) => void;
  qwen3MaxNewTokens: number;
  onQwen3MaxNewTokensChange: (value: number) => void;
}

export function LocalRuntimeModelInputs(props: Props) {
  if (props.model === "neutts") {
    return (
      <div className="space-y-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          NeuTTS model
          <select
            value={props.neuttsModel}
            onChange={(event) => props.onNeuttsModelChange(event.target.value)}
            className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
          >
            {NEUTTS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Reference audio or codes
          <input
            type="file"
            accept=".wav,.npy,audio/wav,audio/x-wav"
            onChange={(event) => props.onReferenceAudioChange(event.target.files?.[0] ?? null)}
            className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
          />
          <span className="text-sm font-normal normal-case text-text-muted">
            {props.referenceAudioName || "Upload a WAV clip or pre-encoded .npy codes"}
          </span>
          {props.referenceAudioGuidance && (
            <span className={`text-sm font-normal normal-case ${statusClass(props.referenceAudioGuidance.tone)}`}>
              {props.referenceAudioGuidance.text}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Reference transcript
          <textarea
            value={props.referenceText}
            onChange={(event) => props.onReferenceTextChange(event.target.value)}
            className="w-full min-h-20 px-3 py-2 rounded-lg border border-black/10 bg-surface/55 backdrop-blur-sm text-sm normal-case text-text-primary"
          />
        </label>
      </div>
    );
  }

  if (props.model !== "qwen3") return null;
  const voiceClone = props.qwen3Profile.mode === "voiceClone";
  const readiness = props.qwen3Readiness;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Native profile
          <select
            value={props.qwen3Profile.repo}
            onChange={(event) => props.onQwen3ProfileChange(event.target.value)}
            className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
          >
            {props.qwen3Profiles.map((profile) => <option key={profile.repo} value={profile.repo}>{profile.label}</option>)}
          </select>
        </label>
        {!voiceClone && (
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Speaker
            <select
              value={props.qwen3Speaker}
              onChange={(event) => props.onQwen3SpeakerChange(event.target.value)}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            >
              {QWEN3_SPEAKER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="rounded-xl border border-black/10 bg-white/35 p-3 text-sm text-text-secondary backdrop-blur-md">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wider">Native provider · {props.qwen3Profile.provider}</p>
            <p>{props.qwen3Profile.provider === "mlx" ? "Apple Silicon MLX/Metal" : "Windows LibTorch CUDA with CPU fallback"}</p>
            <p className="break-all text-xs text-text-muted">
              Revision {props.qwen3Profile.revision.slice(0, 12)} · directory {readiness}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={props.onQwen3DownloadModel}
              disabled={props.qwen3DownloadBusy || props.qwen3SetupBusy}
              className="rounded-md border border-white/55 bg-white/40 px-3 py-2 text-xs font-semibold text-text-primary shadow-glass-sm disabled:opacity-50"
            >
              {props.qwen3DownloadBusy ? "Downloading…" : "Download & verify"}
            </button>
            <button
              type="button"
              onClick={props.onQwen3RefreshSetup}
              disabled={props.qwen3SetupBusy || props.qwen3DownloadBusy}
              className="rounded-md border border-white/55 bg-white/40 px-3 py-2 text-xs font-semibold text-text-primary shadow-glass-sm disabled:opacity-50"
            >
              {props.qwen3SetupBusy ? "Checking…" : "Refresh"}
            </button>
          </div>
        </div>
        {props.qwen3DownloadProgress && <p className="mt-2 break-all text-xs text-text-muted">{downloadLabel(props.qwen3DownloadProgress)}</p>}
      </div>

      <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
        Model directory
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={props.qwen3ModelPath}
            onChange={(event) => props.onQwen3ModelPathChange(event.target.value)}
            className="min-w-0 flex-1 px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            placeholder="/path/to/Qwen3-TTS-model"
          />
          <button
            type="button"
            onClick={props.onQwen3ChooseModelPath}
            className="rounded-md border border-white/55 bg-white/40 px-3 py-2 text-xs font-semibold text-text-primary shadow-glass-sm"
          >
            Choose…
          </button>
        </div>
      </label>

      {voiceClone && (
        <div className="grid gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Reference WAV
            <input
              type="file"
              accept=".wav,audio/wav,audio/x-wav"
              onChange={(event) => props.onQwen3ReferenceAudioChange(event.target.files?.[0] ?? null)}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            />
            <span className="text-sm font-normal normal-case text-text-muted">{props.qwen3ReferenceAudioName || "Upload a WAV reference clip"}</span>
            {props.qwen3ReferenceAudioGuidance && (
              <span className={`text-sm font-normal normal-case ${statusClass(props.qwen3ReferenceAudioGuidance.tone)}`}>
                {props.qwen3ReferenceAudioGuidance.text}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Exact reference transcript
            <textarea
              value={props.qwen3ReferenceText}
              onChange={(event) => props.onQwen3ReferenceTextChange(event.target.value)}
              className="w-full min-h-20 px-3 py-2 rounded-lg border border-black/10 bg-surface/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            />
          </label>
        </div>
      )}

      <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
        Language
        <select
          value={props.qwen3Language}
          onChange={(event) => props.onQwen3LanguageChange(event.target.value)}
          className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
        >
          {QWEN3_LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>

      {!voiceClone && (
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Instruction (optional)
          <textarea
            value={props.qwen3Instruct}
            onChange={(event) => props.onQwen3InstructChange(event.target.value)}
            className="w-full min-h-20 px-3 py-2 rounded-lg border border-black/10 bg-surface/55 backdrop-blur-sm text-sm normal-case text-text-primary"
          />
        </label>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-xs font-medium text-text-secondary">
        <label className="flex flex-col gap-1">Temperature
          <input type="number" min={0.2} max={2} step={0.05} value={props.qwen3Temperature} onChange={(event) => props.onQwen3TemperatureChange(Number(event.target.value))} className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 text-sm" />
        </label>
        <label className="flex flex-col gap-1">Top-k
          <input type="number" min={0} max={1000} value={props.qwen3TopK} onChange={(event) => props.onQwen3TopKChange(Number(event.target.value))} className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 text-sm" />
        </label>
        <label className="flex flex-col gap-1">Max tokens
          <input type="number" min={64} max={8192} step={64} value={props.qwen3MaxNewTokens} onChange={(event) => props.onQwen3MaxNewTokensChange(Number(event.target.value))} className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 text-sm" />
        </label>
      </div>
    </div>
  );
}

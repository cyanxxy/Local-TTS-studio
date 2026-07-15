import type {
  LocalTtsModel,
  LocalTtsQwen3DownloadProgress,
} from "../../electron";
import type { Qwen3Profile } from "../../../electron/qwen3Profiles";
import { CheckCircle2, Download, FolderOpen, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { QWEN3_LANGUAGE_OPTIONS, QWEN3_SPEAKER_OPTIONS, NEUTTS_OPTIONS } from "./modelOptions";
import type { StatusTone } from "./utils";

type StatusMessage = { tone: StatusTone; text: string } | null;

function statusClass(tone: StatusTone): string {
  if (tone === "success") return "text-success";
  if (tone === "error") return "text-danger";
  return "text-text-muted";
}

function downloadProgressView(progress: LocalTtsQwen3DownloadProgress) {
  const downloadedMb = progress.downloadedBytes / (1024 * 1024);
  const totalMb = progress.totalBytes ? progress.totalBytes / (1024 * 1024) : null;
  const fileFraction = progress.totalBytes && progress.totalBytes > 0
    ? Math.min(1, progress.downloadedBytes / progress.totalBytes)
    : 0;
  const completedFiles = Math.max(0, progress.fileIndex - 1);
  const percent = progress.totalFiles > 0
    ? Math.min(100, ((completedFiles + fileFraction) / progress.totalFiles) * 100)
    : 0;

  return {
    percent,
    transferred: totalMb === null
      ? `${downloadedMb.toFixed(1)} MB downloaded`
      : `${downloadedMb.toFixed(1)} of ${totalMb.toFixed(1)} MB`,
  };
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
  qwen3Error: string | null;
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

type QwenModelSetupProps = Pick<Props,
  | "qwen3Profile"
  | "qwen3Profiles"
  | "onQwen3ProfileChange"
  | "qwen3ModelPath"
  | "onQwen3ModelPathChange"
  | "qwen3Readiness"
  | "qwen3SetupBusy"
  | "qwen3DownloadBusy"
  | "qwen3DownloadProgress"
  | "qwen3Error"
  | "onQwen3RefreshSetup"
  | "onQwen3DownloadModel"
  | "onQwen3ChooseModelPath"
>;

export function LocalRuntimeQwenSetup(props: QwenModelSetupProps) {
  const readiness = props.qwen3Readiness;
  const modelReady = readiness === "verified";
  const progress = props.qwen3DownloadProgress
    ? downloadProgressView(props.qwen3DownloadProgress)
    : null;
  const setupTitle = modelReady
    ? "Qwen model ready"
    : readiness === "structural"
      ? "Model files need verification"
      : "Download the Qwen model";
  const setupDescription = modelReady
    ? "The selected model is verified and ready for private, local generation."
    : readiness === "structural"
      ? "Open TTS found a model folder, but some required files still need to be checked or repaired."
      : "Download the selected model once. It stays on this device for future sessions.";

  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
        Model size and voice mode
        <select
          value={props.qwen3Profile.repo}
          onChange={(event) => props.onQwen3ProfileChange(event.target.value)}
          className="min-h-[44px] rounded-lg border border-black/10 bg-white/55 px-3 py-2 text-sm normal-case text-text-primary backdrop-blur-sm"
        >
          {props.qwen3Profiles.map((profile) => <option key={profile.repo} value={profile.repo}>{profile.label}</option>)}
        </select>
      </label>

      <section className={`rounded-2xl border p-4 backdrop-blur-md ${modelReady ? "border-success/20 bg-success/[0.06]" : "border-accent/20 bg-accent-light/35"}`}>
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${modelReady ? "bg-success/10 text-success" : "bg-accent-light text-accent"}`}>
            {modelReady ? <CheckCircle2 size={18} /> : <Download size={18} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-lg font-semibold text-text-primary">{setupTitle}</h3>
              <span className={`rounded-full px-2 py-0.5 font-mono text-2xs uppercase tracking-wider ${modelReady ? "bg-success/10 text-success" : "bg-accent-light text-accent"}`}>
                {modelReady ? "Ready" : readiness === "structural" ? "Needs attention" : "Not installed"}
              </span>
            </div>
            <p className="mt-1 text-sm leading-5 text-text-secondary">{setupDescription}</p>
            <p className="mt-2 text-xs text-text-muted">
              {props.qwen3Profile.label} · {props.qwen3Profile.provider === "mlx" ? "Apple Silicon" : "Windows CUDA/CPU"}
            </p>
          </div>
        </div>

        {props.qwen3DownloadBusy && (
          <div className="mt-4 rounded-xl border border-border/70 bg-panel/55 p-3" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-xs font-semibold text-text-secondary">
              <span className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-accent" />
                {props.qwen3DownloadProgress
                  ? `Downloading file ${props.qwen3DownloadProgress.fileIndex} of ${props.qwen3DownloadProgress.totalFiles}`
                  : "Preparing download…"}
              </span>
              {progress && <span className="font-mono text-text-muted">{Math.round(progress.percent)}%</span>}
            </div>
            <div
              role="progressbar"
              aria-label="Qwen model download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress?.percent ?? 0)}
              className="mt-2 h-2 overflow-hidden rounded-full bg-border"
            >
              <div
                className={`h-full rounded-full bg-accent transition-[width] duration-300 ${progress ? "" : "animate-pulse"}`}
                style={{ width: `${Math.max(progress?.percent ?? 8, 8)}%` }}
              />
            </div>
            {props.qwen3DownloadProgress && progress && (
              <div className="mt-2 flex flex-col gap-0.5 text-xs text-text-muted sm:flex-row sm:justify-between sm:gap-3">
                <span className="truncate" title={props.qwen3DownloadProgress.fileName}>{props.qwen3DownloadProgress.fileName}</span>
                <span className="shrink-0 font-mono">{progress.transferred}</span>
              </div>
            )}
            <p className="mt-2 text-xs text-text-muted">Keep Open TTS open until download and verification finish.</p>
          </div>
        )}

        {props.qwen3Error && (
          <div className="mt-4 flex gap-2 rounded-xl border border-danger/20 bg-danger/[0.06] p-3 text-sm text-danger" role="status">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">Model setup failed</p>
              <p className="mt-0.5 break-words text-xs leading-5">{props.qwen3Error}</p>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={props.onQwen3DownloadModel}
            disabled={props.qwen3DownloadBusy || props.qwen3SetupBusy}
            className={`flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${modelReady ? "border border-white/55 bg-white/45 text-text-primary shadow-glass-sm hover:bg-white/65" : "glass-accent text-white"}`}
          >
            {props.qwen3DownloadBusy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            {props.qwen3DownloadBusy
              ? "Downloading Qwen model…"
              : modelReady
                ? "Re-download model"
                : readiness === "structural"
                  ? "Repair model download"
                  : "Download Qwen model"}
          </button>
          <button
            type="button"
            onClick={props.onQwen3RefreshSetup}
            disabled={props.qwen3SetupBusy || props.qwen3DownloadBusy}
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-white/55 bg-white/40 px-4 py-2.5 text-sm font-semibold text-text-primary shadow-glass-sm transition-colors hover:bg-white/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {props.qwen3SetupBusy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            {props.qwen3SetupBusy ? "Checking model…" : "Check again"}
          </button>
        </div>

        <details className="mt-4 border-t border-border/70 pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-text-secondary hover:text-text-primary">
            <FolderOpen size={15} /> Use an existing model folder
          </summary>
          <label className="mt-3 flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Model directory
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={props.qwen3ModelPath}
                onChange={(event) => props.onQwen3ModelPathChange(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white/55 px-3 py-2 text-sm normal-case text-text-primary backdrop-blur-sm"
                placeholder="/path/to/Qwen3-TTS-model"
              />
              <button
                type="button"
                onClick={props.onQwen3ChooseModelPath}
                disabled={props.qwen3DownloadBusy || props.qwen3SetupBusy}
                className="min-h-[44px] rounded-lg border border-white/55 bg-white/40 px-4 py-2 text-sm font-semibold text-text-primary shadow-glass-sm disabled:opacity-50"
              >
                Choose folder…
              </button>
            </div>
          </label>
          <p className="mt-2 break-all font-mono text-2xs text-text-muted">Revision {props.qwen3Profile.revision.slice(0, 12)}</p>
        </details>
      </section>
    </div>
  );
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
  return (
    <div className="space-y-4">
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

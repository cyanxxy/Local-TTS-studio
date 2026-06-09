import { Fragment } from "react";
import type {
  LocalTtsModel,
  LocalTtsQwen3MlxDownloadProgress,
  LocalTtsQwen3MlxSetup,
} from "../../electron";
import {
  NEUTTS_OPTIONS,
  QWEN3_ATTENTION_OPTIONS,
  QWEN3_DTYPE_OPTIONS,
  QWEN3_OPTIONS,
  QWEN3_SPEAKER_OPTIONS,
  getQwen3DeviceOptions,
  qwen3SupportsInstruct,
  qwen3UsesMlx,
  qwen3UsesMlxCustomVoice,
  qwen3UsesVoiceClone,
  type LocalRuntimeOption,
} from "./modelOptions";
import { statusClass, type StatusTone } from "./utils";

type StatusMessage = { tone: StatusTone; text: string } | null;

function formatDownloadProgress(progress: LocalTtsQwen3MlxDownloadProgress): string {
  const downloadedMb = (progress.downloadedBytes / (1024 * 1024)).toFixed(1);
  const total = progress.totalBytes
    ? ` of ${(progress.totalBytes / (1024 * 1024)).toFixed(1)} MB`
    : " MB";
  return `${progress.fileName} (${progress.fileIndex}/${progress.totalFiles}) ${downloadedMb}${total}`;
}

interface LocalRuntimeModelInputsProps {
  model: LocalTtsModel;
  neuttsModel: string;
  onNeuttsModelChange: (value: string) => void;
  referenceText: string;
  onReferenceTextChange: (value: string) => void;
  referenceAudioName: string;
  referenceAudioGuidance: StatusMessage;
  onReferenceAudioChange: (file: File | null) => void;
  qwen3Model: string;
  onQwen3ModelChange: (value: string) => void;
  qwen3BaseModelPath: string;
  onQwen3BaseModelPathChange: (value: string) => void;
  qwen3MlxSetup: LocalTtsQwen3MlxSetup | null;
  qwen3MlxSetupBusy: boolean;
  qwen3MlxDownloadBusy: boolean;
  qwen3MlxDownloadProgress: LocalTtsQwen3MlxDownloadProgress | null;
  onQwen3RefreshMlxSetup: () => void;
  onQwen3DownloadMlxModel: () => void;
  onQwen3ChooseBaseModelPath: () => void;
  qwen3ReferenceAudioName: string;
  qwen3ReferenceAudioGuidance: StatusMessage;
  onQwen3ReferenceAudioChange: (file: File | null) => void;
  qwen3ReferenceText: string;
  onQwen3ReferenceTextChange: (value: string) => void;
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
  qwen3TopK: number;
  onQwen3TopKChange: (value: number) => void;
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
  qwen3Model,
  onQwen3ModelChange,
  qwen3BaseModelPath,
  onQwen3BaseModelPathChange,
  qwen3MlxSetup,
  qwen3MlxSetupBusy,
  qwen3MlxDownloadBusy,
  qwen3MlxDownloadProgress,
  onQwen3RefreshMlxSetup,
  onQwen3DownloadMlxModel,
  onQwen3ChooseBaseModelPath,
  qwen3ReferenceAudioName,
  qwen3ReferenceAudioGuidance,
  onQwen3ReferenceAudioChange,
  qwen3ReferenceText,
  onQwen3ReferenceTextChange,
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
  qwen3TopK,
  onQwen3TopKChange,
  qwen3TopP,
  onQwen3TopPChange,
  qwen3MaxNewTokens,
  onQwen3MaxNewTokensChange,
}: LocalRuntimeModelInputsProps) {
  if (model === "neutts") {
    return (
      <Fragment key="neutts">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
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

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Reference Codes
            <input
              type="file"
              accept=".npy,application/octet-stream"
              onChange={(event) => onReferenceAudioChange(event.target.files?.[0] ?? null)}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            />
            <span className="text-sm font-normal normal-case text-text-muted">
              {referenceAudioName || "Upload pre-encoded NeuTTS .npy reference codes"}
            </span>
            <span className="text-sm font-normal normal-case text-text-muted">
              The Rust runtime cannot encode a WAV clip itself. Produce the .npy
              by encoding a 3–15s mono reference clip with NeuCodec from the
              Neuphonic NeuTTS project (github.com/neuphonic/neutts-air), then
              upload it here with its exact transcript below.
            </span>
            {referenceAudioGuidance && (
              <span className={`text-sm font-normal normal-case ${statusClass(referenceAudioGuidance.tone)}`}>
                {referenceAudioGuidance.text}
              </span>
            )}
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Reference Transcript (exact)
          <textarea
            value={referenceText}
            onChange={(event) => onReferenceTextChange(event.target.value)}
            className="w-full min-h-20 px-3 py-2 rounded-lg border border-black/10 bg-surface/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            placeholder="Paste the transcript that matches the encoded reference codes"
          />
          <span className="text-sm font-normal normal-case text-text-muted">
            The Rust NeuTTS crate consumes pre-encoded reference code arrays. Same-language references work best.
          </span>
        </label>
      </Fragment>
    );
  }

  if (model === "qwen3") {
    const qwen3DeviceOptions = getQwen3DeviceOptions(window.electron?.platform);
    const qwen3InstructSupported = qwen3SupportsInstruct(qwen3Model);
    const qwen3VoiceClone = qwen3UsesVoiceClone(qwen3Model);
    const qwen3MlxCustomVoice = qwen3UsesMlxCustomVoice(qwen3Model);
    const qwen3Mlx = qwen3UsesMlx(qwen3Model);
    const qwen3MlxToolAvailable = qwen3VoiceClone
      ? qwen3MlxSetup?.workerAvailable
      : ((qwen3MlxSetup?.apiServerAvailable ?? false) || (qwen3MlxSetup?.ttsAvailable ?? false));
    return (
      <Fragment key="qwen3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
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

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
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
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
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

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Device Map
            <select
              value={qwen3DeviceMap}
              onChange={(event) => onQwen3DeviceMapChange(event.target.value)}
              className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
            >
              {qwen3DeviceOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        {qwen3Mlx && (
          <div className="grid grid-cols-1 gap-3">
            <div className="rounded-xl border border-black/10 bg-white/35 p-3 text-sm text-text-secondary backdrop-blur-md">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Apple MLX Path</p>
                  <p>
                    {qwen3MlxCustomVoice
                      ? "Uses the upstream 6-bit MLX CustomVoice api_server for resident streaming inference."
                      : "Uses the upstream 6-bit MLX Base worker for voice cloning."}
                    {qwen3MlxToolAvailable
                      ? " Required MLX binary found."
                      : " Build or bundle the required MLX binary before generating."}
                  </p>
                  {qwen3MlxSetup && (
                    <div className="space-y-1 break-all text-xs text-text-muted">
                      <p>
                        {qwen3VoiceClone ? "Worker" : "CustomVoice api_server"}: {" "}
                        {qwen3VoiceClone
                          ? qwen3MlxSetup.workerPath ?? "not found"
                          : qwen3MlxSetup.apiServerPath
                            ?? qwen3MlxSetup.ttsPath
                            ?? "not found"}
                      </p>
                      <p>Recommended model dir: {qwen3MlxSetup.recommendedModelDir}</p>
                      <p>Model directory: {qwen3MlxSetup.modelDirLooksReady ? "ready" : "not ready"}</p>
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={onQwen3DownloadMlxModel}
                    disabled={qwen3MlxDownloadBusy || qwen3MlxSetupBusy}
                    className="rounded-md border border-white/55 bg-white/40 px-3 py-2 text-xs font-semibold text-text-primary shadow-glass-sm transition-colors hover:bg-white/60 disabled:cursor-not-allowed disabled:border-border disabled:text-text-muted"
                  >
                    {qwen3MlxDownloadBusy ? "Downloading…" : "Download Model"}
                  </button>
                  <button
                    type="button"
                    onClick={onQwen3RefreshMlxSetup}
                    disabled={qwen3MlxSetupBusy || qwen3MlxDownloadBusy}
                    className="rounded-md border border-white/55 bg-white/40 px-3 py-2 text-xs font-semibold text-text-primary shadow-glass-sm transition-colors hover:bg-white/60 disabled:cursor-not-allowed disabled:border-border disabled:text-text-muted"
                  >
                    {qwen3MlxSetupBusy ? "Checking…" : "Refresh"}
                  </button>
                </div>
              </div>
              {qwen3MlxDownloadProgress && (
                <p className="mt-3 break-all text-xs text-text-muted">
                  Downloading {formatDownloadProgress(qwen3MlxDownloadProgress)}
                </p>
              )}
              {qwen3MlxSetup && !qwen3MlxSetup.modelDirLooksReady && (
                <div className="mt-3 space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Fallback CLI Command</p>
                  <code className="block overflow-x-auto rounded-lg border border-black/10 bg-white/50 px-2 py-1 text-xs normal-case text-text-primary">
                    {qwen3MlxSetup.modelDownloadCommand}
                  </code>
                </div>
              )}
              {qwen3MlxSetup && !qwen3MlxToolAvailable && (
                <div className="mt-3 space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">MLX Tool Build Command</p>
                  <code className="block overflow-x-auto rounded-lg border border-black/10 bg-white/50 px-2 py-1 text-xs normal-case text-text-primary">
                    {qwen3MlxSetup.workerBuildCommand}
                  </code>
                </div>
              )}
            </div>

            <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
              MLX Model Directory
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={qwen3BaseModelPath}
                  onChange={(event) => onQwen3BaseModelPathChange(event.target.value)}
                  className="min-w-0 flex-1 px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
                  placeholder={
                    qwen3VoiceClone
                      ? "/path/to/Qwen3-TTS-12Hz-0.6B-Base-6bit"
                      : "/path/to/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit"
                  }
                />
                <button
                  type="button"
                  onClick={onQwen3ChooseBaseModelPath}
                  className="rounded-md border border-white/55 bg-white/40 px-3 py-2 text-xs font-semibold text-text-primary shadow-glass-sm transition-colors hover:bg-white/60"
                >
                  Choose…
                </button>
              </div>
            </label>

            {qwen3VoiceClone && (
              <>
                <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
                  Reference WAV
                  <input
                    type="file"
                    accept=".wav,audio/wav,audio/x-wav"
                    onChange={(event) => onQwen3ReferenceAudioChange(event.target.files?.[0] ?? null)}
                    className="px-3 py-2 rounded-lg border border-black/10 bg-white/55 backdrop-blur-sm text-sm normal-case text-text-primary"
                  />
                  <span className="text-sm font-normal normal-case text-text-muted">
                    {qwen3ReferenceAudioName || "Upload a mono 24 kHz WAV reference voice sample"}
                  </span>
                  {qwen3ReferenceAudioGuidance && (
                    <span className={`text-sm font-normal normal-case ${statusClass(qwen3ReferenceAudioGuidance.tone)}`}>
                      {qwen3ReferenceAudioGuidance.text}
                    </span>
                  )}
                </label>

                <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
                  Reference Transcript (exact)
                  <textarea
                    value={qwen3ReferenceText}
                    onChange={(event) => onQwen3ReferenceTextChange(event.target.value)}
                    className="w-full min-h-20 px-3 py-2 rounded-lg border border-black/10 bg-surface/55 backdrop-blur-sm text-sm normal-case text-text-primary"
                    placeholder="Paste the transcript that exactly matches the reference WAV"
                  />
                </label>
              </>
            )}
          </div>
        )}

        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Instruction (optional)
          <textarea
            value={qwen3Instruct}
            onChange={(event) => onQwen3InstructChange(event.target.value)}
            disabled={!qwen3InstructSupported}
            className={`w-full min-h-20 px-3 py-2 rounded-lg border border-black/10 bg-surface/55 backdrop-blur-sm text-sm normal-case text-text-primary ${qwen3InstructSupported ? "" : "opacity-50 cursor-not-allowed"}`}
            placeholder="Example: Speak warmly with a calm documentary narration style."
          />
          {!qwen3InstructSupported && (
            <span className="text-sm font-normal normal-case text-text-muted">
              Style instructions are not supported by the selected model.
            </span>
          )}
        </label>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
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

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
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

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-medium text-text-secondary">
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
            Top-k
            <input
              type="number"
              value={qwen3TopK}
              min={0}
              max={1000}
              step={1}
              onChange={(event) => onQwen3TopKChange(Number(event.target.value))}
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

  return null;
}

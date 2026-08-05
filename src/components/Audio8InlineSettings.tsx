import { ExternalLink } from "lucide-react";
import type { LocalTtsCacheInfo } from "../electron";
import { AUDIO8_MODEL_DOWNLOAD_LABEL, AUDIO8_MODEL_URL, AUDIO8_VOICES } from "../constants";
import { formatBytes, statusClass, type StatusTone } from "./localRuntime/utils";

interface Audio8InlineSettingsProps {
  voice: string;
  onVoiceChange: (voice: string) => void;
  cacheInfo: LocalTtsCacheInfo | null;
  cacheBusy: boolean;
  cacheStatus: { tone: StatusTone; text: string } | null;
  onClearCache: () => void;
}

export function Audio8InlineSettings({
  voice,
  onVoiceChange,
  cacheInfo,
  cacheBusy,
  cacheStatus,
  onClearCache,
}: Audio8InlineSettingsProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">Voice</span>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {AUDIO8_VOICES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onVoiceChange(item.id)}
              aria-pressed={voice === item.id}
              className={`rounded-xl border px-3 py-2 text-left transition-all duration-200 ${
                voice === item.id
                  ? "border-accent/40 bg-accent-light text-text-primary shadow-accent-sm"
                  : "border-white/50 bg-white/35 text-text-muted shadow-glass-sm hover:-translate-y-0.5 hover:bg-white/55 hover:text-text-primary"
              }`}
            >
              <span className="block text-sm font-medium">{item.name}</span>
              <span className="block text-2xs">{item.detail}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="rounded-xl border border-accent/15 bg-accent-light/60 px-3 py-2 text-xs leading-5 text-text-secondary">
        Runs fully on-device after a one-time {AUDIO8_MODEL_DOWNLOAD_LABEL} model download. Text and generated audio stay local. {" "}
        <a
          href={AUDIO8_MODEL_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
        >
          Model card <ExternalLink size={11} aria-hidden="true" />
        </a>
      </p>

      {/* Mirrors the cache block the NeuTTS and Qwen3 runtime pages render, so
          the only model that downloads half a gigabyte is no longer the one
          model whose storage the user cannot see or reclaim. */}
      <section
        aria-label="Audio8 model cache"
        className="rounded-xl border border-black/10 bg-surface/55 p-3 backdrop-blur-md"
      >
        <h3 className="text-xs font-semibold uppercase tracking-widest text-text-secondary">Cache</h3>
        <div className="mt-2 space-y-1 font-mono text-2xs text-text-secondary">
          <p className="break-all">Path: {cacheInfo?.path ?? "-"}</p>
          <p>Size: {cacheInfo ? formatBytes(cacheInfo.sizeBytes) : "-"}</p>
        </div>
        <button
          type="button"
          onClick={onClearCache}
          disabled={cacheBusy || !cacheInfo?.exists}
          className={`mt-3 w-full rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
            cacheBusy || !cacheInfo?.exists
              ? "cursor-not-allowed border-border text-text-muted"
              : "border-white/55 bg-white/45 text-text-primary backdrop-blur-md hover:bg-white/65"
          }`}
        >
          Clear Local Cache
        </button>
        {cacheStatus && (
          <p className={`mt-2 break-words text-2xs ${statusClass(cacheStatus.tone)}`}>
            {cacheStatus.text}
          </p>
        )}
      </section>
    </div>
  );
}

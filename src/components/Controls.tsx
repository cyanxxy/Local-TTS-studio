import { memo } from "react";
import { Loader2, RefreshCw, Sparkles, Square } from "lucide-react";
import {
  QUALITY_MIN, QUALITY_MAX, QUALITY_STEP,
} from "../constants";
import { useControlsContext } from "./ControlsContext";

const WAVEFORM_BARS = [
  { id: "bar-0", delay: 0,    duration: 0.7  },
  { id: "bar-1", delay: 0.1,  duration: 0.55 },
  { id: "bar-2", delay: 0.22, duration: 0.65 },
  { id: "bar-3", delay: 0.08, duration: 0.6  },
  { id: "bar-4", delay: 0.16, duration: 0.72 },
] as const;

/** Animated waveform bars shown inside the generate button while running */
const WaveformBars = memo(function WaveformBars() {
  return (
    <span className="inline-flex items-center gap-[2.5px] h-[16px]" aria-hidden>
      {WAVEFORM_BARS.map(({ id, delay, duration }) => (
        <span
          key={id}
          className="w-[3px] rounded-full bg-current"
          style={{
            height: "100%",
            transformOrigin: "center",
            animation: `wave-bar ${duration}s ease-in-out ${delay}s infinite`,
          }}
        />
      ))}
    </span>
  );
});

export function Controls() {
  const {
    activeModel,
    quality,
    onQualityChange,
    onGenerate,
    onRetryLoad,
    onStop,
    isGenerating,
    canGenerate,
    modelReady,
    modelError,
    loadingProgress,
    generationProgress,
  } = useControlsContext();

  const showRetry = !modelReady && !!modelError;
  const generateDisabled = isGenerating || (!showRetry && !canGenerate);
  const displayProgress = Math.max(0, Math.min(100, generationProgress));

  return (
    <div className="flex flex-col gap-5">

      {/* Quality slider — Supertonic only */}
      {activeModel === "supertonic" && (
        <div>
          <div className="flex items-baseline justify-between mb-2.5">
            <label className="text-xs font-semibold uppercase tracking-widest text-text-muted">
              Quality
            </label>
            <span className="font-mono text-sm font-medium text-text-primary tabular-nums">
              {quality} steps
            </span>
          </div>
          <input
            type="range"
            min={QUALITY_MIN}
            max={QUALITY_MAX}
            step={QUALITY_STEP}
            value={quality}
            onChange={(e) => onQualityChange(parseInt(e.target.value))}
          />
          <div className="flex justify-between mt-1.5">
            <span className="text-xs text-text-muted">Faster</span>
            <span className="text-xs text-text-muted">Higher quality</span>
          </div>
        </div>
      )}

      {/* Divider */}
      <div className="border-t border-border/60" />

      {/* Generate / Stop */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          onClick={showRetry ? onRetryLoad : onGenerate}
          disabled={generateDisabled}
          className={`
            flex-1 py-3 px-5 rounded-2xl text-sm font-semibold tracking-wide
            flex items-center justify-center gap-2.5 transition-all duration-200
            ${isGenerating
              ? "bg-accent text-white cursor-wait"
              : showRetry
              ? "bg-danger text-white shadow-accent-sm hover:bg-danger/90 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]"
              : !generateDisabled
              ? "glass-accent text-white"
              : "bg-border/70 text-text-muted cursor-not-allowed backdrop-blur-sm"
            }
          `}
          style={
            !generateDisabled
              ? { boxShadow: isGenerating ? "var(--shadow-accent-md)" : undefined }
              : undefined
          }
        >
          {isGenerating ? (
            <>
              <WaveformBars />
              <span>
                {displayProgress > 0 ? `${Math.round(displayProgress)}%` : "Generating…"}
              </span>
            </>
          ) : modelReady ? (
            <>
              <Sparkles size={14} />
              <span>Generate Speech</span>
            </>
          ) : modelError ? (
            <>
              <RefreshCw size={14} />
              <span>Retry Model Load</span>
            </>
          ) : (
            <>
              <Loader2 size={14} className="animate-spin" />
              <span>
                {loadingProgress > 0 ? `Preparing ${Math.round(loadingProgress)}%` : "Preparing…"}
              </span>
            </>
          )}
        </button>

        {isGenerating && (
          <button
            onClick={onStop}
            aria-label="Stop"
            title="Stop generation"
            className="flex h-11 w-full items-center justify-center rounded-2xl border border-danger/20 bg-danger-light text-danger backdrop-blur-md shadow-glass-sm transition-all duration-200 hover:bg-danger hover:text-white active:scale-[0.96] sm:w-11"
          >
            <Square size={14} />
          </button>
        )}
      </div>

      {showRetry && (
        <p className="text-xs leading-relaxed text-danger">
          {modelError}
        </p>
      )}
    </div>
  );
}

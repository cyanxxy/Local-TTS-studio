import { useMemo } from "react";
import { clampTrim, computePeaks, type TrimRange } from "../../lib/voiceLibrary/cloneWizard";
import { labelClass } from "./ui";

const BINS = 160;
const HEIGHT = 64;

interface WaveformTrimmerProps {
  samples: Float32Array;
  sampleRate: number;
  range: TrimRange;
  onRangeChange: (range: TrimRange) => void;
}

function formatTime(seconds: number): string {
  return `${seconds.toFixed(2)} s`;
}

/**
 * A waveform of the whole clip with the kept part highlighted, and two sliders
 * for its start and end. Sliders keep trimming usable from the keyboard and
 * with assistive technology.
 */
export function WaveformTrimmer({ samples, sampleRate, range, onRangeChange }: WaveformTrimmerProps) {
  const duration = samples.length / sampleRate;
  const peaks = useMemo(() => computePeaks(samples, BINS), [samples]);
  const startBin = Math.floor((range.startSec / duration) * BINS);
  const endBin = Math.ceil((range.endSec / duration) * BINS);
  const step = 0.01;

  return (
    <div className="space-y-2">
      <svg
        role="img"
        aria-label={`Waveform of the ${formatTime(duration)} clip. Kept part: ${formatTime(range.startSec)} to ${formatTime(range.endSec)}.`}
        viewBox={`0 0 ${BINS} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-16 w-full rounded-lg bg-text-primary/[0.04]"
      >
        {Array.from(peaks, (peak, index) => {
          const barHeight = Math.max(1, peak * (HEIGHT - 4));
          const kept = index >= startBin && index < endBin;
          return (
            <rect
              key={index}
              x={index + 0.15}
              y={(HEIGHT - barHeight) / 2}
              width={0.7}
              height={barHeight}
              rx={0.35}
              className={kept ? "fill-accent" : "fill-text-muted/40"}
            />
          );
        })}
      </svg>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span className="flex justify-between"><span>Trim start</span><span className="font-mono tabular-nums">{formatTime(range.startSec)}</span></span>
          <input
            type="range"
            aria-label="Trim start"
            min={0}
            max={duration}
            step={step}
            value={range.startSec}
            onChange={(event) => onRangeChange(clampTrim({ startSec: Number(event.target.value), endSec: range.endSec }, duration))}
          />
        </label>
        <label className={labelClass}>
          <span className="flex justify-between"><span>Trim end</span><span className="font-mono tabular-nums">{formatTime(range.endSec)}</span></span>
          <input
            type="range"
            aria-label="Trim end"
            min={0}
            max={duration}
            step={step}
            value={range.endSec}
            onChange={(event) => onRangeChange(clampTrim({ startSec: range.startSec, endSec: Number(event.target.value) }, duration))}
          />
        </label>
      </div>
    </div>
  );
}

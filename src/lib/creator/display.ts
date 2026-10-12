/** Small formatting and judging helpers the Creator Toolkit's sections share. */
import type { LoudnessReport } from "../audio/loudness";
import type { TextDiffPart } from "../text/textEdits";

/** m:ss, or h:mm:ss from an hour on. */
export function formatEstimate(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

const CONTEXT_CHARS = 24;
const MAX_CHANGES_SHOWN = 12;

interface PreviewPart {
  type: TextDiffPart["type"];
  text: string;
}

/**
 * The diff reduced to its changes with a little text around each, so a long
 * script previews briefly. Consecutive removals and insertions are one change.
 */
export function condenseDiff(parts: readonly TextDiffPart[]): { shown: PreviewPart[]; hiddenChanges: number } {
  const shown: PreviewPart[] = [];
  let changes = 0;
  let hiddenChanges = 0;
  parts.forEach((part, index) => {
    const startsChange = part.type !== "equal" && (index === 0 || parts[index - 1].type === "equal");
    if (startsChange) changes += 1;
    if (part.type !== "equal") {
      if (changes <= MAX_CHANGES_SHOWN) shown.push({ type: part.type, text: part.text });
      else if (startsChange) hiddenChanges += 1;
      return;
    }
    if (changes > MAX_CHANGES_SHOWN) return;
    // Only the sides that touch a change are kept: not the start of the script before the first one, nor its end after the last.
    const touchesPrevious = index > 0;
    const touchesNext = index < parts.length - 1;
    const text = part.text;
    if (text.length <= CONTEXT_CHARS * 2) {
      shown.push({ type: "equal", text });
    } else if (touchesPrevious && touchesNext) {
      shown.push({ type: "equal", text: `${text.slice(0, CONTEXT_CHARS)} … ${text.slice(-CONTEXT_CHARS)}` });
    } else if (touchesNext) {
      shown.push({ type: "equal", text: `… ${text.slice(-CONTEXT_CHARS)}` });
    } else {
      shown.push({ type: "equal", text: `${text.slice(0, CONTEXT_CHARS)} …` });
    }
  });
  return { shown, hiddenChanges };
}

export function formatDb(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "silent";
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded).toFixed(1)} ${unit}`;
}

/** ACX audiobook rules: RMS between -23 and -18 dBFS, peaks below -3 dBFS. */
export function acxCompliance(report: Pick<LoudnessReport, "rmsDbfs" | "samplePeakDbfs">): { ok: boolean; text: string } {
  const { rmsDbfs, samplePeakDbfs } = report;
  const rmsOk = rmsDbfs >= -23 && rmsDbfs <= -18;
  const peakOk = samplePeakDbfs <= -3;
  if (rmsOk && peakOk) return { ok: true, text: "Meets the ACX loudness and peak limits." };
  const problems = [
    ...(rmsOk ? [] : [`RMS ${formatDb(rmsDbfs, "dBFS")} is outside −23 to −18 dBFS`]),
    ...(peakOk ? [] : [`peak ${formatDb(samplePeakDbfs, "dBFS")} is above −3 dBFS`]),
  ];
  return { ok: false, text: `Outside the ACX limits: ${problems.join("; ")}.` };
}


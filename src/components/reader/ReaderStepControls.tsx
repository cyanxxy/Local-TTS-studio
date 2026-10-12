import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReaderStepDirection, ReaderStepUnit } from "./readerNavigation";

const STEP_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-accent-light hover:text-accent active:scale-[0.96]";

const UNITS: ReadonlyArray<{ unit: ReaderStepUnit; label: string; keys: [string, string] }> = [
  { unit: "sentence", label: "Sentence", keys: ["⇧←", "⇧→"] },
  { unit: "paragraph", label: "Paragraph", keys: ["⇧↑", "⇧↓"] },
];

/** Back and forward by sentence or paragraph, above the Reader's player. */
export function ReaderStepControls({ onStep }: { onStep: (unit: ReaderStepUnit, direction: ReaderStepDirection) => void }) {
  return (
    <div className="mb-2 flex justify-center">
      <div className="glass flex items-center gap-1 rounded-full p-0.5 font-sans text-2xs font-semibold text-text-secondary">
        {UNITS.map(({ unit, label, keys }) => (
          <div key={unit} role="group" aria-label={`${label} steps`} className="flex items-center">
            <button
              type="button"
              aria-label={`Previous ${unit}`}
              title={`Previous ${unit} (${keys[0]})`}
              onClick={() => onStep(unit, "previous")}
              className={STEP_BUTTON}
            >
              <ChevronLeft size={14} aria-hidden />
            </button>
            <span aria-hidden className="px-0.5">{label}</span>
            <button
              type="button"
              aria-label={`Next ${unit}`}
              title={`Next ${unit} (${keys[1]})`}
              onClick={() => onStep(unit, "next")}
              className={STEP_BUTTON}
            >
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

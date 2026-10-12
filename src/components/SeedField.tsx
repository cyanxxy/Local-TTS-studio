import { useId } from "react";
import { X } from "lucide-react";
import { MAX_SEED } from "../models/settings";

interface SeedFieldProps {
  seed: number | null;
  onChange: (seed: number | null) => void;
  /** Names the field for assistive technology when several engines' fields exist. */
  label?: string;
}

/** A sampling seed input: empty means a fresh seed each time. */
export function SeedField({ seed, onChange, label = "Seed" }: SeedFieldProps) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={id}
          type="number"
          min={0}
          max={MAX_SEED}
          step={1}
          placeholder="Random each time"
          value={seed ?? ""}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            onChange(Number.isInteger(next) && next >= 0 && next <= MAX_SEED ? next : null);
          }}
          className="w-full rounded-lg border border-black/10 bg-text-primary/[0.06] px-3 py-1.5 text-sm text-text-primary"
        />
        {seed !== null && (
          <button
            type="button"
            aria-label="Use a random seed"
            title="Use a random seed"
            onClick={() => onChange(null)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-text-muted hover:text-text-primary"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="mt-1 text-2xs leading-4 text-text-muted">A fixed seed repeats the same delivery for the same text and voice.</p>
    </div>
  );
}

import { useState, type InputHTMLAttributes } from "react";

interface DraftNumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange" | "min" | "max"> {
  value: number | null;
  min?: number;
  max?: number;
  /** Receives the typed number; the owner clamps or rejects it. */
  onCommit: (value: number) => void;
  /** When given, emptying the field clears the value; otherwise an empty field reverts on blur. */
  onClear?: () => void;
}

/**
 * A number field that keeps what is typed as text. A number inside
 * [min, max] commits as it is typed, so a value is never lost to a shortcut
 * (Ctrl+Enter) that generates without leaving the field. Anything else (an
 * empty field, a partial "1" on the way to "128", a value past the maximum)
 * stays a draft until blur or Enter, when the owner clamps it.
 *
 * Committing every keystroke through a clamping setter made fields with a
 * minimum impossible to type into: clearing "1024" to type "128" snapped the
 * empty field to the minimum at once, and the digits that followed were
 * appended to it.
 */
export function DraftNumberInput({ value, min, max, onCommit, onClear, onBlur, onKeyDown, ...inputProps }: DraftNumberInputProps) {
  // `null` while not editing, so the field shows the committed value,
  // including one the owner clamped or changed from elsewhere.
  const [draft, setDraft] = useState<string | null>(null);

  const parse = (text: string): number | null => {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const next = Number(trimmed);
    return Number.isFinite(next) ? next : null;
  };
  const inRange = (next: number) => (min === undefined || next >= min) && (max === undefined || next <= max);

  const change = (text: string) => {
    setDraft(text);
    if (text.trim() === "") {
      if (onClear && value !== null) onClear();
      return;
    }
    const next = parse(text);
    if (next !== null && inRange(next) && next !== value) onCommit(next);
  };

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const next = parse(draft);
    if (next !== null && next !== value) onCommit(next);
  };

  return (
    <input
      {...inputProps}
      type="number"
      min={min}
      max={max}
      value={draft ?? (value === null ? "" : String(value))}
      onChange={(event) => change(event.target.value)}
      onBlur={(event) => {
        commit();
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        onKeyDown?.(event);
      }}
    />
  );
}

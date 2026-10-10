/** Narrows untrusted stored settings to a plain object, or an empty one. */
export function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

/** Returns `value` when it is one of `allowed`, otherwise `fallback`. */
export function pickAllowed<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback;
}

/** A finite number clamped into `[min, max]`, otherwise `fallback`. */
export function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

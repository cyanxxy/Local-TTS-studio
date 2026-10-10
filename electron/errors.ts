/**
 * The exact text of a deliberate stop. The Rust bridge sends the same string
 * (rust/local-tts-bridge/src/main.rs) and the renderer recognises a
 * cancellation by matching it, so it must not change on one side alone.
 */
export const GENERATION_CANCELLED_MESSAGE = "Generation cancelled.";

/** Refusal for new local-runtime work once the quit has started. */
export const LOCAL_RUNTIME_SHUTTING_DOWN_MESSAGE = "The local runtime is shutting down.";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function generationCancelledError(): Error {
  return new Error(GENERATION_CANCELLED_MESSAGE);
}

export function isGenerationCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === GENERATION_CANCELLED_MESSAGE;
}

/** What a native runtime process left behind when it failed. */
export interface NativeFailureDiagnostics {
  /** The bridge's full error chain (`details`), when it reported one. */
  details?: string;
  /** Bounded, sanitized tail of the process's stderr. */
  stderr?: string;
  /** Bounded, sanitized tail of the process's stdout. */
  stdout?: string;
  exitCode?: number | null;
  signal?: string | null;
}

/**
 * A native runtime failure together with the diagnostics that explain it, for
 * the main-process log. `name` deliberately stays "Error": Electron sends a
 * rejected invoke to the renderer as `${error}`, and the renderer strips only an
 * "Error: " prefix before showing the message.
 */
export class NativeRuntimeError extends Error {
  readonly diagnostics: NativeFailureDiagnostics;

  constructor(message: string, diagnostics: NativeFailureDiagnostics) {
    super(message);
    this.diagnostics = diagnostics;
  }
}

export function nativeFailureDiagnostics(error: unknown): NativeFailureDiagnostics | undefined {
  return error instanceof NativeRuntimeError ? error.diagnostics : undefined;
}

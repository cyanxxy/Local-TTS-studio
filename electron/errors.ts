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

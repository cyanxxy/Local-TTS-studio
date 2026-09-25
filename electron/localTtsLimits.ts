// These limits are shared by renderer file selection and the Electron IPC
// boundary. NeuCodec produces at most 1,000 int32 codes for the 20-second
// reference window, so 64 KiB leaves ample NPY-header room without allowing a
// multi-megabyte code payload through IPC. Base64 expands each partial group.
export const MAX_REFERENCE_CODES_FILE_BYTES = 64 * 1024;
export const MAX_REFERENCE_CODES_BASE64_LENGTH = Math.ceil(MAX_REFERENCE_CODES_FILE_BYTES / 3) * 4;
export const MAX_REFERENCE_AUDIO_BASE64_LENGTH = 60_000_000;
export const MAX_LOCAL_TTS_TEXT_LENGTH = 6_000;
// Qwen generates each ~200-character passage separately, and the Rust bridge
// caps every passage at this many codec tokens (about 30 seconds at 12.5
// frames per second) to bound its KV cache. Keep this in sync with
// MAX_TEXT_UNIT_GENERATION_TOKENS in rust/local-tts-bridge/src/qwen3/config.rs.
export const QWEN3_MAX_NEW_TOKENS_PER_PASSAGE = 384;
export const QWEN3_MIN_NEW_TOKENS = 64;
// Seeds travel as JSON numbers and are u64 in Rust; 32 bits keeps them exact.
export const QWEN3_MAX_SEED = 0xFFFF_FFFF;

export const MAX_REFERENCE_AUDIO_FILE_BYTES = Math.floor(MAX_REFERENCE_AUDIO_BASE64_LENGTH / 4) * 3;

/** Count Unicode scalar values, matching Rust's `str::chars().count()`. */
export function countUnicodeScalars(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; count += 1) {
    const codePoint = value.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
  }
  return count;
}

/** Avoid allocating an intermediate code-point array for large Reader text. */
export function exceedsUnicodeScalarLimit(value: string, limit: number): boolean {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

import { StringDecoder } from "string_decoder";
import { readsAsCancellation } from "./errors";

/** How much of each native process stream is kept for diagnostics. */
export const NATIVE_OUTPUT_TAIL_CHARS = 16 * 1024;
const EXCERPT_MAX_LINES = 12;
const EXCERPT_MAX_CHARS = 1_500;

const ESCAPE = 0x1b;
const BELL = 0x07;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Keeps the most recent characters of a native process stream, decoding UTF-8
 * across chunk boundaries, so a crash can be explained without holding every
 * byte a long-lived process ever printed.
 */
export class NativeOutputTail {
  readonly #maxChars: number;
  readonly #decoder = new StringDecoder("utf8");
  #text = "";

  constructor(maxChars: number = NATIVE_OUTPUT_TAIL_CHARS) {
    this.#maxChars = maxChars;
  }

  append(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    if (text.length === 0) return;
    const combined = this.#text + text;
    this.#text = combined.length > this.#maxChars ? combined.slice(combined.length - this.#maxChars) : combined;
  }

  get text(): string {
    return this.#text;
  }
}

/**
 * Native output as plain text: terminal escape sequences removed, carriage
 * return redraws (progress bars) reduced to their final state, and any other
 * control character replaced by a space. Newlines and tabs are kept.
 */
export function sanitizeNativeOutput(text: string): string {
  const redrawn = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.split("\r").reverse().find((segment) => segment.length > 0) ?? "")
    .join("\n");
  return stripControlSequences(redrawn).replace(LONE_SURROGATE, "");
}

function isControlCharacter(code: number): boolean {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
}

// Drops CSI (`ESC [ … final byte`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`) and
// two-character escape sequences, and turns any other control character into
// a space.
function stripControlSequences(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== ESCAPE) {
      output += isControlCharacter(code) ? " " : text[index];
      continue;
    }
    const introducer = text[index + 1];
    if (introducer === "[") {
      index += 2;
      while (index < text.length && !(text.charCodeAt(index) >= 0x40 && text.charCodeAt(index) <= 0x7e)) index += 1;
    } else if (introducer === "]") {
      index += 2;
      while (
        index < text.length
        && text.charCodeAt(index) !== BELL
        && !(text.charCodeAt(index) === ESCAPE && text[index + 1] === "\\")
      ) index += 1;
      if (text.charCodeAt(index) === ESCAPE) index += 1;
    } else {
      index += 1;
    }
  }
  return output;
}

/**
 * The last few meaningful lines of native output, sized for an error message.
 * Blank lines are dropped (the bridge's heartbeat writes bare spaces to stderr)
 * and both the line count and the length are capped from the end, where a panic
 * or abort message lands.
 */
export function nativeOutputExcerpt(
  text: string,
  { maxLines = EXCERPT_MAX_LINES, maxChars = EXCERPT_MAX_CHARS }: { maxLines?: number; maxChars?: number } = {},
): string {
  const lines = sanitizeNativeOutput(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const kept: string[] = [];
  let length = 0;
  for (let index = lines.length - 1; index >= 0 && kept.length < maxLines; index -= 1) {
    const line = lines[index];
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (length + cost > maxChars) {
      // A single over-long last line still contributes its end.
      if (kept.length === 0) kept.push(`…${line.slice(line.length - (maxChars - 1))}`);
      break;
    }
    kept.unshift(line);
    length += cost;
  }
  return kept.join("\n");
}

/**
 * Appends an excerpt of native output to a failure message bound for the
 * renderer. The renderer treats any message that mentions "cancelled" as a
 * deliberate stop and hides it, so an excerpt containing that word is left out
 * rather than turning a crash into a silent cancel; the diagnostics log still
 * receives the full output.
 */
export function withNativeOutput(message: string, output: string): string {
  const excerpt = nativeOutputExcerpt(output);
  if (!excerpt || readsAsCancellation(excerpt)) return message;
  return `${message}\nNative output:\n${excerpt}`;
}

/** Replaces every occurrence of `secret`, such as the bridge's auth token. */
export function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

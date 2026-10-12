/**
 * English eSpeak NG phonemization for the browser models that phonemize
 * without kokoro-js (Kitten, Paradee, Piper). It reuses the phonemizer 1.2.1
 * build that kokoro-js also embeds (its voice list is limited to English).
 * Workers pass in PHONEMIZER_MODULE_URL from src/lib/onnxWasmAssets.ts, which
 * vite.kokoroAssets.ts serves unbundled beside kokoro.web.js, so the
 * Emscripten runtime never passes through Rolldown or dependency pre-bundling
 * and this module stays importable anywhere (tests, chunk planners). Every
 * worker that loads it gets its own eSpeak instance.
 */

/** phonemizer's `phonemize(text, language)`: one IPA string per output line. */
export type EspeakPhonemize = (text: string, language?: string) => Promise<string[]>;

export const ESPEAK_AMERICAN_ENGLISH = "en-us";

/**
 * eSpeak drops punctuation, but these models were trained on phonemes with it
 * kept in place (the Python phonemizer's preserve_punctuation). These are the
 * marks both that phonemizer and kokoro-js 1.2.1 preserve.
 */
export const PRESERVED_PUNCTUATION = ";:,.!?¡¿—…\"«»“”(){}[]";

const PUNCTUATION_RUN = new RegExp(
  `(?:\\s*[${PRESERVED_PUNCTUATION.replace(/[\]\\^-]/g, "\\$&")}]+\\s*)+`,
  "g",
);

export interface PhonemeSegment {
  /** Source range in the text that was phonemized. */
  textStart: number;
  textEnd: number;
  /** The range those characters became in PhonemizedText.phonemes. */
  phonemeStart: number;
  phonemeEnd: number;
  /** Punctuation runs (with their surrounding whitespace) are copied through verbatim. */
  punctuation: boolean;
}

export interface PhonemizedText {
  phonemes: string;
  /** Contiguous, in order, and covering the whole input text. */
  segments: PhonemeSegment[];
}

interface PhonemizerModule {
  phonemize?: unknown;
}

let loaded: { moduleUrl: string; promise: Promise<EspeakPhonemize> } | null = null;

/** Load (once per worker) the unbundled phonemizer build at `moduleUrl`. A failed load can be retried. */
export function loadEspeakPhonemizer(moduleUrl: string): Promise<EspeakPhonemize> {
  if (loaded?.moduleUrl !== moduleUrl) {
    const promise = (import(/* @vite-ignore */ moduleUrl) as Promise<PhonemizerModule>)
      .then((module) => {
        if (typeof module.phonemize !== "function") {
          throw new Error("The phonemizer module does not export phonemize().");
        }
        return module.phonemize as EspeakPhonemize;
      })
      .catch((error: unknown) => {
        if (loaded?.promise === promise) loaded = null;
        throw error;
      });
    loaded = { moduleUrl, promise };
  }
  return loaded.promise;
}

function splitPunctuationRuns(text: string): Array<{ start: number; end: number; punctuation: boolean }> {
  const runs: Array<{ start: number; end: number; punctuation: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(PUNCTUATION_RUN)) {
    const end = match.index + match[0].length;
    // Keep "4.50", "1,000" and "10:30" whole: eSpeak reads them as one number,
    // while splitting them would make "4.50" sound like "4. 50".
    if (/^[.,:]$/.test(match[0]) && /\d/.test(text[match.index - 1] ?? "") && /\d/.test(text[end] ?? "")) continue;
    if (cursor < match.index) runs.push({ start: cursor, end: match.index, punctuation: false });
    runs.push({ start: match.index, end, punctuation: true });
    cursor = end;
  }
  if (cursor < text.length) runs.push({ start: cursor, end: text.length, punctuation: false });
  return runs;
}

function spellOutMoney(value: string): string {
  const unit = value[0] === "$" ? "dollar" : "pound";
  const amount = value.slice(1);
  if (Number.isNaN(Number(amount))) return `${amount} ${unit}s`;
  if (!amount.includes(".")) return `${amount} ${unit}${amount === "1" ? "" : "s"}`;
  const [whole, fraction] = amount.split(".");
  const cents = parseInt(fraction.padEnd(2, "0"), 10);
  const centUnit = value[0] === "$" ? (cents === 1 ? "cent" : "cents") : (cents === 1 ? "penny" : "pence");
  return `${whole} ${unit}${whole === "1" ? "" : "s"} and ${cents} ${centUnit}`;
}

/**
 * kokoro-js 1.2.1's money rules (Apache-2.0): drop digit-group commas, then
 * spell amounts out ("$4.50" -> "4 dollars and 50 cents"). eSpeak alone reads
 * "$4.50" as "dollar four point five zero".
 */
export function spellOutCurrency(text: string): string {
  return text
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, spellOutMoney);
}

export interface PhonemizeOptions {
  /** eSpeak voice; American English by default. */
  language?: string;
  /** Rewrites each run of words just before eSpeak sees it, such as spellOutCurrency. */
  prepareRun?: (run: string) => string;
}

/**
 * Phonemize English text the way kokoro-js does: split out punctuation runs,
 * send only the words between them to eSpeak, and splice the punctuation back
 * in unchanged. The returned segments map every source range to its phonemes,
 * which is what word timing needs.
 */
export async function phonemizeKeepingPunctuation(
  text: string,
  phonemize: EspeakPhonemize,
  { language = ESPEAK_AMERICAN_ENGLISH, prepareRun = (run) => run }: PhonemizeOptions = {},
): Promise<PhonemizedText> {
  let phonemes = "";
  const segments: PhonemeSegment[] = [];
  // Sequential on purpose: phonemizer switches eSpeak's voice on every call.
  for (const run of splitPunctuationRuns(text)) {
    const source = text.slice(run.start, run.end);
    let output = source;
    if (!run.punctuation && source.trim()) {
      // A curly apostrophe would split "don’t" into two eSpeak words.
      output = (await phonemize(prepareRun(source.replace(/[‘’]/g, "'")), language)).join(" ");
    }
    segments.push({
      textStart: run.start,
      textEnd: run.end,
      phonemeStart: phonemes.length,
      phonemeEnd: phonemes.length + output.length,
      punctuation: run.punctuation,
    });
    phonemes += output;
  }
  return { phonemes, segments };
}

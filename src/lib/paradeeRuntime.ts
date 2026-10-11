/**
 * Paradee-8M v1.0 (Apache-2.0): Kokoro-82M's af_heart voice distilled into one
 * 9 MB graph. It was trained on misaki phonemes, so the browser front end is
 * kokoro-js 1.2.1's English text normalization and eSpeak phonemization
 * followed by Paradee's own eSpeak-to-misaki table (web/misaki.js), the
 * pipeline its authors ship for the web.
 *
 * Graph I/O: input_ids int64[1, T] (Kokoro vocabulary, a 0 pad at each end,
 * T <= 512) and speed float32[1] in; waveform float32[1, N] at 24 kHz out.
 * There is no style input and no duration output.
 */
import * as ort from "onnxruntime-web";
import { chunkWithConstraintsDetailed, type TextChunk } from "./chunking";
import { phonemizeKeepingPunctuation, spellOutCurrency, type EspeakPhonemize } from "./espeakPhonemizer";
import {
  ChunkTooLongError,
  disposeOutputs,
  finiteWaveform,
  idsTensor,
  STYLE_TTS_MAX_INPUT_TOKENS,
  STYLE_TTS_SAMPLE_RATE,
  trimNearSilence,
  type StyleTtsSession,
} from "./styleTtsRuntime";

export const PARADEE_SAMPLE_RATE = STYLE_TTS_SAMPLE_RATE;
/** Cache Storage for the pinned files; "transformers" keeps it inside the app's clear-cache contract. */
export const PARADEE_CACHE_NAME = "transformers-cache-paradee-v1";
export const PARADEE_VOICE = "heart";

/** Plan a GENERATE text into chunks; the Reader preview must use this same function. */
export function chunkParadeeText(text: string): TextChunk[] {
  return chunkWithConstraintsDetailed(text, { minCharacters: 40, maxCharacters: 280 });
}

function splitNumber(value: string): string {
  if (value.includes(".")) return value;
  if (value.includes(":")) {
    const [hours, minutes] = value.split(":").map(Number);
    if (minutes === 0) return `${hours} o'clock`;
    return minutes < 10 ? `${hours} oh ${minutes}` : `${hours} ${minutes}`;
  }
  const year = parseInt(value.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return value;
  const left = value.slice(0, 2);
  const right = parseInt(value.slice(2, 4), 10);
  const suffix = value.endsWith("s") ? "s" : "";
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function pointNumber(value: string): string {
  const [whole, fraction] = value.split(".");
  return `${whole} point ${fraction.split("").join(" ")}`;
}

/**
 * kokoro-js 1.2.1's normalize_text (Apache-2.0), rule for rule, except that
 * runs of spaces are collapsed everywhere rather than only the first one.
 */
export function normalizeParadeeText(text: string): string {
  const withNumbers = text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, "“")
    .replace(/»/g, "”")
    .replace(/[“”]/g, "\"")
    .replace(/\(/g, "«")
    .replace(/\)/g, "»")
    .replace(/、/g, ", ")
    .replace(/。/g, ". ")
    .replace(/！/g, "! ")
    .replace(/，/g, ", ")
    .replace(/：/g, ": ")
    .replace(/；/g, "; ")
    .replace(/？/g, "? ")
    .replace(/[^\S \n]/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/(?<=\n) +(?=\n)/g, "")
    .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replace(/\betc\.(?! [A-Z])/gi, "etc")
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNumber);
  return spellOutCurrency(withNumbers)
    .replace(/\d*\.\d+/g, pointNumber)
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/(?<=\d)S/g, " S")
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, "s")
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (match) => match.replace(/\./g, "-"))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim();
}

/** kokoro-js 1.2.1's American English fixes to raw eSpeak output. */
function applyKokoroPhonemeFixes(phonemes: string): string {
  return phonemes
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z")
    .replace(/(?<=nˈaɪn)ti(?!ː)/g, "di")
    .trim();
}

// Paradee's web/misaki.js (Apache-2.0): misaki's own eSpeak-to-misaki table
// (misaki/espeak.py, EspeakFallback, American English), adapted to eSpeak
// output without diphthong tie marks. Order matters.
const ESPEAK_TO_MISAKI: ReadonlyArray<readonly [string, string]> = [
  ["ʔˌn̩", "ʔn"], ["ʔn̩", "ʔn"],
  ["aɪ", "I"], ["aʊ", "W"],
  ["dʒ", "ʤ"],
  ["eɪ", "A"], ["e", "A"],
  ["tʃ", "ʧ"],
  ["ɔɪ", "Y"],
  ["ʲo", "jo"], ["ʲə", "jə"], ["ʲ", ""],
  ["ɚ", "əɹ"],
  ["r", "ɹ"],
  ["x", "k"], ["ç", "k"],
  ["ɬ", "l"],
  ["̃", ""],
];

export function espeakToMisaki(phonemes: string): string {
  let result = phonemes;
  for (const [from, to] of ESPEAK_TO_MISAKI) result = result.split(from).join(to);
  result = result.replace(/(\S)̩/gu, "ᵊ$1").replace(/̩/g, "");
  // misaki writes a word-final syllabic l as ᵊl (naval -> nˈAvᵊl).
  result = result.replace(/əl(?=[\s;:,.!?—…"“”()]|$)/gu, "ᵊl");
  // misaki maps ɐ to ə, except that its lexicon keeps ɐ for the article "a".
  result = result.replace(/ɐ(?![\s;:,.!?—…"“”()]|$)/gu, "ə");
  result = result.split("oʊ").join("O")
    .split("ɜːɹ").join("ɜɹ")
    .split("ɜː").join("ɜɹ")
    .split("ɪə").join("iə")
    .split("ː").join("");
  result = result.split("o").join("ɔ");
  return result.split("ɾ").join("T").split("ʔ").join("t");
}

export async function paradeePhonemes(text: string, phonemize: EspeakPhonemize): Promise<string> {
  const { phonemes } = await phonemizeKeepingPunctuation(normalizeParadeeText(text), phonemize);
  return espeakToMisaki(applyKokoroPhonemeFixes(phonemes));
}

/** Parse config.json's Kokoro phoneme vocabulary (single characters to ids). */
export function parseParadeeVocabulary(buffer: ArrayBuffer): ReadonlyMap<string, number> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new Error("Paradee config.json is invalid JSON.");
  }
  const config = value as { vocab?: unknown; sample_rate?: unknown } | null;
  if (config?.sample_rate !== PARADEE_SAMPLE_RATE) throw new Error("Paradee config.json has an unexpected sample rate.");
  const vocab = config.vocab;
  if (!vocab || typeof vocab !== "object") throw new Error("Paradee config.json has no vocab.");
  const entries = Object.entries(vocab);
  for (const [symbol, id] of entries) {
    if (Array.from(symbol).length !== 1 || !Number.isSafeInteger(id) || (id as number) < 1) {
      throw new Error(`Paradee config.json has an invalid vocab entry for ${JSON.stringify(symbol)}.`);
    }
  }
  if (entries.length === 0) throw new Error("Paradee config.json has an empty vocab.");
  return new Map(entries as Array<[string, number]>);
}

export function tokenizeParadeePhonemes(phonemes: string, vocabulary: ReadonlyMap<string, number>): number[] {
  const ids = [0];
  for (const symbol of phonemes) {
    const id = vocabulary.get(symbol);
    if (id !== undefined) ids.push(id);
  }
  ids.push(0);
  return ids;
}

export class ParadeeRuntime {
  readonly sampleRate = PARADEE_SAMPLE_RATE;
  private readonly session: StyleTtsSession;
  private readonly vocabulary: ReadonlyMap<string, number>;
  private readonly phonemize: EspeakPhonemize;

  constructor(session: StyleTtsSession, vocabulary: ReadonlyMap<string, number>, phonemize: EspeakPhonemize) {
    this.session = session;
    this.vocabulary = vocabulary;
    this.phonemize = phonemize;
  }

  /**
   * Standalone 24 kHz PCM. The graph pads speech with about 0.3 s of digital
   * silence before and 0.5 s after; that is trimmed to a 50 ms margin.
   */
  async synthesize(text: string, speed: number): Promise<Float32Array> {
    const phonemes = await paradeePhonemes(text, this.phonemize);
    const ids = tokenizeParadeePhonemes(phonemes, this.vocabulary);
    if (ids.length > STYLE_TTS_MAX_INPUT_TOKENS) throw new ChunkTooLongError(ids.length);
    if (!Array.from(phonemes).some((symbol) => this.vocabulary.has(symbol) && !/[\s\p{P}]/u.test(symbol))) {
      return new Float32Array(0);
    }
    const outputs = await this.session.run({
      input_ids: idsTensor(ids),
      speed: new ort.Tensor("float32", Float32Array.of(speed), [1]),
    });
    try {
      return trimNearSilence(finiteWaveform(outputs.waveform), PARADEE_SAMPLE_RATE);
    } finally {
      disposeOutputs(outputs);
    }
  }

  async dispose(): Promise<void> {
    await this.session.release();
  }
}

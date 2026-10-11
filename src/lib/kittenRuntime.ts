/**
 * Kitten TTS 0.8 (StyleTTS 2 family, Apache-2.0) inference on top of one
 * onnxruntime-web session. The text front end ports kittenml/kittentts_legacy
 * (onnx_model.py): eSpeak en-us phonemes with punctuation kept, Python-style
 * word tokenization joined with spaces, the TextCleaner symbol table, and
 * ids = [0, ...ids, 10, 0].
 *
 * Graph I/O: input_ids int64[1, T], style float32[1, 256], speed float32[1] in;
 * waveform float32[N] at 24 kHz and duration int64[T] (frames per input token,
 * 600 samples each) out.
 */
import * as ort from "onnxruntime-web";
import type { InferenceBackend } from "../types";
import { chunkWithConstraintsDetailed, type TextChunk } from "./chunking";
import { phonemizeKeepingPunctuation, spellOutCurrency, type EspeakPhonemize, type PhonemizedText } from "./espeakPhonemizer";
import {
  KITTEN_STYLE_DIMENSION,
  resolveKittenVoice,
  type KittenConfig,
  type KittenStyleTable,
} from "./kittenVoices";
import {
  ChunkTooLongError,
  disposeOutputs,
  finiteWaveform,
  idsTensor,
  STYLE_TTS_MAX_INPUT_TOKENS,
  STYLE_TTS_SAMPLE_RATE,
  type StyleTtsSession,
  type WordTiming,
} from "./styleTtsRuntime";

export const KITTEN_SAMPLE_RATE = STYLE_TTS_SAMPLE_RATE;
/** Cache Storage for the pinned files; "transformers" keeps it inside the app's clear-cache contract. */
export const KITTEN_CACHE_NAME = "transformers-cache-kitten-v1";
export const KITTEN_FRAME_SAMPLES = 600;
/** Upstream chunk_text's limit, which also keeps the style row inside the 400-row tables. */
export const KITTEN_MAX_CHUNK_CHARACTERS = 400;

// TextCleaner from onnx_model.py, character for character. The straight double
// quote and the apostrophe each appear twice; as in the Python dict, the later
// index wins.
const PAD = "$";
const PUNCTUATION = ";:,.!?¡¿—…\"«»\"\" ";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const IPA_LETTERS = "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ";
const SYMBOL_IDS: ReadonlyMap<string, number> = new Map(
  Array.from(PAD + PUNCTUATION + LETTERS + IPA_LETTERS, (symbol, index) => [symbol, index] as const),
);
const PAD_ID = 0;
/** "…", which upstream appends before the closing pad. */
const END_ID = 10;
/** Ids up to the space are pad and punctuation: no phoneme is spoken for them. */
const LAST_NON_PHONEME_ID = SYMBOL_IDS.get(" ")!;
/** Python's re.findall(r"\w+|[^\w\s]", text) on str: Unicode letter/number runs or single symbols. */
const PHONEME_PIECE = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu;

export interface KittenTokens {
  ids: number[];
  /** Per id, the index in the phoneme string it came from; -1 for pads, the end marker and joining spaces. */
  phonemeOffsets: number[];
}

export function tokenizeKittenPhonemes(phonemes: string): KittenTokens {
  const ids = [PAD_ID];
  const phonemeOffsets = [-1];
  let first = true;
  for (const match of phonemes.matchAll(PHONEME_PIECE)) {
    if (!first) {
      ids.push(SYMBOL_IDS.get(" ")!);
      phonemeOffsets.push(-1);
    }
    first = false;
    let offset = match.index;
    for (const symbol of match[0]) {
      const id = SYMBOL_IDS.get(symbol);
      if (id !== undefined) {
        ids.push(id);
        phonemeOffsets.push(offset);
      }
      offset += symbol.length;
    }
  }
  ids.push(END_ID, PAD_ID);
  phonemeOffsets.push(-1, -1);
  return { ids, phonemeOffsets };
}

/**
 * Plan a GENERATE text into chunks. The Reader's passage preview must use this
 * same function so its ranges match the worker's AUDIO_CHUNKs.
 */
export function chunkKittenText(text: string, backend: InferenceBackend | null): TextChunk[] {
  return chunkWithConstraintsDetailed(text, backend === "webgpu"
    ? { minCharacters: 80, maxCharacters: KITTEN_MAX_CHUNK_CHARACTERS }
    : { minCharacters: 40, maxCharacters: 240 });
}

/**
 * Upstream ensure_punctuation (kittenml/preprocess.py): a chunk that ends
 * without prosodic punctuation gets a comma. Only trailing text changes, so
 * source offsets into the chunk stay valid.
 */
export function ensureTerminalPunctuation(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed && !/[.!?,;:]$/.test(trimmed) ? `${trimmed},` : text;
}

const SILENCE_FLOOR_RMS = 0.005;
const SILENCE_RELATIVE_RMS = 0.05;
const SILENCE_MARGIN_FRAMES = 3;

interface FrameRange {
  start: number;
  end: number;
}

/**
 * Where to cut the waveform. The leading pad token lasts most of a second of
 * near-silence and the trailing punctuation/pad tokens a few frames, so trim
 * silence (keeping a 75 ms margin) but never past those tokens, which keeps
 * every spoken phoneme. Returns null when durations do not tile the waveform.
 */
function speechFrames(samples: Float32Array, ids: readonly number[], durations: readonly number[]): FrameRange | null {
  const frameCount = durations.reduce((sum, frames) => sum + frames, 0);
  if (frameCount * KITTEN_FRAME_SAMPLES !== samples.length || frameCount === 0) return null;

  const rms = new Float32Array(frameCount);
  let peak = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    let energy = 0;
    for (let index = frame * KITTEN_FRAME_SAMPLES; index < (frame + 1) * KITTEN_FRAME_SAMPLES; index += 1) {
      energy += samples[index] * samples[index];
    }
    rms[frame] = Math.sqrt(energy / KITTEN_FRAME_SAMPLES);
    peak = Math.max(peak, rms[frame]);
  }
  const threshold = Math.max(SILENCE_FLOOR_RMS, peak * SILENCE_RELATIVE_RMS);
  let firstLoud = frameCount;
  let lastLoud = -1;
  for (let frame = 0; frame < frameCount; frame += 1) {
    if (rms[frame] < threshold) continue;
    firstLoud = Math.min(firstLoud, frame);
    lastLoud = frame;
  }

  let trailingNonPhonemeFrames = 0;
  for (let token = ids.length - 1; token > 0 && ids[token] <= LAST_NON_PHONEME_ID; token -= 1) {
    trailingNonPhonemeFrames += durations[token];
  }
  const start = Math.min(durations[0], Math.max(0, firstLoud - SILENCE_MARGIN_FRAMES));
  const end = Math.max(frameCount - trailingNonPhonemeFrames, Math.min(frameCount, lastLoud + 1 + SILENCE_MARGIN_FRAMES));
  return { start, end: Math.max(start, end) };
}

function wordRanges(text: string, offset: number): Array<{ start: number; end: number }> {
  return Array.from(text.matchAll(/\S+/g), (match) => ({
    start: offset + match.index,
    end: offset + match.index + match[0].length,
  }));
}

/**
 * Exact word timings from the duration output. Each eSpeak word is matched to
 * its source word when a text run phonemizes to the same number of words;
 * otherwise (numbers, abbreviations, merged function words) the run's exact
 * span is shared out by source word length.
 */
export function kittenWordTimings(
  text: string,
  phonemized: PhonemizedText,
  tokens: KittenTokens,
  durations: readonly number[],
  speech: FrameRange,
): WordTiming[] {
  const tokenStarts: number[] = [];
  let frame = 0;
  for (const value of durations) {
    tokenStarts.push(frame);
    frame += value;
  }
  const toSeconds = (value: number) =>
    (Math.max(speech.start, Math.min(speech.end, value)) - speech.start) * KITTEN_FRAME_SAMPLES / KITTEN_SAMPLE_RATE;

  const timings: WordTiming[] = [];
  let token = 0;
  for (const segment of phonemized.segments) {
    if (segment.punctuation) continue;
    const phonemeWords = wordRanges(phonemized.phonemes.slice(segment.phonemeStart, segment.phonemeEnd), segment.phonemeStart);
    const spans = phonemeWords.map(() => ({ start: Infinity, end: -Infinity }));
    const segmentSpan = { start: Infinity, end: -Infinity };
    for (; token < tokens.ids.length; token += 1) {
      const offset = tokens.phonemeOffsets[token];
      if (offset < 0) continue;
      if (offset >= segment.phonemeEnd) break;
      if (offset < segment.phonemeStart) continue;
      const word = phonemeWords.findIndex((range) => offset >= range.start && offset < range.end);
      if (word < 0) continue;
      const span = spans[word];
      const tokenEnd = tokenStarts[token] + durations[token];
      span.start = Math.min(span.start, tokenStarts[token]);
      span.end = Math.max(span.end, tokenEnd);
      segmentSpan.start = Math.min(segmentSpan.start, tokenStarts[token]);
      segmentSpan.end = Math.max(segmentSpan.end, tokenEnd);
    }
    if (segmentSpan.end < 0) continue;

    const sourceWords = wordRanges(text.slice(segment.textStart, Math.min(segment.textEnd, text.length)), segment.textStart);
    if (sourceWords.length === spans.length && spans.every((span) => span.end >= 0)) {
      sourceWords.forEach((word, index) => timings.push({
        ...word,
        startSec: toSeconds(spans[index].start),
        endSec: toSeconds(spans[index].end),
      }));
      continue;
    }
    const totalLength = sourceWords.reduce((sum, word) => sum + word.end - word.start, 0);
    let consumed = 0;
    for (const word of sourceWords) {
      const startFrame = segmentSpan.start + (segmentSpan.end - segmentSpan.start) * consumed / totalLength;
      consumed += word.end - word.start;
      const endFrame = segmentSpan.start + (segmentSpan.end - segmentSpan.start) * consumed / totalLength;
      timings.push({ ...word, startSec: toSeconds(startFrame), endSec: toSeconds(endFrame) });
    }
  }
  return timings;
}

export interface KittenSynthesis {
  /** Standalone 24 kHz PCM with the leading and trailing silence trimmed. */
  audio: Float32Array;
  /** Frames (600 samples) per input token, pads included. */
  durations: number[];
  /** Word offsets relative to the synthesized text; absent when durations do not tile the waveform. */
  wordTimings?: WordTiming[];
}

export class KittenRuntime {
  readonly sampleRate = KITTEN_SAMPLE_RATE;
  private readonly session: StyleTtsSession;
  private readonly styles: ReadonlyMap<string, KittenStyleTable>;
  private readonly config: KittenConfig;
  private readonly phonemize: EspeakPhonemize;

  constructor(
    session: StyleTtsSession,
    styles: ReadonlyMap<string, KittenStyleTable>,
    config: KittenConfig,
    phonemize: EspeakPhonemize,
  ) {
    this.session = session;
    this.styles = styles;
    this.config = config;
    this.phonemize = phonemize;
  }

  async synthesize(text: string, voice: string, speed: number): Promise<KittenSynthesis> {
    const { styleKey } = resolveKittenVoice(voice);
    const styles = this.styles.get(styleKey);
    if (!styles) throw new Error(`Kitten voice ${styleKey} is not loaded.`);
    const prepared = ensureTerminalPunctuation(text);
    // Upstream expands numbers and currency in Python before eSpeak; eSpeak
    // handles everything but money itself.
    const phonemized = await phonemizeKeepingPunctuation(prepared, this.phonemize, { prepareRun: spellOutCurrency });
    const tokens = tokenizeKittenPhonemes(phonemized.phonemes);
    if (tokens.ids.length > STYLE_TTS_MAX_INPUT_TOKENS) throw new ChunkTooLongError(tokens.ids.length);
    if (!tokens.ids.some((id) => id > LAST_NON_PHONEME_ID)) {
      return { audio: new Float32Array(0), durations: [], wordTimings: [] };
    }

    const outputs = await this.session.run({
      input_ids: idsTensor(tokens.ids),
      style: new ort.Tensor("float32", styles.styleFor(prepared.length), [1, KITTEN_STYLE_DIMENSION]),
      speed: new ort.Tensor("float32", Float32Array.of(speed * (this.config.speedPriors[styleKey] ?? 1)), [1]),
    });
    try {
      const samples = finiteWaveform(outputs.waveform);
      const durationData = outputs.duration?.data;
      const durations = durationData instanceof BigInt64Array ? Array.from(durationData, Number) : [];
      const speech = durations.length === tokens.ids.length ? speechFrames(samples, tokens.ids, durations) : null;
      if (!speech) {
        // Upstream's fixed trim, for output whose durations cannot place the speech.
        return { audio: samples.slice(0, Math.max(0, samples.length - 5000)), durations };
      }
      return {
        audio: samples.slice(speech.start * KITTEN_FRAME_SAMPLES, speech.end * KITTEN_FRAME_SAMPLES),
        durations,
        wordTimings: kittenWordTimings(prepared, phonemized, tokens, durations, speech),
      };
    } finally {
      disposeOutputs(outputs);
    }
  }

  async dispose(): Promise<void> {
    await this.session.release();
  }
}

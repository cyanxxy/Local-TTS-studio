/**
 * Piper (VITS, rhasspy/piper-voices) inference on top of one onnxruntime-web
 * session per voice. Text is phonemized with the English eSpeak NG build the
 * app ships (punctuation kept in place, as piper-phonemize does), mapped to
 * ids through the voice's own phoneme_id_map with a pad between phonemes, and
 * run with the voice's noise scales.
 *
 * Graph I/O: input int64[1, T], input_lengths int64[1], scales float32[3]
 * (noise_scale, length_scale, noise_w) and, for multi-speaker voices, sid
 * int64[1] in; output float32[1, 1, 1, N] at the voice's sample rate out.
 *
 * One chunk per run on purpose. The graph accepts a batch dimension, but its
 * rows all come back as long as the longest one, with a noisy tail instead of
 * digital silence and no duration output to cut by (measured with the
 * en_US-kristin-medium graph), so batched rows cannot be trimmed reliably.
 */
import * as ort from "onnxruntime-web";
import { chunkWithConstraintsDetailed, type TextChunk } from "./chunking";
import { phonemizeKeepingPunctuation, type EspeakPhonemize } from "./espeakPhonemizer";
import { isEnglishEspeakVoice } from "./piperVoices";
import { disposeOutputs, finiteWaveform, type StyleTtsSession } from "./styleTtsRuntime";

const BOS = "^";
const EOS = "$";
const PAD = "_";
/** The longest sentence-sized chunk Piper reads well; longer ones are split by the chunker. */
export const PIPER_MAX_CHUNK_CHARACTERS = 250;
/** Piper scales every utterance's peak to full scale; this keeps the same loudness without clipping. */
const PEAK_LEVEL = 0.95;
/** Piper's own floor, so near-silent output is not amplified into noise. */
const MIN_PEAK = 0.01;

/** Plan a GENERATE text into chunks; the Reader preview must use this same function. */
export function chunkPiperText(text: string): TextChunk[] {
  return chunkWithConstraintsDetailed(text, { minCharacters: 40, maxCharacters: PIPER_MAX_CHUNK_CHARACTERS });
}

export interface PiperVoiceConfig {
  sampleRate: number;
  espeakVoice: string;
  noiseScale: number;
  lengthScale: number;
  noiseW: number;
  numSpeakers: number;
  /** Speaker names to ids; empty for single-speaker voices. */
  speakerIds: ReadonlyMap<string, number>;
  /** A phoneme can map to several ids. */
  phonemeIds: ReadonlyMap<string, readonly number[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Piper config has an invalid ${field}.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Piper config has an invalid ${field}.`);
  }
  return value;
}

/** Strict reader for a voice's <name>.onnx.json. */
export function parsePiperConfig(buffer: ArrayBuffer): PiperVoiceConfig {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new Error("Piper config is invalid JSON.");
  }
  if (!isRecord(value)) throw new Error("Piper config is not an object.");
  const { audio, espeak, inference } = value;
  if (!isRecord(audio) || !isRecord(espeak) || !isRecord(inference)) {
    throw new Error("Piper config is missing its audio, espeak or inference section.");
  }
  if ((value.phoneme_type ?? "espeak") !== "espeak") throw new Error("Piper config does not use eSpeak phonemes.");
  if (typeof espeak.voice !== "string" || !isEnglishEspeakVoice(espeak.voice)) {
    throw new Error("Piper config needs an eSpeak voice other than English, which this build cannot phonemize.");
  }
  if (!isRecord(value.phoneme_id_map)) throw new Error("Piper config has no phoneme_id_map.");
  const phonemeIds = new Map<string, readonly number[]>();
  for (const [phoneme, ids] of Object.entries(value.phoneme_id_map)) {
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Number.isSafeInteger(id) && id >= 0)) {
      throw new Error(`Piper config has an invalid phoneme_id_map entry for ${JSON.stringify(phoneme)}.`);
    }
    phonemeIds.set(phoneme, ids as number[]);
  }
  for (const marker of [BOS, EOS, PAD]) {
    if (!phonemeIds.has(marker)) throw new Error(`Piper config's phoneme_id_map has no ${marker} entry.`);
  }
  const numSpeakers = nonNegativeInteger(value.num_speakers ?? 1, "num_speakers");
  if (numSpeakers < 1) throw new Error("Piper config has an invalid num_speakers.");
  const speakerIds = new Map<string, number>();
  if (isRecord(value.speaker_id_map)) {
    for (const [name, id] of Object.entries(value.speaker_id_map)) {
      speakerIds.set(name, nonNegativeInteger(id, `speaker_id_map entry ${JSON.stringify(name)}`));
    }
  }
  return {
    sampleRate: finitePositive(audio.sample_rate, "audio.sample_rate"),
    espeakVoice: espeak.voice,
    noiseScale: finitePositive(inference.noise_scale, "inference.noise_scale"),
    lengthScale: finitePositive(inference.length_scale, "inference.length_scale"),
    noiseW: finitePositive(inference.noise_w, "inference.noise_w"),
    numSpeakers,
    speakerIds,
    phonemeIds,
  };
}

/**
 * Phoneme ids for one utterance: BOS, a pad, then each known phoneme followed
 * by a pad, then EOS. Phonemes are NFD-normalized first and code points
 * without an id are dropped, as piper-phonemize does.
 */
export function phonemesToIds(phonemes: string, phonemeIds: ReadonlyMap<string, readonly number[]>): number[] {
  const pad = phonemeIds.get(PAD)!;
  const ids = [...phonemeIds.get(BOS)!, ...pad];
  for (const phoneme of phonemes.normalize("NFD")) {
    const mapped = phonemeIds.get(phoneme);
    if (mapped) ids.push(...mapped, ...pad);
  }
  ids.push(...phonemeIds.get(EOS)!);
  return ids;
}

/** The sid for a speaker name or numeric id; the first speaker when none is given. */
export function resolvePiperSpeaker(config: PiperVoiceConfig, speaker: string | null): number {
  if (config.numSpeakers <= 1 || speaker === null) return 0;
  const named = config.speakerIds.get(speaker);
  if (named !== undefined) return named;
  const numeric = /^\d+$/.test(speaker) ? Number(speaker) : NaN;
  return Number.isSafeInteger(numeric) && numeric < config.numSpeakers ? numeric : 0;
}

/** Scales the waveform's peak to PEAK_LEVEL, like Piper's own writers. */
export function normalizePeak(samples: Float32Array): Float32Array {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const gain = PEAK_LEVEL / Math.max(MIN_PEAK, peak);
  return samples.map((sample) => sample * gain);
}

export class PiperRuntime {
  readonly sampleRate: number;
  private readonly session: StyleTtsSession;
  private readonly config: PiperVoiceConfig;
  private readonly phonemize: EspeakPhonemize;

  constructor(session: StyleTtsSession, config: PiperVoiceConfig, phonemize: EspeakPhonemize) {
    this.session = session;
    this.config = config;
    this.phonemize = phonemize;
    this.sampleRate = config.sampleRate;
  }

  async idsFor(text: string): Promise<number[]> {
    const { phonemes } = await phonemizeKeepingPunctuation(text, this.phonemize, { language: this.config.espeakVoice });
    return phonemesToIds(phonemes, this.config.phonemeIds);
  }

  private scales(speed: number): ort.Tensor {
    const { noiseScale, lengthScale, noiseW } = this.config;
    return new ort.Tensor("float32", Float32Array.of(noiseScale, lengthScale / speed, noiseW), [3]);
  }

  private feeds(ids: readonly number[], speakerId: number, speed: number): Record<string, ort.Tensor> {
    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new ort.Tensor("int64", BigInt64Array.of(BigInt(ids.length)), [1]),
      scales: this.scales(speed),
    };
    if (this.config.numSpeakers > 1) feeds.sid = new ort.Tensor("int64", BigInt64Array.of(BigInt(speakerId)), [1]);
    return feeds;
  }

  /**
   * Standalone PCM at the voice's sample rate for one chunk of text. `speed`
   * divides the voice's length_scale; `speakerId` only matters for
   * multi-speaker voices.
   */
  async synthesize(text: string, speakerId: number, speed: number): Promise<Float32Array> {
    const ids = await this.idsFor(text);
    // BOS, pad and EOS only: no phoneme of the text has an id.
    if (ids.length <= phonemesToIds("", this.config.phonemeIds).length) return new Float32Array(0);
    const outputs = await this.session.run(this.feeds(ids, speakerId, speed));
    try {
      return normalizePeak(finiteWaveform(outputs.output).slice());
    } finally {
      disposeOutputs(outputs);
    }
  }

  async dispose(): Promise<void> {
    await this.session.release();
  }
}

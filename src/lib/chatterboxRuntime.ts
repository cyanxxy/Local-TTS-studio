import {
  AutoTokenizer,
  ChatterboxModel,
  LogitsProcessor,
  LogitsProcessorList,
  StoppingCriteria,
  StoppingCriteriaList,
  Tensor,
  random,
} from "@huggingface/transformers";
import type { InferenceBackend } from "../types";
import type { ChatterboxDtype } from "./chatterboxAssets";
import { CHATTERBOX_MODEL_ID, CHATTERBOX_MODEL_REVISION } from "./chatterboxModel";
import { CHATTERBOX_SAMPLE_RATE } from "./chatterboxReference";

export const CHATTERBOX_START_SPEECH_TOKEN = 6561;
export const CHATTERBOX_STOP_SPEECH_TOKEN = 6562;
export const CHATTERBOX_SILENCE_TOKEN = 4299;
/** Upstream `inference_turbo` caps generation at 1000 speech tokens (40 s). */
export const CHATTERBOX_MAX_NEW_TOKENS = 1000;
const TRAILING_SILENCE_TOKENS = 3;
// Measured about 1.4-1.5 speech tokens per character at 25 tokens per second;
// a non-speech tag such as [laugh] adds up to about two seconds.
const TOKENS_PER_SPOKEN_CHARACTER = 3;
const TOKENS_PER_TAG = 50;
const MIN_TOKEN_BUDGET = 75;

export interface ChatterboxSampling {
  /** 0 selects greedy decoding (the official ONNX recipe). */
  temperature: number;
  /** 0 disables top-k filtering. */
  topK: number;
  /** 1 disables nucleus filtering. */
  topP: number;
  repetitionPenalty: number;
  /** Unsigned 32-bit seed; omitted means a fresh random seed per chunk. */
  seed?: number;
}

/** Upstream ChatterboxTurboTTS.generate defaults. CFG and exaggeration do not exist in Turbo. */
export const CHATTERBOX_DEFAULT_SAMPLING: Readonly<ChatterboxSampling> = {
  temperature: 0.8,
  topK: 1000,
  topP: 0.95,
  repetitionPenalty: 1.2,
};

export interface ChatterboxConditioning {
  audioFeatures: Tensor;
  audioTokens: Tensor;
  speakerEmbeddings: Tensor;
  speakerFeatures: Tensor;
}

export interface ChatterboxSynthesisResult {
  audio: Float32Array;
  /** False when the token budget ran out before the stop token (a runaway). */
  reachedStop: boolean;
  speechTokens: number;
}

export interface ChatterboxRuntime {
  readonly backend: InferenceBackend;
  readonly dtype: ChatterboxDtype;
  readonly sampleRate: number;
  encodeReference(audio: Float32Array): Promise<ChatterboxConditioning>;
  synthesize(
    text: string,
    conditioning: ChatterboxConditioning,
    options: {
      maxNewTokens: number;
      sampling: ChatterboxSampling;
      /** Polled after every speech token; true ends generation early with no audio (a soft abort). */
      shouldStop?: () => boolean;
    },
  ): Promise<ChatterboxSynthesisResult>;
  dispose(): Promise<void>;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeChatterboxSampling(input: Partial<ChatterboxSampling> = {}): ChatterboxSampling {
  const sampling: ChatterboxSampling = {
    temperature: clamp(finiteOr(input.temperature, CHATTERBOX_DEFAULT_SAMPLING.temperature), 0, 2),
    topK: Math.round(clamp(finiteOr(input.topK, CHATTERBOX_DEFAULT_SAMPLING.topK), 0, CHATTERBOX_STOP_SPEECH_TOKEN + 1)),
    topP: clamp(finiteOr(input.topP, CHATTERBOX_DEFAULT_SAMPLING.topP), 0.01, 1),
    repetitionPenalty: clamp(finiteOr(input.repetitionPenalty, CHATTERBOX_DEFAULT_SAMPLING.repetitionPenalty), 1, 2),
  };
  if (typeof input.seed === "number" && Number.isFinite(input.seed)) {
    sampling.seed = Math.abs(Math.trunc(input.seed)) % 0x1_0000_0000;
  }
  return sampling;
}

/**
 * The graph variants Chatterbox Turbo runs, measured on onnxruntime-web 1.26
 * in Electron's Chromium (Apple GPU):
 * - WASM cannot run it. The quantized graphs use GatherBlockQuantized, which
 *   the WASM execution provider lacks (session creation fails for q4, q4f16
 *   and q8), and the unquantized graphs total 3.3 GB.
 * - On WebGPU the quantized `embed_tokens` graph fails at run time (an empty
 *   dispatch in its GatherBlockQuantized node), so that one graph loads
 *   unquantized.
 * - The q4f16 language model and fp16 variants of the other graphs decode to
 *   garbled speech on WebGPU; q4 with fp32 activations transcribes correctly.
 */
export const CHATTERBOX_DTYPE: ChatterboxDtype = {
  embed_tokens: "fp32",
  speech_encoder: "q4",
  language_model: "q4",
  conditional_decoder: "q4",
};

/** Speech-token budget for one chunk; exceeding it means the model never stopped. */
export function getChatterboxTokenBudget(spokenCharacters: number, tagCount: number): number {
  const estimate = (Math.max(0, spokenCharacters) * TOKENS_PER_SPOKEN_CHARACTER) + (Math.max(0, tagCount) * TOKENS_PER_TAG);
  return Math.round(clamp(estimate, MIN_TOKEN_BUDGET, CHATTERBOX_MAX_NEW_TOKENS));
}

function keepTopK(scores: Float32Array, topK: number): void {
  if (topK <= 0 || topK >= scores.length) return;
  const sorted = Float32Array.from(scores).sort();
  const threshold = sorted[sorted.length - topK];
  for (let i = 0; i < scores.length; i += 1) {
    if (scores[i] < threshold) scores[i] = -Infinity;
  }
}

function keepTopP(scores: Float32Array, topP: number): void {
  if (topP >= 1) return;
  let max = -Infinity;
  for (const score of scores) max = Math.max(max, score);
  if (!Number.isFinite(max)) return;
  const order = Array.from(scores.keys())
    .filter((index) => scores[index] > -Infinity)
    .sort((a, b) => scores[b] - scores[a]);
  const weights = order.map((index) => Math.exp(scores[index] - max));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cumulative = 0;
  let keep = 0;
  // Keep the smallest prefix whose probability mass reaches topP (at least one token).
  while (keep < order.length && cumulative < topP) {
    cumulative += weights[keep] / total;
    keep += 1;
  }
  for (let i = keep; i < order.length; i += 1) scores[order[i]] = -Infinity;
}

/**
 * Apply upstream Turbo's logits pipeline in place, in its order: temperature,
 * top-k, top-p, then repetition penalty over the speech tokens produced so far
 * (seeded with START). Text prompt ids are never penalized: they live in a
 * different vocabulary than the 6563 speech logits.
 */
export function processChatterboxLogits(
  scores: Float32Array,
  speechHistory: Iterable<number>,
  sampling: ChatterboxSampling,
): void {
  if (sampling.temperature > 0) {
    if (sampling.temperature !== 1) {
      for (let i = 0; i < scores.length; i += 1) scores[i] /= sampling.temperature;
    }
    keepTopK(scores, sampling.topK);
    keepTopP(scores, sampling.topP);
  }
  if (sampling.repetitionPenalty === 1) return;
  for (const token of new Set(speechHistory)) {
    if (token < 0 || token >= scores.length) continue;
    scores[token] = scores[token] < 0 ? scores[token] * sampling.repetitionPenalty : scores[token] / sampling.repetitionPenalty;
  }
}

class ChatterboxLogitsProcessor extends LogitsProcessor {
  private readonly promptLength: number;
  private readonly sampling: ChatterboxSampling;

  constructor(promptLength: number, sampling: ChatterboxSampling) {
    super();
    this.promptLength = promptLength;
    this.sampling = sampling;
  }

  _call(inputIds: bigint[][], logits: Tensor): Tensor {
    const vocabularySize = logits.dims[logits.dims.length - 1];
    const scores = logits.data as Float32Array;
    for (let batch = 0; batch < inputIds.length; batch += 1) {
      const history = [CHATTERBOX_START_SPEECH_TOKEN, ...inputIds[batch].slice(this.promptLength).map(Number)];
      const row = scores.subarray(batch * vocabularySize, (batch + 1) * vocabularySize);
      processChatterboxLogits(row, history, this.sampling);
    }
    return logits;
  }
}

class ChatterboxAbortCriteria extends StoppingCriteria {
  private readonly shouldStop: () => boolean;

  constructor(shouldStop: () => boolean) {
    super();
    this.shouldStop = shouldStop;
  }

  _call(inputIds: number[][]): boolean[] {
    const stop = this.shouldStop();
    return inputIds.map(() => stop);
  }
}

/** Decoder input: reference prompt tokens, generated speech tokens, then trailing silence. */
export function assembleChatterboxSpeechTokens(
  promptTokens: ArrayLike<bigint>,
  generated: ArrayLike<bigint>,
): BigInt64Array {
  const speech = Array.from(generated).filter((token) => token < BigInt(CHATTERBOX_START_SPEECH_TOKEN));
  const tokens = new BigInt64Array(promptTokens.length + speech.length + TRAILING_SILENCE_TOKENS);
  tokens.set(Array.from(promptTokens));
  tokens.set(speech, promptTokens.length);
  tokens.fill(BigInt(CHATTERBOX_SILENCE_TOKEN), promptTokens.length + speech.length);
  return tokens;
}

interface DisposableCache {
  dispose?: () => Promise<void> | void;
}

interface BaseGenerateOutput {
  sequences: Tensor;
  past_key_values?: DisposableCache;
}

type BaseGenerate = (this: ChatterboxModel, params: Record<string, unknown>) => Promise<BaseGenerateOutput>;

// ChatterboxModel.generate() requests return_dict_in_generate, which keeps the
// KV cache alive, then drops it. On WebGPU those are GPU buffers, so every
// chunk would leak ~100 MB. Call the generic generate directly and dispose the
// cache ourselves (the decode step it skips is reproduced below).
const baseGenerate = (Object.getPrototypeOf(ChatterboxModel.prototype) as { generate: BaseGenerate }).generate;

function toStandaloneFloat32(tensor: Tensor): Float32Array {
  const data = tensor.type === "float32" ? tensor.data : tensor.to("float32").data;
  return Float32Array.from(data as Float32Array);
}

export async function loadChatterboxRuntime({
  backend,
  dtype,
}: {
  backend: InferenceBackend;
  dtype: ChatterboxDtype;
}): Promise<ChatterboxRuntime> {
  const tokenizer = await AutoTokenizer.from_pretrained(CHATTERBOX_MODEL_ID, {
    revision: CHATTERBOX_MODEL_REVISION,
  });
  const model = await ChatterboxModel.from_pretrained(CHATTERBOX_MODEL_ID, {
    revision: CHATTERBOX_MODEL_REVISION,
    device: backend,
    dtype,
  }) as ChatterboxModel;

  return {
    backend,
    dtype,
    sampleRate: CHATTERBOX_SAMPLE_RATE,

    async encodeReference(audio) {
      const encoded = await model.encode_speech(new Tensor("float32", audio, [1, audio.length]));
      return {
        audioFeatures: encoded.audio_features,
        audioTokens: encoded.audio_tokens,
        speakerEmbeddings: encoded.speaker_embeddings,
        speakerFeatures: encoded.speaker_features,
      };
    },

    async synthesize(text, conditioning, { maxNewTokens, sampling, shouldStop }) {
      const { input_ids: inputIds, attention_mask: attentionMask } = tokenizer(text) as {
        input_ids: Tensor;
        attention_mask: Tensor;
      };
      const promptLength = inputIds.dims[1];
      if (sampling.seed === undefined) random.seed();
      else random.seed(sampling.seed);

      const processors = new LogitsProcessorList();
      processors.push(new ChatterboxLogitsProcessor(promptLength, sampling));
      const stoppers = new StoppingCriteriaList();
      if (shouldStop) stoppers.push(new ChatterboxAbortCriteria(shouldStop));
      const output = await baseGenerate.call(model, {
        input_ids: inputIds,
        attention_mask: attentionMask,
        audio_features: conditioning.audioFeatures,
        audio_tokens: conditioning.audioTokens,
        speaker_embeddings: conditioning.speakerEmbeddings,
        speaker_features: conditioning.speakerFeatures,
        max_new_tokens: Math.round(clamp(maxNewTokens, 1, CHATTERBOX_MAX_NEW_TOKENS)),
        do_sample: sampling.temperature > 0,
        // The custom processor owns temperature, top-k/p and the penalty.
        temperature: 1,
        top_k: 0,
        repetition_penalty: 1,
        logits_processor: processors,
        stopping_criteria: stoppers,
        return_dict_in_generate: true,
      });

      let generated: BigInt64Array;
      try {
        generated = (output.sequences.data as BigInt64Array).slice(promptLength);
      } finally {
        await output.past_key_values?.dispose?.();
      }

      if (shouldStop?.()) return { audio: new Float32Array(0), reachedStop: false, speechTokens: 0 };

      const speechTokens = assembleChatterboxSpeechTokens(conditioning.audioTokens.data as BigInt64Array, generated);
      const decoded = await model.sessions.conditional_decoder.run({
        speech_tokens: new Tensor("int64", speechTokens, [1, speechTokens.length]).ort_tensor,
        speaker_embeddings: conditioning.speakerEmbeddings.ort_tensor,
        speaker_features: conditioning.speakerFeatures.ort_tensor,
      });
      return {
        audio: toStandaloneFloat32(new Tensor(decoded.waveform)),
        reachedStop: generated.includes(BigInt(CHATTERBOX_STOP_SPEECH_TOKEN)),
        speechTokens: speechTokens.length - conditioning.audioTokens.dims[1] - TRAILING_SILENCE_TOKENS,
      };
    },

    async dispose() {
      await model.dispose();
    },
  };
}

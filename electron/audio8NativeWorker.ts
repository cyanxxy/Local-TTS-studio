/**
 * Audio8 native inference worker.
 *
 * Runs the pinned Audio8 TTS Preview INT4 graphs on `onnxruntime-node` inside a
 * worker thread: a slow autoregressive transformer emits one semantic token and
 * a hidden state per frame, a fast transformer expands that hidden state into
 * the remaining acoustic codebooks, and a codec decoder turns the finished code
 * matrix into 44.1 kHz PCM. Everything the model needs — asset table, pinned
 * revisions, voice catalogue — comes from `audio8Model.ts`; everything the
 * graphs need to be driven correctly — sequence lengths, head counts, token ids
 * — comes from the model's own `runtime_manifest.json`.
 *
 * Attribution: the inference procedure below (prompt layout, the two-stage
 * slow/fast sampling loop, the KV-cache update scheme, and the codec decode) is
 * adapted from Audio8's Apache-2.0 reference runtime, as credited in the README
 * model table. The Open TTS additions are the caching, integrity, cancellation
 * and worker-protocol layers around it.
 */

import path from "path";
import { parentPort, workerData } from "worker_threads";
import * as ort from "onnxruntime-node";
import { Audio8AssetCache } from "./audio8AssetCache";
import {
  AUDIO8_MAX_TEXT_CHARACTERS,
  AUDIO8_MODEL_ASSETS,
  AUDIO8_VOICE_ASSETS,
  isAudio8VoiceId,
  type Audio8Asset,
  type Audio8VoiceId,
} from "./audio8Model";
import type { Audio8NativeResult, Audio8WorkerResponse } from "./audio8NativeClient";
import { SerialTaskQueue, SharedTask, SharedTaskGroup, type SharedTaskContext } from "./audio8SharedTask";
import { selectAudio8InferenceThreads } from "./audio8Threading";

/**
 * onnxruntime-common selects its FP16 backing array lazily, the first time an
 * `ort.Tensor` is constructed. Node 24 introduced a native `Float16Array`, so
 * ORT 1.27 now selects that instead of the Uint16Array representation its Node
 * binding has historically used. The native addon accepts the new array type,
 * but node-addon-api 6 reports its byte length as zero. Every non-empty FP16
 * input consequently fails with e.g. `not enough space: expected 524288, got
 * 0`.
 *
 * Prime ORT's process-local type mapping while Float16Array is hidden. The map
 * then keeps using Uint16Array, whose bits are identical and which the native
 * binding handles correctly. Restore the global immediately so this worker
 * does not change JavaScript semantics for the tokenizer or any other code.
 */
export function initialiseAudio8OrtFloat16Compatibility(): void {
  const globalWithFloat16 = globalThis as typeof globalThis & { Float16Array?: unknown };
  if (typeof globalWithFloat16.Float16Array !== "function") return;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Float16Array");
  if (!descriptor?.configurable) {
    throw new Error("Audio8 cannot initialise ONNX Runtime FP16 compatibility.");
  }
  try {
    Object.defineProperty(globalThis, "Float16Array", { ...descriptor, value: undefined });
    const probe = new ort.Tensor("float16", new Uint16Array(1), [1]);
    probe.dispose();
  } finally {
    Object.defineProperty(globalThis, "Float16Array", descriptor);
  }
}

initialiseAudio8OrtFloat16Compatibility();

// ORT logs one info line per session and per optimisation pass otherwise, which
// ends up in the packaged app's stderr for every load.
ort.env.logLevel = "error";

const RUNTIME_MANIFEST_FILE = "runtime_manifest.json";
const TOKENIZER_FILE = "tokenizer/tokenizer.json";
const SLOW_GRAPH_FILE = "slow_ar_int4.onnx";
const FAST_GRAPH_FILE = "fast_ar_int4.onnx";
const CODEC_GRAPH_FILE = "codec_decoder_fp16.onnx";

/**
 * Load progress in percent. Downloads own the first stretch because they
 * dominate a cold start; the remainder marks off the three ONNX sessions, whose
 * durations are fixed enough that stepped values read better than a fake ramp.
 */
const ASSET_PROGRESS_SHARE = 90;
const PROGRESS_ASSETS_READY = 92;
const PROGRESS_SLOW_SESSION = 95;
const PROGRESS_FAST_SESSION = 97;
const PROGRESS_READY = 100;

/** Sampling settings from the reference runtime. */
const SAMPLER_SEED = 42;
const NUCLEUS_SAMPLING: SamplingOptions = { temperature: 0.3, topP: 0.9, topK: 50 };
const REPEAT_ESCAPE_SAMPLING: SamplingOptions = { temperature: 1, topP: 0.9, topK: 50 };

/** Semantic tokens seen this recently are re-rolled at a higher temperature. */
const RECENT_SEMANTIC_WINDOW = 10;

/** Token budget per request, before the remaining context window is applied. */
const MIN_GENERATED_TOKENS = 64;
const MAX_GENERATED_TOKENS = 512;
const TOKENS_PER_CHARACTER = 2.5;

/**
 * Voice profiles are published as a `(10, frames)` uint16 code matrix, one row
 * per codebook. The row count is a property of the file format rather than of
 * the loaded model, so it is not read from the runtime manifest.
 */
const VOICE_CODEBOOK_ROWS = 10;

/** Token steps between synthesis progress messages. */
const PROGRESS_TOKEN_INTERVAL = 16;

export interface SamplingOptions {
  temperature: number;
  topP: number;
  topK: number;
}

/**
 * The parent port, narrowed to what this worker uses so the request handling
 * can be driven from a test without a real worker thread.
 */
export interface Audio8WorkerPort {
  on(event: "message", listener: (value: unknown) => void): unknown;
  postMessage(value: Audio8WorkerResponse, transfer?: readonly ArrayBuffer[]): void;
}

export interface Audio8Voice {
  codes: Uint16Array;
  frames: number;
  referenceText: string;
}

/** The subset of `runtime_manifest.json` the runtime actually drives. */
export interface Audio8RuntimeManifest {
  sampleRate: number;
  slowLogitsSize: number;
  codebookSize: number;
  maxSeqLen: number;
  numLayers: number;
  numFastLayers: number;
  numCodebooks: number;
  localHeads: number;
  fastLocalHeads: number;
  headDim: number;
  fastHeadDim: number;
  fastDim: number;
  semanticBeginId: number;
  imEndId: number;
}

type Audio8Tokenizer = (
  text: string,
  options: { add_special_tokens: false; return_tensor: false },
) => { input_ids: number[] };

interface SlowStep {
  logits: Float64Array;
  hidden: ort.Tensor;
}

interface SynthesisOptions {
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

function loadCancelledError(): Error {
  return new Error("Audio8 model load cancelled.");
}

function synthesisCancelledError(): Error {
  return new Error("Audio8 synthesis cancelled.");
}

function throwIfSynthesisCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw synthesisCancelledError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelAsset(file: string): Audio8Asset {
  const asset = AUDIO8_MODEL_ASSETS.find((candidate) => candidate.file === file);
  if (!asset) throw new Error(`Audio8 asset table is missing ${file}.`);
  return asset;
}

function manifestNumber(values: Record<string, unknown>, key: string): number {
  const value = Number(values[key]);
  if (!Number.isFinite(value)) throw new Error(`Audio8 runtime manifest is missing "${key}".`);
  return value;
}

export function readRuntimeManifest(values: unknown): Audio8RuntimeManifest {
  if (!isRecord(values)) throw new Error("Audio8 runtime manifest is not an object.");
  return {
    sampleRate: manifestNumber(values, "sample_rate"),
    slowLogitsSize: manifestNumber(values, "slow_logits_size"),
    codebookSize: manifestNumber(values, "codebook_size"),
    maxSeqLen: manifestNumber(values, "max_seq_len"),
    numLayers: manifestNumber(values, "num_layers"),
    numFastLayers: manifestNumber(values, "num_fast_layers"),
    numCodebooks: manifestNumber(values, "num_codebooks"),
    localHeads: manifestNumber(values, "n_local_heads"),
    fastLocalHeads: manifestNumber(values, "fast_n_local_heads"),
    headDim: manifestNumber(values, "head_dim"),
    fastHeadDim: manifestNumber(values, "fast_head_dim"),
    fastDim: manifestNumber(values, "fast_dim"),
    semanticBeginId: manifestNumber(values, "semantic_begin_id"),
    imEndId: manifestNumber(values, "im_end_id"),
  };
}

/**
 * IEEE-754 half precision to a JS number. The graphs emit FP16 activations and
 * `onnxruntime-node` hands them back as raw `Uint16Array` bit patterns.
 */
export function decodeFloat16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  if (!exponent) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * The last `count` values of a tensor as doubles. Both graphs return a value
 * per prompt position, and only the newest position is ever sampled.
 */
export function readTrailingValues(tensor: ort.Tensor, count: number): Float64Array {
  const data = tensor.data as ArrayLike<number | bigint | string | boolean>;
  const start = data.length - count;
  const values = new Float64Array(count);
  const isHalf = tensor.data instanceof Uint16Array;
  for (let index = 0; index < count; index += 1) {
    const value = data[start + index];
    values[index] = isHalf ? decodeFloat16(value as number) : Number(value);
  }
  return values;
}

function trailingHiddenState(tensor: ort.Tensor, size: number): ort.Tensor {
  if (!(tensor.data instanceof Uint16Array)) throw new Error("Audio8 hidden state was not FP16.");
  return new ort.Tensor("float16", tensor.data.slice(-size), [1, 1, size]);
}

/**
 * mulberry32. Seeding the sampler makes a given text, voice and model revision
 * reproduce the same audio, which is what makes regressions in this file
 * detectable at all.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Top-k, then nucleus (top-p), then temperature, then an exponential race for
 * the winner: each surviving candidate draws `weight / -ln(u)` and the largest
 * draw wins, which is the Gumbel-max trick in multiplicative form. The race is
 * equivalent to sampling from the softmax, and keeps the whole step branch-free
 * of cumulative-sum edge cases.
 */
export function sampleTokenId(
  logits: Float64Array,
  { temperature, topP, topK }: SamplingOptions,
  random: () => number,
): number {
  const ranked = Array.from({ length: logits.length }, (_unused, index) => index)
    .sort((left, right) => logits[right] - logits[left])
    .slice(0, topK);
  const highest = logits[ranked[0]];
  const unscaled = ranked.map((index) => Math.exp(logits[index] - highest));
  const unscaledTotal = unscaled.reduce((total, weight) => total + weight, 0);

  // The candidate that crosses `topP` is kept, so the nucleus is never empty.
  const nucleus: number[] = [];
  let cumulative = 0;
  for (let rank = 0; rank < ranked.length; rank += 1) {
    if (rank && cumulative > topP) break;
    nucleus.push(ranked[rank]);
    cumulative += unscaled[rank] / unscaledTotal;
  }

  const scaledHighest = Math.max(...nucleus.map((index) => logits[index] / temperature));
  const weights = nucleus.map((index) => Math.exp(logits[index] / temperature - scaledHighest));
  const weightTotal = weights.reduce((total, weight) => total + weight, 0);

  let winner = nucleus[0];
  let bestScore = -Infinity;
  for (let candidate = 0; candidate < nucleus.length; candidate += 1) {
    const score = weights[candidate] / weightTotal / -Math.log(Math.max(1e-12, random()));
    if (score > bestScore) {
      bestScore = score;
      winner = nucleus[candidate];
    }
  }
  return winner;
}

/**
 * Collapses every whitespace run to a single space and drops control and
 * format characters, which the tokenizer would otherwise turn into stray
 * tokens the model has never seen next to speech.
 */
export function normaliseSpeechText(text: string): string {
  const normalised = Array.from(text, (character) => {
    if (/\s/u.test(character)) return " ";
    return /\p{C}/u.test(character) ? "" : character;
  }).join("").replace(/\s+/g, " ").trim();
  if (!normalised) throw new Error("Audio8 text is empty.");
  return normalised;
}

/** Reads the `(10, frames)` uint16 `.npy` matrix of a voice profile. */
export function parseVoiceCodes(data: Uint8Array): { codes: Uint16Array; frames: number } {
  if (String.fromCharCode(...data.slice(1, 6)) !== "NUMPY") {
    throw new Error("Invalid Audio8 voice profile.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Format v1 stores a uint16 header length, v2 and later a uint32.
  const isVersion1 = data[6] === 1;
  const headerStart = isVersion1 ? 10 : 12;
  const headerLength = isVersion1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const codesStart = headerStart + headerLength;
  const header = new TextDecoder().decode(data.slice(headerStart, codesStart));
  const shape = header.match(/shape['"]?\s*:\s*\(\s*10\s*,\s*(\d+)/);
  if (!shape) throw new Error("Invalid Audio8 voice shape.");

  const frames = Number(shape[1]);
  const codes = new Uint16Array(VOICE_CODEBOOK_ROWS * frames);
  for (let index = 0; index < codes.length; index += 1) {
    codes[index] = view.getUint16(codesStart + index * 2, true);
  }
  return { codes, frames };
}

async function createTokenizer(tokenizerJson: unknown): Promise<Audio8Tokenizer> {
  // `@huggingface/transformers` is ESM-only. The indirection stops TypeScript
  // from rewriting the dynamic import into a `require` this CommonJS build
  // cannot satisfy.
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<typeof import("@huggingface/transformers", { with: { "resolution-mode": "import" } })>;
  const { PreTrainedTokenizer } = await dynamicImport("@huggingface/transformers");
  return new PreTrainedTokenizer(
    tokenizerJson as ConstructorParameters<typeof PreTrainedTokenizer>[0],
    {},
  ) as unknown as Audio8Tokenizer;
}

export class Audio8Runtime {
  readonly #manifest: Audio8RuntimeManifest;
  readonly #tokenizer: Audio8Tokenizer;
  readonly #slow: ort.InferenceSession;
  readonly #fast: ort.InferenceSession;
  readonly #decoder: ort.InferenceSession;

  constructor(
    manifest: Audio8RuntimeManifest,
    tokenizer: Audio8Tokenizer,
    slow: ort.InferenceSession,
    fast: ort.InferenceSession,
    decoder: ort.InferenceSession,
  ) {
    this.#manifest = manifest;
    this.#tokenizer = tokenizer;
    this.#slow = slow;
    this.#fast = fast;
    this.#decoder = decoder;
  }

  get sampleRate(): number {
    return this.#manifest.sampleRate;
  }

  async synthesize(
    text: string,
    voice: Audio8Voice,
    { signal, onProgress }: SynthesisOptions = {},
  ): Promise<Float32Array> {
    const manifest = this.#manifest;
    const prompt = this.#buildPrompt(text, voice);
    const promptLength = prompt.dims[2];
    const maxTokens = Math.min(
      MAX_GENERATED_TOKENS,
      Math.max(MIN_GENERATED_TOKENS, [...text].length * TOKENS_PER_CHARACTER),
      manifest.maxSeqLen - promptLength,
    );
    const caches = this.#createCaches(
      manifest.numLayers,
      manifest.localHeads,
      manifest.maxSeqLen,
      manifest.headDim,
    );
    const random = createSeededRandom(SAMPLER_SEED);
    const frames: number[][] = [];
    let step: SlowStep | null = null;
    let recentSemantics: number[] = [];

    try {
      throwIfSynthesisCancelled(signal);
      step = await this.#slowStep(
        prompt,
        Array.from({ length: promptLength }, (_unused, i) => i),
        caches,
        signal,
      );
      for (let token = 0; token < maxTokens; token += 1) {
        throwIfSynthesisCancelled(signal);
        const semantic = this.#chooseSemanticToken(step.logits, recentSemantics, random);
        if (semantic === manifest.imEndId) break;
        recentSemantics = [...recentSemantics, semantic].slice(-RECENT_SEMANTIC_WINDOW);
        frames.push(await this.#expandFrame(semantic, step.hidden, random, signal));
        if (token % PROGRESS_TOKEN_INTERVAL === 0) onProgress?.((token / maxTokens) * 100);

        // The final frame needs no follow-up state, and the slow step is the
        // expensive half of the loop.
        if (token + 1 >= maxTokens) break;
        const column = this.#nextInputColumn(semantic, frames[frames.length - 1]);
        try {
          const next = await this.#slowStep(column, [promptLength + token], caches, signal);
          step.hidden.dispose();
          step = next;
        } finally {
          column.dispose();
        }
      }
      if (frames.length === 0) throw new Error("Audio8 produced no audio frames.");
      throwIfSynthesisCancelled(signal);
      return await this.#decodeFrames(frames, signal);
    } finally {
      prompt.dispose();
      step?.hidden.dispose();
      for (const cache of caches) cache.dispose();
    }
  }

  /**
   * One semantic token per frame. A token the model has just produced is
   * re-rolled once at a higher temperature, which is what stops the loop
   * settling into a repeated syllable.
   */
  #chooseSemanticToken(logits: Float64Array, recent: number[], random: () => number): number {
    const manifest = this.#manifest;
    // Both draws are always taken so the seeded stream stays aligned with the
    // reference runtime whether or not the retry is used.
    const first = sampleTokenId(logits, NUCLEUS_SAMPLING, random);
    const retry = sampleTokenId(logits, REPEAT_ESCAPE_SAMPLING, random);
    const toSemantic = (index: number) => (
      index < manifest.codebookSize ? manifest.semanticBeginId + index : manifest.imEndId
    );
    const chosen = toSemantic(first);
    if (chosen !== manifest.imEndId && recent.includes(chosen)) return toSemantic(retry);
    return chosen;
  }

  /**
   * Expands one semantic token into a full acoustic frame: the fast graph is
   * primed with the slow hidden state, then walks the remaining codebooks.
   */
  async #expandFrame(
    semantic: number,
    hidden: ort.Tensor,
    random: () => number,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const manifest = this.#manifest;
    const fastCaches = this.#createCaches(
      manifest.numFastLayers,
      manifest.fastLocalHeads,
      manifest.numCodebooks,
      manifest.fastHeadDim,
    );
    try {
      throwIfSynthesisCancelled(signal);
      await this.#fastStep(hidden, 0, true, 0, fastCaches, signal);
      let code = Math.max(0, Math.min(manifest.codebookSize - 1, semantic - manifest.semanticBeginId));
      const frame = [code];
      for (let book = 1; book < manifest.numCodebooks; book += 1) {
        throwIfSynthesisCancelled(signal);
        const logits = await this.#fastStep(hidden, code, false, book, fastCaches, signal);
        code = sampleTokenId(logits, NUCLEUS_SAMPLING, random);
        frame.push(code);
      }
      return frame;
    } finally {
      for (const cache of fastCaches) cache.dispose();
    }
  }

  /** The generated frame, fed back as the next single-position slow input. */
  #nextInputColumn(semantic: number, frame: number[]): ort.Tensor {
    const values = BigInt64Array.from([semantic, ...frame], BigInt);
    return new ort.Tensor("int64", values, [1, this.#manifest.numCodebooks + 1, 1]);
  }

  async #decodeFrames(frames: number[][], signal?: AbortSignal): Promise<Float32Array> {
    const books = this.#manifest.numCodebooks;
    const codes = new BigInt64Array(books * frames.length);
    for (let book = 0; book < books; book += 1) {
      for (let frame = 0; frame < frames.length; frame += 1) {
        codes[book * frames.length + frame] = BigInt(frames[frame][book]);
      }
    }
    const input = new ort.Tensor("int64", codes, [1, books, frames.length]);
    try {
      throwIfSynthesisCancelled(signal);
      const outputs = await this.#decoder.run({ codes: input });
      try {
        throwIfSynthesisCancelled(signal);
        const audio = outputs[this.#decoder.outputNames[0]].data;
        return audio instanceof Float32Array
          ? Float32Array.from(audio)
          : Float32Array.from(audio as Uint16Array, decodeFloat16);
      } finally {
        for (const output of Object.values(outputs)) output.dispose();
      }
    } finally {
      input.dispose();
    }
  }

  /**
   * The prompt is a `(codebooks + 1, length)` matrix: row 0 carries text tokens
   * and the voice's semantic codes, the remaining rows carry that voice's
   * acoustic codes under the same positions.
   */
  #buildPrompt(text: string, voice: Audio8Voice): ort.Tensor {
    const manifest = this.#manifest;
    const encode = (part: string) => this.#tokenizer(part, {
      add_special_tokens: false,
      return_tensor: false,
    }).input_ids.map(Number);

    // Profiles published before the speaker tag existed are addressed to
    // speaker 0, matching how they were registered.
    const reference = /<\|speaker:\d+\|>/.test(voice.referenceText)
      ? normaliseSpeechText(voice.referenceText)
      : `<|speaker:0|>${normaliseSpeechText(voice.referenceText)}`;
    const prefix = [
      "<|im_start|>system\n",
      "convert the provided text to speech reference to the following:\n\nText:\n",
      reference,
      "\n\nSpeech:\n",
    ].flatMap(encode);
    const suffix = [
      "<|im_end|>\n",
      "<|im_start|>user\n",
      normaliseSpeechText(text),
      "<|im_end|>\n",
      "<|im_start|>assistant\n<|voice|>",
    ].flatMap(encode);

    const rows = manifest.numCodebooks + 1;
    const length = prefix.length + voice.frames + suffix.length;
    const values = new BigInt64Array(rows * length);
    prefix.forEach((token, index) => {
      values[index] = BigInt(token);
    });
    for (let frame = 0; frame < voice.frames; frame += 1) {
      values[prefix.length + frame] = BigInt(voice.codes[frame] + manifest.semanticBeginId);
    }
    suffix.forEach((token, index) => {
      values[prefix.length + voice.frames + index] = BigInt(token);
    });
    for (let book = 0; book < manifest.numCodebooks; book += 1) {
      for (let frame = 0; frame < voice.frames; frame += 1) {
        values[(book + 1) * length + prefix.length + frame] = BigInt(voice.codes[book * voice.frames + frame]);
      }
    }
    return new ort.Tensor("int64", values, [1, rows, length]);
  }

  /** A zeroed key/value pair per layer, sized for the whole context window. */
  #createCaches(layers: number, heads: number, length: number, dim: number): ort.Tensor[] {
    return Array.from({ length: layers * 2 }, () => new ort.Tensor(
      "float16",
      new Uint16Array(heads * length * dim),
      [1, heads, length, dim],
    ));
  }

  /**
   * Both graphs return the key/value slices for the positions they just
   * attended to; the caches are updated in place because they are re-fed to the
   * next step and ORT cannot alias an output onto an input.
   */
  #updateCaches(
    caches: ort.Tensor[],
    positions: number[],
    deltas: ort.Tensor[],
    heads: number,
    length: number,
    dim: number,
  ): void {
    deltas.forEach((delta, cacheIndex) => {
      const destination = caches[cacheIndex].data as Uint16Array;
      const source = delta.data as Uint16Array;
      for (let head = 0; head < heads; head += 1) {
        for (let slot = 0; slot < positions.length; slot += 1) {
          const from = (head * positions.length + slot) * dim;
          destination.set(source.subarray(from, from + dim), (head * length + positions[slot]) * dim);
        }
      }
    });
  }

  async #slowStep(
    codes: ort.Tensor,
    positions: number[],
    caches: ort.Tensor[],
    signal?: AbortSignal,
  ): Promise<SlowStep> {
    const manifest = this.#manifest;
    const inputPos = new ort.Tensor("int64", BigInt64Array.from(positions, BigInt), [positions.length]);
    const feeds: Record<string, ort.Tensor> = { codes, input_pos: inputPos };
    for (let layer = 0; layer < manifest.numLayers; layer += 1) {
      feeds[`cache_key_${layer}`] = caches[layer * 2];
      feeds[`cache_value_${layer}`] = caches[layer * 2 + 1];
    }
    throwIfSynthesisCancelled(signal);
    const outputs = await this.#slow.run(feeds);
    try {
      throwIfSynthesisCancelled(signal);
      // Outputs are logits, hidden state, then the key/value deltas in layer
      // order; `outputNames` is the only ordering ORT guarantees.
      const ordered = this.#slow.outputNames.map((name) => outputs[name]);
      this.#updateCaches(
        caches,
        positions,
        ordered.slice(2),
        manifest.localHeads,
        manifest.maxSeqLen,
        manifest.headDim,
      );
      return {
        logits: readTrailingValues(ordered[0], manifest.slowLogitsSize),
        hidden: trailingHiddenState(ordered[1], manifest.fastDim),
      };
    } finally {
      for (const output of Object.values(outputs)) output.dispose();
      // `codes` and the caches belong to the caller and outlive this step.
      inputPos.dispose();
    }
  }

  async #fastStep(
    hidden: ort.Tensor,
    code: number,
    useHidden: boolean,
    position: number,
    caches: ort.Tensor[],
    signal?: AbortSignal,
  ): Promise<Float64Array> {
    const manifest = this.#manifest;
    const tokenId = new ort.Tensor("int64", BigInt64Array.from([BigInt(code)]), [1, 1]);
    const useSlowHidden = new ort.Tensor("bool", Uint8Array.from([useHidden ? 1 : 0]), [1]);
    const inputPos = new ort.Tensor("int64", BigInt64Array.from([BigInt(position)]), [1]);
    const feeds: Record<string, ort.Tensor> = {
      slow_hidden: hidden,
      token_id: tokenId,
      use_slow_hidden: useSlowHidden,
      input_pos: inputPos,
    };
    for (let layer = 0; layer < manifest.numFastLayers; layer += 1) {
      feeds[`cache_key_${layer}`] = caches[layer * 2];
      feeds[`cache_value_${layer}`] = caches[layer * 2 + 1];
    }
    throwIfSynthesisCancelled(signal);
    const outputs = await this.#fast.run(feeds);
    try {
      throwIfSynthesisCancelled(signal);
      const ordered = this.#fast.outputNames.map((name) => outputs[name]);
      this.#updateCaches(
        caches,
        [position],
        ordered.slice(1),
        manifest.fastLocalHeads,
        manifest.numCodebooks,
        manifest.fastHeadDim,
      );
      return readTrailingValues(ordered[0], manifest.codebookSize);
    } finally {
      for (const output of Object.values(outputs)) output.dispose();
      // `slow_hidden` and the caches belong to the caller.
      tokenId.dispose();
      useSlowHidden.dispose();
      inputPos.dispose();
    }
  }
}

export async function createAudio8Runtime(
  assets: Audio8AssetCache,
  { signal, report }: SharedTaskContext<number>,
): Promise<Audio8Runtime> {
  const throwIfCancelled = () => {
    if (signal.aborted) throw loadCancelledError();
  };
  await assets.ensure(
    AUDIO8_MODEL_ASSETS,
    ({ receivedBytes, totalBytes }) => report((receivedBytes / totalBytes) * ASSET_PROGRESS_SHARE),
    signal,
  );
  report(PROGRESS_ASSETS_READY);

  const manifest = readRuntimeManifest(
    JSON.parse((await assets.readFile(modelAsset(RUNTIME_MANIFEST_FILE))).toString("utf8")),
  );
  const tokenizerJson: unknown = JSON.parse(
    (await assets.readFile(modelAsset(TOKENIZER_FILE))).toString("utf8"),
  );
  const tokenizer = await createTokenizer(tokenizerJson);
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: selectAudio8InferenceThreads(),
    interOpNumThreads: 2,
  };

  // Each session maps hundreds of MiB of weights. A load that fails or is
  // cancelled part way through must not strand the ones already built.
  const sessions: ort.InferenceSession[] = [];
  try {
    throwIfCancelled();
    const slow = await ort.InferenceSession.create(assets.filePath(modelAsset(SLOW_GRAPH_FILE)), options);
    sessions.push(slow);
    report(PROGRESS_SLOW_SESSION);

    throwIfCancelled();
    const fast = await ort.InferenceSession.create(assets.filePath(modelAsset(FAST_GRAPH_FILE)), options);
    sessions.push(fast);
    report(PROGRESS_FAST_SESSION);

    throwIfCancelled();
    const decoder = await ort.InferenceSession.create(assets.filePath(modelAsset(CODEC_GRAPH_FILE)), options);
    sessions.push(decoder);
    report(PROGRESS_READY);
    return new Audio8Runtime(manifest, tokenizer, slow, fast, decoder);
  } catch (error) {
    for (const session of sessions) await session.release().catch(() => undefined);
    throw error;
  }
}

export async function readVoiceProfile(
  assets: Audio8AssetCache,
  voiceId: Audio8VoiceId,
  signal?: AbortSignal,
): Promise<Audio8Voice> {
  const profile = AUDIO8_VOICE_ASSETS[voiceId];
  await assets.ensure([profile.codes, profile.meta], undefined, signal);
  const { codes, frames } = parseVoiceCodes(await assets.readFile(profile.codes));
  const meta: unknown = JSON.parse((await assets.readFile(profile.meta)).toString("utf8"));
  if (!isRecord(meta) || typeof meta.reference_text !== "string") {
    throw new Error(`Audio8 voice profile ${voiceId} has no reference text.`);
  }
  return { codes, frames, referenceText: meta.reference_text };
}

function assertSynthesisText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Audio8 synthesis text is empty.");
  }
  if ([...value].length > AUDIO8_MAX_TEXT_CHARACTERS) {
    throw new Error(`Audio8 synthesis text exceeds ${AUDIO8_MAX_TEXT_CHARACTERS} characters.`);
  }
  return value;
}

/**
 * The IPC boundary in `main.ts` already rejects unknown voices with this
 * wording. Substituting a default here instead would contradict that contract
 * and hand the user audio in a voice they did not ask for.
 */
function assertVoiceId(value: unknown): Audio8VoiceId {
  if (!isAudio8VoiceId(value)) throw new Error("Unsupported Audio8 voice.");
  return value;
}

export function startAudio8Worker(port: Audio8WorkerPort, modelDir: string): void {
  const assets = new Audio8AssetCache(modelDir);
  // One load, however many windows and StrictMode double-effects ask for it.
  const loading = new SharedTask<Audio8Runtime, number>(loadCancelledError);
  const voices = new Map<Audio8VoiceId, Audio8Voice>();
  const voiceLoads = new SharedTaskGroup<Audio8Voice>(synthesisCancelledError);
  const inFlight = new Map<string, AbortController>();
  let runtime: Audio8Runtime | null = null;
  const generationQueue = new SerialTaskQueue();

  const post = (message: Audio8WorkerResponse, transfer: ArrayBuffer[] = []): void => {
    port.postMessage(message, transfer);
  };

  const load = (requestId: string, signal: AbortSignal): Promise<Audio8Runtime> => {
    if (runtime) return Promise.resolve(runtime);
    return loading.run(async (context) => {
      const loaded = await createAudio8Runtime(assets, context);
      runtime = loaded;
      return loaded;
    }, {
      onProgress: (percent) => post({ type: "progress", requestId, percent }),
      signal,
    });
  };

  // Voice profiles are a few kilobytes of `.npy` that never change, and the
  // renderer sends one request per 180 characters of text.
  const loadVoice = (voiceId: Audio8VoiceId, signal: AbortSignal): Promise<Audio8Voice> => {
    const cached = voices.get(voiceId);
    if (cached) return Promise.resolve(cached);
    return voiceLoads.run(voiceId, async ({ signal: sharedSignal }) => {
      const loaded = await readVoiceProfile(assets, voiceId, sharedSignal);
      voices.set(voiceId, loaded);
      return loaded;
    }, { signal });
  };

  const generate = async (
    requestId: string,
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Audio8NativeResult> => {
    const text = assertSynthesisText(request.text);
    const voiceId = assertVoiceId(request.voice);
    const loaded = await load(requestId, signal);
    const voice = await loadVoice(voiceId, signal);
    const startedAt = performance.now();
    const audio = await loaded.synthesize(text, voice, {
      signal,
      onProgress: (percent) => post({ type: "progress", requestId, percent }),
    });
    return {
      sampleRate: loaded.sampleRate,
      elapsedSec: (performance.now() - startedAt) / 1000,
      audio: audio.buffer as ArrayBuffer,
    };
  };

  const scheduleGenerate = (
    requestId: string,
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Audio8NativeResult> => {
    return generationQueue.run(() => {
      throwIfSynthesisCancelled(signal);
      return generate(requestId, request, signal);
    });
  };

  port.on("message", (value: unknown) => {
    if (!isRecord(value) || typeof value.requestId !== "string") return;
    const requestId = value.requestId;
    if (value.type === "cancel") {
      // Unknown ids are dropped rather than remembered: a cancel that lands
      // after its request finished used to sit in a set that only ever grew.
      inFlight.get(requestId)?.abort();
      return;
    }
    const controller = new AbortController();
    inFlight.set(requestId, controller);
    void (async () => {
      try {
        if (value.type === "load") {
          const loaded = await load(requestId, controller.signal);
          post({ type: "result", requestId, result: { ready: true, sampleRate: loaded.sampleRate } });
          return;
        }
        if (value.type !== "generate") throw new Error(`Unsupported Audio8 request "${String(value.type)}".`);
        const result = await scheduleGenerate(requestId, value, controller.signal);
        post({ type: "result", requestId, result }, result.audio ? [result.audio] : []);
      } catch (error) {
        post({
          type: "error",
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inFlight.delete(requestId);
      }
    })();
  });
}

// Absent when the module is imported directly, which is how the pure helpers
// above are unit tested.
if (parentPort && isRecord(workerData) && typeof workerData.modelDir === "string") {
  startAudio8Worker(parentPort, path.resolve(workerData.modelDir));
}

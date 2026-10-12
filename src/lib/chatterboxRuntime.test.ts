import { beforeEach, describe, expect, it, vi } from "vitest";

const transformers = vi.hoisted(() => {
  class MockTensor {
    type: string;
    data: ArrayLike<number | bigint>;
    dims: number[];
    ort_tensor: unknown;
    constructor(typeOrOrt: string | { type: string; data: ArrayLike<number | bigint>; dims: number[] }, data?: ArrayLike<number | bigint>, dims?: number[]) {
      if (typeof typeOrOrt === "string") {
        this.type = typeOrOrt;
        this.data = data!;
        this.dims = dims!;
      } else {
        this.type = typeOrOrt.type;
        this.data = typeOrOrt.data;
        this.dims = typeOrOrt.dims;
      }
      this.ort_tensor = { wrapped: this };
    }
    to(type: string) {
      return new MockTensor(type, Float32Array.from(this.data as ArrayLike<number>), this.dims);
    }
  }
  class MockLogitsProcessor {}
  class MockLogitsProcessorList {
    items: unknown[] = [];
    push(item: unknown) {
      this.items.push(item);
    }
  }
  class MockStoppingCriteria {}
  class MockStoppingCriteriaList {
    items: unknown[] = [];
    push(item: unknown) {
      this.items.push(item);
    }
  }
  const state = {
    generateCalls: [] as Array<Record<string, unknown>>,
    generated: [] as bigint[],
    pastKeyValuesDispose: vi.fn(),
    decoderRun: vi.fn(),
    modelDispose: vi.fn(),
    encodeSpeech: vi.fn(),
    seed: vi.fn(),
    tokenizerInputIds: [10n, 11n, 12n],
    pastKeyValues: true,
  };
  class MockPreTrained {
    async generate(params: Record<string, unknown>) {
      state.generateCalls.push(params);
      return {
        sequences: new MockTensor("int64", BigInt64Array.from([...state.tokenizerInputIds, ...state.generated]), [1, state.tokenizerInputIds.length + state.generated.length]),
        past_key_values: state.pastKeyValues ? { dispose: state.pastKeyValuesDispose } : undefined,
      };
    }
  }
  class MockChatterboxModel extends MockPreTrained {
    static from_pretrained = vi.fn(async () => new MockChatterboxModel());
    sessions = { conditional_decoder: { run: state.decoderRun } };
    encode_speech = state.encodeSpeech;
    dispose = state.modelDispose;
  }
  const tokenizer = vi.fn(() => ({
    input_ids: new MockTensor("int64", BigInt64Array.from(state.tokenizerInputIds), [1, state.tokenizerInputIds.length]),
    attention_mask: new MockTensor("int64", BigInt64Array.from(state.tokenizerInputIds.map(() => 1n)), [1, state.tokenizerInputIds.length]),
  }));
  return {
    state,
    tokenizer,
    exports: {
      AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizer) },
      ChatterboxModel: MockChatterboxModel,
      LogitsProcessor: MockLogitsProcessor,
      LogitsProcessorList: MockLogitsProcessorList,
      StoppingCriteria: MockStoppingCriteria,
      StoppingCriteriaList: MockStoppingCriteriaList,
      Tensor: MockTensor,
      random: { seed: state.seed },
    },
  };
});

vi.mock("@huggingface/transformers", () => transformers.exports);

import {
  CHATTERBOX_DEFAULT_SAMPLING,
  CHATTERBOX_DTYPE,
  CHATTERBOX_MAX_NEW_TOKENS,
  CHATTERBOX_SILENCE_TOKEN,
  CHATTERBOX_START_SPEECH_TOKEN,
  CHATTERBOX_STOP_SPEECH_TOKEN,
  assembleChatterboxSpeechTokens,
  getChatterboxTokenBudget,
  loadChatterboxRuntime,
  normalizeChatterboxSampling,
  processChatterboxLogits,
  type ChatterboxConditioning,
} from "./chatterboxRuntime";
import { CHATTERBOX_MODEL_ID, CHATTERBOX_MODEL_REVISION } from "./chatterboxModel";

const { state } = transformers;

describe("normalizeChatterboxSampling", () => {
  it("falls back to the upstream Turbo defaults", () => {
    expect(normalizeChatterboxSampling()).toEqual(CHATTERBOX_DEFAULT_SAMPLING);
    expect(normalizeChatterboxSampling({ temperature: Number.NaN, topK: undefined })).toEqual(CHATTERBOX_DEFAULT_SAMPLING);
  });

  it("clamps every control into its valid range", () => {
    expect(normalizeChatterboxSampling({ temperature: 9, topK: 99_999, topP: 0, repetitionPenalty: 0.1 })).toEqual({
      temperature: 2,
      topK: CHATTERBOX_STOP_SPEECH_TOKEN + 1,
      topP: 0.01,
      repetitionPenalty: 1,
    });
    expect(normalizeChatterboxSampling({ temperature: -1, topK: -5, topP: 5, repetitionPenalty: 9 })).toEqual({
      temperature: 0,
      topK: 0,
      topP: 1,
      repetitionPenalty: 2,
    });
  });

  it("keeps a finite seed as an unsigned 32-bit integer and omits the rest", () => {
    expect(normalizeChatterboxSampling({ seed: 7.9 }).seed).toBe(7);
    expect(normalizeChatterboxSampling({ seed: -3 }).seed).toBe(3);
    expect(normalizeChatterboxSampling({ seed: 2 ** 32 + 5 }).seed).toBe(5);
    expect(normalizeChatterboxSampling({ seed: Number.POSITIVE_INFINITY })).not.toHaveProperty("seed");
  });
});

describe("getChatterboxTokenBudget", () => {
  it("scales with spoken characters and tags and stays within bounds", () => {
    expect(getChatterboxTokenBudget(0, 0)).toBe(75);
    expect(getChatterboxTokenBudget(40, 0)).toBe(120);
    expect(getChatterboxTokenBudget(40, 2)).toBe(220);
    expect(getChatterboxTokenBudget(10_000, 0)).toBe(CHATTERBOX_MAX_NEW_TOKENS);
    expect(getChatterboxTokenBudget(-5, -5)).toBe(75);
  });
});

describe("processChatterboxLogits", () => {
  const vocabulary = (values: number[]) => Float32Array.from(values);

  it("leaves greedy scores alone apart from the repetition penalty", () => {
    const scores = vocabulary([2, -2, 1, 0]);
    processChatterboxLogits(scores, [0, 1], { temperature: 0, topK: 1, topP: 0.01, repetitionPenalty: 2 });
    expect(Array.from(scores)).toEqual([1, -4, 1, 0]);
  });

  it("divides by temperature and filters with top-k", () => {
    const scores = vocabulary([4, 3, 2, 1]);
    processChatterboxLogits(scores, [], { temperature: 2, topK: 2, topP: 1, repetitionPenalty: 1 });
    expect(Array.from(scores)).toEqual([2, 1.5, -Infinity, -Infinity]);
  });

  it("keeps the smallest nucleus that reaches top-p", () => {
    const scores = vocabulary([10, 9.9, 0, 0]);
    processChatterboxLogits(scores, [], { temperature: 1, topK: 0, topP: 0.5, repetitionPenalty: 1 });
    expect(scores[0]).toBe(10);
    expect(scores[1]).toBe(-Infinity);
    expect(scores[2]).toBe(-Infinity);
  });

  it("ignores a degenerate all-masked row and out-of-range history", () => {
    const scores = vocabulary([-Infinity, -Infinity]);
    processChatterboxLogits(scores, [-1, 5], { temperature: 1, topK: 0, topP: 0.5, repetitionPenalty: 1.5 });
    expect(Array.from(scores)).toEqual([-Infinity, -Infinity]);
  });

  it("penalizes each repeated token once", () => {
    const scores = vocabulary([3, 3]);
    processChatterboxLogits(scores, [0, 0, 0], { temperature: 0, topK: 0, topP: 1, repetitionPenalty: 1.5 });
    expect(Array.from(scores)).toEqual([2, 3]);
  });
});

describe("assembleChatterboxSpeechTokens", () => {
  it("joins prompt tokens, speech tokens and trailing silence, dropping control tokens", () => {
    const tokens = assembleChatterboxSpeechTokens(
      BigInt64Array.from([1n, 2n]),
      BigInt64Array.from([5n, BigInt(CHATTERBOX_START_SPEECH_TOKEN), 6n, BigInt(CHATTERBOX_STOP_SPEECH_TOKEN)]),
    );
    const silence = BigInt(CHATTERBOX_SILENCE_TOKEN);
    expect(Array.from(tokens)).toEqual([1n, 2n, 5n, 6n, silence, silence, silence]);
  });
});

describe("loadChatterboxRuntime", () => {
  const conditioning = (): ChatterboxConditioning => ({
    audioFeatures: new transformers.exports.Tensor("float32", new Float32Array(4), [1, 2, 2]) as never,
    audioTokens: new transformers.exports.Tensor("int64", BigInt64Array.from([100n, 101n]), [1, 2]) as never,
    speakerEmbeddings: new transformers.exports.Tensor("float32", new Float32Array(2), [1, 2]) as never,
    speakerFeatures: new transformers.exports.Tensor("float32", new Float32Array(2), [1, 1, 2]) as never,
  });

  beforeEach(() => {
    state.generateCalls.length = 0;
    state.generated = [7n, 8n, BigInt(CHATTERBOX_STOP_SPEECH_TOKEN)];
    state.pastKeyValues = true;
    state.pastKeyValuesDispose.mockClear();
    state.modelDispose.mockClear();
    state.seed.mockClear();
    state.decoderRun.mockReset();
    state.decoderRun.mockResolvedValue({ waveform: { type: "float32", data: Float32Array.from([0.1, -0.2, 0.3]), dims: [1, 3] } });
    state.encodeSpeech.mockReset();
    transformers.exports.ChatterboxModel.from_pretrained.mockClear();
    transformers.exports.AutoTokenizer.from_pretrained.mockClear();
  });

  it("loads the pinned revision on the requested device with the dtype plan", async () => {
    const runtime = await loadChatterboxRuntime({ backend: "webgpu", dtype: CHATTERBOX_DTYPE });
    expect(transformers.exports.AutoTokenizer.from_pretrained).toHaveBeenCalledWith(CHATTERBOX_MODEL_ID, { revision: CHATTERBOX_MODEL_REVISION });
    expect(transformers.exports.ChatterboxModel.from_pretrained).toHaveBeenCalledWith(CHATTERBOX_MODEL_ID, {
      revision: CHATTERBOX_MODEL_REVISION,
      device: "webgpu",
      dtype: CHATTERBOX_DTYPE,
    });
    expect(runtime).toMatchObject({ backend: "webgpu", sampleRate: 24_000 });
  });

  it("encodes a reference clip into the four conditioning tensors", async () => {
    const encoded = {
      audio_features: "features",
      audio_tokens: "tokens",
      speaker_embeddings: "embeddings",
      speaker_features: "speaker features",
    };
    state.encodeSpeech.mockResolvedValue(encoded);
    const runtime = await loadChatterboxRuntime({ backend: "webgpu", dtype: CHATTERBOX_DTYPE });
    await expect(runtime.encodeReference(new Float32Array(6))).resolves.toEqual({
      audioFeatures: "features",
      audioTokens: "tokens",
      speakerEmbeddings: "embeddings",
      speakerFeatures: "speaker features",
    });
    expect(state.encodeSpeech.mock.calls[0][0].dims).toEqual([1, 6]);
  });

  it("generates speech tokens, decodes them and reports the stop token", async () => {
    const runtime = await loadChatterboxRuntime({ backend: "webgpu", dtype: CHATTERBOX_DTYPE });
    const sampling = normalizeChatterboxSampling({ seed: 42 });
    const result = await runtime.synthesize("Hello.", conditioning(), { maxNewTokens: 9_999, sampling });

    expect(result.reachedStop).toBe(true);
    expect(result.speechTokens).toBe(2);
    expect(Array.from(result.audio)).toEqual([expect.closeTo(0.1), expect.closeTo(-0.2), expect.closeTo(0.3)]);
    expect(state.seed).toHaveBeenCalledWith(42);
    const params = state.generateCalls[0];
    expect(params).toMatchObject({
      max_new_tokens: CHATTERBOX_MAX_NEW_TOKENS,
      do_sample: true,
      temperature: 1,
      top_k: 0,
      repetition_penalty: 1,
      return_dict_in_generate: true,
    });
    // The KV cache is released instead of leaking GPU buffers.
    expect(state.pastKeyValuesDispose).toHaveBeenCalledTimes(1);
    // Decoder input: reference prompt tokens, speech (control tokens removed), 3 silence tokens.
    const decoderInput = state.decoderRun.mock.calls[0][0].speech_tokens.wrapped.data as BigInt64Array;
    expect(Array.from(decoderInput)).toEqual([100n, 101n, 7n, 8n, ...Array(3).fill(BigInt(CHATTERBOX_SILENCE_TOKEN))]);
  });

  it("seeds randomly without a seed and decodes greedily at temperature 0", async () => {
    const runtime = await loadChatterboxRuntime({ backend: "webgpu", dtype: CHATTERBOX_DTYPE });
    await runtime.synthesize("Hi.", conditioning(), { maxNewTokens: 0, sampling: normalizeChatterboxSampling({ temperature: 0 }) });
    expect(state.seed).toHaveBeenCalledWith();
    expect(state.generateCalls[0]).toMatchObject({ do_sample: false, max_new_tokens: 1 });
  });

  it("reports a runaway that never emitted the stop token", async () => {
    state.generated = [7n, 8n];
    state.pastKeyValues = false;
    const runtime = await loadChatterboxRuntime({ backend: "webgpu", dtype: CHATTERBOX_DTYPE });
    const result = await runtime.synthesize("Hi.", conditioning(), { maxNewTokens: 50, sampling: normalizeChatterboxSampling() });
    expect(result.reachedStop).toBe(false);
  });

  it("converts non-float32 decoder output", async () => {
    state.decoderRun.mockResolvedValue({ waveform: { type: "float16", data: Float32Array.from([0.5]), dims: [1, 1] } });
    const runtime = await loadChatterboxRuntime({ backend: "webgpu", dtype: CHATTERBOX_DTYPE });
    const result = await runtime.synthesize("Hi.", conditioning(), { maxNewTokens: 50, sampling: normalizeChatterboxSampling() });
    expect(Array.from(result.audio)).toEqual([0.5]);
  });

  it("asks generation to stop when the caller aborts, and skips decoding", async () => {
    const runtime = await loadChatterboxRuntime({ backend: "webgpu", dtype: CHATTERBOX_DTYPE });
    let stop = false;
    const pending = runtime.synthesize("Hi.", conditioning(), {
      maxNewTokens: 50,
      sampling: normalizeChatterboxSampling(),
      shouldStop: () => stop,
    });
    stop = true;
    const result = await pending;
    expect(result).toEqual({ audio: new Float32Array(0), reachedStop: false, speechTokens: 0 });
    expect(state.decoderRun).not.toHaveBeenCalled();

    const criteria = (state.generateCalls[0].stopping_criteria as { items: Array<{ _call(ids: number[][]): boolean[] }> }).items;
    stop = false;
    expect(criteria[0]._call([[1], [2]])).toEqual([false, false]);
    stop = true;
    expect(criteria[0]._call([[1], [2]])).toEqual([true, true]);
  });

  it("does not register a stopping criterion without shouldStop", async () => {
    const runtime = await loadChatterboxRuntime({ backend: "webgpu", dtype: CHATTERBOX_DTYPE });
    await runtime.synthesize("Hi.", conditioning(), { maxNewTokens: 50, sampling: normalizeChatterboxSampling() });
    expect((state.generateCalls[0].stopping_criteria as { items: unknown[] }).items).toHaveLength(0);
  });

  it("applies the sampling pipeline to the generated rows only, with START seeding the history", async () => {
    const runtime = await loadChatterboxRuntime({ backend: "webgpu", dtype: CHATTERBOX_DTYPE });
    await runtime.synthesize("Hi.", conditioning(), {
      maxNewTokens: 50,
      sampling: { temperature: 0, topK: 0, topP: 1, repetitionPenalty: 2 },
    });
    const processor = (state.generateCalls[0].logits_processor as { items: Array<{ _call(ids: bigint[][], logits: unknown): unknown }> }).items[0];
    const scores = new Float32Array(CHATTERBOX_STOP_SPEECH_TOKEN + 1).fill(1);
    const logits = { dims: [1, scores.length], data: scores };
    // Prompt ids (10, 11, 12) are not speech tokens; only 3 and START are.
    processor._call([[10n, 11n, 12n, 3n]], logits);
    expect(scores[3]).toBe(0.5);
    expect(scores[CHATTERBOX_START_SPEECH_TOKEN]).toBe(0.5);
    expect(scores[10]).toBe(1);
  });

  it("disposes the model", async () => {
    const runtime = await loadChatterboxRuntime({ backend: "webgpu", dtype: CHATTERBOX_DTYPE });
    await runtime.dispose();
    expect(state.modelDispose).toHaveBeenCalledTimes(1);
  });
});

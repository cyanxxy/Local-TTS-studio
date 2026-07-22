// Adapted from Supertone's MIT-licensed ONNX web example at
// https://github.com/supertone-inc/supertonic (dff55dc00064c398736080c78195f577527832ae).
import * as ort from "onnxruntime-web";

interface Supertonic3Config {
  ae: {
    sample_rate: number;
    base_chunk_size: number;
  };
  ttl: {
    chunk_compress_factor: number;
    latent_dim: number;
  };
}

interface VoiceStyleJson {
  style_ttl: { dims: number[]; data: unknown[] };
  style_dp: { dims: number[]; data: unknown[] };
}

export interface Supertonic3Style {
  ttl: ort.Tensor;
  dp: ort.Tensor;
}

function disposeTensor(tensor: ort.Tensor | null | undefined): void {
  try {
    tensor?.dispose();
  } catch {
    // Keep disposing the remaining native resources after an ORT failure.
  }
}

async function releaseSessions(sessions: readonly ort.InferenceSession[]): Promise<void> {
  await Promise.allSettled(sessions.map((session) => Promise.resolve().then(() => session.release())));
}

function flattenNumbers(value: unknown): number[] {
  if (Array.isArray(value)) return value.flat(Infinity).map(Number);
  return [];
}

export function createSupertonic3Style(value: VoiceStyleJson): Supertonic3Style {
  const ttlDims = value.style_ttl.dims;
  const dpDims = value.style_dp.dims;
  const ttl = new ort.Tensor("float32", new Float32Array(flattenNumbers(value.style_ttl.data)), ttlDims);
  try {
    return {
      ttl,
      dp: new ort.Tensor("float32", new Float32Array(flattenNumbers(value.style_dp.data)), dpDims),
    };
  } catch (error) {
    disposeTensor(ttl);
    throw error;
  }
}

function gaussianRandom(): number {
  const u1 = Math.max(0.0001, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function normalizeSupertonic3Text(text: string): string {
  const normalized = text
    .normalize("NFKD")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, "")
    .replace(/[–‑—]/g, "-")
    .replace(/_/g, " ")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’´`]/g, "'")
    .replaceAll("[", " ")
    .replaceAll("]", " ")
    .replaceAll("|", " ")
    .replaceAll("/", " ")
    .replaceAll("#", " ")
    .replaceAll("→", " ")
    .replaceAll("←", " ")
    .replace(/[♥☆♡©\\]/g, "")
    .replaceAll("@", " at ")
    .replaceAll("e.g.,", "for example, ")
    .replaceAll("i.e.,", "that is, ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(normalized)
    && !/<\/?[A-Za-z][^<>]*>$/.test(normalized)
  ) return `${normalized}.`;
  return normalized;
}

function disposeOutputs(outputs: ort.InferenceSession.ReturnType | null): void {
  if (!outputs) return;
  for (const tensor of new Set(Object.values(outputs))) disposeTensor(tensor);
}

class UnicodeProcessor {
  private readonly indexer: number[];

  constructor(indexer: number[]) {
    this.indexer = indexer;
  }

  process(text: string, language: string): { ids: BigInt64Array; mask: Float32Array; length: number } {
    const normalized = normalizeSupertonic3Text(text);
    const wrapped = `<${language}>${normalized}</${language}>`;
    const codePoints = Array.from(wrapped, (character) => character.codePointAt(0) ?? 0);
    const ids = new BigInt64Array(codePoints.map((codePoint) => BigInt(
      codePoint < this.indexer.length ? this.indexer[codePoint] : -1,
    )));
    return { ids, mask: new Float32Array(codePoints.length).fill(1), length: codePoints.length };
  }
}

export class Supertonic3Runtime {
  readonly sampleRate: number;
  private readonly processor: UnicodeProcessor;
  private readonly config: Supertonic3Config;
  private readonly durationPredictor: ort.InferenceSession;
  private readonly textEncoder: ort.InferenceSession;
  private readonly vectorEstimator: ort.InferenceSession;
  private readonly vocoder: ort.InferenceSession;
  private disposed = false;

  constructor(
    config: Supertonic3Config,
    indexer: number[],
    durationPredictor: ort.InferenceSession,
    textEncoder: ort.InferenceSession,
    vectorEstimator: ort.InferenceSession,
    vocoder: ort.InferenceSession,
  ) {
    this.config = config;
    this.durationPredictor = durationPredictor;
    this.textEncoder = textEncoder;
    this.vectorEstimator = vectorEstimator;
    this.vocoder = vocoder;
    this.sampleRate = config.ae.sample_rate;
    this.processor = new UnicodeProcessor(indexer);
  }

  async synthesize(
    text: string,
    language: string,
    style: Supertonic3Style,
    totalSteps: number,
    speed: number,
    onStep?: (step: number, total: number) => void,
  ): Promise<Float32Array> {
    if (this.disposed) throw new Error("Supertonic 3 runtime has been disposed.");
    const processed = this.processor.process(text, language);
    let textIds: ort.Tensor | null = null;
    let textMask: ort.Tensor | null = null;
    let textEncoderOutput: ort.InferenceSession.ReturnType | null = null;
    let latentTensor: ort.Tensor | null = null;
    let latentMask: ort.Tensor | null = null;
    let totalStepTensor: ort.Tensor | null = null;
    let currentStepTensor: ort.Tensor | null = null;
    try {
      textIds = new ort.Tensor("int64", processed.ids, [1, processed.length]);
      textMask = new ort.Tensor("float32", processed.mask, [1, 1, processed.length]);
      const durationOutput = await this.durationPredictor.run({
        text_ids: textIds,
        style_dp: style.dp,
        text_mask: textMask,
      });
      let duration: number;
      try {
        duration = Number(durationOutput.duration.data[0]) / speed;
      } finally {
        disposeOutputs(durationOutput);
      }
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Supertonic 3 returned an invalid duration.");
      }

      textEncoderOutput = await this.textEncoder.run({
        text_ids: textIds,
        style_ttl: style.ttl,
        text_mask: textMask,
      });
      const chunkSize = this.config.ae.base_chunk_size * this.config.ttl.chunk_compress_factor;
      const latentLength = Math.ceil((duration * this.sampleRate) / chunkSize);
      const latentChannels = this.config.ttl.latent_dim * this.config.ttl.chunk_compress_factor;
      const latent = new Float32Array(latentChannels * latentLength);
      for (let index = 0; index < latent.length; index += 1) latent[index] = gaussianRandom();
      latentTensor = new ort.Tensor("float32", latent, [1, latentChannels, latentLength]);
      latentMask = new ort.Tensor("float32", new Float32Array(latentLength).fill(1), [1, 1, latentLength]);
      totalStepTensor = new ort.Tensor("float32", new Float32Array([totalSteps]), [1]);
      const currentStepData = new Float32Array(1);
      currentStepTensor = new ort.Tensor("float32", currentStepData, [1]);

      for (let step = 0; step < totalSteps; step += 1) {
        onStep?.(step + 1, totalSteps);
        currentStepData[0] = step;
        let stepOutput: ort.InferenceSession.ReturnType | null = null;
        try {
          stepOutput = await this.vectorEstimator.run({
            noisy_latent: latentTensor,
            text_emb: textEncoderOutput.text_emb,
            style_ttl: style.ttl,
            latent_mask: latentMask,
            text_mask: textMask,
            current_step: currentStepTensor,
            total_step: totalStepTensor,
          });
          latent.set(stepOutput.denoised_latent.data as ArrayLike<number>);
        } finally {
          disposeOutputs(stepOutput);
        }
      }

      let vocoderOutput: ort.InferenceSession.ReturnType | null = null;
      try {
        vocoderOutput = await this.vocoder.run({ latent: latentTensor });
        const waveform = Float32Array.from(vocoderOutput.wav_tts.data as ArrayLike<number>);
        return waveform.slice(0, Math.min(waveform.length, Math.floor(this.sampleRate * duration)));
      } finally {
        disposeOutputs(vocoderOutput);
      }
    } finally {
      disposeTensor(textIds);
      disposeTensor(textMask);
      disposeTensor(latentTensor);
      disposeTensor(latentMask);
      disposeTensor(totalStepTensor);
      disposeTensor(currentStepTensor);
      disposeOutputs(textEncoderOutput);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await releaseSessions([
      this.durationPredictor,
      this.textEncoder,
      this.vectorEstimator,
      this.vocoder,
    ]);
  }
}

export async function createSupertonic3Runtime(
  config: Supertonic3Config,
  indexer: number[],
  models: Record<"duration_predictor" | "text_encoder" | "vector_estimator" | "vocoder", ArrayBuffer>,
  executionProvider: "webgpu" | "wasm",
): Promise<Supertonic3Runtime> {
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: [executionProvider],
    graphOptimizationLevel: "all",
  };
  const sessions: ort.InferenceSession[] = [];
  try {
    const durationPredictor = await ort.InferenceSession.create(models.duration_predictor, options);
    sessions.push(durationPredictor);
    const textEncoder = await ort.InferenceSession.create(models.text_encoder, options);
    sessions.push(textEncoder);
    const vectorEstimator = await ort.InferenceSession.create(models.vector_estimator, options);
    sessions.push(vectorEstimator);
    const vocoder = await ort.InferenceSession.create(models.vocoder, options);
    sessions.push(vocoder);
    return new Supertonic3Runtime(
      config,
      indexer,
      durationPredictor,
      textEncoder,
      vectorEstimator,
      vocoder,
    );
  } catch (error) {
    await releaseSessions(sessions);
    throw error;
  }
}

export type { Supertonic3Config, VoiceStyleJson };

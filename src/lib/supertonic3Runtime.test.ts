import * as ort from "onnxruntime-web";
import { describe, expect, it, vi } from "vitest";
import {
  createSupertonic3Runtime,
  normalizeSupertonic3Text,
  Supertonic3Runtime,
} from "./supertonic3Runtime";

const config = {
  ae: { sample_rate: 8, base_chunk_size: 2 },
  ttl: { chunk_compress_factor: 1, latent_dim: 1 },
};

function outputTensor(data: ArrayLike<number>) {
  return { data, dispose: vi.fn() } as unknown as ort.Tensor;
}

function session(
  run: (feeds: Record<string, ort.Tensor>) => Promise<ort.InferenceSession.ReturnType>,
  release = vi.fn(async () => undefined),
) {
  return { run: vi.fn(run), release } as unknown as ort.InferenceSession;
}

describe("Supertonic 3 text normalization", () => {
  it("adds sentence punctuation without rewriting terminal expression tags", () => {
    expect(normalizeSupertonic3Text("A plain sentence")).toBe("A plain sentence.");
    expect(normalizeSupertonic3Text("That was funny <laugh>")).toBe("That was funny <laugh>");
  });
});

describe("Supertonic 3 runtime resources", () => {
  it("reuses the latent input and disposes every inference output", async () => {
    const duration = outputTensor(new Float32Array([1]));
    const textEmbedding = outputTensor(new Float32Array([1]));
    const denoised = [
      outputTensor(new Float32Array([1, 1, 1, 1])),
      outputTensor(new Float32Array([2, 2, 2, 2])),
      outputTensor(new Float32Array([3, 3, 3, 3])),
    ];
    const waveform = outputTensor(new Float32Array(8).fill(0.25));
    const noisyLatents: ort.Tensor[] = [];
    const runtime = new Supertonic3Runtime(
      config,
      new Array(256).fill(1),
      session(async () => ({ duration })),
      session(async () => ({ text_emb: textEmbedding })),
      session(async (feeds) => {
        noisyLatents.push(feeds.noisy_latent);
        return { denoised_latent: denoised[noisyLatents.length - 1] };
      }),
      session(async () => ({ wav_tts: waveform })),
    );
    const style = {
      ttl: new ort.Tensor("float32", new Float32Array([1]), [1]),
      dp: new ort.Tensor("float32", new Float32Array([1]), [1]),
    };

    await expect(runtime.synthesize("hello", "en", style, 3, 1)).resolves.toHaveLength(8);

    expect(new Set(noisyLatents).size).toBe(1);
    for (const tensor of [duration, textEmbedding, ...denoised, waveform]) {
      expect(tensor.dispose).toHaveBeenCalledOnce();
    }
    style.ttl.dispose();
    style.dp.dispose();
  });

  it("attempts to release every session even when one release throws synchronously", async () => {
    const releases = [
      vi.fn(() => { throw new Error("release failed"); }),
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    ];
    const sessions = releases.map((release) => session(async () => ({}), release));
    const runtime = new Supertonic3Runtime(config, [], sessions[0], sessions[1], sessions[2], sessions[3]);

    await expect(runtime.dispose()).resolves.toBeUndefined();
    releases.forEach((release) => expect(release).toHaveBeenCalledOnce());
  });

  it("releases sessions created before a partial factory failure", async () => {
    const release = vi.fn(async () => undefined);
    const firstSession = session(async () => ({}), release);
    const create = vi.spyOn(ort.InferenceSession, "create")
      .mockResolvedValueOnce(firstSession)
      .mockRejectedValueOnce(new Error("second model failed"));
    const models = {
      duration_predictor: new ArrayBuffer(1),
      text_encoder: new ArrayBuffer(1),
      vector_estimator: new ArrayBuffer(1),
      vocoder: new ArrayBuffer(1),
    };

    await expect(createSupertonic3Runtime(config, [], models, "wasm"))
      .rejects.toThrow("second model failed");
    expect(release).toHaveBeenCalledOnce();
    create.mockRestore();
  });
});

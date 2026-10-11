import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web/webgpu";
import { describe, expect, it, vi } from "vitest";
import {
  createSeededRandom,
  createSupertonic3Runtime,
  createSupertonic3RuntimeStreaming,
  deriveChunkSeed,
  normalizeSupertonic3Text,
  SUPERTONIC3_MAX_SEED,
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

  it("returns one standalone copy of the waveform trimmed to the predicted duration", async () => {
    const style = {
      ttl: new ort.Tensor("float32", new Float32Array([1]), [1]),
      dp: new ort.Tensor("float32", new Float32Array([1]), [1]),
    };
    const waveforms: ArrayLike<number>[] = [
      Float32Array.from({ length: 12 }, (_, index) => index / 16),
      Array.from({ length: 12 }, (_, index) => index / 16),
    ];
    const runtime = new Supertonic3Runtime(
      config,
      new Array(256).fill(1),
      session(async () => ({ duration: outputTensor(new Float32Array([1])) })),
      session(async () => ({ text_emb: outputTensor(new Float32Array([1])) })),
      session(async () => ({ denoised_latent: outputTensor(new Float32Array(4)) })),
      session(async () => ({ wav_tts: outputTensor(waveforms.shift()!) })),
    );
    const expected = Array.from({ length: 8 }, (_, index) => index / 16);

    // One second at 8 Hz keeps 8 of the vocoder's 12 samples.
    for (let run = 0; run < 2; run += 1) {
      const audio = await runtime.synthesize("hello", "en", style, 1, 1);
      expect(audio).toBeInstanceOf(Float32Array);
      expect(Array.from(audio)).toEqual(expected);
      expect(audio.byteOffset).toBe(0);
      expect(audio.buffer.byteLength).toBe(audio.byteLength);
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

  it("loads and instantiates model files one at a time", async () => {
    const events: string[] = [];
    const createdSessions = [0, 1, 2, 3].map(() => session(async () => ({})));
    const create = vi.spyOn(ort.InferenceSession, "create")
      .mockImplementation(async (buffer) => {
        const bytes = buffer instanceof Uint8Array
          ? buffer
          : new Uint8Array(buffer as unknown as ArrayBuffer);
        events.push(`create:${bytes[0]}`);
        return createdSessions.shift()!;
      });
    const modelIds = {
      duration_predictor: 1,
      text_encoder: 2,
      vector_estimator: 3,
      vocoder: 4,
    } as const;

    const runtime = await createSupertonic3RuntimeStreaming(
      config,
      [],
      async (name) => {
        events.push(`load:${name}`);
        return new Uint8Array([modelIds[name]]).buffer;
      },
      "wasm",
    );

    expect(events).toEqual([
      "load:duration_predictor",
      "create:1",
      "load:text_encoder",
      "create:2",
      "load:vector_estimator",
      "create:3",
      "load:vocoder",
      "create:4",
    ]);
    await runtime.dispose();
    create.mockRestore();
  });
});

describe("Supertonic 3 seeded noise", () => {
  const sample = (random: () => number, count = 6) => Array.from({ length: count }, () => random());

  it("repeats a uniform [0, 1) sequence for the same seed", () => {
    const values = sample(createSeededRandom(42));

    expect(values).toEqual(sample(createSeededRandom(42)));
    expect(values).not.toEqual(sample(createSeededRandom(43)));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(sample(createSeededRandom(SUPERTONIC3_MAX_SEED)).every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("derives each chunk's seed from both the generation seed and the chunk text", () => {
    const seed = deriveChunkSeed(7, "Hello there.");

    expect(deriveChunkSeed(7, "Hello there.")).toBe(seed);
    expect(deriveChunkSeed(8, "Hello there.")).not.toBe(seed);
    expect(deriveChunkSeed(7, "Hello there!")).not.toBe(seed);
    expect(deriveChunkSeed(7, "\u4f60\u597d")).not.toBe(deriveChunkSeed(7, "\u597d\u4f60"));
    expect(Number.isInteger(seed) && seed >= 0 && seed <= SUPERTONIC3_MAX_SEED).toBe(true);
  });

  it("starts denoising from the same latent noise for the same random source", async () => {
    const initialLatents: number[][] = [];
    const runtime = new Supertonic3Runtime(
      config,
      new Array(256).fill(1),
      session(async () => ({ duration: outputTensor(new Float32Array([1])) })),
      session(async () => ({ text_emb: outputTensor(new Float32Array([1])) })),
      session(async (feeds) => {
        initialLatents.push(Array.from(feeds.noisy_latent.data as Float32Array));
        return { denoised_latent: outputTensor(new Float32Array(4)) };
      }),
      session(async () => ({ wav_tts: outputTensor(new Float32Array(8)) })),
    );
    const style = {
      ttl: new ort.Tensor("float32", new Float32Array([1]), [1]),
      dp: new ort.Tensor("float32", new Float32Array([1]), [1]),
    };

    await runtime.synthesize("hello", "en", style, 1, 1, { random: createSeededRandom(1) });
    await runtime.synthesize("hello", "en", style, 1, 1, { random: createSeededRandom(1) });
    await runtime.synthesize("hello", "en", style, 1, 1, { random: createSeededRandom(2) });
    const mathRandom = vi.spyOn(Math, "random");
    await runtime.synthesize("hello", "en", style, 1, 1);

    expect(initialLatents[0]).toHaveLength(4);
    expect(initialLatents[1]).toEqual(initialLatents[0]);
    expect(initialLatents[2]).not.toEqual(initialLatents[0]);
    expect(mathRandom).toHaveBeenCalled();
    mathRandom.mockRestore();
    style.ttl.dispose();
    style.dp.dispose();
  });
});

describe("Supertonic 3 ONNX Runtime entry", () => {
  // The worker points ORT at the asyncify WASM build, which only the webgpu
  // entry runs WebGPU on. The default entry needs the JSEP build, so every
  // WebGPU session failed and Supertonic 3 always fell back to WASM.
  it.each(["src/lib/supertonic3Runtime.ts", "src/workers/supertonic3.worker.ts"])("%s imports onnxruntime-web/webgpu", (file) => {
    const imports = [...readFileSync(file, "utf8").matchAll(/from "(onnxruntime-web[^"]*)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["onnxruntime-web/webgpu"]);
  });

  it("pairs that entry with the asyncify WASM build", () => {
    expect(readFileSync("src/workers/supertonic3.worker.ts", "utf8"))
      .toContain("ort.env.wasm.wasmPaths = TRANSFORMERS_ONNX_WASM_ASSETS.asyncify;");
  });
});

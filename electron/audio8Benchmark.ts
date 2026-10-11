/**
 * Audio8 as a participant in the native runtime benchmark.
 *
 * Audio8 renders a whole take before answering, so its first audio is its
 * completed take and its time to first audio equals its wall time. A streaming
 * runtime's adapter would signal on its first chunk instead.
 */

import { parseAudio8SamplingOptions } from "./audio8Ipc";
import { AUDIO8_DEFAULT_VOICE, AUDIO8_MODEL_ID, AUDIO8_MODEL_REVISION, isAudio8VoiceId } from "./audio8Model";
import type { Audio8NativeClient } from "./audio8NativeClient";
import type { NativeRuntimeBenchmarkAdapter } from "./nativeModels/runtimeBenchmark";

export type Audio8BenchmarkClient = Pick<Audio8NativeClient, "load" | "generate" | "destroy">;

function parseNumberOption(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) throw new Error(`Audio8 benchmark ${name} must be a number.`);
  return parsed;
}

/**
 * `options` are the benchmark's runtime flags as typed: `voice`, `seed` and
 * `temperature`. They are checked with the same rules as the IPC boundary.
 */
export function createAudio8BenchmarkAdapter(
  client: Audio8BenchmarkClient,
  options: Readonly<Record<string, string>> = {},
): NativeRuntimeBenchmarkAdapter {
  const unknown = Object.keys(options).filter((key) => !["voice", "seed", "temperature"].includes(key));
  if (unknown.length > 0) throw new Error(`Audio8 benchmark does not accept ${unknown.join(", ")}.`);
  const voice = options.voice ?? AUDIO8_DEFAULT_VOICE;
  if (!isAudio8VoiceId(voice)) throw new Error("Unsupported Audio8 voice.");
  const sampling = parseAudio8SamplingOptions({
    seed: parseNumberOption("seed", options.seed),
    temperature: parseNumberOption("temperature", options.temperature),
  });
  let requests = 0;

  return {
    runtime: "audio8",
    model: { id: AUDIO8_MODEL_ID, revision: AUDIO8_MODEL_REVISION },
    async load() {
      await client.load("benchmark-load", () => undefined);
    },
    async synthesize(text, onFirstAudio) {
      requests += 1;
      const result = await client.generate(`benchmark-${requests}`, text, voice, undefined, sampling);
      if (!(result.audio instanceof ArrayBuffer)) throw new Error("Audio8 benchmark returned no audio buffer.");
      onFirstAudio();
      return {
        sampleRate: result.sampleRate,
        samples: result.audio.byteLength / Float32Array.BYTES_PER_ELEMENT,
      };
    },
    dispose: () => client.destroy(),
  };
}

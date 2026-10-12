import { describe, expect, it, vi } from "vitest";
import { getQwen3Profiles } from "../../../electron/qwen3Profiles";
import type { EngineRuntimeMap } from "../../shared/engineRuntime";
import type { SurfaceEngineSettings } from "../../models/registry";
import { createPresetSynthesize, libraryVoiceAudioLoader } from "./presetSynthesize";
import type { VoiceRecord } from "./types";

const audio = { sampleRate: 24000, durationSec: 4, byteLength: 10, sha256: "b".repeat(64) };
const base = { schemaVersion: 1 as const, name: "N", description: "", tags: [], favorite: false, createdAt: 1, updatedAt: 1 };
const records: Record<string, VoiceRecord> = {
  clone: { ...base, id: "clone", kind: "cloned", transcript: "Said.", language: "English", targets: ["qwen3-base"], source: "upload", reference: audio },
  design: { ...base, id: "design", kind: "designed", design: { description: "d", seed: 1, language: "English", previewText: "Preview line." }, sample: audio },
  bare: { ...base, id: "bare", kind: "designed", design: { description: "d", seed: 1, language: "English", previewText: "x" } },
  preset: { ...base, id: "preset", kind: "preset", preset: { engineId: "kokoro", voiceId: "v", settings: {} } },
};
const library = {
  getVoice: vi.fn(async (id: string) => records[id] ?? null),
  getVoiceAudio: vi.fn(async (_id: string, role: string) => (role === "reference" ? new Uint8Array([1]) : new Uint8Array([2]))),
};

describe("libraryVoiceAudioLoader", () => {
  it("returns a clone's reference and a designed voice's sample with its preview text", async () => {
    const load = libraryVoiceAudioLoader(library);
    expect(await load("clone")).toEqual({ wav: new Uint8Array([1]), transcript: "Said.", sha256: audio.sha256 });
    expect(await load("design")).toEqual({ wav: new Uint8Array([2]), transcript: "Preview line.", sha256: audio.sha256 });
    expect(await load("bare")).toBeNull();
    expect(await load("preset")).toBeNull();
    expect(await load("missing")).toBeNull();
  });
});

describe("createPresetSynthesize", () => {
  function setup() {
    const synthesize = vi.fn(async function* () {
      yield { audio: new Float32Array([0.1, 0.2]), samplingRate: 24000, text: "x", index: 1, total: 1 };
    });
    const runtimes = { kokoro: { synthesize } } as unknown as EngineRuntimeMap;
    const deps = () => ({
      runtimes,
      library,
      context: {
        tuning: { speed: 1, quality: 5 },
        engineSettings: { kokoro: { voice: "af_heart" } } as unknown as SurfaceEngineSettings,
        qwen3Profiles: getQwen3Profiles("darwin", "arm64"),
        qwen3Setup: null,
      },
    });
    return { synthesize, run: createPresetSynthesize(deps) };
  }

  it("streams the engine's chunks for the preset's request, aborting with the caller's signal", async () => {
    const { synthesize, run } = setup();
    const controller = new AbortController();
    const chunks = [];
    for await (const chunk of run("Hello.", { engineId: "kokoro", voiceId: "bm_george", settings: { speed: 1.2 } }, controller.signal)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ audio: new Float32Array([0.1, 0.2]), samplingRate: 24000 }]);
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      text: "Hello.",
      settings: { voice: "bm_george" },
      tuning: { speed: 1.2, quality: 5 },
      signal: controller.signal,
    }));
  });

  it("stops before touching the engine when already aborted", async () => {
    const { synthesize, run } = setup();
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect((async () => {
      for await (const chunk of run("Hi.", { engineId: "kokoro", voiceId: "v", settings: {} }, controller.signal)) void chunk;
    })()).rejects.toThrow("stop");
    expect(synthesize).not.toHaveBeenCalled();
  });
});

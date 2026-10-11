import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { PresetSynthesize, SynthesizedAudioChunk } from "./presetSynthesis";
import { createVoiceLibraryStore } from "./voiceLibrary/store";
import type { VoicePreset } from "./voiceLibrary/types";
import { VoiceLibraryValidationError } from "./voiceLibrary/validation";
import {
  DEFAULT_VOICE_DESIGN_PREVIEW_TEXTS,
  cloneReferenceFromPreview,
  createVoiceDesignPreviewSession,
  defaultVoiceDesignPreviewText,
  designedVoiceFromPreview,
  nextPreviewSeed,
  planVoiceDesignPreviews,
  renderVoiceDesignPreviews,
  saveSelectedPreview,
  voiceDesignPreviewReducer,
  type VoiceDesignPreviewAction,
  type VoiceDesignPreviewSession,
} from "./voiceDesignPreviews";
import { decodeWav } from "./wavCodec";

const DESCRIPTION = "A warm, low female voice with a slight rasp.";

/** Silence, a tone standing in for speech, silence: passes the reference checks. */
function speechLike(seconds: number, rate = 24000): Float32Array {
  const edge = Math.round(0.2 * rate);
  const body = Math.round(seconds * rate);
  const samples = new Float32Array(edge * 2 + body);
  let state = 7;
  for (let index = 0; index < samples.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const noise = ((state / 0xffffffff) * 2 - 1) * 0.0005;
    const inBody = index >= edge && index < edge + body;
    samples[index] = noise + (inBody ? 0.3 * Math.sin((2 * Math.PI * 180 * index) / rate) : 0);
  }
  return samples;
}

function readySession(seconds = 5, rate = 24000): VoiceDesignPreviewSession {
  const plan = planVoiceDesignPreviews({ description: DESCRIPTION, language: "English", baseSeed: 10, profileRepo: "repo/VoiceDesign" });
  let session = createVoiceDesignPreviewSession(plan);
  session = voiceDesignPreviewReducer(session, { type: "ready", requestId: "seed-11", samples: speechLike(seconds, rate), sampleRate: rate, firstAudioMs: 120 });
  return voiceDesignPreviewReducer(session, { type: "select", requestId: "seed-11" });
}

describe("planVoiceDesignPreviews", () => {
  it("plans consecutive seeded VoiceDesign requests with a default preview text", () => {
    const plan = planVoiceDesignPreviews({ description: `  ${DESCRIPTION}`, language: "German", baseSeed: 4294967295, extraSettings: { temperature: 0.8 } });
    expect(plan.previewText).toBe(DEFAULT_VOICE_DESIGN_PREVIEW_TEXTS.German);
    expect(plan.description).toBe(DESCRIPTION);
    expect(plan.requests.map((request) => request.seed)).toEqual([4294967295, 0, 1]);
    expect(plan.requests[1]).toEqual({
      id: "seed-0",
      seed: 0,
      preset: {
        engineId: "qwen3",
        voiceId: "voice-design",
        mode: "voiceDesign",
        settings: { instruction: DESCRIPTION, seed: 0, language: "German", extra: { temperature: 0.8 } },
        label: "Preview 2",
      },
    } satisfies { id: string; seed: number; preset: VoicePreset });
    expect(plan).not.toHaveProperty("profileRepo");
  });

  it("accepts explicit seeds, custom text and random seeds", () => {
    const plan = planVoiceDesignPreviews({ description: DESCRIPTION, seeds: [9, 3], previewText: " Short line. " });
    expect(plan).toMatchObject({ language: "Auto", previewText: "Short line." });
    expect(plan.requests.map((request) => request.id)).toEqual(["seed-9", "seed-3"]);
    expect(plan.requests[0].preset.settings).not.toHaveProperty("extra");
    const random = planVoiceDesignPreviews({ description: DESCRIPTION, count: 2 });
    expect(random.requests).toHaveLength(2);
    expect(random.previewText).toBe(DEFAULT_VOICE_DESIGN_PREVIEW_TEXTS.English);
    expect(defaultVoiceDesignPreviewText("Klingon")).toBe(DEFAULT_VOICE_DESIGN_PREVIEW_TEXTS.English);
  });

  it("keeps every default preview text to one Qwen3 unit", () => {
    for (const language of Object.keys(DEFAULT_VOICE_DESIGN_PREVIEW_TEXTS)) {
      expect(() => planVoiceDesignPreviews({ description: DESCRIPTION, language, baseSeed: 1 })).not.toThrow();
    }
  });

  it("rejects invalid descriptions, texts, counts and seeds", () => {
    expect(() => planVoiceDesignPreviews({ description: "  " })).toThrow(VoiceLibraryValidationError);
    expect(() => planVoiceDesignPreviews({ description: DESCRIPTION, previewText: "word ".repeat(60) })).toThrow(/one or two short sentences/);
    expect(() => planVoiceDesignPreviews({ description: DESCRIPTION, count: 0 })).toThrow(/between 1 and 6/);
    expect(() => planVoiceDesignPreviews({ description: DESCRIPTION, count: 7 })).toThrow(/between 1 and 6/);
    expect(() => planVoiceDesignPreviews({ description: DESCRIPTION, seeds: [] })).toThrow(/between 1 and 6/);
    expect(() => planVoiceDesignPreviews({ description: DESCRIPTION, seeds: [1, 1] })).toThrow(/different/);
    expect(() => planVoiceDesignPreviews({ description: DESCRIPTION, seeds: [-1] })).toThrow(/Seed must be/);
  });
});

describe("voiceDesignPreviewReducer", () => {
  const plan = planVoiceDesignPreviews({ description: DESCRIPTION, baseSeed: 1, count: 2 });
  const fresh = createVoiceDesignPreviewSession(plan);

  it("tracks rendering, results, failures and selection", () => {
    expect(fresh.results).toEqual({
      "seed-1": { requestId: "seed-1", status: "pending" },
      "seed-2": { requestId: "seed-2", status: "pending" },
    });
    let session = voiceDesignPreviewReducer(fresh, { type: "rendering", requestId: "seed-1" });
    expect(session.results["seed-1"].status).toBe("rendering");
    // Only ready previews can be selected.
    expect(voiceDesignPreviewReducer(session, { type: "select", requestId: "seed-1" })).toBe(session);
    const samples = new Float32Array([0.1]);
    session = voiceDesignPreviewReducer(session, { type: "ready", requestId: "seed-1", samples, sampleRate: 24000, firstAudioMs: 50 });
    expect(session.results["seed-1"]).toEqual({ requestId: "seed-1", status: "ready", samples, sampleRate: 24000, firstAudioMs: 50 });
    session = voiceDesignPreviewReducer(session, { type: "select", requestId: "seed-1" });
    expect(session.selectedId).toBe("seed-1");
    expect(voiceDesignPreviewReducer(session, { type: "select", requestId: "seed-1" })).toBe(session);
    const cleared = voiceDesignPreviewReducer(session, { type: "select", requestId: null });
    expect(cleared.selectedId).toBeNull();
    expect(voiceDesignPreviewReducer(cleared, { type: "select", requestId: null })).toBe(cleared);

    const failedOther = voiceDesignPreviewReducer(session, { type: "failed", requestId: "seed-2", error: "boom" });
    expect(failedOther.results["seed-2"]).toEqual({ requestId: "seed-2", status: "failed", error: "boom" });
    expect(failedOther.selectedId).toBe("seed-1");
    expect(voiceDesignPreviewReducer(session, { type: "failed", requestId: "seed-1", error: "late" }).selectedId).toBeNull();
    expect(voiceDesignPreviewReducer(session, { type: "rendering", requestId: "seed-99" })).toBe(session);
  });

  it("regenerates one preview with a new seed and forgets its result", () => {
    let session = voiceDesignPreviewReducer(fresh, { type: "ready", requestId: "seed-1", samples: new Float32Array(1), sampleRate: 24000, firstAudioMs: null });
    session = voiceDesignPreviewReducer(session, { type: "select", requestId: "seed-1" });
    const regenerated = voiceDesignPreviewReducer(session, { type: "regenerate", requestId: "seed-1", seed: 50 });
    expect(regenerated.plan.requests.map((request) => [request.id, request.preset.settings.seed, request.preset.label]))
      .toEqual([["seed-50", 50, "Preview 1"], ["seed-2", 2, "Preview 2"]]);
    expect(regenerated.results).toEqual({
      "seed-50": { requestId: "seed-50", status: "pending" },
      "seed-2": { requestId: "seed-2", status: "pending" },
    });
    expect(regenerated.selectedId).toBeNull();
    // A late result for the replaced request is ignored.
    expect(voiceDesignPreviewReducer(regenerated, { type: "ready", requestId: "seed-1", samples: new Float32Array(1), sampleRate: 1, firstAudioMs: null })).toBe(regenerated);
    expect(voiceDesignPreviewReducer(session, { type: "regenerate", requestId: "seed-2", seed: 60 }).selectedId).toBe("seed-1");
    expect(() => voiceDesignPreviewReducer(session, { type: "regenerate", requestId: "seed-1", seed: 2 })).toThrow(/already/);
  });

  it("picks regeneration seeds outside the plan", () => {
    expect(nextPreviewSeed(plan, 1)).toBe(3);
    expect(plan.requests.map((request) => request.seed)).not.toContain(nextPreviewSeed(plan));
  });
});

describe("renderVoiceDesignPreviews", () => {
  const plan = planVoiceDesignPreviews({ description: DESCRIPTION, baseSeed: 1, count: 3, previewText: "Hi there." });

  function synthesizer(failSeed?: number): PresetSynthesize & { seen: Array<[string, number | undefined]> } {
    const seen: Array<[string, number | undefined]> = [];
    const synthesize = async function* (text: string, preset: VoicePreset): AsyncGenerator<SynthesizedAudioChunk> {
      seen.push([text, preset.settings.seed]);
      if (preset.settings.seed === failSeed) throw new Error("Model is not loaded.");
      yield { audio: new Float32Array(4).fill((preset.settings.seed ?? 0) / 10), samplingRate: 24000 };
    };
    return Object.assign(synthesize, { seen });
  }

  it("renders each preview in sequence into its own buffer", async () => {
    const synthesize = synthesizer(2);
    const actions: VoiceDesignPreviewAction[] = [];
    let session = createVoiceDesignPreviewSession(plan);
    await renderVoiceDesignPreviews({
      plan,
      synthesize,
      now: () => 0,
      dispatch: (action) => {
        actions.push(action);
        session = voiceDesignPreviewReducer(session, action);
      },
    });
    expect(synthesize.seen).toEqual([["Hi there.", 1], ["Hi there.", 2], ["Hi there.", 3]]);
    expect(actions.map((action) => [action.type, "requestId" in action ? action.requestId : null])).toEqual([
      ["rendering", "seed-1"], ["ready", "seed-1"],
      ["rendering", "seed-2"], ["failed", "seed-2"],
      ["rendering", "seed-3"], ["ready", "seed-3"],
    ]);
    expect(session.results["seed-2"].error).toBe("Model is not loaded.");
    expect(session.results["seed-1"].samples?.[0]).toBeCloseTo(0.1);
    expect(session.results["seed-3"].samples?.[0]).toBeCloseTo(0.3);
    expect(session.results["seed-1"].samples).not.toBe(session.results["seed-3"].samples);
  });

  it("renders only the requested previews and gives a fallback error message", async () => {
    const dispatch = vi.fn();
    const failing: PresetSynthesize = async function* () {
      yield* [];
      throw new Error("");
    };
    await renderVoiceDesignPreviews({ plan, synthesize: failing, dispatch, requestIds: ["seed-3"] });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "rendering", requestId: "seed-3" },
      { type: "failed", requestId: "seed-3", error: "The preview failed to render." },
    ]);
  });

  it("stops on abort", async () => {
    const controller = new AbortController();
    const dispatch = vi.fn();
    const synthesize: PresetSynthesize = async function* () {
      controller.abort();
      yield { audio: new Float32Array(1), samplingRate: 24000 };
    };
    await expect(renderVoiceDesignPreviews({ plan, synthesize, dispatch, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("saving a preview", () => {
  it("builds a designed voice with a 24 kHz sample", () => {
    const voice = designedVoiceFromPreview(readySession(5, 48000), { name: "Rasp", tags: ["warm"], favorite: true });
    expect(voice).toMatchObject({
      kind: "designed",
      name: "Rasp",
      tags: ["warm"],
      favorite: true,
      design: { description: DESCRIPTION, seed: 11, language: "English", previewText: DEFAULT_VOICE_DESIGN_PREVIEW_TEXTS.English, profileRepo: "repo/VoiceDesign" },
    });
    const decoded = decodeWav(voice.sampleWav!);
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.channels[0].length).toBe(Math.round(5.4 * 24000));
    const noRepo = createVoiceDesignPreviewSession(planVoiceDesignPreviews({ description: DESCRIPTION, seeds: [5] }));
    const selected = voiceDesignPreviewReducer(
      voiceDesignPreviewReducer(noRepo, { type: "ready", requestId: "seed-5", samples: speechLike(4), sampleRate: 24000, firstAudioMs: 1 }),
      { type: "select", requestId: "seed-5" },
    );
    expect(designedVoiceFromPreview(selected, { name: "x" }).design).not.toHaveProperty("profileRepo");
  });

  it("requires a finished, selected preview", () => {
    const plan = planVoiceDesignPreviews({ description: DESCRIPTION, baseSeed: 1 });
    expect(() => designedVoiceFromPreview(createVoiceDesignPreviewSession(plan), { name: "x" })).toThrow(/Choose a finished preview/);
  });

  it("builds a trimmed clone reference with the preview text as transcript", () => {
    const { voice, warnings } = cloneReferenceFromPreview(readySession(), { name: "Rasp clone", designedFromId: "designed-1", targets: ["qwen3-base", "neutts"] });
    expect(voice).toMatchObject({
      kind: "cloned",
      name: "Rasp clone",
      transcript: DEFAULT_VOICE_DESIGN_PREVIEW_TEXTS.English,
      language: "English",
      targets: ["qwen3-base", "neutts"],
      source: "voiceDesign",
      designedFromId: "designed-1",
    });
    const decoded = decodeWav(voice.referenceWav);
    expect(decoded.sampleRate).toBe(24000);
    // 0.2 s edges trimmed down to the 0.15 s padding.
    expect(decoded.channels[0].length / 24000).toBeLessThan(5.4);
    expect(warnings.every((check) => check.status === "warn")).toBe(true);
    expect(cloneReferenceFromPreview(readySession(), { name: "x" }).voice).not.toHaveProperty("designedFromId");
  });

  it("reports the reference checks' guidance for unusable clips", () => {
    expect(() => cloneReferenceFromPreview(readySession(0.5), { name: "x" })).toThrow(/Qwen3 Base needs at least 1 s of speech.*Record or choose/);
    expect(() => cloneReferenceFromPreview(readySession(), { name: "x", targets: [] })).toThrow(/at least one clone target/);
    // Very short clips warn rather than fail for NeuTTS and dedupe warnings across targets.
    const { warnings } = cloneReferenceFromPreview(readySession(2), { name: "x", targets: ["qwen3-base", "neutts"] });
    expect(warnings.filter((check) => check.id === "duration")).toHaveLength(1);
  });

  it("saves the designed voice and an optional linked clone in one transaction", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    try {
      let ids = 0;
      const store = createVoiceLibraryStore({ createId: () => `voice-${++ids}` });
      const designedOnly = await saveSelectedPreview(store, readySession(), { name: "Rasp" });
      expect(designedOnly).toMatchObject({ designed: { id: "voice-1", kind: "designed" }, cloned: null, warnings: [] });

      const both = await saveSelectedPreview(store, readySession(), { name: "Rasp", alsoClone: true, cloneName: "Rasp (clone)" }, () => "design-1");
      expect(both.designed).toMatchObject({ id: "design-1", kind: "designed", name: "Rasp" });
      expect(both.cloned).toMatchObject({ kind: "cloned", name: "Rasp (clone)", designedFromId: "design-1", source: "voiceDesign" });
      const same = await saveSelectedPreview(store, readySession(), { name: "Same", alsoClone: true });
      expect(same.cloned?.name).toBe("Same");
      expect(same.designed.id).toMatch(/[0-9a-f-]{36}/);
      expect((await store.listVoices())).toHaveLength(5);

      // A clip that cannot be cloned is rejected before anything is written.
      await expect(saveSelectedPreview(store, readySession(0.5), { name: "x", alsoClone: true })).rejects.toThrow(/needs at least/);
      expect((await store.listVoices())).toHaveLength(5);

      // A store-level failure on the clone rolls back the designed voice too.
      const small = createVoiceLibraryStore({ databaseName: "small", maxVoices: 1 });
      await expect(saveSelectedPreview(small, readySession(), { name: "Warm", alsoClone: true })).rejects.toThrow(/at most 1 voices/);
      expect(await small.listVoices()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { resampleAudio } from "./pcmTransforms";
import { collectSynthesizedAudio, type PresetSynthesize } from "./presetSynthesis";
import { buildQwen3TextUnits } from "./qwenChunking";
import {
  REFERENCE_TARGET_SAMPLE_RATE,
  prepareReferenceClip,
  type ReferenceCheck,
  type ReferenceCloneTarget,
} from "./referenceAudio";
import { planVariationSeeds, randomSeed } from "./takes";
import type { NewClonedVoice, NewDesignedVoice, VoicePreset, VoiceRecord, VoiceSettingValue } from "./voiceLibrary/types";
import { normalizeLanguage, normalizeSeed, normalizeVoiceDesign } from "./voiceLibrary/validation";
import { encodeWavPcm16 } from "./wavCodec";

/**
 * Planning logic for the Qwen3 VoiceDesign flow: describe a voice, render N
 * seeded previews of one short sentence, pick one, and save it as a designed
 * voice, optionally also as a Qwen3 Base clone reference so the voice stays
 * consistent across long texts. A preview is reproducible from (description,
 * text, language, seed), and its transcript is known exactly, so saving it as
 * a clone reference needs no speech-to-text.
 */

export const VOICE_DESIGN_ENGINE_ID = "qwen3";
export const VOICE_DESIGN_PREVIEW_VOICE_ID = "voice-design";
export const DEFAULT_VOICE_DESIGN_PREVIEW_COUNT = 3;
export const MAX_VOICE_DESIGN_PREVIEW_COUNT = 6;

/**
 * Neutral sentences that run roughly 4-8 seconds, inside the 3-20 s window a
 * Qwen3 Base reference needs, and short enough to render as one Qwen3 text
 * unit so every preview is a single reproducible generation.
 */
export const DEFAULT_VOICE_DESIGN_PREVIEW_TEXTS: Readonly<Record<string, string>> = {
  English: "Hello there. This is how I sound when I read aloud, at an easy pace, with a calm and natural tone.",
  Chinese: "你好，这是我朗读时的声音。我会用平稳、自然的语气，慢慢地读给你听。",
  Japanese: "こんにちは。これは私が朗読するときの声です。落ち着いた自然な調子で、ゆっくり読みます。",
  Korean: "안녕하세요. 제가 소리 내어 읽을 때의 목소리입니다. 차분하고 자연스러운 어조로 천천히 읽어 볼게요.",
  German: "Hallo. So klinge ich, wenn ich laut vorlese, in ruhigem Tempo und mit einem natürlichen Ton.",
  French: "Bonjour. Voici ma voix quand je lis à haute voix, à un rythme posé et sur un ton naturel.",
  Russian: "Здравствуйте. Так звучит мой голос, когда я читаю вслух, спокойно и в естественном темпе.",
  Portuguese: "Olá. É assim que eu soo quando leio em voz alta, num ritmo tranquilo e com um tom natural.",
  Spanish: "Hola. Así suena mi voz cuando leo en voz alta, a un ritmo tranquilo y con un tono natural.",
  Italian: "Ciao. Ecco come suona la mia voce quando leggo ad alta voce, con calma e con un tono naturale.",
};

export function defaultVoiceDesignPreviewText(language: string): string {
  return DEFAULT_VOICE_DESIGN_PREVIEW_TEXTS[language] ?? DEFAULT_VOICE_DESIGN_PREVIEW_TEXTS.English;
}

export interface VoiceDesignPreviewRequest {
  id: string;
  seed: number;
  /** Ready to hand to a synthesizer together with the plan's preview text. */
  preset: VoicePreset;
}

export interface VoiceDesignPreviewPlan {
  description: string;
  language: string;
  previewText: string;
  profileRepo?: string;
  requests: VoiceDesignPreviewRequest[];
}

export interface PlanVoiceDesignPreviewsOptions {
  description: string;
  language?: string;
  /** Defaults to a neutral sentence in `language`. */
  previewText?: string;
  count?: number;
  /** Explicit seeds, for reproducing a previous set; overrides `count`. */
  seeds?: readonly number[];
  /** Start of a consecutive seed run; random when omitted. */
  baseSeed?: number;
  /** The VoiceDesign profile the previews are rendered with. */
  profileRepo?: string;
  /** Engine-specific knobs, such as temperature, sent with every preview. */
  extraSettings?: Record<string, VoiceSettingValue>;
}

function previewRequest(
  plan: Pick<VoiceDesignPreviewPlan, "description" | "language">,
  seed: number,
  position: number,
  extra: Record<string, VoiceSettingValue> | undefined,
): VoiceDesignPreviewRequest {
  return {
    id: `seed-${seed}`,
    seed,
    preset: {
      engineId: VOICE_DESIGN_ENGINE_ID,
      voiceId: VOICE_DESIGN_PREVIEW_VOICE_ID,
      mode: "voiceDesign",
      settings: {
        instruction: plan.description,
        seed,
        language: plan.language,
        ...(extra ? { extra: { ...extra } } : {}),
      },
      label: `Preview ${position + 1}`,
    },
  };
}

/**
 * Plan N seeded preview requests for one description. Validation matches
 * what the library accepts for a designed voice, and the preview text must fit
 * one Qwen3 text unit.
 */
export function planVoiceDesignPreviews(options: PlanVoiceDesignPreviewsOptions): VoiceDesignPreviewPlan {
  const language = normalizeLanguage(options.language);
  const previewText = (options.previewText ?? defaultVoiceDesignPreviewText(language)).trim();
  // Reuse the library's rules so a planned preview can always be saved.
  const design = normalizeVoiceDesign({
    description: options.description,
    seed: 0,
    language,
    previewText,
    profileRepo: options.profileRepo,
  });
  if (buildQwen3TextUnits(previewText).length !== 1) {
    throw new Error("Keep the preview text to one or two short sentences (about 200 characters).");
  }

  let seeds: number[];
  if (options.seeds !== undefined) {
    seeds = options.seeds.map(normalizeSeed);
    if (new Set(seeds).size !== seeds.length) throw new Error("Preview seeds must be different from each other.");
  } else {
    const count = options.count ?? DEFAULT_VOICE_DESIGN_PREVIEW_COUNT;
    if (!Number.isInteger(count) || count < 1 || count > MAX_VOICE_DESIGN_PREVIEW_COUNT) {
      throw new Error(`Request between 1 and ${MAX_VOICE_DESIGN_PREVIEW_COUNT} previews.`);
    }
    seeds = planVariationSeeds(options.baseSeed ?? randomSeed(), count);
  }
  if (seeds.length < 1 || seeds.length > MAX_VOICE_DESIGN_PREVIEW_COUNT) {
    throw new Error(`Request between 1 and ${MAX_VOICE_DESIGN_PREVIEW_COUNT} previews.`);
  }

  const base = { description: design.description, language };
  return {
    ...base,
    previewText,
    ...(design.profileRepo ? { profileRepo: design.profileRepo } : {}),
    requests: seeds.map((seed, position) => previewRequest(base, seed, position, options.extraSettings)),
  };
}

export type VoiceDesignPreviewStatus = "pending" | "rendering" | "ready" | "failed";

export interface VoiceDesignPreviewResult {
  requestId: string;
  status: VoiceDesignPreviewStatus;
  samples?: Float32Array;
  sampleRate?: number;
  /** Time to first audio, for showing how quickly the profile responds. */
  firstAudioMs?: number | null;
  error?: string;
}

export interface VoiceDesignPreviewSession {
  plan: VoiceDesignPreviewPlan;
  results: Readonly<Record<string, VoiceDesignPreviewResult>>;
  selectedId: string | null;
}

export type VoiceDesignPreviewAction =
  | { type: "rendering"; requestId: string }
  | { type: "ready"; requestId: string; samples: Float32Array; sampleRate: number; firstAudioMs: number | null }
  | { type: "failed"; requestId: string; error: string }
  | { type: "select"; requestId: string | null }
  /** Swap one preview for a new seed; its old result and any selection of it go. */
  | { type: "regenerate"; requestId: string; seed: number };

export function createVoiceDesignPreviewSession(plan: VoiceDesignPreviewPlan): VoiceDesignPreviewSession {
  const results: Record<string, VoiceDesignPreviewResult> = {};
  for (const request of plan.requests) results[request.id] = { requestId: request.id, status: "pending" };
  return { plan, results, selectedId: null };
}

/**
 * Pure state transitions for a preview session. Updates for requests that
 * are no longer in the plan (a late result after a regenerate) are ignored,
 * and only a ready preview can be selected.
 */
export function voiceDesignPreviewReducer(
  session: VoiceDesignPreviewSession,
  action: VoiceDesignPreviewAction,
): VoiceDesignPreviewSession {
  if (action.type === "select") {
    if (action.requestId === null) return session.selectedId === null ? session : { ...session, selectedId: null };
    if (session.results[action.requestId]?.status !== "ready" || session.selectedId === action.requestId) return session;
    return { ...session, selectedId: action.requestId };
  }
  if (!Object.hasOwn(session.results, action.requestId)) return session;

  switch (action.type) {
    case "rendering":
      return { ...session, results: { ...session.results, [action.requestId]: { requestId: action.requestId, status: "rendering" } } };
    case "ready":
      return {
        ...session,
        results: {
          ...session.results,
          [action.requestId]: {
            requestId: action.requestId,
            status: "ready",
            samples: action.samples,
            sampleRate: action.sampleRate,
            firstAudioMs: action.firstAudioMs,
          },
        },
      };
    case "failed":
      return {
        ...session,
        results: { ...session.results, [action.requestId]: { requestId: action.requestId, status: "failed", error: action.error } },
        selectedId: session.selectedId === action.requestId ? null : session.selectedId,
      };
    case "regenerate": {
      const seed = normalizeSeed(action.seed);
      const position = session.plan.requests.findIndex((request) => request.id === action.requestId);
      if (session.plan.requests.some((request) => request.seed === seed)) {
        throw new Error("That seed is already one of the previews.");
      }
      const previous = session.plan.requests[position];
      const replacement = previewRequest(session.plan, seed, position, previous.preset.settings.extra);
      const requests = session.plan.requests.map((request, index) => (index === position ? replacement : request));
      const results = { ...session.results };
      delete results[action.requestId];
      results[replacement.id] = { requestId: replacement.id, status: "pending" };
      return {
        plan: { ...session.plan, requests },
        results,
        selectedId: session.selectedId === action.requestId ? null : session.selectedId,
      };
    }
  }
}

/** A fresh seed for regenerating one preview, never one already in the plan. */
export function nextPreviewSeed(plan: VoiceDesignPreviewPlan, baseSeed: number = randomSeed()): number {
  return planVariationSeeds(baseSeed, 1, plan.requests.map((request) => request.seed))[0];
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The preview failed to render.";
}

/**
 * Render previews one after another (the bridge serves one request at a time)
 * into their own buffers, kept apart from the main player. A preview that
 * fails is marked failed and the rest still render; an abort stops the run
 * and rejects. Pass `requestIds` to render only some, such as one that was
 * just regenerated.
 */
export async function renderVoiceDesignPreviews(options: {
  plan: VoiceDesignPreviewPlan;
  synthesize: PresetSynthesize;
  dispatch: (action: VoiceDesignPreviewAction) => void;
  signal?: AbortSignal;
  requestIds?: readonly string[];
  now?: () => number;
}): Promise<void> {
  const signal = options.signal ?? new AbortController().signal;
  const wanted = options.requestIds ? new Set(options.requestIds) : null;
  for (const request of options.plan.requests) {
    if (wanted && !wanted.has(request.id)) continue;
    signal.throwIfAborted();
    options.dispatch({ type: "rendering", requestId: request.id });
    try {
      const audio = await collectSynthesizedAudio(
        options.synthesize(options.plan.previewText, request.preset, signal),
        signal,
        options.now,
      );
      options.dispatch({ type: "ready", requestId: request.id, ...audio });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      options.dispatch({ type: "failed", requestId: request.id, error: errorMessage(error) });
    }
  }
}

function selectedPreview(session: VoiceDesignPreviewSession): {
  request: VoiceDesignPreviewRequest;
  samples: Float32Array;
  sampleRate: number;
} {
  const request = session.plan.requests.find((item) => item.id === session.selectedId);
  const result = request ? session.results[request.id] : undefined;
  if (!request || result?.status !== "ready" || !result.samples || !result.sampleRate) {
    throw new Error("Choose a finished preview first.");
  }
  return { request, samples: result.samples, sampleRate: result.sampleRate };
}

export interface SavePreviewDetails {
  name: string;
  description?: string;
  tags?: readonly string[];
  favorite?: boolean;
}

/** The selected preview as a designed voice: description, seed and sample. */
export function designedVoiceFromPreview(session: VoiceDesignPreviewSession, details: SavePreviewDetails): NewDesignedVoice {
  const { request, samples, sampleRate } = selectedPreview(session);
  const sample = resampleAudio(samples, sampleRate, REFERENCE_TARGET_SAMPLE_RATE);
  const { plan } = session;
  return {
    kind: "designed",
    name: details.name,
    description: details.description,
    tags: details.tags,
    favorite: details.favorite,
    design: {
      description: plan.description,
      seed: request.seed,
      language: plan.language,
      previewText: plan.previewText,
      ...(plan.profileRepo ? { profileRepo: plan.profileRepo } : {}),
    },
    sampleWav: encodeWavPcm16(sample, REFERENCE_TARGET_SAMPLE_RATE),
  };
}

export interface PreviewCloneReference {
  voice: NewClonedVoice;
  /** Warnings from the reference checks, worth showing before saving. */
  warnings: ReferenceCheck[];
}

/**
 * The selected preview as a clone reference: its audio with silent edges
 * trimmed, at the clone rate, and the preview text as the exact transcript.
 * Only silence is trimmed, so the transcript stays exact. Throws with the
 * checks' guidance when the clip fails a target's hard limits.
 */
export function cloneReferenceFromPreview(
  session: VoiceDesignPreviewSession,
  details: SavePreviewDetails & { targets?: readonly ReferenceCloneTarget[]; designedFromId?: string },
): PreviewCloneReference {
  const { samples, sampleRate } = selectedPreview(session);
  const targets = details.targets ?? ["qwen3-base"];
  const wav = encodeWavPcm16(samples, sampleRate);
  const warnings: ReferenceCheck[] = [];
  let referenceWav: Uint8Array | null = null;
  for (const target of targets) {
    const prepared = prepareReferenceClip(wav, { target, transcript: session.plan.previewText, autoTrim: true });
    const failures = prepared.assessment.checks.filter((check) => check.status === "fail");
    if (failures.length > 0) {
      throw new Error(failures.map((check) => [check.message, check.fix].filter(Boolean).join(" ")).join(" "));
    }
    for (const check of prepared.assessment.checks) {
      if (check.status === "warn" && !warnings.some((existing) => existing.id === check.id)) warnings.push(check);
    }
    // Preparation does not depend on the target, so every pass yields the same clip.
    referenceWav = prepared.wav;
  }
  if (!referenceWav) throw new Error("Choose at least one clone target.");
  return {
    voice: {
      kind: "cloned",
      name: details.name,
      description: details.description,
      tags: details.tags,
      favorite: details.favorite,
      transcript: session.plan.previewText,
      language: session.plan.language,
      targets,
      source: "voiceDesign",
      referenceWav,
      ...(details.designedFromId ? { designedFromId: details.designedFromId } : {}),
    },
    warnings,
  };
}

/**
 * Save the selected preview: always as a designed voice and, when asked, also
 * as a Qwen3 Base clone linked back to it. The clone is validated before
 * anything is written, so a failing clip never leaves a half-saved pair.
 */
export async function saveSelectedPreview(
  library: { createVoice(input: NewDesignedVoice | NewClonedVoice): Promise<VoiceRecord> },
  session: VoiceDesignPreviewSession,
  details: SavePreviewDetails & { alsoClone?: boolean; cloneName?: string },
): Promise<{ designed: VoiceRecord; cloned: VoiceRecord | null; warnings: ReferenceCheck[] }> {
  const designedInput = designedVoiceFromPreview(session, details);
  const clone = details.alsoClone
    ? cloneReferenceFromPreview(session, { ...details, name: details.cloneName ?? details.name })
    : null;
  const designed = await library.createVoice(designedInput);
  if (!clone) return { designed, cloned: null, warnings: [] };
  const cloned = await library.createVoice({ ...clone.voice, designedFromId: designed.id });
  return { designed, cloned, warnings: clone.warnings };
}

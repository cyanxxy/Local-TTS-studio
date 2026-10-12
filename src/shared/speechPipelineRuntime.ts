/**
 * Runs the spoken-text pipeline (`lib/speechPipeline.ts`) in front of every
 * engine runtime, so a dictionary rule, normalization or a break tag behaves
 * the same on every engine.
 */
import { flattenPronunciationDictionaries, type PronunciationDictionary } from "../lib/pronunciation/dictionary";
import {
  buildSpeechPlan,
  createChunkRemapper,
  type SpeechBreakBoundary,
  type SpeechPipelineSettings,
} from "../lib/speechPipeline";
import { getEngine, type SurfaceEngineId, type SurfaceEngineSettings } from "../models/registry";
import type { EngineRuntime, EngineRuntimeMap, SynthesisChunk, SynthesisRequest } from "./engineRuntime";

/** The Creator controls of the pipeline; each engine's language completes them. */
export interface SpeechPipelineChoices {
  dictionaries: readonly PronunciationDictionary[];
  normalize: boolean;
  cleanup: boolean;
}

const KOKORO_VOICE_LANGUAGES: Readonly<Record<string, string>> = {
  a: "en-US",
  b: "en-GB",
  e: "es",
  f: "fr",
  h: "hi",
  i: "it",
  j: "ja",
  p: "pt",
  z: "zh",
};

const QWEN3_LANGUAGE_TAGS: Readonly<Record<string, string>> = {
  Chinese: "zh",
  English: "en",
  Japanese: "ja",
  Korean: "ko",
  German: "de",
  French: "fr",
  Russian: "ru",
  Portuguese: "pt",
  Spanish: "es",
  Italian: "it",
};

/** Marks a language the pipeline cannot know: no normalizer runs and tagged dictionaries stay out. */
const UNKNOWN_LANGUAGE = "und";

/**
 * The BCP-47 language an engine speaks with its current settings, or
 * undefined when it speaks English by default.
 */
export function engineSpeechLanguage(
  id: SurfaceEngineId,
  settings: Pick<SurfaceEngineSettings, "kokoro" | "supertonic" | "supertonic3" | "qwen3">,
): string | undefined {
  switch (id) {
    case "kokoro": {
      // Built-in voices are named "<language letter><gender letter>_<name>".
      const prefix = /^([a-z])[fm]_/.exec(settings.kokoro.voice)?.[1];
      return prefix === undefined ? undefined : (KOKORO_VOICE_LANGUAGES[prefix] ?? UNKNOWN_LANGUAGE);
    }
    case "supertonic":
      return settings.supertonic.language;
    case "supertonic3":
      return settings.supertonic3.language;
    case "qwen3":
      return QWEN3_LANGUAGE_TAGS[settings.qwen3.language] ?? UNKNOWN_LANGUAGE;
    default:
      return undefined;
  }
}

/**
 * How a pause is forced in the text an engine receives. Engines that stream
 * model text units (Qwen3) merge short paragraphs into one unit, so they split
 * their requests at pause marks instead.
 */
export function speechBreakBoundary(id: SurfaceEngineId): SpeechBreakBoundary {
  return getEngine(id).capabilities.streamingGranularity === "unit" ? "mark" : "paragraph";
}

/** The pipeline settings for one engine's language. */
export function resolveSpeechPipelineSettings(
  choices: SpeechPipelineChoices,
  language: string | undefined,
): SpeechPipelineSettings {
  return {
    rules: flattenPronunciationDictionaries(choices.dictionaries, { language }).rules,
    normalize: choices.normalize,
    cleanup: choices.cleanup,
    language,
  };
}

async function* remapChunks(
  chunks: AsyncIterable<SynthesisChunk>,
  remapper: ReturnType<typeof createChunkRemapper>,
): AsyncGenerator<SynthesisChunk, void, undefined> {
  for await (const chunk of chunks) yield remapper.map(chunk);
}

/**
 * `runtime` with a `synthesize` that speaks the pipeline's spoken form of the
 * request text and reports chunks against the text it was given. The request
 * is queued at once, as it is without the wrapper.
 *
 * The pipeline owns the pronunciation rules, so the engine's own copy of them
 * is cleared: applying them twice could rewrite a replacement.
 */
export function withSpeechPipeline<Id extends SurfaceEngineId>(
  id: Id,
  runtime: EngineRuntime<Id>,
  resolveSettings: (id: Id) => SpeechPipelineSettings,
): EngineRuntime<Id> {
  const boundary = speechBreakBoundary(id);
  return {
    ...runtime,
    synthesize: (request: SynthesisRequest<Id>) => {
      const plan = buildSpeechPlan(request.text, resolveSettings(id), boundary);
      const inner = runtime.synthesize({
        ...request,
        text: plan.spoken,
        tuning: { ...request.tuning, pronunciationRules: [] },
      });
      return plan.identity ? inner : remapChunks(inner, createChunkRemapper(plan));
    },
  };
}

/** `withSpeechPipeline` for every runtime in the map. */
export function withSpeechPipelineAll(
  runtimes: EngineRuntimeMap,
  resolveSettings: (id: SurfaceEngineId) => SpeechPipelineSettings,
): EngineRuntimeMap {
  const entries = Object.entries(runtimes) as unknown as Array<[SurfaceEngineId, EngineRuntime<SurfaceEngineId>]>;
  return Object.fromEntries(
    entries.map(([id, runtime]) => [id, withSpeechPipeline(id, runtime, resolveSettings)]),
  ) as unknown as EngineRuntimeMap;
}

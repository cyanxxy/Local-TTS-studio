import type { LocalTtsGenerateResult } from "../electron";
import { createLocalAudioAssembler } from "../lib/localTtsStream";
import type { TextChunk } from "../lib/chunking";
import { buildQwen3RequestPlan, type Qwen3RequestSection } from "../lib/qwenChunking";
import { qwen3ProfileSupportsInstruct } from "../models/qwen3";
import { createAsyncChannel } from "../shared/asyncChannel";
import type { Qwen3SynthesisSettings, SynthesisChunk, SynthesisRequest } from "../shared/engineRuntime";

export type LocalTtsBridge = NonNullable<NonNullable<Window["electron"]>["localTts"]>;

const LOCAL_MODEL = "qwen3";
/** The pause the renderer restores between request sections; Rust only pauses within one request. */
export const QWEN3_SECTION_JOIN_PAUSE_SEC = 0.2;
const REFERENCE_CACHE_MISS = /reference cache entry was not found/i;

export function qwen3RequestId(kind: "probe" | "generate" | "job"): string {
  return `${LOCAL_MODEL}-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function qwen3ErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export function isQwen3ReferenceCacheMiss(error: unknown): boolean {
  return REFERENCE_CACHE_MISS.test(qwen3ErrorMessage(error));
}

/**
 * The text unit a streamed chunk speaks. Rust reports `textUnitIndex` within
 * one request; older bridges omit it, and then the chunk index stands in.
 */
export function qwen3ChunkTextUnitIndex(
  chunk: { textUnitIndex?: number },
  chunkIndex: number,
  declaredTotal: number,
  section: Pick<Qwen3RequestSection, "unitStart" | "unitEnd">,
  unitCount: number,
): number {
  const sectionUnitCount = section.unitEnd - section.unitStart;
  const reported = chunk.textUnitIndex
    ?? (declaredTotal > 0 ? chunkIndex : sectionUnitCount === 1 ? 0 : chunkIndex);
  const local = Math.min(Math.max(0, reported), Math.max(0, sectionUnitCount - 1));
  return Math.min(section.unitStart + local, Math.max(0, unitCount - 1));
}

/** The `generate` payload fields every section of one job shares. */
export function qwen3BasePayload(settings: Qwen3SynthesisSettings, seed: number | null): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    mode: settings.profile.mode,
    modelRepo: settings.profile.repo,
    modelPath: settings.modelPath.trim(),
    language: settings.language,
    temperature: settings.temperature,
    topK: settings.topK,
    maxNewTokens: settings.maxNewTokens,
    ...(seed !== null ? { seed } : {}),
  };
  if (settings.profile.mode === "customVoice") {
    payload.speaker = settings.speaker;
    payload.instruct = qwen3ProfileSupportsInstruct(settings.profile) ? settings.instruct : "";
  } else if (settings.profile.mode === "voiceDesign") {
    payload.instruct = settings.instruct;
  }
  return payload;
}

/** The reference fields of a section payload: the clip itself only when the bridge needs it. */
export function qwen3ReferencePayload(
  settings: Qwen3SynthesisSettings,
  jobId: string,
  uploadReference: boolean,
): Record<string, unknown> {
  if (settings.profile.mode !== "voiceClone") return {};
  return uploadReference
    ? {
        referenceAudioBase64: settings.referenceAudioBase64,
        referenceText: settings.referenceText.trim(),
        referenceCacheKey: jobId,
      }
    : { referenceCacheKey: jobId };
}

/** Why `settings` cannot render anything yet, or null when they can. */
export function qwen3SettingsProblem(settings: Qwen3SynthesisSettings): string | null {
  if (settings.modelPath.trim().length === 0) {
    return "Select or download a valid Qwen3 model directory before generating.";
  }
  if (settings.profile.mode === "voiceDesign" && settings.instruct.trim().length === 0) {
    return "Describe the VoiceDesign voice before generating.";
  }
  if (settings.profile.mode === "voiceClone"
    && (!settings.referenceAudioBase64 || settings.referenceText.trim().length === 0)) {
    return "Choose a reference clip and type what it says before generating.";
  }
  return null;
}

interface SectionContext {
  bridge: LocalTtsBridge;
  settings: Qwen3SynthesisSettings;
  basePayload: Record<string, unknown>;
  jobId: string;
  sections: Qwen3RequestSection[];
  units: TextChunk[];
  text: string;
  signal: AbortSignal;
}

/**
 * Streams one bridge request: its audio events arrive out of band, are put back
 * in index order and yielded as they become contiguous, and the request ends
 * once the bridge's result and every chunk it declared have both arrived.
 */
async function* streamSection(
  context: SectionContext,
  sectionIndex: number,
  uploadReference: boolean,
  onChunk: () => void,
): AsyncGenerator<SynthesisChunk, LocalTtsGenerateResult, undefined> {
  const { bridge, settings, sections, units, text, signal } = context;
  const section = sections[sectionIndex];
  const requestId = qwen3RequestId("generate");
  const channel = createAsyncChannel<SynthesisChunk>();
  let expectedChunks: number | null = null;
  let result: LocalTtsGenerateResult | null = null;
  let settled = false;

  const assembler = createLocalAudioAssembler((part) => {
    const unitIndex = qwen3ChunkTextUnitIndex(part, part.chunkIndex, part.declaredTotal, section, units.length);
    const unit = units[unitIndex];
    channel.push({
      audio: part.samples,
      samplingRate: part.sampleRate,
      text: unit?.text ?? text,
      index: unitIndex + 1,
      total: units.length || 1,
      textStart: unit?.start ?? 0,
      textEnd: unit?.end ?? text.length,
      pauseAfterSec: part.pauseAfterSec,
    });
  });
  const finishIfComplete = () => {
    if (expectedChunks !== null && assembler.receivedCount >= expectedChunks) channel.close();
  };
  const unsubscribe = bridge.subscribeAudioChunk((event) => {
    if (event.model !== LOCAL_MODEL || event.requestId !== requestId) return;
    assembler.accept(event);
    finishIfComplete();
  });
  const cancelRequest = () => {
    if (settled) return;
    settled = true;
    void Promise.resolve(bridge.cancel({ model: LOCAL_MODEL, requestId })).catch(() => undefined);
  };
  const onAbort = () => {
    cancelRequest();
    channel.fail(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  bridge.generate({
    model: LOCAL_MODEL,
    requestId,
    continuation: { jobId: context.jobId, sectionIndex, sectionCount: sections.length },
    payload: {
      ...context.basePayload,
      text: section.text,
      ...qwen3ReferencePayload(settings, context.jobId, uploadReference),
    },
  }).then((generated) => {
    settled = true;
    result = generated;
    expectedChunks = generated.audioChunkCount;
    finishIfComplete();
    // The result arrives only after the preload has delivered every chunk of
    // the request, so audio still missing here will never come.
    if (!channel.settled) channel.fail(new Error("Generation returned incomplete streamed audio."));
  }, (error: unknown) => {
    settled = true;
    channel.fail(error);
  });

  try {
    for await (const chunk of channel) {
      onChunk();
      yield chunk;
    }
    signal.throwIfAborted();
    return result!;
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", onAbort);
    // Stopping early (the reader broke off, or a chunk failed) leaves the
    // bridge request running unless it is told.
    cancelRequest();
  }
}

/**
 * Renders a whole request through the Qwen3 bridge, independently of the
 * runtime's surface generation: the text is split into the same request
 * sections the surface uses, each section streams its audio as it arrives,
 * and a short pause joins consecutive sections.
 *
 * A voice-clone job uploads its reference with the first section and reuses
 * the bridge's cached copy after that. If the cache was lost between sections
 * before any of a section's audio arrived, the section is retried once with
 * the reference uploaded again.
 */
export async function* streamQwen3Synthesis(
  bridge: LocalTtsBridge,
  request: Pick<SynthesisRequest<"qwen3">, "text" | "settings" | "seed">,
  signal: AbortSignal,
): AsyncGenerator<SynthesisChunk, void, undefined> {
  const { settings } = request;
  const problem = qwen3SettingsProblem(settings);
  if (problem) throw new Error(problem);
  const plan = buildQwen3RequestPlan(request.text);
  const context: SectionContext = {
    bridge,
    settings,
    basePayload: qwen3BasePayload(settings, request.seed ?? settings.seed),
    jobId: qwen3RequestId("job"),
    sections: plan.sections,
    units: plan.units,
    text: request.text,
    signal,
  };

  try {
    for (let sectionIndex = 0; sectionIndex < plan.sections.length; sectionIndex += 1) {
      signal.throwIfAborted();
      const uploadsReference = settings.profile.mode === "voiceClone" && sectionIndex === 0;
      let streamedChunks = 0;
      let generated: LocalTtsGenerateResult;
      try {
        generated = yield* streamSection(context, sectionIndex, uploadsReference, () => {
          streamedChunks += 1;
        });
      } catch (error) {
        if (signal.aborted || uploadsReference || streamedChunks > 0 || !isQwen3ReferenceCacheMiss(error)) throw error;
        generated = yield* streamSection(context, sectionIndex, true, () => undefined);
      }

      if (sectionIndex < plan.sections.length - 1) {
        const section = plan.sections[sectionIndex];
        const unitIndex = Math.max(section.unitStart, section.unitEnd - 1);
        const unit = plan.units[unitIndex];
        yield {
          audio: new Float32Array(Math.max(1, Math.round(generated.sampleRate * QWEN3_SECTION_JOIN_PAUSE_SEC))),
          samplingRate: generated.sampleRate,
          text: unit?.text ?? section.text,
          index: unitIndex + 1,
          total: plan.units.length || 1,
          textStart: unit?.start ?? section.start,
          textEnd: unit?.end ?? section.end,
          pauseAfterSec: QWEN3_SECTION_JOIN_PAUSE_SEC,
          pauseKind: "sentence",
        };
      }
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(qwen3ErrorMessage(error));
  }
}

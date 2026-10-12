import { concatFloat32Arrays, createSilence } from "../lib/audio";
import { resolvePauseSeconds, tuneChunkText } from "../lib/textTuning";
import { chunkAudio8Text } from "../models/audio8";
import { abortable } from "../shared/asyncChannel";
import type { SynthesisChunk } from "../shared/engineRuntime";
import type { GenerationTuningSettings } from "../types";

export type Audio8Bridge = NonNullable<NonNullable<Window["electron"]>["audio8"]>;

export function audio8RequestId(kind: string): string {
  return `audio8-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function audio8ErrorMessage(error: unknown): string {
  // `ipcRenderer.invoke` wraps every main-process rejection as
  // "Error invoking remote method '<channel>': Error: <message>". The channel
  // name is noise to the reader, so strip the wrapper and keep the cause.
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export interface Audio8SynthesisInput {
  text: string;
  voice: string;
  tuning: GenerationTuningSettings;
  /** Sampling for the whole request; a seed is stepped per passage so passages differ but repeat. */
  sampling?: { seed: number | null; temperature: number | null };
}

/** Hears which bridge request renders which passage, e.g. to route its progress events. */
export type Audio8RequestObserver = (requestId: string, passageIndex: number, passageCount: number) => void;

/**
 * Renders `text` passage by passage through the Audio8 bridge, one IPC request
 * per passage, yielding each passage with its pause already appended. The
 * passages are the ones the Reader previews for Audio8.
 *
 * Aborting `signal` cancels the request in flight and rejects with the signal's
 * reason; nothing after it is requested. A bridge failure rejects with its
 * cause, minus Electron's IPC wrapper.
 */
export async function* streamAudio8Synthesis(
  bridge: Audio8Bridge,
  { text, voice, tuning, sampling }: Audio8SynthesisInput,
  signal: AbortSignal,
  onRequest?: Audio8RequestObserver,
): AsyncGenerator<SynthesisChunk, void, undefined> {
  const passages = chunkAudio8Text(text);
  for (let index = 0; index < passages.length; index += 1) {
    signal.throwIfAborted();
    const passage = passages[index];
    const requestId = audio8RequestId("generate");
    onRequest?.(requestId, index, passages.length);
    const cancel = () => {
      void bridge.cancel({ requestId }).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    let result: Awaited<ReturnType<Audio8Bridge["generate"]>>;
    try {
      const tuned = tuneChunkText(passage.text, tuning.pronunciationRules ?? [], tuning.emphasisStrength ?? 0);
      result = await abortable(bridge.generate({
        requestId,
        text: tuned,
        voice,
        ...(sampling?.seed != null ? { seed: (sampling.seed + index) >>> 0 } : {}),
        ...(sampling?.temperature != null ? { temperature: sampling.temperature } : {}),
      }), signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new Error(audio8ErrorMessage(error));
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    // `Audio8GenerateResult` promises both fields, but nothing validates the
    // payload as it crosses IPC — the declaration is the renderer's assertion
    // about the main process, not a checked contract. Both failures are silent
    // rather than loud without this guard: `new Float32Array(undefined)` yields
    // an empty array, and a zero sample rate turns every derived duration into
    // NaN. A generation that "succeeds" with no audio is the worst outcome here.
    if (!(result.audio instanceof ArrayBuffer) || !result.sampleRate) throw new Error("Audio8 returned invalid local audio.");
    const generated = new Float32Array(result.audio);
    const pauseSec = index + 1 === passages.length
      ? 0
      : resolvePauseSeconds(passage.pauseKind, passage.pauseAfterSec, tuning.pauseOverridesSec);
    yield {
      audio: pauseSec > 0 ? concatFloat32Arrays([generated, createSilence(pauseSec, result.sampleRate)]) : generated,
      samplingRate: result.sampleRate,
      text: passage.text,
      index: index + 1,
      total: passages.length,
      textStart: passage.start,
      textEnd: passage.end,
      pauseAfterSec: pauseSec,
      pauseKind: passage.pauseKind,
    };
  }
}

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAudioSignature, buildReaderSections, createReaderAudioCacheKey, createReaderDocument } from "../lib/readerDocument";
import type { CachedReaderAudio } from "../lib/readerDocument";
import { createAbortError } from "../shared/asyncChannel";
import type { SynthesisChunk, SynthesisRequest } from "../shared/engineRuntime";
import {
  READER_LOOKAHEAD_MAX_BYTES,
  useReaderLookahead,
} from "./useReaderLookahead";

const book = createReaderDocument({
  id: "lookahead-book",
  text: "A paragraph long enough to fill several sections. ".repeat(900),
});
const sections = buildReaderSections(book.text, book.chapters);
const nextSection = sections[1];
const nextText = book.text.slice(nextSection.start, nextSection.end);
const parts = { voice: "af_heart", tuning: {}, legacy: { voice: "af_heart", quality: 5, tuning: { speed: 1, quality: 5 } } };
const signatureFor = (voice = "af_heart") => buildAudioSignature({
  text: nextText,
  model: "kokoro",
  ...parts,
  voice,
});

const pcm = (value: number): SynthesisChunk => ({
  audio: new Float32Array(24_000).fill(value),
  samplingRate: 24_000,
  text: "A passage.",
  index: 1,
  total: 0,
});

/** A synthesize that yields `chunks` and stays open until `finish()` is called. */
function controllableSynthesis(chunks: SynthesisChunk[]) {
  const requests: SynthesisRequest[] = [];
  let finish: () => void = () => undefined;
  const synthesize = vi.fn((request: SynthesisRequest) => {
    requests.push(request);
    return (async function* () {
      for (const chunk of chunks) yield chunk;
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason ?? createAbortError("x")), { once: true });
      });
    })();
  });
  return { synthesize, requests, finish: () => finish() };
}

interface Props {
  enabled?: boolean;
  playing?: boolean;
  voice?: string;
  engineBusy?: boolean;
  engineId?: "kokoro" | "qwen3";
  hasAudio?: boolean;
  nextText?: string;
  isRetaking?: boolean;
}

function setup(synthesis: ReturnType<typeof controllableSynthesis>, initial: Props = {}) {
  const library = {
    hasAudio: vi.fn(async () => initial.hasAudio ?? false),
    saveAudio: vi.fn<(audio: CachedReaderAudio) => Promise<void>>(async () => undefined),
  };
  const onFailure = vi.fn();
  const view = renderHook((props: Props) => useReaderLookahead({
    enabled: props.enabled ?? true,
    active: true,
    document: book,
    nextSection,
    nextSectionText: props.nextText ?? nextText,
    engineId: props.engineId ?? "kokoro",
    signatureParts: { ...parts, voice: props.voice ?? "af_heart" },
    renderSection: (text: string, signal: AbortSignal) => synthesis.synthesize({
      text,
      settings: { voice: props.voice ?? "af_heart" },
      tuning: { speed: 1, quality: 5 },
      signal,
    }),
    engineBusy: props.engineBusy ?? false,
    modelReady: true,
    currentSectionPlaying: props.playing ?? true,
    isRetaking: props.isRetaking ?? false,
    library,
    onFailure,
  }), { initialProps: initial });
  return { ...view, library, onFailure };
}

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

describe("useReaderLookahead", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the next section into the audio cache once the current one is playing", async () => {
    const synthesis = controllableSynthesis([pcm(0.1), pcm(0.2)]);
    const { result, library } = setup(synthesis);
    await settle();
    expect(result.current.status).toBe("rendering");
    expect(synthesis.requests[0]).toMatchObject({ text: nextText, settings: { voice: "af_heart" } });
    expect(library.saveAudio).not.toHaveBeenCalled();

    synthesis.finish();
    await settle();
    expect(result.current.status).toBe("ready");
    const saved = library.saveAudio.mock.calls[0][0];
    expect(saved).toMatchObject({
      cacheKey: createReaderAudioCacheKey(book.id, nextSection.id),
      documentId: book.id,
      sectionId: nextSection.id,
      chapterId: nextSection.chapterId,
      signature: signatureFor(),
      synthesisComplete: true,
      currentTime: 0,
    });
    expect(saved.chunks).toHaveLength(2);
    expect(saved.chunks.every((chunk) => chunk.total === 2)).toBe(true);
    expect(saved.totalDuration).toBeCloseTo(2);
    expect(result.current.sectionId).toBe(nextSection.id);
  });

  it("waits for playback, and keeps rendering when playback pauses", async () => {
    const synthesis = controllableSynthesis([pcm(0.1)]);
    const { result, rerender } = setup(synthesis, { playing: false });
    await settle();
    expect(synthesis.synthesize).not.toHaveBeenCalled();
    expect(result.current.status).toBe("waiting");

    rerender({ playing: true });
    await settle();
    expect(synthesis.synthesize).toHaveBeenCalledTimes(1);

    rerender({ playing: false });
    await settle();
    expect(synthesis.requests[0].signal?.aborted).toBe(false);
    expect(result.current.status).toBe("rendering");
  });

  it("does not render what is already cached under the same signature", async () => {
    const synthesis = controllableSynthesis([pcm(0.1)]);
    const { result, library } = setup(synthesis, { hasAudio: true });
    await settle();
    expect(library.hasAudio).toHaveBeenCalledWith(book.id, nextSection.id, signatureFor());
    expect(synthesis.synthesize).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
  });

  it("soft-aborts when the voice changes, and renders again under the new signature", async () => {
    const synthesis = controllableSynthesis([pcm(0.1)]);
    const { result, rerender, library } = setup(synthesis);
    await settle();
    rerender({ voice: "am_adam" });
    await settle();

    expect(synthesis.requests[0].signal?.aborted).toBe(true);
    expect(synthesis.requests).toHaveLength(2);
    expect(synthesis.requests[1].settings).toMatchObject({ voice: "am_adam" });
    synthesis.finish();
    await settle();
    expect(library.saveAudio).toHaveBeenCalledTimes(1);
    expect(library.saveAudio.mock.calls[0][0].signature).toBe(signatureFor("am_adam"));
    expect(result.current.status).toBe("ready");
  });

  it("aborts, and saves nothing, when the engine takes up its own generation", async () => {
    const synthesis = controllableSynthesis([pcm(0.1)]);
    const { result, rerender, library } = setup(synthesis);
    await settle();
    rerender({ engineBusy: true });
    await settle();
    expect(synthesis.requests[0].signal?.aborted).toBe(true);
    expect(library.saveAudio).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("aborts on a segment retake, when turned off, and on unmount", async () => {
    const retake = controllableSynthesis([pcm(0.1)]);
    const first = setup(retake);
    await settle();
    first.rerender({ isRetaking: true });
    expect(retake.requests[0].signal?.aborted).toBe(true);

    const off = controllableSynthesis([pcm(0.1)]);
    const second = setup(off);
    await settle();
    second.rerender({ enabled: false });
    expect(off.requests[0].signal?.aborted).toBe(true);

    const gone = controllableSynthesis([pcm(0.1)]);
    const third = setup(gone);
    await settle();
    third.unmount();
    expect(gone.requests[0].signal?.aborted).toBe(true);
  });

  it("yields the engine on request and reports when it has wound down", async () => {
    const synthesis = controllableSynthesis([pcm(0.1)]);
    const { result } = setup(synthesis);
    await settle();
    expect(result.current.isBusy()).toBe(true);

    let busyWhenSettled: boolean | null = null;
    act(() => {
      result.current.preempt();
      void result.current.settled().then(() => { busyWhenSettled = result.current.isBusy(); });
    });
    expect(synthesis.requests[0].signal?.aborted).toBe(true);
    await settle();
    expect(busyWhenSettled).toBe(false);
  });

  it("starts a render that yielded over once it has wound down, unless what it yielded to took the engine", async () => {
    const synthesis = controllableSynthesis([pcm(0.1)]);
    const { result, rerender } = setup(synthesis);
    await settle();
    expect(result.current.status).toBe("rendering");

    // Nothing takes the engine after all: the render starts over.
    act(() => result.current.preempt());
    await settle();
    await settle();
    expect(synthesis.synthesize).toHaveBeenCalledTimes(2);
    expect(synthesis.requests[1].signal?.aborted).toBe(false);
    expect(result.current.status).toBe("rendering");

    // A generation takes the engine: the render waits for it to end.
    act(() => {
      result.current.preempt();
      rerender({ engineBusy: true });
    });
    await settle();
    await settle();
    expect(synthesis.synthesize).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("idle");

    rerender({ engineBusy: false });
    await settle();
    expect(synthesis.synthesize).toHaveBeenCalledTimes(3);
  });

  it("does not start a second render for a section it already finished", async () => {
    const synthesis = controllableSynthesis([pcm(0.1)]);
    const { rerender } = setup(synthesis);
    await settle();
    synthesis.finish();
    await settle();
    rerender({ playing: false });
    rerender({ playing: true });
    await settle();
    expect(synthesis.synthesize).toHaveBeenCalledTimes(1);
  });

  it("skips a section whose audio would not fit the memory budget", async () => {
    const synthesis = controllableSynthesis([pcm(0.1)]);
    const huge = "word ".repeat(Math.ceil((READER_LOOKAHEAD_MAX_BYTES / (24_000 * 4)) * 14 / 5) + 100);
    const { result } = setup(synthesis, { nextText: huge });
    await settle();
    expect(result.current.status).toBe("skipped");
    expect(synthesis.synthesize).not.toHaveBeenCalled();
  });

  it("logs a failed render without surfacing it, and does not retry it", async () => {
    const failing = {
      synthesize: vi.fn(() => (async function* () {
        yield pcm(0.1);
        throw new Error("engine fell over");
      })()),
      requests: [],
      finish: () => undefined,
    } as unknown as ReturnType<typeof controllableSynthesis>;
    const { result, onFailure, library, rerender } = setup(failing);
    await settle();
    expect(result.current.status).toBe("failed");
    expect(onFailure).toHaveBeenCalledWith(new Error("engine fell over"));
    expect(library.saveAudio).not.toHaveBeenCalled();
    rerender({ playing: false });
    rerender({ playing: true });
    await settle();
    expect(failing.synthesize).toHaveBeenCalledTimes(1);
  });
});

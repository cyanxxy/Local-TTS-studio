import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalTtsAudioChunkEvent, LocalTtsAudioGapEvent, LocalTtsAudioStreamEvent, LocalTtsGenerateResult } from "../electron";
import { buildQwen3RequestPlan } from "../lib/qwenChunking";
import { encodeSpeechBreakMark } from "../lib/speechBreakMarks";
import type { Qwen3SynthesisSettings, SynthesisChunk } from "../shared/engineRuntime";
import {
  QWEN3_SECTION_JOIN_PAUSE_SEC,
  qwen3BasePayload,
  qwen3ChunkTextUnitIndex,
  qwen3SettingsProblem,
  streamQwen3Synthesis,
  type LocalTtsBridge,
} from "./qwen3Synthesis";

const SAMPLE_RATE = 24_000;

const SETTINGS: Qwen3SynthesisSettings = {
  profile: {
    repo: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    revision: "rev",
    mode: "customVoice",
    parameters: "1.7B",
    provider: "mlx",
    label: "1.7B CustomVoice",
  },
  modelPath: " /models/qwen3 ",
  speaker: "Aiden",
  language: "English",
  instruct: "Warm and calm.",
  temperature: 0.9,
  topK: 50,
  maxNewTokens: 384,
  seed: null,
  referenceAudioSignature: "",
  referenceText: "",
  referenceAudioBase64: null,
};

type GenerateRequest = Parameters<LocalTtsBridge["generate"]>[0];

/** A bridge whose requests the test settles and streams audio for by hand. */
function createBridge() {
  const listeners = new Set<(event: LocalTtsAudioStreamEvent) => void>();
  const requests: Array<{
    request: GenerateRequest;
    resolve: (result: LocalTtsGenerateResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  const bridge = {
    generate: vi.fn((request: GenerateRequest) => new Promise<LocalTtsGenerateResult>((resolve, reject) => {
      requests.push({ request, resolve, reject });
    })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    subscribeAudioChunk: vi.fn((listener: (event: LocalTtsAudioStreamEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return {
    bridge: bridge as unknown as LocalTtsBridge & typeof bridge,
    requests,
    listenerCount: () => listeners.size,
    emitGap(requestId: string, afterChunkIndex: number, textUnitIndex: number, silenceSamples = 4_800) {
      const event: LocalTtsAudioGapEvent = {
        kind: "gap",
        requestId,
        model: "qwen3",
        afterChunkIndex,
        sampleRate: SAMPLE_RATE,
        silenceSamples,
        textUnitIndex,
        textUnitTotal: 2,
      };
      for (const listener of [...listeners]) listener(event);
    },
    emit(requestId: string, index: number, total: number, extra: Partial<LocalTtsAudioChunkEvent> = {}) {
      const sampleCount = extra.sampleCount ?? 4;
      const event: LocalTtsAudioChunkEvent = {
        requestId,
        model: "qwen3",
        index,
        total,
        sampleRate: SAMPLE_RATE,
        sampleCount,
        silenceAfterSamples: 0,
        audio: new Float32Array(sampleCount).fill(index + 1).buffer,
        ...extra,
      };
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function result(audioChunkCount: number): LocalTtsGenerateResult {
  return {
    sampleRate: SAMPLE_RATE,
    modelRepo: SETTINGS.profile.repo,
    durationSec: 1,
    elapsedSec: 1,
    audioTransport: "websocket-binary",
    audioChunkCount,
    phaseTimingsSec: {},
  };
}

async function collect(iterable: AsyncIterable<SynthesisChunk>): Promise<SynthesisChunk[]> {
  const values: SynthesisChunk[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

/** Lets the stream subscribe and post its next request. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("streamQwen3Synthesis", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts out-of-order audio back in order and ends once the declared chunks arrive", async () => {
    const { bridge, requests, emit, listenerCount } = createBridge();
    // Each sentence is long enough to be a text unit of its own.
    const text = [
      "The first sentence wanders along the harbour road past the lamps and the boats and the nets that dry on the wall, long enough to fill a passage by itself.",
      "The second sentence follows the tide back out beyond the breakwater where the gulls circle the fishing fleet, and it is long enough to stand alone as well.",
    ].join(" ");
    const chunks = collect(streamQwen3Synthesis(bridge, { text, settings: SETTINGS, seed: 7 }, new AbortController().signal));
    await settle();

    const [{ request }] = requests;
    expect(request).toMatchObject({
      model: "qwen3",
      continuation: { sectionIndex: 0, sectionCount: 1 },
      payload: {
        mode: "customVoice",
        modelPath: "/models/qwen3",
        speaker: "Aiden",
        instruct: "Warm and calm.",
        seed: 7,
        text,
      },
    });
    emit("someone-else", 0, 2);
    emit(request.requestId, 1, 2, { textUnitIndex: 1 });
    // A repeat of a delivered chunk changes nothing.
    emit(request.requestId, 1, 2, { textUnitIndex: 1 });
    emit(request.requestId, 0, 2, { textUnitIndex: 0 });
    // The result follows every chunk on the preload's ordered stream.
    requests[0].resolve(result(2));

    const output = await chunks;
    const { units } = buildQwen3RequestPlan(text);
    expect(units).toHaveLength(2);
    expect(output.map((chunk) => chunk.audio[0])).toEqual([1, 2]);
    expect(output.map((chunk) => chunk.text)).toEqual(units.map((unit) => unit.text));
    expect(output[1]).toMatchObject({ index: 2, total: units.length, textStart: units[1].start, textEnd: units[1].end });
    expect(listenerCount()).toBe(0);
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it("yields a unit gap as silence that extends the sentence it ends", async () => {
    const { bridge, requests, emit, emitGap } = createBridge();
    const text = [
      "The first sentence wanders along the harbour road past the lamps and the boats and the nets that dry on the wall, long enough to fill a passage by itself.",
      "The second sentence follows the tide back out beyond the breakwater where the gulls circle the fishing fleet, and it is long enough to stand alone as well.",
    ].join(" ");
    const chunks = collect(streamQwen3Synthesis(bridge, { text, settings: SETTINGS, seed: 3 }, new AbortController().signal));
    await settle();

    const [{ request }] = requests;
    emit(request.requestId, 0, 0, { textUnitIndex: 0, textUnitTotal: 2 });
    emitGap(request.requestId, 0, 0);
    emit(request.requestId, 1, 0, { textUnitIndex: 1, textUnitTotal: 2 });
    requests[0].resolve(result(2));

    const output = await chunks;
    expect(output.map((chunk) => chunk.audio.length)).toEqual([4, 4_800, 4]);
    expect(output[1]).toMatchObject({ index: 1, text: output[0].text, textStart: output[0].textStart, textEnd: output[0].textEnd });
    expect(output[1].pauseAfterSec).toBeCloseTo(0.2);
    expect(output[1].audio.every((sample) => sample === 0)).toBe(true);
    expect(output[2].index).toBe(2);
  });

  it("joins request sections with a short pause and keeps a voice-clone reference cached", async () => {
    const { bridge, requests, emit } = createBridge();
    const text = Array.from({ length: 150 }, (_, index) => `Sentence number ${index} keeps the request long enough.`).join(" ");
    const plan = buildQwen3RequestPlan(text);
    expect(plan.sections.length).toBe(2);
    const clone: Qwen3SynthesisSettings = {
      ...SETTINGS,
      profile: { ...SETTINGS.profile, mode: "voiceClone", repo: "Qwen/Qwen3-TTS-12Hz-1.7B-Base" },
      referenceAudioBase64: "UklGRg==",
      referenceText: " A reference line. ",
    };
    const chunks = collect(streamQwen3Synthesis(bridge, { text, settings: clone }, new AbortController().signal));

    for (let section = 0; section < 2; section += 1) {
      await settle();
      const { request, resolve } = requests[section];
      emit(request.requestId, 0, 1);
      resolve(result(1));
    }

    const output = await chunks;
    expect(requests[0].request.payload).toMatchObject({ referenceAudioBase64: "UklGRg==", referenceText: "A reference line." });
    expect(requests[1].request.payload).not.toHaveProperty("referenceAudioBase64");
    expect(requests[1].request.payload).toHaveProperty("referenceCacheKey", requests[0].request.payload?.referenceCacheKey);
    expect(requests[0].request.payload).not.toHaveProperty("speaker");
    expect(output).toHaveLength(3);
    expect(output[1]).toMatchObject({ pauseAfterSec: QWEN3_SECTION_JOIN_PAUSE_SEC, pauseKind: "sentence" });
    expect(output[1].audio).toHaveLength(Math.round(SAMPLE_RATE * QWEN3_SECTION_JOIN_PAUSE_SEC));
  });

  it("sends a request per inline pause and joins them with the requested silence", async () => {
    const { bridge, requests, emit } = createBridge();
    const text = `Hi.\n\nOk.${encodeSpeechBreakMark(1.5)}Yes.${encodeSpeechBreakMark(0.5)}`;
    const chunks = collect(streamQwen3Synthesis(bridge, { text, settings: SETTINGS }, new AbortController().signal));

    for (let section = 0; section < 2; section += 1) {
      await settle();
      const { request, resolve } = requests[section];
      expect(request.payload?.text).toBe(section === 0 ? "Hi.\n\nOk." : "Yes.");
      emit(request.requestId, 0, 1);
      resolve(result(1));
    }

    const output = await chunks;
    expect(output.map((chunk) => chunk.pauseAfterSec)).toEqual([0, 1.5, 0, 0.5]);
    expect(output[1].audio).toHaveLength(Math.round(SAMPLE_RATE * 1.5));
    expect(output[3].audio).toHaveLength(Math.round(SAMPLE_RATE * 0.5));
  });

  it("uploads the reference again once when the bridge lost it before a section streamed", async () => {
    const { bridge, requests, emit } = createBridge();
    const text = Array.from({ length: 150 }, (_, index) => `Sentence number ${index} keeps the request long enough.`).join(" ");
    const clone: Qwen3SynthesisSettings = {
      ...SETTINGS,
      profile: { ...SETTINGS.profile, mode: "voiceClone" },
      referenceAudioBase64: "UklGRg==",
      referenceText: "A reference line.",
    };
    const chunks = collect(streamQwen3Synthesis(bridge, { text, settings: clone }, new AbortController().signal));
    await settle();
    emit(requests[0].request.requestId, 0, 1);
    requests[0].resolve(result(1));
    await settle();
    requests[1].reject(new Error("Error invoking remote method 'local-tts:generate': Error: Qwen3 reference cache entry was not found."));
    await settle();

    expect(requests[2].request.payload).toHaveProperty("referenceAudioBase64", "UklGRg==");
    emit(requests[2].request.requestId, 0, 1);
    requests[2].resolve(result(1));
    await expect(chunks).resolves.toHaveLength(3);
  });

  it("cancels its bridge request and rejects with the signal's reason when aborted", async () => {
    const { bridge, requests, listenerCount } = createBridge();
    const controller = new AbortController();
    const chunks = collect(streamQwen3Synthesis(bridge, { text: "Long enough to speak aloud.", settings: SETTINGS }, controller.signal));
    await settle();

    controller.abort(new Error("Preview closed."));

    await expect(chunks).rejects.toThrow("Preview closed.");
    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith({ model: "qwen3", requestId: requests[0].request.requestId });
    expect(listenerCount()).toBe(0);
  });

  it("cancels its bridge request when the reader breaks off early", async () => {
    const { bridge, requests, emit } = createBridge();
    const iterable = streamQwen3Synthesis(bridge, { text: "Long enough to speak aloud.", settings: SETTINGS }, new AbortController().signal);
    const first = iterable.next();
    await settle();
    emit(requests[0].request.requestId, 0, 2);
    await first;

    await iterable.return(undefined);

    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith({ model: "qwen3", requestId: requests[0].request.requestId });
  });

  it("fails at once when declared audio is missing from a finished request, and passes bridge errors through without the IPC wrapper", async () => {
    vi.useFakeTimers();
    const { bridge, requests } = createBridge();
    const missing = collect(streamQwen3Synthesis(bridge, { text: "Long enough to speak aloud.", settings: SETTINGS }, new AbortController().signal));
    const missingOutcome = missing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    // The result follows every chunk on the preload's ordered stream, so no
    // grace period is waited out.
    requests[0].resolve(result(2));
    expect(await missingOutcome).toEqual(new Error("Generation returned incomplete streamed audio."));

    const failing = collect(streamQwen3Synthesis(bridge, { text: "Long enough to speak aloud.", settings: SETTINGS }, new AbortController().signal));
    const failingOutcome = failing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    requests[1].reject(new Error("Error invoking remote method 'local-tts:generate': Error: Model directory is missing."));
    expect(await failingOutcome).toEqual(new Error("Model directory is missing."));
  });

  it("refuses settings that cannot render yet without calling the bridge", async () => {
    const { bridge } = createBridge();
    await expect(collect(streamQwen3Synthesis(bridge, { text: "Long enough to speak aloud.", settings: { ...SETTINGS, modelPath: " " } }, new AbortController().signal)))
      .rejects.toThrow("Select or download a valid Qwen3 model directory before generating.");
    expect(bridge.generate).not.toHaveBeenCalled();
  });
});

describe("Qwen3 synthesis helpers", () => {
  it("names what is missing before a request can render", () => {
    expect(qwen3SettingsProblem(SETTINGS)).toBeNull();
    expect(qwen3SettingsProblem({ ...SETTINGS, profile: { ...SETTINGS.profile, mode: "voiceDesign" }, instruct: " " }))
      .toBe("Describe the VoiceDesign voice before generating.");
    expect(qwen3SettingsProblem({ ...SETTINGS, profile: { ...SETTINGS.profile, mode: "voiceClone" } }))
      .toBe("Choose a reference clip and type what it says before generating.");
  });

  it("drops the instruction for a CustomVoice model that ignores it, and sends a design brief", () => {
    expect(qwen3BasePayload({ ...SETTINGS, profile: { ...SETTINGS.profile, parameters: "0.6B" } }, null))
      .toMatchObject({ instruct: "" });
    expect(qwen3BasePayload({ ...SETTINGS, profile: { ...SETTINGS.profile, mode: "voiceDesign" } }, 3))
      .toEqual(expect.objectContaining({ instruct: "Warm and calm.", seed: 3 }));
    expect(qwen3BasePayload(SETTINGS, null)).not.toHaveProperty("seed");
  });

  it("maps a chunk onto the request's text units, clamped to its section", () => {
    const section = { unitStart: 2, unitEnd: 4 };
    expect(qwen3ChunkTextUnitIndex({ textUnitIndex: 1 }, 0, 2, section, 5)).toBe(3);
    expect(qwen3ChunkTextUnitIndex({ textUnitIndex: 9 }, 0, 2, section, 5)).toBe(3);
    expect(qwen3ChunkTextUnitIndex({}, 1, 0, section, 5)).toBe(3);
    expect(qwen3ChunkTextUnitIndex({}, 3, 0, { unitStart: 0, unitEnd: 1 }, 1)).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { LoadProgress } from "./progress";
import type { TextChunk } from "../../lib/chunking";
import { ChunkTooLongError, type StyleTtsOutMessage } from "../../lib/styleTtsRuntime";
import type { WorkerInMessage } from "../../types";
import { splitChunkInHalf, startPhonemeWorker, type LoadedPhonemeModel, type PhonemeChunkAudio, type PhonemeEngine, type PhonemeSynthesisContext } from "./phonemeWorker";
import { createWorkerPort } from "./protocol";

const SAMPLE_RATE = 10;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Plans one chunk per sentence, with exact offsets, like the real chunkers. */
function sentenceChunks(text: string): TextChunk[] {
  return Array.from(text.matchAll(/[^.!?]+[.!?]?/g), (match) => {
    const leading = match[0].length - match[0].trimStart().length;
    const trimmed = match[0].trim();
    const start = match.index + leading;
    return { text: trimmed, start, end: start + trimmed.length, pauseAfterSec: 0.2, pauseKind: "sentence" as const };
  }).filter((chunk) => chunk.text.length > 0);
}

interface Harness {
  messages: StyleTtsOutMessage[];
  transfers: Array<Transferable[] | undefined>;
  close: ReturnType<typeof vi.fn>;
  send(message: WorkerInMessage): void;
  engine: PhonemeEngine & { load: ReturnType<typeof vi.fn>; expectedBytes: ReturnType<typeof vi.fn>; clearCache: ReturnType<typeof vi.fn> };
  model: LoadedPhonemeModel & { synthesize: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  ofType<T extends StyleTtsOutMessage["type"]>(type: T): Array<Extract<StyleTtsOutMessage, { type: T }>>;
}

function createHarness(
  synthesize: (text: string, voice: string, speed: number, context: PhonemeSynthesisContext) => Promise<PhonemeChunkAudio> =
    async (text) => ({ audio: new Float32Array(text.length).fill(0.5) }),
): Harness {
  const messages: StyleTtsOutMessage[] = [];
  const transfers: Array<Transferable[] | undefined> = [];
  const model = {
    backend: "wasm" as const,
    voices: ["A", "B"],
    sampleRate: SAMPLE_RATE,
    planChunks: vi.fn(sentenceChunks),
    synthesize: vi.fn(synthesize),
    pendingDownloadBytes: vi.fn((voice: string): Record<string, number> => (voice === "B" ? { "b.bin": 100 } : {})),
    dispose: vi.fn(async () => undefined),
  };
  const engine = {
    label: "Test TTS",
    expectedBytes: vi.fn(() => ({ "model.bin": 100 })),
    load: vi.fn(async (progress: LoadProgress) => {
      progress.update("model.bin", 50);
      progress.complete("model.bin");
      return model;
    }),
    clearCache: vi.fn(async () => undefined),
  };
  const target = {
    postMessage: (message: unknown, options?: StructuredSerializeOptions) => {
      messages.push(message as StyleTtsOutMessage);
      transfers.push(options?.transfer);
    },
  };
  const close = vi.fn();
  const runtime = startPhonemeWorker(engine, { port: createWorkerPort(target), close });
  return {
    messages,
    transfers,
    close,
    send: (message) => runtime.handleMessage(message),
    engine,
    model,
    ofType: (type) => messages.filter((message) => message.type === type) as never,
  };
}

async function loaded(harness: Harness): Promise<void> {
  harness.send({ type: "LOAD" });
  await vi.waitFor(() => expect(harness.ofType("READY")).toHaveLength(1));
}

function generate(text: string, extra: Partial<Extract<WorkerInMessage, { type: "GENERATE" }>> = {}): WorkerInMessage {
  return { type: "GENERATE", generationId: "g1", text, voice: "A", speed: 1, quality: 5, ...extra };
}

describe("startPhonemeWorker loading", () => {
  it("reports byte-weighted progress, then READY with the voices and backend, and reuses the loaded model", async () => {
    const harness = createHarness();

    await loaded(harness);
    harness.send({ type: "LOAD" });
    await vi.waitFor(() => expect(harness.ofType("READY")).toHaveLength(2));

    expect(harness.ofType("LOAD_PROGRESS").map((message) => message.percent)).toEqual([0, 49.5, 99, 100]);
    expect(harness.ofType("READY")[0]).toEqual({ type: "READY", voices: ["A", "B"], backend: "wasm" });
    expect(harness.engine.load).toHaveBeenCalledOnce();
  });

  it("hands the preferred voice to the engine for its progress sizes and its load", async () => {
    const harness = createHarness();

    harness.send({ type: "LOAD", preferredVoice: "B" });
    await vi.waitFor(() => expect(harness.ofType("READY")).toHaveLength(1));

    expect(harness.engine.expectedBytes).toHaveBeenCalledWith({ preferredVoice: "B" });
    expect(harness.engine.load).toHaveBeenCalledWith(expect.anything(), { preferredVoice: "B" });
  });

  it("reports load failures with the load scope", async () => {
    const harness = createHarness();
    harness.engine.load.mockRejectedValueOnce(new Error("integrity check failed"));

    harness.send({ type: "LOAD" });

    await vi.waitFor(() => expect(harness.ofType("ERROR")).toEqual([{ type: "ERROR", scope: "load", message: "integrity check failed" }]));
  });

  it("drops the model and its cache on a forced reload, after the inference in flight", async () => {
    const pending = deferred<PhonemeChunkAudio>();
    const harness = createHarness(() => pending.promise);
    await loaded(harness);

    harness.send(generate("Hello."));
    await vi.waitFor(() => expect(harness.model.synthesize).toHaveBeenCalledOnce());
    harness.send({ type: "LOAD", forceReload: true });
    await Promise.resolve();
    expect(harness.model.dispose).not.toHaveBeenCalled();

    pending.resolve({ audio: new Float32Array(2) });
    await vi.waitFor(() => expect(harness.ofType("READY")).toHaveLength(2));

    expect(harness.model.dispose).toHaveBeenCalledOnce();
    expect(harness.engine.clearCache).toHaveBeenCalledOnce();
    expect(harness.engine.load).toHaveBeenCalledTimes(2);
    // The reload superseded the generation: it posted nothing.
    expect(harness.ofType("AUDIO_CHUNK")).toHaveLength(0);
    expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(0);
  });
});

describe("startPhonemeWorker generation", () => {
  it("streams chunks with exact offsets, rendered pauses and transferred PCM", async () => {
    const harness = createHarness();
    await loaded(harness);

    harness.send(generate("One. Three.", { pauseOverridesSec: { sentence: 0.3 }, finalPauseSec: 0.5 }));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toEqual([{ type: "GENERATION_COMPLETE", generationId: "g1" }]));

    const chunks = harness.ofType("AUDIO_CHUNK");
    expect(chunks.map(({ text, index, total, textStart, textEnd, pauseAfterSec, pauseKind, generationId, samplingRate }) => ({
      text, index, total, textStart, textEnd, pauseAfterSec, pauseKind, generationId, samplingRate,
    }))).toEqual([
      { text: "One.", index: 1, total: 2, textStart: 0, textEnd: 4, pauseAfterSec: 0.3, pauseKind: "sentence", generationId: "g1", samplingRate: SAMPLE_RATE },
      { text: "Three.", index: 2, total: 2, textStart: 5, textEnd: 11, pauseAfterSec: 0.5, pauseKind: "sentence", generationId: "g1", samplingRate: SAMPLE_RATE },
    ]);
    // Pauses are silence inside the PCM: 4 speech + 3 silent samples, then 6 + 5.
    expect(Array.from(chunks[0].audio)).toEqual([0.5, 0.5, 0.5, 0.5, 0, 0, 0]);
    expect(Array.from(chunks[1].audio)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0, 0]);
    const chunkIndex = harness.messages.indexOf(chunks[0]);
    expect(harness.transfers[chunkIndex]).toEqual([chunks[0].audio.buffer]);
  });

  it("uses the sample rate a chunk reports instead of the model's", async () => {
    const harness = createHarness(async () => ({ audio: new Float32Array(2), sampleRate: 16_000 }));
    await loaded(harness);

    harness.send(generate("Hello."));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    expect(harness.ofType("AUDIO_CHUNK")[0].samplingRate).toBe(16_000);
  });

  it("applies pronunciation rules, sentence speed and the requested voice", async () => {
    const harness = createHarness();
    await loaded(harness);

    harness.send(generate("Read the API docs.", { voice: "B", speed: 2, pronunciationRules: [{ from: "API", to: "A P I" }] }));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    // Speed is clamped to the app's stable range (SPEED_MAX = 1.15).
    expect(harness.model.synthesize).toHaveBeenCalledWith("Read the A P I docs.", "B", 1.15, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(harness.ofType("AUDIO_CHUNK")[0].text).toBe("Read the API docs.");
  });

  it("maps word timings to GENERATE offsets, and drops them when tuning rewrote the text", async () => {
    const harness = createHarness(async (text) => ({
      audio: new Float32Array(4),
      wordTimings: [{ start: 0, end: text.indexOf(" "), startSec: 0, endSec: 0.1 }],
    }));
    await loaded(harness);

    harness.send(generate("First one. Second one."));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(1));
    harness.send(generate("Say API now.", { generationId: "g2", pronunciationRules: [{ from: "API", to: "A P I" }] }));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(2));

    const [first, second, rewritten] = harness.ofType("AUDIO_CHUNK");
    expect(first.wordTimings).toEqual([{ start: 0, end: 5, startSec: 0, endSec: 0.1 }]);
    expect(second.wordTimings).toEqual([{ start: 11, end: 17, startSec: 0, endSec: 0.1 }]);
    expect(rewritten).not.toHaveProperty("wordTimings");
  });

  it("splits a chunk that needs too many tokens and marks the total as dynamic", async () => {
    const harness = createHarness(async (text) => {
      if (text.length > 20) throw new ChunkTooLongError(600);
      return { audio: new Float32Array(1) };
    });
    await loaded(harness);
    const text = "A long clause goes here, and another one follows.";

    harness.send(generate(text));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    const chunks = harness.ofType("AUDIO_CHUNK");
    expect(chunks.map((chunk) => text.slice(chunk.textStart, chunk.textEnd))).toEqual(chunks.map((chunk) => chunk.text));
    expect(chunks.map((chunk) => chunk.text)).toEqual(["A long clause", "goes here,", "and another", "one follows."]);
    expect(chunks.map((chunk) => chunk.total)).toEqual([0, 0, 0, 0]);
    expect(chunks.map((chunk) => chunk.index)).toEqual([1, 2, 3, 4]);
    expect(chunks.map((chunk) => chunk.pauseKind)).toEqual(["comma", "comma", "comma", "sentence"]);
  });

  it("reports a chunk that cannot be split, without changing model state", async () => {
    const harness = createHarness(async (text) => {
      if (text.startsWith("Unsplittable")) throw new ChunkTooLongError(600);
      return { audio: new Float32Array(1) };
    });
    await loaded(harness);

    harness.send(generate("Unsplittable."));
    await vi.waitFor(() => expect(harness.ofType("ERROR")).toHaveLength(1));
    harness.send(generate("Fine.", { generationId: "g2" }));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    expect(harness.ofType("ERROR")[0]).toEqual({
      type: "ERROR",
      scope: "generate",
      generationId: "g1",
      message: "The chunk needs 600 phoneme tokens; the model accepts at most 512.",
    });
    expect(harness.ofType("GENERATION_COMPLETE")[0].generationId).toBe("g2");
  });

  it("rejects GENERATE before LOAD and empty text", async () => {
    const harness = createHarness();

    harness.send(generate("Hello."));
    await vi.waitFor(() => expect(harness.ofType("ERROR")).toHaveLength(1));
    await loaded(harness);
    harness.send(generate("   ", { generationId: "g2" }));
    await vi.waitFor(() => expect(harness.ofType("ERROR")).toHaveLength(2));

    expect(harness.ofType("ERROR").map(({ message, generationId }) => ({ message, generationId }))).toEqual([
      { message: "Test TTS is not loaded.", generationId: "g1" },
      { message: "Input text is empty.", generationId: "g2" },
    ]);
  });

  it("lets a new GENERATE supersede the running one without overlapping inference", async () => {
    const first = deferred<PhonemeChunkAudio>();
    let running = 0;
    let maxRunning = 0;
    const harness = createHarness(async (text) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      try {
        return text === "Old one." ? await first.promise : { audio: new Float32Array(1) };
      } finally {
        running -= 1;
      }
    });
    await loaded(harness);

    harness.send(generate("Old one. Old two."));
    await vi.waitFor(() => expect(harness.model.synthesize).toHaveBeenCalledOnce());
    harness.send(generate("New.", { generationId: "g2" }));
    await Promise.resolve();
    expect(harness.model.synthesize).toHaveBeenCalledOnce();

    first.resolve({ audio: new Float32Array(1) });
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    expect(maxRunning).toBe(1);
    expect(harness.model.synthesize.mock.calls.map(([text]) => text)).toEqual(["Old one.", "New."]);
    expect(harness.ofType("AUDIO_CHUNK").map((chunk) => chunk.generationId)).toEqual(["g2"]);
    expect(harness.ofType("GENERATION_COMPLETE")[0].generationId).toBe("g2");
  });

  it("posts nothing, not even its error, for a superseded generation", async () => {
    const first = deferred<PhonemeChunkAudio>();
    const harness = createHarness((text) => (text === "Old." ? first.promise : Promise.resolve({ audio: new Float32Array(1) })));
    await loaded(harness);

    harness.send(generate("Old."));
    await vi.waitFor(() => expect(harness.model.synthesize).toHaveBeenCalledOnce());
    harness.send(generate("New.", { generationId: "g2" }));
    first.reject(new Error("session failed"));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    expect(harness.ofType("ERROR")).toHaveLength(0);
  });

  it("closes on CANCEL and posts nothing more for the generation in flight", async () => {
    const pending = deferred<PhonemeChunkAudio>();
    const harness = createHarness(() => pending.promise);
    await loaded(harness);

    harness.send(generate("Hello."));
    await vi.waitFor(() => expect(harness.model.synthesize).toHaveBeenCalledOnce());
    harness.send({ type: "CANCEL" });
    pending.resolve({ audio: new Float32Array(1) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.ofType("CANCELLED")).toHaveLength(1);
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.ofType("AUDIO_CHUNK")).toHaveLength(0);
    expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(0);
  });

  it("soft-aborts a generation without closing the worker or dropping the model", async () => {
    const pending = deferred<PhonemeChunkAudio>();
    const harness = createHarness((text) => (text === "Old." ? pending.promise : Promise.resolve({ audio: new Float32Array(1) })));
    await loaded(harness);

    harness.send(generate("Old. Older."));
    await vi.waitFor(() => expect(harness.model.synthesize).toHaveBeenCalledOnce());
    harness.send({ type: "ABORT", generationId: "g1" });
    expect(harness.ofType("ABORTED")).toHaveLength(0);
    pending.resolve({ audio: new Float32Array(1) });
    await vi.waitFor(() => expect(harness.ofType("ABORTED")).toEqual([{ type: "ABORTED", generationId: "g1" }]));
    harness.send(generate("Again.", { generationId: "g2" }));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(1));

    expect(harness.close).not.toHaveBeenCalled();
    expect(harness.model.dispose).not.toHaveBeenCalled();
    expect(harness.engine.load).toHaveBeenCalledOnce();
    expect(harness.model.synthesize).toHaveBeenCalledTimes(2);
    expect(harness.ofType("AUDIO_CHUNK").map((chunk) => chunk.generationId)).toEqual(["g2"]);
  });
});

describe("startPhonemeWorker voice downloads during GENERATE", () => {
  it("reports a download made while synthesizing like a LOAD, ending at 100", async () => {
    const harness = createHarness(async (text, voice, _speed, { progress }) => {
      if (voice === "B") {
        progress.update("b.bin", 40);
        progress.update("b.bin", 100);
        progress.complete("b.bin");
      }
      return { audio: new Float32Array(text.length) };
    });
    await loaded(harness);
    const loadMessages = harness.ofType("LOAD_PROGRESS").length;

    harness.send(generate("Hello.", { voice: "A" }));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(1));
    expect(harness.ofType("LOAD_PROGRESS")).toHaveLength(loadMessages);

    harness.send(generate("Hello.", { voice: "B", generationId: "g2" }));
    await vi.waitFor(() => expect(harness.ofType("GENERATION_COMPLETE")).toHaveLength(2));

    expect(harness.model.pendingDownloadBytes).toHaveBeenCalledWith("B");
    expect(harness.ofType("LOAD_PROGRESS").slice(loadMessages).map((message) => message.percent)).toEqual([40, 100]);
  });

  it("aborts the download when the generation is aborted, and posts ABORTED once it settles", async () => {
    let signal: AbortSignal | undefined;
    const harness = createHarness((_text, _voice, _speed, context) => {
      signal = context.signal;
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    });
    await loaded(harness);

    harness.send(generate("Hello.", { voice: "B" }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);
    harness.send({ type: "ABORT", generationId: "g1" });

    await vi.waitFor(() => expect(harness.ofType("ABORTED")).toEqual([{ type: "ABORTED", generationId: "g1" }]));
    expect(signal!.aborted).toBe(true);
    expect(harness.ofType("ERROR")).toHaveLength(0);
    expect(harness.ofType("LOAD_PROGRESS").at(-1)?.percent).toBe(100);
  });

  it("aborts the download on CANCEL and when a newer GENERATE supersedes the generation", async () => {
    const signals: AbortSignal[] = [];
    const harness = createHarness((_text, _voice, _speed, context) => {
      signals.push(context.signal);
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    });
    await loaded(harness);

    harness.send(generate("Hello.", { voice: "B" }));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    harness.send(generate("Again.", { voice: "B", generationId: "g2" }));
    expect(signals[0].aborted).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    harness.send({ type: "CANCEL" });

    expect(signals[1].aborted).toBe(true);
    expect(harness.ofType("ERROR")).toHaveLength(0);
  });
});

describe("splitChunkInHalf", () => {
  const chunk = (text: string) => ({ text, start: 10, end: 10 + text.length, pauseAfterSec: 0.4, pauseKind: "paragraph" as const });

  it("prefers a clause boundary near the middle and keeps exact offsets", () => {
    // The plain space after "four" is nearer the middle, but the comma wins.
    const text = "one two three, four five six seven";
    const source = `${" ".repeat(10)}${text}`;

    const halves = splitChunkInHalf(source, chunk(text));

    expect(halves).toEqual([
      { text: "one two three,", start: 10, end: 24, pauseAfterSec: 0.14, pauseKind: "comma" },
      { text: "four five six seven", start: 25, end: 44, pauseAfterSec: 0.4, pauseKind: "paragraph" },
    ]);
  });

  it("cannot split a single word", () => {
    expect(splitChunkInHalf(`${" ".repeat(10)}Supercalifragilistic`, chunk("Supercalifragilistic"))).toBeNull();
  });
});

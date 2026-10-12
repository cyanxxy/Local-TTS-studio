import { describe, expect, it, vi } from "vitest";
import { chunkAudio8Text } from "../models/audio8";
import type { SynthesisChunk } from "../shared/engineRuntime";
import { audio8ErrorMessage, streamAudio8Synthesis, type Audio8Bridge } from "./audio8Synthesis";

const SAMPLE_RATE = 24_000;
const TEXT = [
  "The lamplighter walked the length of the harbour road every evening at dusk.",
  "He carried a brass ladder over one shoulder and a taper in his free hand.",
  "Nobody had asked him to keep the lamps burning since the electric line arrived.",
].join(" ");

function createBridge() {
  return {
    load: vi.fn(),
    generate: vi.fn<Audio8Bridge["generate"]>(async () => ({
      sampleRate: SAMPLE_RATE,
      elapsedSec: 0.1,
      audio: new Float32Array(SAMPLE_RATE / 2).buffer,
    })),
    cancel: vi.fn<Audio8Bridge["cancel"]>(async () => ({ cancelled: true })),
    getCacheInfo: vi.fn(),
    clearCache: vi.fn(),
    subscribeProgress: vi.fn(() => () => undefined),
  };
}

async function collect(iterable: AsyncIterable<SynthesisChunk>): Promise<SynthesisChunk[]> {
  const values: SynthesisChunk[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("streamAudio8Synthesis sampling", () => {
  const run = async (sampling?: { seed: number | null; temperature: number | null }) => {
    const bridge = createBridge();
    await collect(streamAudio8Synthesis(
      bridge as unknown as Audio8Bridge,
      { text: TEXT, voice: "clara", tuning: { speed: 1, quality: 5 }, sampling },
      new AbortController().signal,
    ));
    return bridge.generate.mock.calls.map(([request]) => request);
  };

  it("steps a fixed seed per passage so the passages differ but a repeat is identical", async () => {
    const requests = await run({ seed: 100, temperature: 0.4 });

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.map((request) => request.seed)).toEqual(requests.map((_, index) => 100 + index));
    expect(requests.every((request) => request.temperature === 0.4)).toBe(true);
    expect((await run({ seed: 100, temperature: 0.4 })).map((request) => request.seed)).toEqual(requests.map((request) => request.seed));
  });

  it("wraps the stepped seed inside 32 bits", async () => {
    const requests = await run({ seed: 0xffff_ffff, temperature: null });

    expect(requests.map((request) => request.seed)).toEqual(requests.map((_, index) => index === 0 ? 0xffff_ffff : index - 1));
  });

  it("sends neither field when nothing is set, leaving the model's own sampling", async () => {
    for (const sampling of [undefined, { seed: null, temperature: null }]) {
      for (const request of await run(sampling)) {
        expect(request).not.toHaveProperty("seed");
        expect(request).not.toHaveProperty("temperature");
      }
    }
  });
});

describe("streamAudio8Synthesis", () => {
  it("renders every passage in order with its pause appended, and names each request", async () => {
    const bridge = createBridge();
    const onRequest = vi.fn();

    const chunks = await collect(streamAudio8Synthesis(
      bridge as unknown as Audio8Bridge,
      { text: TEXT, voice: "clara", tuning: { speed: 1, quality: 5, pauseOverridesSec: { sentence: 0.5 } } },
      new AbortController().signal,
      onRequest,
    ));

    const passages = chunkAudio8Text(TEXT);
    expect(passages.length).toBeGreaterThan(1);
    expect(bridge.generate.mock.calls.map(([request]) => request.text)).toEqual(passages.map((passage) => passage.text));
    expect(bridge.generate.mock.calls.every(([request]) => request.voice === "clara")).toBe(true);
    expect(chunks.map((chunk) => chunk.index)).toEqual(passages.map((_, index) => index + 1));
    expect(chunks[0]).toMatchObject({ samplingRate: SAMPLE_RATE, total: passages.length, pauseAfterSec: 0.5 });
    expect(chunks[0].audio).toHaveLength(SAMPLE_RATE / 2 + SAMPLE_RATE / 2);
    // The last passage ends the request, so it gets no pause.
    expect(chunks.at(-1)).toMatchObject({ pauseAfterSec: 0 });
    expect(chunks.at(-1)?.audio).toHaveLength(SAMPLE_RATE / 2);
    expect(onRequest.mock.calls.map(([requestId, index, count]) => [typeof requestId, index, count]))
      .toEqual(passages.map((_, index) => ["string", index, passages.length]));
    expect(onRequest.mock.calls[0][0]).toBe(bridge.generate.mock.calls[0][0].requestId);
  });

  it("applies the pronunciation lexicon to what it sends, not to the passage text", async () => {
    const bridge = createBridge();

    const [chunk] = await collect(streamAudio8Synthesis(
      bridge as unknown as Audio8Bridge,
      { text: "Open TTS reads every word aloud.", voice: "clara", tuning: { speed: 1, quality: 5, pronunciationRules: [{ from: "TTS", to: "tee tee ess" }] } },
      new AbortController().signal,
    ));

    expect(bridge.generate.mock.calls[0][0].text).toContain("tee tee ess");
    expect(chunk.text).toBe("Open TTS reads every word aloud.");
  });

  it("cancels the request in flight and rejects with the signal's reason", async () => {
    const bridge = createBridge();
    bridge.generate.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const result = collect(streamAudio8Synthesis(
      bridge as unknown as Audio8Bridge,
      { text: TEXT, voice: "clara", tuning: { speed: 1, quality: 5 } },
      controller.signal,
    ));
    await vi.waitFor(() => expect(bridge.generate).toHaveBeenCalledOnce());

    controller.abort(new Error("Preview closed."));

    await expect(result).rejects.toThrow("Preview closed.");
    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith({ requestId: bridge.generate.mock.calls[0][0].requestId });
    expect(bridge.generate).toHaveBeenCalledOnce();
  });

  it("requests nothing once already aborted", async () => {
    const bridge = createBridge();
    const controller = new AbortController();
    controller.abort(new Error("Never mind."));

    await expect(collect(streamAudio8Synthesis(
      bridge as unknown as Audio8Bridge,
      { text: TEXT, voice: "clara", tuning: { speed: 1, quality: 5 } },
      controller.signal,
    ))).rejects.toThrow("Never mind.");
    expect(bridge.generate).not.toHaveBeenCalled();
  });

  it("rejects with the bridge's cause and refuses audio that is not audio", async () => {
    const failing = createBridge();
    failing.generate.mockRejectedValueOnce(new Error("Error invoking remote method 'audio8:generate': Error: Audio8 worker exited."));
    await expect(collect(streamAudio8Synthesis(
      failing as unknown as Audio8Bridge,
      { text: TEXT, voice: "clara", tuning: { speed: 1, quality: 5 } },
      new AbortController().signal,
    ))).rejects.toThrow(/^Audio8 worker exited\.$/);

    const silent = createBridge();
    silent.generate.mockResolvedValueOnce({ sampleRate: 0, elapsedSec: 0, audio: new ArrayBuffer(8) });
    await expect(collect(streamAudio8Synthesis(
      silent as unknown as Audio8Bridge,
      { text: TEXT, voice: "clara", tuning: { speed: 1, quality: 5 } },
      new AbortController().signal,
    ))).rejects.toThrow("Audio8 returned invalid local audio.");
  });
});

describe("audio8ErrorMessage", () => {
  it("strips Electron's IPC wrapper and keeps other messages", () => {
    expect(audio8ErrorMessage(new Error("Error invoking remote method 'audio8:load': Error: offline"))).toBe("offline");
    expect(audio8ErrorMessage("plain")).toBe("plain");
  });
});

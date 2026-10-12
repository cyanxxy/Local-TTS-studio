import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addChatterboxClipFromWav,
  ensureChatterboxReference,
  getChatterboxClip,
  getChatterboxClips,
  removeChatterboxClip,
  setChatterboxClipResolver,
  subscribeChatterboxClips,
  type ChatterboxClip,
} from "./chatterboxClips";
import { ChatterboxReferenceError } from "./chatterboxReference";
import { encodeWavPcm16 } from "./wavCodec";

function speech(seconds: number, rate: number, amplitude = 0.3): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    samples[i] = amplitude * (0.6 + (0.4 * Math.sin(2 * Math.PI * 3 * t))) * Math.sin(2 * Math.PI * 200 * t);
  }
  return samples;
}

function wav(seconds: number, rate = 24_000, amplitude = 0.3): ArrayBuffer {
  const bytes = encodeWavPcm16(speech(seconds, rate, amplitude), rate);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A worker that answers SET_REFERENCE the way chatterbox.worker.ts does. */
class FakeWorker extends EventTarget {
  posted: Array<{ message: Record<string, unknown>; transfer?: Transferable[] }> = [];
  reply: ((message: Record<string, unknown>) => Record<string, unknown> | null) | null = (message) => ({
    type: "REFERENCE_READY",
    referenceId: message.referenceId,
    digest: "d",
    durationSec: 5,
  });

  postMessage(message: Record<string, unknown>, options?: StructuredSerializeOptions) {
    this.posted.push({ message, transfer: options?.transfer });
    const answer = this.reply?.(message);
    if (answer) queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: answer })));
  }
}

const asWorker = (worker: FakeWorker) => worker as unknown as Worker;

afterEach(() => {
  setChatterboxClipResolver(null);
  for (const clip of getChatterboxClips()) removeChatterboxClip(clip.id);
});

describe("chatterbox clips", () => {
  it("loads a WAV as a reference voice named by its content and tells subscribers", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatterboxClips(listener);

    const clip = await addChatterboxClipFromWav(wav(5), "My narrator.wav");

    expect(clip).toMatchObject({ name: "My narrator.wav", samplingRate: 24_000 });
    expect(clip.id).toMatch(/^[0-9a-f]{16}~My narrator$/);
    expect(clip.durationSec).toBeGreaterThan(4.5);
    expect(getChatterboxClips()).toEqual([clip]);
    expect(getChatterboxClip(clip.id)).toBe(clip);
    expect(listener).toHaveBeenCalledOnce();

    // The same audio is the same voice; other audio is another.
    expect((await addChatterboxClipFromWav(wav(5), "Same again.wav")).id.split("~")[0]).toBe(clip.id.split("~")[0]);
    expect((await addChatterboxClipFromWav(wav(6), "Longer.wav")).id.split("~")[0]).not.toBe(clip.id.split("~")[0]);

    removeChatterboxClip(clip.id);
    removeChatterboxClip(clip.id);
    expect(getChatterboxClip(clip.id)).toBeUndefined();
    unsubscribe();
  });

  it("keeps only the prepared window of a long, high-rate recording", async () => {
    const clip = await addChatterboxClipFromWav(wav(30, 48_000), "Long.wav");

    expect(clip.samplingRate).toBe(24_000);
    expect(clip.audio.length).toBeLessThanOrEqual(10 * 24_000);
    expect(clip.durationSec).toBeLessThanOrEqual(10);
    expect(clip.audio.length / clip.samplingRate).toBeCloseTo(clip.durationSec, 6);
  });

  it("explains why a file cannot be a reference voice", async () => {
    await expect(addChatterboxClipFromWav(new ArrayBuffer(16), "notes.txt")).rejects.toThrow("not a WAV recording");
    await expect(addChatterboxClipFromWav(wav(1), "short.wav")).rejects.toBeInstanceOf(ChatterboxReferenceError);
    await expect(addChatterboxClipFromWav(wav(5, 24_000, 0), "silent.wav")).rejects.toThrow(/silent/);
    expect(getChatterboxClips()).toEqual([]);
  });

  it("finds clips from another store through the resolver", () => {
    const stored: ChatterboxClip = { id: "lib~Stored", name: "Stored", durationSec: 5, audio: new Float32Array(4), samplingRate: 24_000 };
    setChatterboxClipResolver((id) => (id === stored.id ? stored : undefined));

    expect(getChatterboxClip("lib~Stored")).toBe(stored);
    expect(getChatterboxClip("other")).toBeUndefined();
  });
});

describe("ensureChatterboxReference", () => {
  it("needs nothing for the default voice", async () => {
    const worker = new FakeWorker();

    await ensureChatterboxReference(asWorker(worker), "chatterbox-default");

    expect(worker.posted).toEqual([]);
  });

  it("sends a clip once per worker, as a transferred copy, and waits for the worker to accept it", async () => {
    const clip = await addChatterboxClipFromWav(wav(5), "Voice.wav");
    const worker = new FakeWorker();

    await Promise.all([
      ensureChatterboxReference(asWorker(worker), clip.id),
      ensureChatterboxReference(asWorker(worker), clip.id),
    ]);
    await ensureChatterboxReference(asWorker(worker), clip.id);

    expect(worker.posted).toHaveLength(1);
    const { message, transfer } = worker.posted[0];
    expect(message).toMatchObject({ type: "SET_REFERENCE", referenceId: clip.id, samplingRate: 24_000 });
    expect(transfer).toHaveLength(1);
    // The session keeps its clip for the next worker.
    expect(clip.audio.length).toBeGreaterThan(0);
    const next = new FakeWorker();
    await ensureChatterboxReference(asWorker(next), clip.id);
    expect(next.posted).toHaveLength(1);
  });

  it("ignores replies about other clips and fails with the worker's reason, then allows a retry", async () => {
    const clip = await addChatterboxClipFromWav(wav(5), "Voice.wav");
    const worker = new FakeWorker();
    worker.reply = (message) => {
      void message;
      return null;
    };
    const pending = ensureChatterboxReference(asWorker(worker), clip.id);
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "REFERENCE_READY", referenceId: "other" } }));
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "ERROR", scope: "load", message: "unrelated" } }));
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "ERROR", scope: "reference", referenceId: "other", message: "no" } }));
    worker.dispatchEvent(new MessageEvent("message", {
      data: { type: "ERROR", scope: "reference", referenceId: clip.id, message: "The reference clip is silent." },
    }));
    await expect(pending).rejects.toThrow("The reference clip is silent.");

    worker.reply = (message) => ({ type: "REFERENCE_READY", referenceId: message.referenceId });
    await ensureChatterboxReference(asWorker(worker), clip.id);
    expect(worker.posted).toHaveLength(2);
  });

  it("fails when the worker crashes mid-transfer", async () => {
    const clip = await addChatterboxClipFromWav(wav(5), "Voice.wav");
    const worker = new FakeWorker();
    worker.reply = null;
    const pending = ensureChatterboxReference(asWorker(worker), clip.id);

    worker.dispatchEvent(new Event("error"));

    await expect(pending).rejects.toThrow("Chatterbox stopped");
  });

  it("fails clearly when the clip is no longer loaded", async () => {
    await expect(ensureChatterboxReference(asWorker(new FakeWorker()), "gone~Voice"))
      .rejects.toThrow("no longer loaded");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  CHATTERBOX_REFERENCE_MAX_SECONDS,
  CHATTERBOX_SAMPLE_RATE,
  ChatterboxReferenceError,
  createChatterboxReferenceStore,
  decodeChatterboxWav,
  digestChatterboxReference,
  prepareChatterboxReference,
} from "./chatterboxReference";
import { encodeWavPcm16 } from "./wavCodec";

/** A tone with a slow amplitude wobble so every 10 ms frame has speech-like energy. */
function tone(seconds: number, sampleRate: number, amplitude = 0.3): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / sampleRate;
    samples[i] = amplitude * (0.6 + (0.4 * Math.sin(2 * Math.PI * 3 * t))) * Math.sin(2 * Math.PI * 180 * t);
  }
  return samples;
}

function withSilence(speech: Float32Array, sampleRate: number, leadSeconds: number, tailSeconds: number): Float32Array {
  const lead = Math.round(leadSeconds * sampleRate);
  const out = new Float32Array(lead + speech.length + Math.round(tailSeconds * sampleRate));
  out.set(speech, lead);
  return out;
}

function peak(audio: Float32Array): number {
  return audio.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
}

describe("prepareChatterboxReference", () => {
  it("resamples to 24 kHz and reports the duration", () => {
    const prepared = prepareChatterboxReference(tone(6, 48_000), 48_000);
    expect(prepared.audio.length / CHATTERBOX_SAMPLE_RATE).toBeCloseTo(prepared.durationSec, 6);
    expect(prepared.durationSec).toBeGreaterThan(5.9);
    expect(prepared.durationSec).toBeLessThan(6.2);
  });

  it("trims leading and trailing silence", () => {
    const prepared = prepareChatterboxReference(withSilence(tone(4, 16_000), 16_000, 3, 5), 16_000);
    expect(prepared.durationSec).toBeGreaterThan(3.9);
    expect(prepared.durationSec).toBeLessThan(4.3);
  });

  it("keeps only the first ten seconds", () => {
    const prepared = prepareChatterboxReference(tone(25, 24_000), 24_000);
    expect(prepared.durationSec).toBeCloseTo(CHATTERBOX_REFERENCE_MAX_SECONDS, 1);
  });

  it("brings quiet and loud clips to a comparable level without clipping", () => {
    const quiet = prepareChatterboxReference(tone(5, 24_000, 0.01), 24_000).audio;
    const loud = prepareChatterboxReference(tone(5, 24_000, 0.99), 24_000).audio;
    expect(peak(loud)).toBeLessThanOrEqual(0.95 + 1e-6);
    expect(peak(quiet) / peak(loud)).toBeGreaterThan(0.1);
    expect(peak(quiet)).toBeGreaterThan(0.05);
  });

  it("never writes into the caller's buffer", () => {
    const original = tone(5, 24_000, 0.01);
    const copy = original.slice();
    prepareChatterboxReference(original, 24_000);
    expect(original).toEqual(copy);
  });

  it.each([
    ["empty audio", new Float32Array(0), 24_000, /empty/],
    ["a sample rate below 8 kHz", tone(5, 4_000), 4_000, /Unsupported reference sample rate/],
    ["a sample rate above 192 kHz", new Float32Array(10), 384_000, /Unsupported reference sample rate/],
    ["a non-finite sample rate", tone(5, 24_000), Number.NaN, /Unsupported reference sample rate/],
    ["silence", new Float32Array(24_000 * 5), 24_000, /silent/],
    ["a clip shorter than three seconds", tone(2, 24_000), 24_000, /at least 3 seconds/],
    ["a clip longer than ten minutes", new Float32Array(8_000 * 601), 8_000, /longer than 600 seconds/],
  ])("rejects %s", (_label, audio, rate, message) => {
    expect(() => prepareChatterboxReference(audio, rate)).toThrow(ChatterboxReferenceError);
    expect(() => prepareChatterboxReference(audio, rate)).toThrow(message);
  });

  it("rejects NaN samples and non-Float32 input", () => {
    const bad = tone(5, 24_000);
    bad[100] = Number.NaN;
    expect(() => prepareChatterboxReference(bad, 24_000)).toThrow(/invalid samples/);
    expect(() => prepareChatterboxReference([1, 2] as unknown as Float32Array, 24_000)).toThrow(/empty/);
  });
});

describe("digestChatterboxReference", () => {
  it("is a stable SHA-256 of the PCM bytes, independent of the view's offset", async () => {
    const audio = tone(1, 24_000);
    const padded = new Float32Array(audio.length + 4);
    padded.set(audio, 4);
    const view = padded.subarray(4);
    const digest = await digestChatterboxReference(audio);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await digestChatterboxReference(view)).toBe(digest);
    expect(await digestChatterboxReference(tone(1, 24_000, 0.2))).not.toBe(digest);
  });
});

describe("decodeChatterboxWav", () => {
  it("decodes a WAV to mono PCM and its sample rate", () => {
    const source = tone(1, 16_000);
    const wav = encodeWavPcm16(source, 16_000);
    const decoded = decodeChatterboxWav(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer);
    expect(decoded.samplingRate).toBe(16_000);
    expect(decoded.audio.length).toBe(source.length);
    expect(decoded.audio[8_000]).toBeCloseTo(source[8_000], 3);
  });
});

describe("createChatterboxReferenceStore", () => {
  const prepared = (value: number) => ({ audio: new Float32Array([value]), durationSec: value });

  it("resolves registered ids and shares one entry between identical digests", () => {
    const store = createChatterboxReferenceStore<string>(4);
    store.register("a", "d1", prepared(1));
    store.register("b", "d1", prepared(1));
    expect(store.resolve("a")).toBe(store.resolve("b"));
    expect(store.resolve("missing")).toBeNull();
  });

  it("keeps an entry while another id still points at it", () => {
    const store = createChatterboxReferenceStore<string>(4);
    store.register("a", "d1", prepared(1));
    store.register("b", "d1", prepared(1));
    store.delete("a");
    expect(store.resolve("a")).toBeNull();
    expect(store.resolve("b")?.digest).toBe("d1");
    store.delete("b");
    expect(store.resolve("b")).toBeNull();
  });

  it("drops the old entry when an id is re-registered with new audio", () => {
    const release = vi.fn();
    const store = createChatterboxReferenceStore<string>(4, release);
    store.register("a", "d1", prepared(1));
    store.setConditioning("d1", "old");
    store.register("a", "d2", prepared(2));
    expect(release).toHaveBeenCalledWith("old");
    expect(store.resolve("a")?.digest).toBe("d2");
  });

  it("evicts the least recently used entry and forgets its ids", () => {
    const release = vi.fn();
    const store = createChatterboxReferenceStore<string>(2, release);
    store.register("a", "d1", prepared(1));
    store.setConditioning("d1", "c1");
    store.register("b", "d2", prepared(2));
    store.resolve("a");
    store.register("c", "d3", prepared(3));
    expect(store.resolve("b")).toBeNull();
    expect(store.resolve("a")?.digest).toBe("d1");
    expect(store.resolve("c")?.digest).toBe("d3");
    store.register("d", "d4", prepared(4));
    expect(release).toHaveBeenCalledWith("c1");
    expect(store.resolve("a")).toBeNull();
  });

  it("releases a replaced conditioning and one set for an unknown digest", () => {
    const release = vi.fn();
    const store = createChatterboxReferenceStore<string>(2, release);
    store.register("a", "d1", prepared(1));
    store.setConditioning("d1", "first");
    store.setConditioning("d1", "second");
    expect(release).toHaveBeenCalledWith("first");
    store.setConditioning("d1", "second");
    expect(release).toHaveBeenCalledTimes(1);
    store.setConditioning("unknown", "orphan");
    expect(release).toHaveBeenCalledWith("orphan");
  });

  it("clears conditionings but keeps the audio", () => {
    const release = vi.fn();
    const store = createChatterboxReferenceStore<string>(2, release);
    store.register("a", "d1", prepared(1));
    store.setConditioning("d1", "c1");
    store.clearConditionings();
    expect(release).toHaveBeenCalledWith("c1");
    expect(store.resolve("a")?.conditioning).toBeUndefined();
    expect(store.resolve("a")?.audio).toEqual(new Float32Array([1]));
  });
});

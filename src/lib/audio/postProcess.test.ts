import { describe, expect, it } from "vitest";
import { ChunkPostProcessor, postProcessChunks } from "./postProcess";

const RATE = 24000;

function tone(seconds: number, amplitude = 0.5): Float32Array {
  const output = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < output.length; i += 1) output[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return output;
}

function constant(seconds: number, value: number): Float32Array {
  return new Float32Array(Math.round(seconds * RATE)).fill(value);
}

function concat(...parts: Float32Array[]): Float32Array {
  const output = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

const silence = (seconds: number) => new Float32Array(Math.round(seconds * RATE));

describe("ChunkPostProcessor", () => {
  it("leaves audio untouched by default when its edges are silent", () => {
    const audio = concat(silence(0.1), tone(0.5), silence(0.4));
    const { audio: output, timings } = postProcessChunks([{ audio, pauseAfterSec: 0.2 }], RATE);
    expect(output).toEqual(audio);
    expect(timings).toEqual([{ startSec: 0, endSec: 1, speechStartSec: 0, speechEndSec: 0.8 }]);
  });

  it("trims model edge silence and keeps the exact pause", () => {
    const audio = concat(silence(0.3), tone(1), silence(0.5));
    const { audio: output, timings } = postProcessChunks([{ audio, pauseAfterSec: 0.2 }], RATE, { trimSilence: true });
    // Tone plus 40 ms kept on each side, then the 0.2 s pause.
    expect(output.length).toBe(Math.round((1 + 0.08 + 0.2) * RATE));
    expect(timings[0].speechEndSec).toBeCloseTo(1.08, 6);
    expect(timings[0].endSec).toBeCloseTo(1.28, 6);
    expect(output.subarray(Math.round(1.08 * RATE)).every((sample) => sample === 0)).toBe(true);
  });

  it("drops the speech of a silent chunk but keeps its pause", () => {
    const { audio, timings } = postProcessChunks(
      [{ audio: silence(0.5), pauseAfterSec: 0.1 }, { audio: tone(0.2) }],
      RATE,
      { trimSilence: true, keepMs: 0, declickMs: 0 },
    );
    expect(timings[0]).toEqual({ startSec: 0, endSec: 0.1, speechStartSec: 0, speechEndSec: 0 });
    expect(timings[1].speechStartSec).toBeCloseTo(0.1, 6);
    expect(audio.length).toBe(Math.round(0.3 * RATE));
  });

  it("ramps abrupt speech edges at joins", () => {
    const { audio } = postProcessChunks([{ audio: constant(0.1, 0.5) }, { audio: constant(0.1, -0.5) }], RATE, { declickMs: 3 });
    const ramp = Math.round(0.003 * RATE);
    expect(Math.abs(audio[0])).toBeLessThan(0.01);
    expect(audio[ramp]).toBe(0.5);
    const join = Math.round(0.1 * RATE);
    expect(Math.abs(audio[join - 1])).toBeLessThan(0.01);
    expect(Math.abs(audio[join])).toBeLessThan(0.01);
    const steps = Array.from(audio.subarray(1), (sample, i) => Math.abs(sample - audio[i]));
    expect(Math.max(...steps)).toBeLessThan(0.5 / ramp * 2);
  });

  it("can turn the join ramp off", () => {
    const { audio } = postProcessChunks([{ audio: constant(0.1, 0.5) }], RATE, { declickMs: 0 });
    expect(audio[0]).toBe(0.5);
  });

  it("adds head and tail padding and shifts timings", () => {
    const { audio, timings } = postProcessChunks([{ audio: tone(0.5) }], RATE, { headSec: 0.25, tailSec: 0.5, declickMs: 0 });
    expect(audio.length).toBe(Math.round(1.25 * RATE));
    expect(audio.subarray(0, Math.round(0.25 * RATE)).every((sample) => sample === 0)).toBe(true);
    expect(timings[0].speechStartSec).toBeCloseTo(0.25, 6);
  });

  it("fades the content in after the head padding and out before the final pause", () => {
    const { audio } = postProcessChunks(
      [{ audio: concat(constant(0.5, 0.5), silence(0.2)), pauseAfterSec: 0.2 }],
      RATE,
      { headSec: 0.1, fadeInMs: 100, fadeOutMs: 100, declickMs: 0 },
    );
    const head = Math.round(0.1 * RATE);
    const fade = Math.round(0.1 * RATE);
    const fadeIn = Array.from(audio.subarray(head, head + fade));
    expect(fadeIn[0]).toBeLessThan(0.001);
    fadeIn.slice(1).forEach((sample, i) => expect(sample).toBeGreaterThanOrEqual(fadeIn[i]));
    expect(audio[head + fade]).toBe(0.5);
    const speechEnd = head + Math.round(0.5 * RATE);
    const fadeOut = Array.from(audio.subarray(speechEnd - fade, speechEnd));
    fadeOut.slice(1).forEach((sample, i) => expect(sample).toBeLessThanOrEqual(fadeOut[i]));
    expect(fadeOut.at(-1)).toBeLessThan(0.001);
    expect(audio[speechEnd - fade - 1]).toBe(0.5);
  });

  it("fades out across chunk boundaries when the last chunk is short", () => {
    const processor = new ChunkPostProcessor(RATE, { fadeOutMs: 300, declickMs: 0 });
    const first = processor.process({ audio: constant(0.5, 0.5) });
    // Everything the fade can still reach is held back.
    expect(first.length).toBe(Math.round(0.2 * RATE));
    const second = processor.process({ audio: constant(0.1, 0.5) });
    expect(second.length).toBe(Math.round(0.1 * RATE));
    const rest = processor.flush();
    expect(rest.length).toBe(Math.round(0.3 * RATE));
    expect(rest[0]).toBeGreaterThan(0.499);
    expect(rest.at(-1)).toBeLessThan(0.001);
  });

  it("gives the same output streamed or all at once", () => {
    const chunks = [
      { audio: concat(silence(0.05), tone(0.3), silence(0.15)), pauseAfterSec: 0.1 },
      { audio: concat(tone(0.2), silence(0.3)), pauseAfterSec: 0.3 },
      { audio: tone(0.1) },
    ];
    const options = { trimSilence: true, headSec: 0.1, tailSec: 0.1, fadeInMs: 50, fadeOutMs: 80 };
    const processor = new ChunkPostProcessor(RATE, options);
    const streamed = concat(...chunks.map((chunk) => processor.process(chunk)), processor.flush());
    expect(streamed).toEqual(postProcessChunks(chunks, RATE, options).audio);
    expect(processor.timings).toHaveLength(3);
  });

  it("clamps out-of-range options and pauses", () => {
    const { audio } = postProcessChunks([{ audio: tone(0.1), pauseAfterSec: 99 }], RATE, {
      headSec: -1,
      tailSec: Number.NaN,
      keepMs: Number.POSITIVE_INFINITY,
      declickMs: 0,
    });
    expect(audio.length).toBe(Math.round(0.1 * RATE));
  });

  it("validates the sample rate and lifecycle", () => {
    expect(() => new ChunkPostProcessor(0)).toThrow(/positive integer/);
    const processor = new ChunkPostProcessor(RATE);
    processor.flush();
    expect(() => processor.process({ audio: tone(0.1) })).toThrow(/after flush/);
    expect(() => processor.flush()).toThrow(/already flushed/);
  });
});

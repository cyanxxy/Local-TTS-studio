import { describe, expect, it } from "vitest";
import type { StoredAudioChunk } from "../audioTimeline";
import { retimeChunksForExport } from "./captionTiming";

const RATE = 1000;

/** A chunk of `speechSec` of tone with `leadSec` of silence before it and `pauseSec` after. */
function chunk(index: number, startSec: number, leadSec: number, speechSec: number, pauseSec: number, rate = RATE): StoredAudioChunk {
  const audio = new Float32Array(Math.round((leadSec + speechSec + pauseSec) * rate));
  audio.fill(0.5, Math.round(leadSec * rate), Math.round((leadSec + speechSec) * rate));
  return {
    audio,
    samplingRate: rate,
    text: `Passage ${index}`,
    index,
    total: 2,
    pauseAfterSec: pauseSec,
    segmentId: `s${index}`,
    startSec,
    endSec: startSec + audio.length / rate,
  } as StoredAudioChunk;
}

describe("retimeChunksForExport", () => {
  const chunks = [chunk(1, 0, 0.3, 1, 0.5), chunk(2, 1.8, 0.3, 1, 0)];

  it("leaves the times alone without finishing options or audio", () => {
    expect(retimeChunksForExport(chunks, undefined)).toBe(chunks);
    expect(retimeChunksForExport([], { trimSilence: true })).toEqual([]);
  });

  it("moves the captions with padding added at the start", () => {
    const retimed = retimeChunksForExport(chunks, { headSec: 2 });
    expect(retimed[0].startSec).toBeCloseTo(2, 2);
    expect(retimed[0].endSec - (retimed[0].pauseAfterSec ?? 0)).toBeCloseTo(3.3, 2);
    // The next chunk follows the first one's speech and pause, shifted by the same padding.
    expect(retimed[1].startSec).toBeCloseTo(chunks[1].startSec + 2, 2);
  });

  it("pulls the captions in when silence at the edges is trimmed", () => {
    const retimed = retimeChunksForExport(chunks, { trimSilence: true, keepMs: 0 });
    expect(retimed[0].startSec).toBeLessThan(0.05);
    expect(retimed[1].startSec).toBeLessThan(chunks[1].startSec);
    expect(retimed[1].startSec).toBeGreaterThan(1.4);
  });

  it("keeps the generated times when the chunks come at different sample rates", () => {
    const mixed = [chunks[0], chunk(2, 1.8, 0.3, 1, 0, 2000)];
    expect(retimeChunksForExport(mixed, { headSec: 2 })).toBe(mixed);
  });
});

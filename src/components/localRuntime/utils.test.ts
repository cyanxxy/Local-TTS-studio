import { describe, expect, it } from "vitest";
import { getNeuttsReferenceGuidance, isLikelyWavBuffer } from "./utils";

function makeWavHeader(): ArrayBuffer {
  const bytes = new Uint8Array(12);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  return bytes.buffer;
}

describe("localRuntime utils", () => {
  it("detects RIFF/WAVE headers", () => {
    expect(isLikelyWavBuffer(makeWavHeader())).toBe(true);
    expect(isLikelyWavBuffer(new Uint8Array([1, 2, 3, 4]).buffer)).toBe(false);
  });

  it("marks a doc-aligned NeuTTS reference clip as success", () => {
    const guidance = getNeuttsReferenceGuidance({
      channelCount: 1,
      sampleRate: 24_000,
      durationSec: 5.5,
    });

    expect(guidance.tone).toBe("success");
    expect(guidance.text).toContain("Reference WAV looks good");
  });

  it("warns when the reference clip falls outside NeuTTS guidance", () => {
    const guidance = getNeuttsReferenceGuidance({
      channelCount: 2,
      sampleRate: 48_000,
      durationSec: 1.2,
    });

    expect(guidance.tone).toBe("info");
    expect(guidance.text).toContain("Best results use mono audio, 16-44 kHz, and a 3-15 second clip.");
  });
});

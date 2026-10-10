import { describe, expect, it, vi } from "vitest";
import { SPEED_DEFAULT, SPEED_MAX, SPEED_MIN } from "../../constants";
import type { WorkerOutMessage } from "../../types";
import {
  appendSilence,
  clampSpeed,
  emitAudioChunk,
  normalizeFinalPauseSec,
  resolveChunkPauseSec,
} from "./emit";
import type { WorkerPort } from "./protocol";

describe("speed and pause helpers", () => {
  it("clamps speed to the shared voice-stable range", () => {
    expect(clampSpeed(2)).toBe(SPEED_MAX);
    expect(clampSpeed(0.1)).toBe(SPEED_MIN);
    expect(clampSpeed(1.05)).toBe(1.05);
    expect(clampSpeed(Number.NaN)).toBe(SPEED_DEFAULT);
  });

  it("clamps the final pause to 0-5 s and ignores invalid values", () => {
    expect(normalizeFinalPauseSec(undefined)).toBe(0);
    expect(normalizeFinalPauseSec(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeFinalPauseSec(-1)).toBe(0);
    expect(normalizeFinalPauseSec(9)).toBe(5);
    expect(normalizeFinalPauseSec(0.4)).toBe(0.4);
  });

  it("uses the boundary pause between chunks and the final pause after the last", () => {
    expect(resolveChunkPauseSec({ hasFollowing: true, pauseKind: "sentence", pauseAfterSec: 0.24 })).toBe(0.24);
    expect(resolveChunkPauseSec({
      hasFollowing: true,
      pauseKind: "sentence",
      pauseAfterSec: 0.24,
      pauseOverridesSec: { sentence: 0.5 },
      finalPauseSec: 3,
    })).toBe(0.5);
    expect(resolveChunkPauseSec({
      hasFollowing: false,
      pauseKind: "sentence",
      pauseAfterSec: 0.24,
      pauseOverridesSec: { sentence: 0.5 },
      finalPauseSec: 3,
    })).toBe(3);
  });

  it("appends silence in one new buffer and returns the input when there is none", () => {
    const speech = new Float32Array([0.5, -0.5]);
    expect(Array.from(appendSilence(speech, 0.3, 10))).toEqual([0.5, -0.5, 0, 0, 0]);
    expect(appendSilence(speech, 0, 10)).toBe(speech);
    expect(appendSilence(speech, 0.01, 10)).toBe(speech);
  });
});

describe("emitAudioChunk", () => {
  it("renders the pause into the PCM and reports it as metadata", () => {
    const posted: WorkerOutMessage[] = [];
    const port: WorkerPort = { post: (message) => posted.push(message), postError: vi.fn() };

    emitAudioChunk(port, {
      generationId: "g1",
      audio: new Float32Array([0.25]),
      samplingRate: 10,
      text: "One.",
      index: 1,
      total: 2,
      textStart: 0,
      textEnd: 4,
      pauseKind: "sentence",
      pauseSec: 0.2,
    });
    emitAudioChunk(port, {
      generationId: undefined,
      audio: new Float32Array([0.5]),
      samplingRate: 10,
      text: "Two.",
      index: 2,
      total: 2,
      pauseKind: "none",
      pauseSec: 0,
    });

    expect(posted[0]).toMatchObject({
      type: "AUDIO_CHUNK",
      generationId: "g1",
      samplingRate: 10,
      text: "One.",
      index: 1,
      total: 2,
      textStart: 0,
      textEnd: 4,
      pauseAfterSec: 0.2,
      pauseKind: "sentence",
    });
    expect(Array.from((posted[0] as Extract<WorkerOutMessage, { type: "AUDIO_CHUNK" }>).audio)).toEqual([0.25, 0, 0]);
    expect(posted[1]).not.toHaveProperty("generationId");
    expect(Array.from((posted[1] as Extract<WorkerOutMessage, { type: "AUDIO_CHUNK" }>).audio)).toEqual([0.5]);
  });
});

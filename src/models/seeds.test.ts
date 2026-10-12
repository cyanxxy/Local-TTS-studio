import { describe, expect, it } from "vitest";
import type { GenerationTuningSettings } from "../types";
import { audio8Engine } from "./audio8";
import { MAX_SEED, parseSeed } from "./settings";
import { supertonic3Engine } from "./supertonic3";

const TUNING: GenerationTuningSettings = { speed: 1, quality: 5, language: "en" };

describe("parseSeed", () => {
  it("keeps unsigned 32-bit integers and nothing else", () => {
    expect(parseSeed(0)).toBe(0);
    expect(parseSeed(MAX_SEED)).toBe(MAX_SEED);
    for (const value of [-1, 1.5, MAX_SEED + 1, "3", null, undefined, Number.NaN]) expect(parseSeed(value), String(value)).toBeNull();
  });
});

describe("Audio8 sampling settings", () => {
  it("declares seed support and stores a seed and a temperature within the IPC's limits", () => {
    expect(audio8Engine.capabilities.seed).toBe(true);
    expect(audio8Engine.parseSettings({ voice: "iris", seed: 12, temperature: 0.5 })).toEqual({ voice: "iris", seed: 12, temperature: 0.5 });
    expect(audio8Engine.parseSettings({ temperature: 0 }).temperature).toBe(0.1);
    expect(audio8Engine.parseSettings({ temperature: 5 }).temperature).toBe(1);
    expect(audio8Engine.parseSettings({ temperature: "hot" }).temperature).toBeNull();
    expect(audio8Engine.parseSettings({ temperature: Number.NaN }).temperature).toBeNull();
    expect(audio8Engine.parseSettings({ seed: -3 }).seed).toBeNull();
  });

  it("signs sampling only when set, so audio cached before it existed stays valid", () => {
    const sign = (patch: object) => audio8Engine.signatureParts({
      settings: { ...audio8Engine.defaultSettings, ...patch },
      tuning: TUNING,
      quality: 5,
    });

    expect(sign({})?.voice).toBe("clara");
    expect(sign({ seed: 1 })?.voice).not.toBe("clara");
    expect(sign({ seed: 1 })).not.toEqual(sign({ seed: 2 }));
    expect(sign({ temperature: 0.5 })).not.toEqual(sign({ temperature: 0.6 }));
  });
});

describe("Supertonic 3 seed", () => {
  it("declares seed support and stores a valid seed", () => {
    expect(supertonic3Engine.capabilities.seed).toBe(true);
    expect(supertonic3Engine.parseSettings({ voice: "F2", language: "ja", seed: 77 })).toEqual({ voice: "F2", language: "ja", seed: 77 });
    expect(supertonic3Engine.parseSettings({ seed: 1.5 }).seed).toBeNull();
  });

  it("signs a fixed seed only when one is set", () => {
    const sign = (seed: number | null) => supertonic3Engine.signatureParts({
      settings: { ...supertonic3Engine.defaultSettings, seed },
      tuning: TUNING,
      quality: 5,
    });

    expect(sign(null)?.voice).toBe("M1");
    expect(sign(3)).not.toEqual(sign(4));
    expect(sign(3)).not.toEqual(sign(null));
  });
});

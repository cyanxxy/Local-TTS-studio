// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  AUDIO8_DEFAULT_VOICE as RENDERER_DEFAULT_VOICE,
  AUDIO8_MODEL_DOWNLOAD_LABEL,
  AUDIO8_MODEL_URL,
  AUDIO8_VOICES,
} from "./src/constants";
import {
  AUDIO8_DEFAULT_VOICE,
  AUDIO8_MODEL_DOWNLOAD_BYTES,
  AUDIO8_MODEL_ID,
  AUDIO8_VOICE_IDS,
} from "./electron/audio8Model";

const MIB = 1024 * 1024;

describe("Audio8 renderer voice catalogue", () => {
  // `src/constants.ts` holds the names and descriptions the picker renders,
  // `electron/audio8Model.ts` holds the ids the worker resolves to asset paths.
  // The renderer cannot import the desktop module, so nothing but this test
  // stops a voice from being added, removed, or renamed on one side only.
  it("offers exactly the voices the desktop runtime can synthesise", () => {
    expect(AUDIO8_VOICES.map((voice) => voice.id)).toEqual([...AUDIO8_VOICE_IDS]);
  });

  it("defaults to the same voice the desktop runtime defaults to", () => {
    expect(RENDERER_DEFAULT_VOICE).toBe(AUDIO8_DEFAULT_VOICE);
  });

  it("gives every offered voice a name and a description to render", () => {
    for (const voice of AUDIO8_VOICES) {
      expect(voice.name.length).toBeGreaterThan(0);
      expect(voice.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("Audio8 renderer download copy", () => {
  // The size is quoted to the user before a ~10 minute download starts, and it
  // is the only number in that sentence they can check against their disk.
  it("quotes the size the desktop runtime actually downloads", () => {
    expect(AUDIO8_MODEL_DOWNLOAD_LABEL)
      .toBe(`${Math.round(AUDIO8_MODEL_DOWNLOAD_BYTES / MIB)} MiB`);
  });

  it("links the model card the assets are pinned against", () => {
    expect(AUDIO8_MODEL_URL).toBe(`https://huggingface.co/${AUDIO8_MODEL_ID}`);
  });
});

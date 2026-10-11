// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseAudio8GenerateRequest,
  parseAudio8RequestId,
  parseAudio8SamplingOptions,
} from "./audio8Ipc";
import { AUDIO8_MAX_SEED, AUDIO8_MAX_TEXT_CHARACTERS } from "./audio8Model";

const SEED_ERROR = "Audio8 seed must be an integer from 0 to 4294967295.";
const TEMPERATURE_ERROR = "Audio8 temperature must be a number from 0.1 to 1.";

function generate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId: "gen-1", text: "Hello there.", voice: "clara", ...overrides };
}

function rejection(parse: () => unknown): Error {
  try {
    parse();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the payload to be rejected");
}

describe("parseAudio8RequestId", () => {
  it.each(["load-1", "audio8-generate-1700000000000-abc123", "a.b_c-d", "x".repeat(128)])(
    "accepts %s",
    (requestId) => {
      expect(parseAudio8RequestId({ requestId })).toBe(requestId);
    },
  );

  it.each([
    ["a missing payload", undefined],
    ["an array", [{ requestId: "load-1" }]],
    ["a missing id", {}],
    ["a numeric id", { requestId: 7 }],
    ["an empty id", { requestId: "" }],
    ["an id with spaces", { requestId: "has spaces" }],
    ["an id one character too long", { requestId: "x".repeat(129) }],
  ])("rejects %s", (_name, request) => {
    const error = rejection(() => parseAudio8RequestId(request));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("Invalid Audio8 request id.");
  });
});

describe("parseAudio8GenerateRequest", () => {
  it("returns the request untouched and omits sampling when nothing was overridden", () => {
    const parsed = parseAudio8GenerateRequest(generate({ text: "  Hello there.  ", voice: "sophie" }));

    expect(parsed).toEqual({ requestId: "gen-1", text: "  Hello there.  ", voice: "sophie" });
    expect(parsed).not.toHaveProperty("sampling");
  });

  it("treats null and undefined overrides as the defaults", () => {
    expect(parseAudio8GenerateRequest(generate({ seed: null, temperature: undefined })))
      .not.toHaveProperty("sampling");
  });

  it("carries only the overrides the caller set", () => {
    expect(parseAudio8GenerateRequest(generate({ seed: 7 })).sampling).toEqual({ seed: 7 });
    expect(parseAudio8GenerateRequest(generate({ temperature: 0.6 })).sampling).toEqual({ temperature: 0.6 });
    expect(parseAudio8GenerateRequest(generate({ seed: 0, temperature: 1 })).sampling)
      .toEqual({ seed: 0, temperature: 1 });
  });

  it.each([
    ["empty text", { text: "" }, "Invalid Audio8 synthesis text."],
    ["whitespace-only text", { text: "   \n " }, "Invalid Audio8 synthesis text."],
    ["non-string text", { text: ["Hello"] }, "Invalid Audio8 synthesis text."],
    ["an unknown voice", { voice: "morgan" }, "Unsupported Audio8 voice."],
    ["a missing voice", { voice: undefined }, "Unsupported Audio8 voice."],
  ])("rejects %s", (_name, overrides, message) => {
    const error = rejection(() => parseAudio8GenerateRequest(generate(overrides)));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe(message);
  });

  it("counts the character cap in Unicode scalars and accepts the cap itself", () => {
    const atCap = "🎧".repeat(AUDIO8_MAX_TEXT_CHARACTERS);

    expect(parseAudio8GenerateRequest(generate({ text: atCap })).text).toBe(atCap);
    expect(rejection(() => parseAudio8GenerateRequest(generate({ text: `${atCap}a` }))).message)
      .toBe("Invalid Audio8 synthesis text.");
  });

  it("reports the first problem in a fixed order", () => {
    expect(rejection(() => parseAudio8GenerateRequest({ requestId: "bad id", text: "", voice: "x", seed: -1 })).message)
      .toBe("Invalid Audio8 request id.");
    expect(rejection(() => parseAudio8GenerateRequest(generate({ text: "", voice: "x", seed: -1 }))).message)
      .toBe("Invalid Audio8 synthesis text.");
    expect(rejection(() => parseAudio8GenerateRequest(generate({ voice: "x", seed: -1 }))).message)
      .toBe("Unsupported Audio8 voice.");
    expect(rejection(() => parseAudio8GenerateRequest(generate({ seed: -1, temperature: 9 }))).message)
      .toBe(SEED_ERROR);
  });
});

describe("parseAudio8SamplingOptions", () => {
  it("returns nothing when no override is present", () => {
    expect(parseAudio8SamplingOptions({})).toBeUndefined();
  });

  it.each([0, 1, 42, AUDIO8_MAX_SEED])("accepts seed %s", (seed) => {
    expect(parseAudio8SamplingOptions({ seed })).toEqual({ seed });
  });

  it.each([
    ["negative", -1],
    ["past uint32", AUDIO8_MAX_SEED + 1],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["infinite", Infinity],
    ["a numeric string", "7"],
    ["a bigint", 7n],
  ])("rejects a %s seed", (_name, seed) => {
    const error = rejection(() => parseAudio8SamplingOptions({ seed }));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe(SEED_ERROR);
  });

  it.each([0.1, 0.3, 0.75, 1])("accepts temperature %s", (temperature) => {
    expect(parseAudio8SamplingOptions({ temperature })).toEqual({ temperature });
  });

  it.each([
    ["zero", 0],
    ["just below the floor", 0.099],
    ["just above the ceiling", 1.001],
    ["negative", -0.3],
    ["NaN", NaN],
    ["infinite", Infinity],
    ["a numeric string", "0.3"],
  ])("rejects a %s temperature", (_name, temperature) => {
    const error = rejection(() => parseAudio8SamplingOptions({ temperature }));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe(TEMPERATURE_ERROR);
  });
});

import { describe, expect, it } from "vitest";
import { tuneChunkText } from "../textTuning";
import { stripSpeechBreakMarkup } from "./speechMarkup";
import { buildSpeechTextRewrite } from "./speechText";

describe("buildSpeechTextRewrite", () => {
  it("returns the text unchanged without options or markup", () => {
    const rewrite = buildSpeechTextRewrite("Plain words.");
    expect(rewrite.text).toBe("Plain words.");
    expect(rewrite.edits).toEqual([]);
  });

  it.each([
    "Say *GIF* now.",
    "Use **bold** and [[urgent]] and *em*.",
    "The US and us, with GIF files.",
    'Wait <break time="1s"/> then [pause 2s] go.',
    "A [pause] [pause] B and [pause][pause]C",
    "[pause 1s] Lead and trail [pause]",
    "Line one. [pause 1s]\nLine two.",
    "**[[x]]** and ***y***",
    "2*3 is *six*",
    "a *[pause]* b",
  ])("matches tuneChunkText for %j", (text) => {
    const rules = [{ from: "GIF", to: "jif" }, { from: "US", to: "United States" }];
    expect(buildSpeechTextRewrite(text, { pronunciationRules: rules }).text).toBe(tuneChunkText(text, rules));
  });

  it("strips break tags exactly like stripSpeechBreakMarkup", () => {
    for (const text of ["x[pause]y", "x [pause] y", "[pause]", "a\t<break/>\tb", "a [pause]\nb"]) {
      expect(buildSpeechTextRewrite(text).text).toBe(stripSpeechBreakMarkup(text));
    }
  });

  it("normalizes on request and lets pronunciation rules win where they overlap", () => {
    const text = "Pay $5 for 2 GIFs or the 3D GIF on 3/4/2024.";
    const rules = [{ from: "3D", to: "three dee" }, { from: "GIF", to: "jif" }];
    expect(buildSpeechTextRewrite(text, { pronunciationRules: rules, normalization: {} }).text).toBe(
      "Pay five dollars for two GIFs or the three dee jif on March fourth, twenty twenty-four.",
    );
    expect(buildSpeechTextRewrite(text, { normalization: false }).text).toBe(text);
  });

  it("keeps both emphasis markers when a break tag takes one of them", () => {
    expect(buildSpeechTextRewrite('x *a <break time="*"/> b').text).toBe("x *a b");
  });

  it("maps spoken offsets back to the source and labels edits", () => {
    const text = "Hi *Dr. Who*, pay $5.";
    const rewrite = buildSpeechTextRewrite(text, { normalization: { rules: ["currency", "abbreviations"] } });
    expect(rewrite.text).toBe("Hi Doctor Who, pay five dollars.");
    expect(rewrite.edits.map((edit) => edit.reason)).toEqual(["emphasis", "abbreviations", "emphasis", "currency"]);
    const five = rewrite.text.indexOf("five");
    expect(rewrite.toSourceRange({ start: five, end: five + "five dollars".length })).toEqual({ start: 18, end: 20 });
  });
});

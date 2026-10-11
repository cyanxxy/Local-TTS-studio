import { describe, expect, it } from "vitest";
import {
  ALL_TEXT_CLEANUP_ACTIONS,
  DEFAULT_TEXT_CLEANUP_ACTIONS,
  cleanupText,
  type TextCleanupAction,
} from "./cleanup";
import { applyTextEdits, buildTextDiff } from "./textEdits";

type Fixture = readonly [input: string, expected: string];

const only = (action: TextCleanupAction, text: string) => cleanupText(text, { actions: [action] }).text;

const FIXTURES: Record<TextCleanupAction, readonly Fixture[]> = {
  markdown: [
    ["# Title\n\nBody", "Title\n\nBody"],
    ["### Closed heading ###", "Closed heading"],
    ["> quoted\n> > nested", "quoted\nnested"],
    ["- one\n* two\n+ three", "one\ntwo\nthree"],
    ["1. first", "1. first"],
    ["Use **bold**, __strong__, *em*, _em_ and ~~gone~~.", "Use bold, strong, em, em and gone."],
    ["A [link](https://example.com) and [ref][1].", "A link and ref."],
    ["![Diagram](a.png) and ![](b.png)", "Diagram and"],
    ["See <https://example.com>.", "See https://example.com."],
    ["Run `a_b_c` or ``x`y``.", "Run a_b_c or x`y."],
    ["```js\nconst a = 1;\n```\nAfter", "const a = 1;\nAfter"],
    ["Above\n\n---\n\nBelow", "Above\n\nBelow"],
    ["**[bold link](x)**", "bold link"],
    ["Note[^1] here.", "Note here."],
    ["2 * 3 * 4 and snake_case_name", "2 * 3 * 4 and snake_case_name"],
  ],
  citations: [
    ["Paris is large.[1] It grew.[2][3]", "Paris is large. It grew."],
    ["Cited [12] here.", "Cited here."],
    ["Range [3–5], list [1, 2] and [4-6].", "Range, list and."],
    ["Claim [citation needed].", "Claim."],
    ["Odd[note 3] and[a] fact", "Odd and fact"],
    ["Words [1] [2] next", "Words next"],
    ["[1] Leading", "Leading"],
    ["  [1].", "."],
    ["Keep [here] and [12345]", "Keep [here] and [12345]"],
  ],
  footnotes: [
    ["As shown.¹ Then²³ more", "As shown. Then more"],
    ["An area of 5 m² stays", "An area of 5 m² stays"],
    ["Smith† and Jones‡,", "Smith and Jones,"],
  ],
  urls: [
    ["Visit https://www.Example.com/path?q=1.", "Visit example.com."],
    ["See www.example.org/docs, then", "See example.org, then"],
    ["(https://example.com/a_(b))", "(example.com)"],
    ["Local http://localhost:3000/x", "Local"],
    ["mail jane@example.com", "mail jane@example.com"],
  ],
  emoji: [
    ["Great job 🎉 team", "Great job team"],
    ["🔥 Hot", "Hot"],
    ["🔥  ", ""],
    ["Wow 🎉 🎉!", "Wow!"],
    ["Family 👨‍👩‍👧 and thumbs 👍🏽 ok", "Family and thumbs ok"],
    ["Flag 🇫🇷 and key 1️⃣ and heart ❤️ end", "Flag and key and heart end"],
    ["© 2024 Acme™ ®", "© 2024 Acme™ ®"],
  ],
  pdfArtifacts: [
    ["The ﬁrst ﬂoor", "The first floor"],
    ["co­operate", "cooperate"],
    ["This is an exam-\nple of text", "This is an example of text"],
    ["a sentence that\ncontinues here", "a sentence that continues here"],
    ["clause,\nNext", "clause, Next"],
    ["End.\nNew line", "End.\nNew line"],
    ["Intro:\n- item", "Intro:\n- item"],
    ["Para one\n\nPara two", "Para one\n\nPara two"],
    ["text before\n12\nmore text", "text before more text"],
    ["end of page.\nPage 7 of 30\nNext page", "end of page.\nNext page"],
    ["42\nThe answer", "42\nThe answer"],
  ],
  htmlEntities: [
    ["Tom &amp; Jerry &lt;3 &quot;hi&quot; &apos;x&apos;", "Tom & Jerry <3 \"hi\" 'x'"],
    ["A&nbsp;B &#8212; &#x2019; &#160;", "A B — ’"],
    ["x &nbsp;&#xA0; y\n&nbsp;Start", "x y\nStart"],
    ["Keep &unknown; &#0; &#xD800; &#1114112;", "Keep &unknown; &#0; &#xD800; &#1114112;"],
  ],
  repeatedPunctuation: [
    ["What?? Really!!! Yes?!?! No!?", "What? Really! Yes?! No!?"],
    ["Wait..... and,, then... ok!?!", "Wait... and, then... ok!?"],
  ],
  whitespace: [
    ["a  b\t c", "a b c"],
    ["line \nnext  ", "line\nnext"],
    ["  indented\n\n\n\nfar", "indented\n\nfar"],
    ["win\r\nline\rmac", "win\nline\nmac"],
  ],
};

describe("cleanupText actions", () => {
  for (const [action, fixtures] of Object.entries(FIXTURES) as [TextCleanupAction, readonly Fixture[]][]) {
    it.each(fixtures)(`${action}: %j -> %j`, (input, expected) => {
      expect(only(action, input)).toBe(expected);
    });
  }

  it("removes URLs entirely in remove mode", () => {
    expect(cleanupText("Visit https://example.com/x now", { actions: ["urls"], urlMode: "remove" }).text).toBe("Visit now");
    expect(cleanupText("Visit https://example.com.", { actions: ["urls"], urlMode: "remove" }).text).toBe("Visit.");
  });
});

describe("cleanupText", () => {
  const messy = [
    "# Notes 🎉",
    "",
    "Paris is the **capital** of France.[1] See https://en.wikipedia.org/wiki/Paris for more!!!",
    "The city has a long his-",
    "tory &amp; culture.²",
    "",
    "12",
    "",
    "- Visit  the [Louvre](https://louvre.fr)",
  ].join("\n");

  it("runs every action except pdfArtifacts by default", () => {
    expect(DEFAULT_TEXT_CLEANUP_ACTIONS).toEqual(ALL_TEXT_CLEANUP_ACTIONS.filter((action) => action !== "pdfArtifacts"));
    expect(cleanupText("an exam-\nple and **bold**").text).toBe("an exam-\nple and bold");
  });

  it("runs the requested actions and counts edits per action", () => {
    const result = cleanupText(messy, { actions: ALL_TEXT_CLEANUP_ACTIONS });
    expect(result.text).toBe([
      "Notes",
      "",
      "Paris is the capital of France. See en.wikipedia.org for more!",
      "The city has a long history & culture.",
      "",
      "Visit the Louvre",
    ].join("\n"));
    expect(result.counts).toMatchObject({
      markdown: 6,
      citations: 1,
      footnotes: 1,
      urls: 1,
      emoji: 1,
      htmlEntities: 1,
      repeatedPunctuation: 1,
    });
    expect(result.counts.whitespace).toBeGreaterThan(0);
    expect(Object.keys(result.counts).sort()).toEqual([...ALL_TEXT_CLEANUP_ACTIONS].sort());
  });

  it("is idempotent with the default actions and with each action alone", () => {
    const inputs = [messy, ...Object.values(FIXTURES).flat().map(([input]) => input)];
    for (const actions of [DEFAULT_TEXT_CLEANUP_ACTIONS, ...ALL_TEXT_CLEANUP_ACTIONS.map((action) => [action])]) {
      for (const input of inputs) {
        const once = cleanupText(input, { actions }).text;
        expect(cleanupText(once, { actions }).text).toBe(once);
      }
    }
  });

  it("maps cleaned offsets back to the original text", () => {
    const source = "Hello **world**.[1] Bye";
    const result = cleanupText(source);
    expect(result.text).toBe("Hello world. Bye");
    const world = result.text.indexOf("world");
    expect(result.toSourceRange({ start: world, end: world + 5 })).toEqual({ start: 8, end: 13 });
    expect(result.toSourceOffset(result.text.indexOf("Bye"))).toBe(source.indexOf("Bye"));
  });

  it("returns an identity result when nothing needs cleaning or no actions run", () => {
    expect(cleanupText("Already clean.").edits).toEqual([]);
    expect(cleanupText(messy, { actions: [] }).text).toBe(messy);
  });
});

describe("buildTextDiff", () => {
  it("lists equal, removed and inserted parts in reading order", () => {
    const result = cleanupText("Tom &amp; Jerry[1] laugh!!!", { actions: ["htmlEntities", "citations", "repeatedPunctuation"] });
    expect(buildTextDiff(result)).toEqual([
      { type: "equal", text: "Tom ", sourceStart: 0 },
      { type: "removed", text: "&amp;", sourceStart: 4, reason: "htmlEntities" },
      { type: "inserted", text: "&", sourceStart: 4, reason: "htmlEntities" },
      { type: "equal", text: " Jerry", sourceStart: 9 },
      { type: "removed", text: "[1]", sourceStart: 15, reason: "citations" },
      { type: "equal", text: " laugh", sourceStart: 18 },
      { type: "removed", text: "!!!", sourceStart: 24, reason: "repeatedPunctuation" },
      { type: "inserted", text: "!", sourceStart: 24, reason: "repeatedPunctuation" },
    ]);
  });

  it("handles insertions, edits without a reason and unchanged text", () => {
    const rewrite = applyTextEdits("ab", [{ start: 1, end: 1, replacement: "-" }]);
    expect(buildTextDiff(rewrite)).toEqual([
      { type: "equal", text: "a", sourceStart: 0 },
      { type: "inserted", text: "-", sourceStart: 1 },
      { type: "equal", text: "b", sourceStart: 1 },
    ]);
    expect(buildTextDiff(applyTextEdits("same", []))).toEqual([{ type: "equal", text: "same", sourceStart: 0 }]);
    expect(buildTextDiff(applyTextEdits("", []))).toEqual([]);
    expect(buildTextDiff(cleanupText("# Hi", { actions: ["markdown"] }))).toEqual([
      { type: "removed", text: "# ", sourceStart: 0, reason: "markdown" },
      { type: "equal", text: "Hi", sourceStart: 2 },
    ]);
  });
});

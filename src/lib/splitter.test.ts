import { describe, it, expect } from "vitest";
import { split, TextSplitterStream } from "./splitter";

describe("split", () => {
  it("ends sentences inside typographic quotes", () => {
    expect(split("“Go home.” He went.")).toEqual(["“Go home.”", "He went."]);
    expect(split("He said “Stop!” Then silence fell.")).toEqual(["He said “Stop!”", "Then silence fell."]);
    expect(split("She whispered, ‘Not yet.’ Then she left.")).toEqual(["She whispered, ‘Not yet.’", "Then she left."]);
  });

  it("keeps curly apostrophes and lowercase dialogue tags inside the sentence", () => {
    expect(split("‘I don’t know,’ she said. He nodded.")).toEqual(["‘I don’t know,’ she said.", "He nodded."]);
    expect(split("“Really?” she asked. Then left.")).toEqual(["“Really?” she asked.", "Then left."]);
    expect(split("The dogs’ bowls were empty. We filled them.")).toEqual(["The dogs’ bowls were empty.", "We filled them."]);
  });

  it("does not end a sentence at a numbered reference", () => {
    expect(split("See No. 5 and Fig. 2 for data. Next.")).toEqual(["See No. 5 and Fig. 2 for data.", "Next."]);
    expect(split("I said no. Then he left.")).toEqual(["I said no.", "Then he left."]);
  });

  it("splits text on sentence boundaries", () => {
    const result = split("Hello world. How are you? I am fine!");
    expect(result).toEqual(["Hello world.", "How are you?", "I am fine!"]);
  });

  it("returns single sentence for text without terminators", () => {
    const result = split("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("handles empty string", () => {
    const result = split("");
    expect(result).toEqual([]);
  });

  it("preserves abbreviations (Mr., Dr., etc.)", () => {
    const result = split("Mr. Smith went to Washington. He arrived on time.");
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Mr. Smith");
  });

  it("handles ellipsis correctly", () => {
    const result = split("Wait... I think so. Yes, definitely.");
    expect(result.length).toBeGreaterThanOrEqual(1);
    // Ellipsis should not be split as a standalone sentence
    expect(result.find((s) => s === "...")).toBeUndefined();
  });

  it("does not split numbers with decimals", () => {
    const result = split("The price is $9.99 and it ships today. Great deal!");
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("$9.99");
  });

  it("handles newlines as terminators", () => {
    const result = split("First line\nSecond line\nThird line");
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("handles quotes correctly", () => {
    const result = split('"Is this real?" she asked. He nodded.');
    expect(result).toHaveLength(2);
  });

  it("splits after quoted sentence endings", () => {
    const result = split('"Hello." Next sentence.');
    expect(result).toEqual(['"Hello."', "Next sentence."]);
  });

  it("splits when a multi-letter acronym ends the sentence", () => {
    const result = split("We live in the U.S. It is large.");
    expect(result).toEqual(["We live in the U.S.", "It is large."]);
  });

  it("does not classify malformed comma URLs as valid URLs", () => {
    const result = split("Visit https,//example. This should split.");
    expect(result).toEqual(["Visit https,//example.", "This should split."]);
  });
});

describe("TextSplitterStream", () => {
  it("implements synchronous iterator", () => {
    const splitter = new TextSplitterStream();
    splitter.push("Hello world. Goodbye.");
    const sentences = [...splitter];
    expect(sentences).toEqual(["Hello world.", "Goodbye."]);
  });

  it("implements async iterator", async () => {
    const splitter = new TextSplitterStream();
    splitter.push("First sentence. Second sentence.");
    splitter.close();

    const sentences: string[] = [];
    for await (const sentence of splitter) {
      sentences.push(sentence);
    }
    expect(sentences).toEqual(["First sentence.", "Second sentence."]);
  });

  it("buffers incomplete sentences until more text arrives", () => {
    const splitter = new TextSplitterStream();
    splitter.push("Hello");
    expect(splitter.sentences).toHaveLength(0);
    splitter.push(" world. Done.");
    // After flush, should have both
    const sentences = [...splitter];
    expect(sentences.length).toBeGreaterThanOrEqual(1);
  });

  it("throws on double close", () => {
    const splitter = new TextSplitterStream();
    splitter.close();
    expect(() => splitter.close()).toThrow("Stream is already closed.");
  });
});

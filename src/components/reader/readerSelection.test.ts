import { afterEach, describe, expect, it } from "vitest";
import { normalizeQuote, readArticleSelection } from "./readerSelection";

/** Paragraphs as the reading pane renders them: one <p> per block, split into spans. */
function renderArticle(blocks: Array<{ start: number; parts: string[] }>): HTMLElement {
  const article = document.createElement("article");
  for (const block of blocks) {
    const paragraph = document.createElement("p");
    paragraph.dataset.blockStart = String(block.start);
    for (const part of block.parts) {
      const span = document.createElement("span");
      span.textContent = part;
      paragraph.append(span);
    }
    article.append(paragraph);
  }
  document.body.append(article);
  return article;
}

function select(startNode: Node, startOffset: number, endNode: Node = startNode, endOffset = startOffset): void {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("readArticleSelection", () => {
  it("maps a selection inside a later paragraph back to its section offset", () => {
    // "First line.\nSecond line here." — the newline is never rendered.
    const article = renderArticle([
      { start: 0, parts: ["First line."] },
      { start: 12, parts: ["Second ", "line here."] },
    ]);
    const secondSpan = article.querySelectorAll("p")[1].lastChild!.firstChild!;
    select(secondSpan, 0, secondSpan, 4);

    expect(readArticleSelection(article, 29)).toEqual({ start: 19, collapsed: false, quote: "line" });
  });

  it("reports a collapsed caret, clamped to the section", () => {
    const article = renderArticle([{ start: 40, parts: ["Tail"] }]);
    select(article.querySelector("span")!.firstChild!, 2);

    expect(readArticleSelection(article, 41)).toEqual({ start: 41, collapsed: true, quote: "" });
  });

  it("ignores selections that start or end outside the article", () => {
    const article = renderArticle([{ start: 0, parts: ["Inside"] }]);
    const outside = document.createElement("p");
    outside.textContent = "Outside";
    document.body.prepend(outside);

    select(outside.firstChild!, 0, article.querySelector("span")!.firstChild!, 3);
    expect(readArticleSelection(article, 6)).toBeNull();

    window.getSelection()!.removeAllRanges();
    expect(readArticleSelection(article, 6)).toBeNull();
  });

  it("ignores positions that are not inside a paragraph block", () => {
    const article = renderArticle([{ start: 0, parts: ["Text"] }]);
    const stray = document.createElement("div");
    stray.textContent = "Not a block";
    article.append(stray);
    select(stray.firstChild!, 1);

    expect(readArticleSelection(article, 4)).toBeNull();
  });
});

describe("normalizeQuote", () => {
  it("collapses whitespace and caps the stored quote", () => {
    expect(normalizeQuote("  A  quoted\n\nline \t")).toBe("A quoted line");
    expect(normalizeQuote("x".repeat(600))).toHaveLength(500);
  });
});

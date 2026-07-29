import { describe, expect, it } from "vitest";
import { findDocumentMatches } from "./readerSearch";

describe("findDocumentMatches", () => {
  it("folds case and diacritics before matching", () => {
    expect(findDocumentMatches("Café au lait", "cafe")).toEqual([
      expect.objectContaining({ offset: 0, match: "Café" }),
    ]);
  });

  it("stops at the requested limit", () => {
    expect(findDocumentMatches("ababab", "ab", 2)).toHaveLength(2);
  });

  it("ignores queries shorter than two characters", () => {
    expect(findDocumentMatches("a document", "a")).toEqual([]);
  });

  // The fold is cached by source-string identity, so a second document must
  // never be searched against the first one's offset map.
  it("does not reuse the cached fold across different documents", () => {
    findDocumentMatches("first document", "document");
    expect(findDocumentMatches("second one", "second")).toEqual([
      expect.objectContaining({ offset: 0, match: "second" }),
    ]);
    expect(findDocumentMatches("first document", "document")).toEqual([
      expect.objectContaining({ offset: 6, match: "document" }),
    ]);
  });
});

export interface ReaderSearchResult {
  offset: number;
  before: string;
  match: string;
  after: string;
}

interface FoldedText {
  value: string;
  sourceStarts: number[];
  sourceEnds: number[];
}

function foldText(text: string): FoldedText {
  // Repeated `+=` on a book-sized string forces the engine to keep flattening
  // rope concatenations, so the folded chunks are collected and joined once.
  const chunks: string[] = [];
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let sourceOffset = 0;

  for (const character of text) {
    const foldedCharacter = character.normalize("NFD").toLowerCase();
    chunks.push(foldedCharacter);
    for (let index = 0; index < foldedCharacter.length; index += 1) {
      sourceStarts.push(sourceOffset);
      sourceEnds.push(sourceOffset + character.length);
    }
    sourceOffset += character.length;
  }

  return { value: chunks.join(""), sourceStarts, sourceEnds };
}

/**
 * Folding a 500KB book walks every code point and fills two offset maps, which
 * is far too expensive to repeat per keystroke. Documents are immutable strings
 * in practice, so a size-1 cache keyed on string identity turns every search
 * after the first into a plain `indexOf` over the already folded haystack.
 */
let foldedDocumentSource: string | null = null;
let foldedDocument: FoldedText | null = null;

function foldDocument(text: string): FoldedText {
  if (foldedDocumentSource === text && foldedDocument) return foldedDocument;
  foldedDocument = foldText(text);
  foldedDocumentSource = text;
  return foldedDocument;
}

export function findDocumentMatches(
  text: string,
  query: string,
  limit = 50,
): ReaderSearchResult[] {
  const trimmedQuery = query.trim();
  if ([...trimmedQuery].length < 2) return [];
  const needle = foldText(trimmedQuery).value;
  const haystack = foldDocument(text);
  const results: ReaderSearchResult[] = [];
  let cursor = 0;

  while (results.length < limit) {
    const at = haystack.value.indexOf(needle, cursor);
    if (at === -1) break;
    const foldedEnd = at + needle.length;
    const sourceStart = haystack.sourceStarts[at];
    const sourceEnd = haystack.sourceEnds[foldedEnd - 1];
    results.push({
      offset: sourceStart,
      before: text.slice(Math.max(0, sourceStart - 40), sourceStart).replace(/\s+/g, " ").trimStart(),
      match: text.slice(sourceStart, sourceEnd),
      after: text.slice(sourceEnd, sourceEnd + 60).replace(/\s+/g, " ").trimEnd(),
    });
    cursor = foldedEnd;
  }

  return results;
}

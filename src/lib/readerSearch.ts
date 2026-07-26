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
  let value = "";
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let sourceOffset = 0;

  for (const character of text) {
    const foldedCharacter = character.normalize("NFD").toLowerCase();
    value += foldedCharacter;
    for (let index = 0; index < foldedCharacter.length; index += 1) {
      sourceStarts.push(sourceOffset);
      sourceEnds.push(sourceOffset + character.length);
    }
    sourceOffset += character.length;
  }

  return { value, sourceStarts, sourceEnds };
}

export function findDocumentMatches(
  text: string,
  query: string,
  limit = 50,
): ReaderSearchResult[] {
  const trimmedQuery = query.trim();
  if ([...trimmedQuery].length < 2) return [];
  const needle = foldText(trimmedQuery).value;
  const haystack = foldText(text);
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

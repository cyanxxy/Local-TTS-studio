/**
 * Returns true if the character is considered a sentence terminator.
 */
function isSentenceTerminator(c: string, includeNewlines: boolean = true): boolean {
  return ".!?…。？！".includes(c) || (includeNewlines && c === "\n");
}

function isTrailingChar(c: string): boolean {
  return "\"')]}」』".includes(c);
}

function getTokenFromBuffer(buffer: string, start: number): string {
  let end = start;
  while (end < buffer.length && !/\s/.test(buffer[end])) {
    ++end;
  }
  return buffer.substring(start, end);
}

const ABBREVIATIONS: Set<string> = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "sgt", "col", "gen",
  "rep", "sen", "gov", "lt", "maj", "capt", "st", "mt", "etc", "co",
  "inc", "ltd", "dept", "vs", "p", "pg",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept",
  "oct", "nov", "dec",
  "sun", "mon", "tu", "tue", "tues", "wed", "th", "thu", "thur", "thurs", "fri", "sat",
]);

function isAbbreviation(token: string): boolean {
  token = token.replace(/['']s$/i, "").replace(/\.+$/, "");
  return ABBREVIATIONS.has(token.toLowerCase());
}

const MATCHING: Map<string, string> = new Map([
  [")", "("], ["]", "["], ["}", "{"],
  ["》", "《"], ["〉", "〈"], ["›", "‹"], ["»", "«"],
  ["」", "「"], ["』", "『"], ["〕", "〔"], ["】", "【"],
]);

const OPENING: Set<string> = new Set(MATCHING.values());

function updateStack(c: string, stack: string[], i: number, buffer: string): void {
  if (c === '"' || c === "'") {
    if (c === "'" && i > 0 && i < buffer.length - 1 && /[A-Za-z]/.test(buffer[i - 1]) && /[A-Za-z]/.test(buffer[i + 1])) return;
    if (c === "'" && i > 0 && /[A-Za-z]/.test(buffer[i - 1]) && (!stack.length || stack.at(-1) !== "'")) return;
    const stackIndex = stack.lastIndexOf(c);
    if (stackIndex !== -1) {
      stack.splice(stackIndex);
    } else {
      stack.push(c);
    }
    return;
  }
  if (OPENING.has(c)) {
    stack.push(c);
    return;
  }
  const expectedOpening = MATCHING.get(c);
  if (expectedOpening && stack.length && stack.at(-1) === expectedOpening) {
    stack.pop();
  }
}

export class TextSplitterStream implements AsyncIterable<string>, Iterable<string> {
  private _buffer: string;
  private _sentences: string[];
  private _resolver: (() => void) | null;
  private _closed: boolean;

  constructor() {
    this._buffer = "";
    this._sentences = [];
    this._resolver = null;
    this._closed = false;
  }

  push(...texts: string[]): void {
    for (const txt of texts) {
      this._buffer += txt;
      this._process();
    }
  }

  close(): void {
    if (this._closed) throw new Error("Stream is already closed.");
    this._closed = true;
    this.flush();
  }

  flush(): void {
    const remainder = this._buffer.trim();
    if (remainder.length > 0) this._sentences.push(remainder);
    this._buffer = "";
    this._resolve();
  }

  private _resolve(): void {
    if (this._resolver) {
      this._resolver();
      this._resolver = null;
    }
  }

  private _process(): void {
    let sentenceStart = 0;
    const buffer = this._buffer;
    const len = buffer.length;
    let i = 0;
    const stack: string[] = [];

    const scanBoundary = (idx: number): { end: number; nextNonSpace: number } => {
      let end = idx;
      while (end + 1 < len && isSentenceTerminator(buffer[end + 1], false)) ++end;
      while (end + 1 < len && isTrailingChar(buffer[end + 1])) ++end;
      let nextNonSpace = end + 1;
      while (nextNonSpace < len && /\s/.test(buffer[nextNonSpace])) ++nextNonSpace;
      return { end, nextNonSpace };
    };

    while (i < len) {
      const c = buffer[i];
      updateStack(c, stack, i, buffer);

      if (stack.length === 0 && isSentenceTerminator(c)) {
        const currentSegment = buffer.slice(sentenceStart, i);
        if (/(^|\n)\d+$/.test(currentSegment)) { ++i; continue; }

        const { end: boundaryEnd, nextNonSpace } = scanBoundary(i);

        if (i === nextNonSpace - 1 && c !== "\n") { ++i; continue; }
        if (nextNonSpace === len) break;

        let tokenStart = i - 1;
        while (tokenStart >= 0 && /\S/.test(buffer[tokenStart])) tokenStart--;
        tokenStart = Math.max(sentenceStart, tokenStart + 1);
        const token = getTokenFromBuffer(buffer, tokenStart);
        if (!token) { ++i; continue; }

        if ((/https?[,:]\/\//.test(token) || token.includes("@")) && token.at(-1) && !isSentenceTerminator(token.at(-1)!)) {
          i = tokenStart + token.length;
          continue;
        }

        if (isAbbreviation(token)) { ++i; continue; }

        if (/^([A-Za-z]\.)+$/.test(token) && nextNonSpace < len && /[A-Z]/.test(buffer[nextNonSpace])) { ++i; continue; }

        if (c === "." && nextNonSpace < len && /[a-z]/.test(buffer[nextNonSpace])) { ++i; continue; }

        const sentence = buffer.substring(sentenceStart, boundaryEnd + 1).trim();
        if (sentence === "..." || sentence === "…") { ++i; continue; }

        if (sentence) this._sentences.push(sentence);
        i = sentenceStart = boundaryEnd + 1;
        continue;
      }
      ++i;
    }

    this._buffer = buffer.substring(sentenceStart);
    if (this._sentences.length > 0) this._resolve();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, void> {
    if (this._resolver) throw new Error("Another iterator is already active.");
    while (true) {
      if (this._sentences.length > 0) {
        yield this._sentences.shift()!;
      } else if (this._closed) {
        break;
      } else {
        await new Promise<void>((resolve) => { this._resolver = resolve; });
      }
    }
  }

  [Symbol.iterator](): Iterator<string> {
    this.flush();
    const iterator = this._sentences[Symbol.iterator]();
    this._sentences = [];
    return iterator;
  }

  get sentences(): string[] {
    return this._sentences;
  }
}

export function split(text: string): string[] {
  const splitter = new TextSplitterStream();
  splitter.push(text);
  return [...splitter];
}

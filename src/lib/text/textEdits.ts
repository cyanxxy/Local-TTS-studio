/**
 * Offset-preserving text rewrites.
 *
 * Text transforms (cleanup, normalization, pronunciation) describe their work
 * as non-overlapping edits against the source string. Applying them yields the
 * rewritten text plus a map between source and output UTF-16 offsets, so chunk
 * `textStart`/`textEnd` values, Reader highlighting and captions can keep
 * pointing at the text the user actually wrote.
 */

export interface TextEdit {
  /** Source range replaced by `replacement` (UTF-16 offsets, end exclusive). */
  start: number;
  end: number;
  replacement: string;
  /** Short machine-readable label of the rule that produced the edit. */
  reason?: string;
}

export interface AppliedTextEdit extends TextEdit {
  outputStart: number;
  outputEnd: number;
}

export interface TextRange {
  start: number;
  end: number;
}

/** Maps offsets between a source string and its rewritten output. */
export interface TextOffsetMap {
  source: string;
  text: string;
  /**
   * Maps an output offset to the source. Offsets inside a replacement snap to
   * the start of the replaced source range.
   */
  toSourceOffset(outputOffset: number): number;
  /**
   * Maps an output range to the smallest source range that covers it; a range
   * that touches part of a replacement covers the whole replaced source.
   */
  toSourceRange(range: TextRange): TextRange;
  /**
   * Maps a source offset to the output. Offsets inside a replaced range snap
   * to the start of its replacement.
   */
  toOutputOffset(sourceOffset: number): number;
}

export interface TextRewrite extends TextOffsetMap {
  /** Applied edits in source order. Edits that changed nothing are dropped. */
  edits: readonly AppliedTextEdit[];
}

function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return offset > 0 ? length : 0;
  return Math.max(0, Math.min(length, Math.trunc(offset)));
}

/**
 * Validates, sorts and applies edits in one pass. Overlapping edits are a
 * programming error in the producing transform and throw; adjacent edits and
 * pure insertions (`start === end`) are allowed.
 */
export function applyTextEdits(source: string, edits: readonly TextEdit[]): TextRewrite {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const applied: AppliedTextEdit[] = [];
  const parts: string[] = [];
  let sourceCursor = 0;
  let outputCursor = 0;

  for (const edit of ordered) {
    if (
      !Number.isInteger(edit.start)
      || !Number.isInteger(edit.end)
      || edit.start < 0
      || edit.end < edit.start
      || edit.end > source.length
    ) {
      throw new RangeError(`Invalid text edit range ${edit.start}-${edit.end}.`);
    }
    if (edit.start < sourceCursor) {
      throw new RangeError(`Overlapping text edit at ${edit.start}.`);
    }
    if (source.slice(edit.start, edit.end) === edit.replacement) continue;

    const unchanged = source.slice(sourceCursor, edit.start);
    parts.push(unchanged, edit.replacement);
    outputCursor += unchanged.length;
    applied.push({
      ...edit,
      outputStart: outputCursor,
      outputEnd: outputCursor + edit.replacement.length,
    });
    outputCursor += edit.replacement.length;
    sourceCursor = edit.end;
  }
  parts.push(source.slice(sourceCursor));
  const text = parts.join("");

  // Index of the last edit whose output (or source) start is <= offset.
  const lastEditAtOrBefore = (offset: number, key: "outputStart" | "start"): number => {
    let low = 0;
    let high = applied.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (applied[mid][key] <= offset) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  };

  const toSourceOffset = (outputOffset: number): number => {
    const offset = clampOffset(outputOffset, text.length);
    const index = lastEditAtOrBefore(offset, "outputStart");
    if (index < 0) return offset;
    const edit = applied[index];
    if (offset < edit.outputEnd) return edit.start;
    return edit.end + (offset - edit.outputEnd);
  };

  const toSourceEnd = (outputOffset: number): number => {
    const offset = clampOffset(outputOffset, text.length);
    // An end offset that lands strictly inside a replacement covers all of it.
    const index = lastEditAtOrBefore(offset - 1, "outputStart");
    if (index >= 0) {
      const edit = applied[index];
      if (offset > edit.outputStart && offset < edit.outputEnd) return edit.end;
    }
    return toSourceOffset(offset);
  };

  const toOutputOffset = (sourceOffset: number): number => {
    const offset = clampOffset(sourceOffset, source.length);
    const index = lastEditAtOrBefore(offset, "start");
    if (index < 0) return offset;
    const edit = applied[index];
    if (offset < edit.end) return edit.outputStart;
    return edit.outputEnd + (offset - edit.end);
  };

  return {
    source,
    text,
    edits: applied,
    toSourceOffset,
    toSourceRange: (range) => {
      const start = toSourceOffset(range.start);
      return { start, end: Math.max(start, toSourceEnd(range.end)) };
    },
    toOutputOffset,
  };
}

/** Composes two rewrites into one map from the first source to the second output. */
export function chainTextRewrites(first: TextOffsetMap, second: TextOffsetMap): TextOffsetMap {
  if (second.source !== first.text) {
    throw new Error("The second rewrite must start from the first rewrite's output.");
  }
  return {
    source: first.source,
    text: second.text,
    toSourceOffset: (offset) => first.toSourceOffset(second.toSourceOffset(offset)),
    toSourceRange: (range) => first.toSourceRange(second.toSourceRange(range)),
    toOutputOffset: (offset) => second.toOutputOffset(first.toOutputOffset(offset)),
  };
}

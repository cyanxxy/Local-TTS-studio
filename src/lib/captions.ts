export interface CaptionSegment {
  startSec: number;
  endSec: number;
  text: string;
}

interface TimedWord {
  word: string;
  startSec: number;
  endSec: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

function toTimestampParts(seconds: number): { h: number; m: number; s: number; ms: number } {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return { h, m, s, ms };
}

function toSrtTimestamp(seconds: number): string {
  const parts = toTimestampParts(seconds);
  return `${pad2(parts.h)}:${pad2(parts.m)}:${pad2(parts.s)},${pad3(parts.ms)}`;
}

function toVttTimestamp(seconds: number): string {
  const parts = toTimestampParts(seconds);
  return `${pad2(parts.h)}:${pad2(parts.m)}:${pad2(parts.s)}.${pad3(parts.ms)}`;
}

function normalizeSegments(segments: CaptionSegment[]): CaptionSegment[] {
  return segments
    .map((segment) => {
      const text = cleanText(segment.text);
      const startSec = Math.max(0, segment.startSec);
      const rawEnd = Math.max(startSec + 0.01, segment.endSec);
      const endSec = clamp(rawEnd, startSec + 0.01, Number.MAX_SAFE_INTEGER);
      return { startSec, endSec, text };
    })
    .filter((segment) => segment.text.length > 0);
}

function estimateWordTimings(segment: CaptionSegment): TimedWord[] {
  const words = cleanText(segment.text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const duration = Math.max(0.01, segment.endSec - segment.startSec);
  const totalWeight = words.reduce((sum, word) => sum + Math.max(1, word.length), 0);
  const wordsOut: TimedWord[] = [];
  let cursor = segment.startSec;

  for (let i = 0; i < words.length; i += 1) {
    const weight = Math.max(1, words[i].length);
    const sliceDuration = i === words.length - 1
      ? Math.max(0.01, segment.endSec - cursor)
      : (duration * weight) / totalWeight;
    const endSec = i === words.length - 1 ? segment.endSec : cursor + sliceDuration;

    wordsOut.push({
      word: words[i],
      startSec: cursor,
      endSec,
    });
    cursor = endSec;
  }

  return wordsOut;
}

export function buildSrt(segments: CaptionSegment[]): string {
  const normalized = normalizeSegments(segments);
  return normalized
    .map((segment, index) => (
      `${index + 1}\n${toSrtTimestamp(segment.startSec)} --> ${toSrtTimestamp(segment.endSec)}\n${segment.text}\n`
    ))
    .join("\n");
}

export function buildVtt(segments: CaptionSegment[]): string {
  const normalized = normalizeSegments(segments);
  const body = normalized
    .map((segment) => (
      `${toVttTimestamp(segment.startSec)} --> ${toVttTimestamp(segment.endSec)}\n${segment.text}\n`
    ))
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function buildCaptionJson(segments: CaptionSegment[]): string {
  const normalized = normalizeSegments(segments);
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    segments: normalized.map((segment, index) => ({
      id: index + 1,
      text: segment.text,
      startSec: Number(segment.startSec.toFixed(3)),
      endSec: Number(segment.endSec.toFixed(3)),
      words: estimateWordTimings(segment).map((word) => ({
        word: word.word,
        startSec: Number(word.startSec.toFixed(3)),
        endSec: Number(word.endSec.toFixed(3)),
      })),
    })),
  };
  return JSON.stringify(payload, null, 2);
}

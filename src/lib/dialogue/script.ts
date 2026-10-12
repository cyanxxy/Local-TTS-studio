/**
 * Parser for speaker-labelled dialogue scripts:
 *
 *   Alice: Did you hear that?
 *   Bob [whispering]: (leaning in) It came from the attic.
 *   It sounded like footsteps.
 *
 *   (a long pause)
 *   Alice: [laughs] Very funny.
 *
 * - "Name: line" starts a turn. Names start with a letter, run up to four
 *   words, and are matched case-insensitively, so "BOB" and "Bob" are one
 *   speaker. The colon must be followed by a space or the end of the line, so
 *   times ("10:30") and URLs never read as labels.
 * - Prose also puts colons after its opening words ("Remember one thing:
 *   ..."), so a label only counts when it names a known speaker, is used on
 *   at least two lines, or looks like a name (capitalized words, allowing
 *   short particles such as "de"). Anything else stays part of the text and
 *   is reported as an issue, as is a multi-word speaker labelled only once.
 * - [tags] in square brackets, after the name or anywhere in the line, are
 *   delivery cues such as [whispering]; they are recorded and never spoken.
 * - (Stage directions) are recorded and not spoken when they open a line or
 *   fill one. Parentheses later in a sentence are ordinary speech.
 * - An unlabelled line continues the current turn. A blank line or a
 *   whole-line cue ends the turn; unlabelled text after it starts a new turn
 *   for the same speaker, which the planner separates with a short beat.
 * - Text before the first label belongs to a default "Narrator" speaker.
 */

export interface DialogueTurn {
  /** Position among the parsed turns, from 0. */
  index: number;
  /** The speaker's name as first written in the script. */
  speaker: string;
  /** Case- and whitespace-insensitive identity used for casting. */
  speakerKey: string;
  /** What is spoken: cues removed, whitespace collapsed. */
  text: string;
  /** Square-bracket delivery cues, without brackets. */
  tags: string[];
  /** Parenthesized stage directions, without parentheses. */
  directions: string[];
  /** 1-based line of the turn's first line. */
  line: number;
  /** Source offsets spanning the turn's content, after its label. */
  start: number;
  end: number;
}

export interface DialogueSpeaker {
  key: string;
  name: string;
  turnCount: number;
}

export interface DialogueScriptIssue {
  line: number;
  message: string;
}

export interface DialogueScript {
  turns: DialogueTurn[];
  /** In order of first appearance. */
  speakers: DialogueSpeaker[];
  issues: DialogueScriptIssue[];
}

export interface ParseDialogueOptions {
  /** Speaker for text before the first label. Defaults to "Narrator". */
  defaultSpeaker?: string;
  /** Names already cast, accepted as labels however they are written. */
  knownSpeakers?: readonly string[];
}

export const DIALOGUE_SCRIPT_LIMITS = {
  maxScriptLength: 200_000,
  maxSpeakerNameLength: 48,
  maxSpeakerWords: 4,
  maxSpeakers: 32,
  maxTurns: 2_000,
} as const;

export const DEFAULT_DIALOGUE_SPEAKER = "Narrator";

const LABEL_PATTERN = /^\s*(\p{L}[\p{L}\p{M}\p{N}'’._-]*(?:[ \t]+[\p{L}\p{M}\p{N}'’._-]+)*)\s*((?:\[[^\]\n]*\]\s*)*):(?:\s+|$)/u;
const LEADING_CUE_PATTERN = /^\s*(?:\[([^\]\n]*)\]|\(([^)\n]*)\))/;
const TAG_PATTERN = /\[([^\]\n]*)\]/g;
const WHOLE_LINE_CUES_PATTERN = /^\s*(?:(?:\[[^\]\n]*\]|\([^)\n]*\))\s*)+$/;

interface SpeakerLabel {
  name: string;
  key: string;
  /** Length of the label, including the colon and following whitespace. */
  length: number;
  /** The bracket tags between the name and the colon. */
  tagsText: string;
}

function matchLabel(line: string): SpeakerLabel | null {
  const match = LABEL_PATTERN.exec(line);
  if (!match) return null;
  const name = cleanCue(match[1]);
  if (name.length > DIALOGUE_SCRIPT_LIMITS.maxSpeakerNameLength) return null;
  if (name.split(" ").length > DIALOGUE_SCRIPT_LIMITS.maxSpeakerWords) return null;
  return { name, key: dialogueSpeakerKey(name), length: match[0].length, tagsText: match[2] };
}

/**
 * Whether a label reads as a name rather than the opening words of a
 * sentence: the first word is capitalized, and so is every later word longer
 * than three letters ("Jean de Florette" and "Mary Ann" pass, "Remember one
 * thing" does not). Letters without case, as in CJK names, always pass.
 */
function looksLikeName(name: string): boolean {
  return name.split(" ").every((word, index) => {
    const letter = word.match(/\p{L}/u)?.[0];
    const isLowercase = letter !== undefined && letter === letter.toLowerCase() && letter !== letter.toUpperCase();
    if (!isLowercase) return true;
    return index > 0 && word.replace(/[^\p{L}]/gu, "").length <= 3;
  });
}

/** Collapse whitespace and fold case so speaker names compare reliably. */
export function dialogueSpeakerKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function cleanCue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

interface ExtractedLine {
  text: string;
  tags: string[];
  directions: string[];
}

/** Strip leading cue groups and every bracket tag from one line of content. */
function extractCues(content: string): ExtractedLine {
  const tags: string[] = [];
  const directions: string[] = [];
  let rest = content;
  for (let match = LEADING_CUE_PATTERN.exec(rest); match; match = LEADING_CUE_PATTERN.exec(rest)) {
    const cue = cleanCue(match[1] ?? match[2]);
    if (cue) (match[1] !== undefined ? tags : directions).push(cue);
    rest = rest.slice(match[0].length);
  }
  rest = rest.replace(TAG_PATTERN, (_whole, tag: string) => {
    const cue = cleanCue(tag);
    if (cue) tags.push(cue);
    return " ";
  });
  return { text: rest.replace(/\s+/g, " ").trim(), tags, directions };
}

interface OpenTurn {
  speaker: string;
  speakerKey: string;
  parts: string[];
  tags: string[];
  directions: string[];
  line: number;
  start: number;
  end: number;
}

export function parseDialogueScript(source: string, options: ParseDialogueOptions = {}): DialogueScript {
  if (source.length > DIALOGUE_SCRIPT_LIMITS.maxScriptLength) {
    throw new Error(`Dialogue scripts are limited to ${DIALOGUE_SCRIPT_LIMITS.maxScriptLength.toLocaleString("en-US")} characters.`);
  }
  const defaultSpeaker = cleanCue(options.defaultSpeaker ?? DEFAULT_DIALOGUE_SPEAKER) || DEFAULT_DIALOGUE_SPEAKER;
  const turns: DialogueTurn[] = [];
  const issues: DialogueScriptIssue[] = [];
  const speakers = new Map<string, DialogueSpeaker>();
  const rejectedSpeakers = new Set<string>();
  let open: OpenTurn | null = null;
  let lastSpeaker: { name: string; key: string } | null = null;
  let pendingTags: string[] = [];
  let pendingDirections: string[] = [];
  let truncated = false;

  // Count label-shaped lines first, so a speaker used more than once is
  // recognized however its name is written.
  const knownKeys = new Set((options.knownSpeakers ?? []).map(dialogueSpeakerKey));
  const labelCounts = new Map<string, number>();
  for (const line of source.split("\n")) {
    const candidate = matchLabel(line);
    if (candidate) labelCounts.set(candidate.key, (labelCounts.get(candidate.key) ?? 0) + 1);
  }
  const acceptsLabel = (label: SpeakerLabel) => (
    knownKeys.has(label.key) || (labelCounts.get(label.key) ?? 0) >= 2 || looksLikeName(label.name)
  );

  function closeTurn(): void {
    if (!open) return;
    const turn = open;
    open = null;
    const text = turn.parts.join(" ");
    if (!text) {
      issues.push({ line: turn.line, message: `${turn.speaker} has no spoken text here, so the line is skipped.` });
      // The cues still describe what happens next.
      pendingTags = [...turn.tags, ...pendingTags];
      pendingDirections = [...turn.directions, ...pendingDirections];
      return;
    }
    if (turns.length >= DIALOGUE_SCRIPT_LIMITS.maxTurns) {
      if (!truncated) {
        issues.push({ line: turn.line, message: `Scripts are limited to ${DIALOGUE_SCRIPT_LIMITS.maxTurns} turns; the rest is ignored.` });
        truncated = true;
      }
      return;
    }
    const speaker = speakers.get(turn.speakerKey);
    if (speaker) speaker.turnCount += 1;
    else speakers.set(turn.speakerKey, { key: turn.speakerKey, name: turn.speaker, turnCount: 1 });
    turns.push({
      index: turns.length,
      speaker: speaker?.name ?? turn.speaker,
      speakerKey: turn.speakerKey,
      text,
      tags: turn.tags,
      directions: turn.directions,
      line: turn.line,
      start: turn.start,
      end: turn.end,
    });
  }

  /** Whether a new speaker fits under the speaker cap. */
  function admitSpeaker(key: string, name: string, line: number): boolean {
    if (speakers.has(key) || speakers.size < DIALOGUE_SCRIPT_LIMITS.maxSpeakers) return true;
    if (!rejectedSpeakers.has(key)) {
      rejectedSpeakers.add(key);
      issues.push({ line, message: `Scripts are limited to ${DIALOGUE_SCRIPT_LIMITS.maxSpeakers} speakers; ${name}'s lines are ignored.` });
    }
    return false;
  }

  function startTurn(name: string, key: string, line: number, offset: number): OpenTurn {
    const turn: OpenTurn = {
      speaker: name,
      speakerKey: key,
      parts: [],
      tags: pendingTags,
      directions: pendingDirections,
      line,
      start: offset,
      end: offset,
    };
    pendingTags = [];
    pendingDirections = [];
    lastSpeaker = { name, key };
    return turn;
  }

  function appendContent(turn: OpenTurn, content: string, contentStart: number): void {
    const extracted = extractCues(content);
    turn.tags.push(...extracted.tags);
    turn.directions.push(...extracted.directions);
    if (extracted.text) turn.parts.push(extracted.text);
    const trimmedEnd = contentStart + content.trimEnd().length;
    turn.end = Math.max(turn.end, trimmedEnd);
  }

  let lineStart = 0;
  const lines = source.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex].endsWith("\r") ? lines[lineIndex].slice(0, -1) : lines[lineIndex];
    const lineNumber = lineIndex + 1;
    const offset = lineStart;
    lineStart += lines[lineIndex].length + 1;

    if (raw.trim() === "") {
      closeTurn();
      continue;
    }
    if (WHOLE_LINE_CUES_PATTERN.test(raw)) {
      closeTurn();
      const extracted = extractCues(raw);
      pendingTags.push(...extracted.tags);
      pendingDirections.push(...extracted.directions);
      continue;
    }

    const candidate = matchLabel(raw);
    const label = candidate && acceptsLabel(candidate) ? candidate : null;
    if (candidate && !label) {
      issues.push({
        line: lineNumber,
        message: `"${candidate.name}:" reads as part of the text, not a speaker. Capitalize the name to make it a speaker.`,
      });
    }
    if (label) {
      closeTurn();
      const { name, key } = label;
      const contentStart = offset + label.length;
      if (!admitSpeaker(key, name, lineNumber)) {
        // Keep the rejected speaker current so its continuation lines are
        // dropped too instead of falling to the previous speaker.
        lastSpeaker = { name, key };
        pendingTags = [];
        pendingDirections = [];
        continue;
      }
      open = startTurn(name, key, lineNumber, contentStart);
      for (const match of label.tagsText.matchAll(TAG_PATTERN)) {
        const cue = cleanCue(match[1]);
        if (cue) open.tags.push(cue);
      }
      appendContent(open, raw.slice(label.length), contentStart);
      continue;
    }

    const contentStart = offset + (raw.length - raw.trimStart().length);
    if (!open) {
      const speaker = lastSpeaker ?? { name: defaultSpeaker, key: dialogueSpeakerKey(defaultSpeaker) };
      if (!admitSpeaker(speaker.key, speaker.name, lineNumber)) continue;
      open = startTurn(speaker.name, speaker.key, lineNumber, contentStart);
    }
    appendContent(open, raw.trimStart(), contentStart);
  }
  closeTurn();

  for (const speaker of speakers.values()) {
    // Multi-word, one-off labels are the ones prose produces ("Rule Number One: ...").
    if (!speaker.name.includes(" ") || knownKeys.has(speaker.key) || (labelCounts.get(speaker.key) ?? 0) !== 1) continue;
    const turn = turns.find((item) => item.speakerKey === speaker.key);
    issues.push({
      line: turn?.line ?? 1,
      message: `"${speaker.name}" speaks only once. If that colon belongs to the sentence, it was read as a speaker by mistake.`,
    });
  }
  issues.sort((a, b) => a.line - b.line);

  return { turns, speakers: [...speakers.values()], issues };
}

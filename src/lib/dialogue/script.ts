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

    const label = LABEL_PATTERN.exec(raw);
    const name = label ? cleanCue(label[1]) : "";
    const isLabel = label !== null
      && name.length <= DIALOGUE_SCRIPT_LIMITS.maxSpeakerNameLength
      && name.split(" ").length <= DIALOGUE_SCRIPT_LIMITS.maxSpeakerWords;
    if (isLabel) {
      closeTurn();
      const key = dialogueSpeakerKey(name);
      const contentStart = offset + label[0].length;
      if (!admitSpeaker(key, name, lineNumber)) {
        // Keep the rejected speaker current so its continuation lines are
        // dropped too instead of falling to the previous speaker.
        lastSpeaker = { name, key };
        pendingTags = [];
        pendingDirections = [];
        continue;
      }
      open = startTurn(name, key, lineNumber, contentStart);
      for (const match of label[2].matchAll(TAG_PATTERN)) {
        const cue = cleanCue(match[1]);
        if (cue) open.tags.push(cue);
      }
      appendContent(open, raw.slice(label[0].length), contentStart);
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

  return { turns, speakers: [...speakers.values()], issues };
}

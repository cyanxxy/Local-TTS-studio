export interface ReaderShortcut {
  keys: string;
  action: string;
}

/** The Reader's keyboard map, listed by the "?" shortcuts dialog. */
export const READER_SHORTCUTS: readonly ReaderShortcut[] = [
  { keys: "Space", action: "Play or pause" },
  { keys: "← / →", action: "Previous or next page" },
  { keys: "⇧← / ⇧→", action: "Previous or next sentence" },
  { keys: "⇧↑ / ⇧↓", action: "Previous or next paragraph" },
  { keys: "⌥← / ⌥→", action: "Skip back or forward 10 seconds" },
  { keys: "⌘/Ctrl Enter", action: "Generate speech" },
  { keys: "⌘/Ctrl .", action: "Stop generating" },
  { keys: "Double-click", action: "Listen from that word" },
  { keys: "F", action: "Toggle focus layout" },
  { keys: "?", action: "Show these shortcuts" },
];

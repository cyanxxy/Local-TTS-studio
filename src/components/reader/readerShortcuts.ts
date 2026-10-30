export interface ReaderShortcut {
  /** As macOS writes them. */
  keys: string;
  /** As Windows and Linux write them, when that differs. */
  otherKeys?: string;
  action: string;
}

/** Marks the shortcuts dialog, the one dialog where "?" still toggles it. */
export const READER_SHORTCUTS_DIALOG_ATTRIBUTE = "data-reader-shortcuts";

/** The Reader's keyboard map, listed by the "?" shortcuts dialog. */
export const READER_SHORTCUTS: readonly ReaderShortcut[] = [
  { keys: "Space", action: "Play or pause" },
  { keys: "← / →", action: "Previous or next page" },
  { keys: "⇧← / ⇧→", otherKeys: "Shift+← / Shift+→", action: "Previous or next sentence" },
  { keys: "⇧↑ / ⇧↓", otherKeys: "Shift+↑ / Shift+↓", action: "Previous or next paragraph" },
  { keys: "⌥← / ⌥→", otherKeys: "Alt+← / Alt+→", action: "Skip back or forward 10 seconds" },
  { keys: "⌘/Ctrl Enter", otherKeys: "Ctrl+Enter", action: "Generate speech" },
  { keys: "⌘/Ctrl .", otherKeys: "Ctrl+.", action: "Stop generating" },
  { keys: "Double-click", action: "Listen from that word" },
  { keys: "Enter", action: "Listen from the focused paragraph" },
  { keys: "⇧Enter", otherKeys: "Shift+Enter", action: "Select the focused paragraph" },
  { keys: "↑ / ↓", action: "Move between paragraphs once one is focused" },
  { keys: "F", action: "Toggle focus layout" },
  { keys: "?", action: "Show these shortcuts" },
];

/** The keys of `shortcut` as the current platform writes them. */
export function readerShortcutKeys(shortcut: ReaderShortcut, mac: boolean): string {
  return mac ? shortcut.keys : shortcut.otherKeys ?? shortcut.keys;
}

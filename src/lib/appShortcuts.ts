export interface AppShortcutDefinition {
  action: string;
  description: string;
  mac: readonly string[];
  windows: readonly string[];
}

export interface AppShortcutGroup {
  label: string;
  shortcuts: readonly AppShortcutDefinition[];
}

export const APP_SHORTCUT_GROUPS: readonly AppShortcutGroup[] = [
  {
    label: "Navigate",
    shortcuts: [
      {
        action: "Open settings",
        description: "Open app preferences from anywhere.",
        mac: ["⌘", ","],
        windows: ["Ctrl", ","],
      },
      {
        action: "Go to Studio",
        description: "Switch to the main text-to-speech workspace.",
        mac: ["⌘", "1"],
        windows: ["Ctrl", "1"],
      },
      {
        action: "Go to Reader",
        description: "Switch to the document reading workspace.",
        mac: ["⌘", "2"],
        windows: ["Ctrl", "2"],
      },
    ],
  },
  {
    label: "Create",
    shortcuts: [
      {
        action: "Generate speech",
        description: "Generate with the active model and current text.",
        mac: ["⌘", "Return"],
        windows: ["Ctrl", "Enter"],
      },
      {
        action: "Stop generation",
        description: "Cancel the generation currently in progress.",
        mac: ["⌘", "."],
        windows: ["Ctrl", "."],
      },
    ],
  },
  {
    label: "Playback",
    shortcuts: [
      {
        action: "Play or pause",
        description: "Toggle generated audio when focus is outside a text field.",
        mac: ["Space"],
        windows: ["Space"],
      },
      {
        action: "Skip 10 seconds",
        description: "Move backward or forward in generated audio.",
        mac: ["⌥", "← / →"],
        windows: ["Alt", "← / →"],
      },
    ],
  },
] as const;

export function hasPrimaryShortcutModifier(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey;
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export function isMacPlatform(platform?: string): boolean {
  return /mac|darwin/i.test(platform ?? "");
}

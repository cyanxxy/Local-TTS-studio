export type ReaderColumnWidth = "narrow" | "comfortable" | "wide";

export interface ReaderViewPreferences {
  fontSize: number;
  lineHeight: number;
  columnWidth: ReaderColumnWidth;
  focusMode: boolean;
  autoAdvance: boolean;
}

export const DEFAULT_READER_VIEW_PREFERENCES: ReaderViewPreferences = {
  fontSize: 19,
  lineHeight: 1.85,
  columnWidth: "comfortable",
  focusMode: false,
  autoAdvance: true,
};

const STORAGE_KEY = "open-tts-reader-view-v1";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isColumnWidth(value: unknown): value is ReaderColumnWidth {
  return value === "narrow" || value === "comfortable" || value === "wide";
}

export function normalizeReaderViewPreferences(
  preferences: Partial<ReaderViewPreferences> | null | undefined,
): ReaderViewPreferences {
  return {
    fontSize: typeof preferences?.fontSize === "number"
      ? Math.round(clamp(preferences.fontSize, 15, 26))
      : DEFAULT_READER_VIEW_PREFERENCES.fontSize,
    lineHeight: typeof preferences?.lineHeight === "number"
      ? Math.round(clamp(preferences.lineHeight, 1.4, 2.2) * 20) / 20
      : DEFAULT_READER_VIEW_PREFERENCES.lineHeight,
    columnWidth: isColumnWidth(preferences?.columnWidth)
      ? preferences.columnWidth
      : DEFAULT_READER_VIEW_PREFERENCES.columnWidth,
    focusMode: typeof preferences?.focusMode === "boolean"
      ? preferences.focusMode
      : DEFAULT_READER_VIEW_PREFERENCES.focusMode,
    autoAdvance: typeof preferences?.autoAdvance === "boolean"
      ? preferences.autoAdvance
      : DEFAULT_READER_VIEW_PREFERENCES.autoAdvance,
  };
}

export function getInitialReaderViewPreferences(): ReaderViewPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored
      ? normalizeReaderViewPreferences(JSON.parse(stored) as Partial<ReaderViewPreferences>)
      : DEFAULT_READER_VIEW_PREFERENCES;
  } catch {
    return DEFAULT_READER_VIEW_PREFERENCES;
  }
}

export function persistReaderViewPreferences(preferences: ReaderViewPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeReaderViewPreferences(preferences)));
  } catch {
    // Reader preferences remain active for this session when storage is blocked.
  }
}

export function readerColumnWidthRem(width: ReaderColumnWidth): number {
  if (width === "narrow") return 36;
  if (width === "wide") return 54;
  return 44;
}

/**
 * Favorites for built-in engine voices. Saved voices carry their own flag in
 * the library; built-in voices are not library records, so their stars live in
 * localStorage, which is a per-device convenience.
 */

const STORAGE_KEY = "open-tts.voice-favorites.v1";

export function loadBuiltinFavorites(storage: Pick<Storage, "getItem"> | null = safeStorage()): Set<string> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveBuiltinFavorites(
  favorites: ReadonlySet<string>,
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...favorites].sort()));
  } catch {
    // Storage can be blocked or full; the star simply does not persist.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

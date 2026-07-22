import { useCallback, useEffect, useState } from "react";
import {
  getInitialReaderViewPreferences,
  normalizeReaderViewPreferences,
  persistReaderViewPreferences,
  type ReaderViewPreferences,
} from "../lib/readerPreferences";

export function useReaderViewPreferences() {
  const [preferences, setPreferences] = useState<ReaderViewPreferences>(getInitialReaderViewPreferences);

  useEffect(() => {
    persistReaderViewPreferences(preferences);
  }, [preferences]);

  const updatePreferences = useCallback((patch: Partial<ReaderViewPreferences>) => {
    setPreferences((current) => normalizeReaderViewPreferences({ ...current, ...patch }));
  }, []);

  return { preferences, updatePreferences };
}

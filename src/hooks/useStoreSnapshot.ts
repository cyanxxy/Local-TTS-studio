import { useCallback, useEffect, useRef, useState } from "react";

export interface SubscribableStore {
  subscribe(listener: () => void): () => void;
}

export interface StoreSnapshot<T> {
  /** The latest successful read, or `initial` until the first one lands. */
  data: T;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep React state in sync with an async, subscribable store: read once on
 * mount and again after every change the store announces. Overlapping reads
 * resolve newest-wins, and state is only set from promise callbacks, so the
 * subscription effect never sets state synchronously.
 *
 * `read` must be stable (a module-level function), or every render re-reads.
 */
export function useStoreSnapshot<S extends SubscribableStore, T>(
  store: S,
  read: (store: S) => Promise<T>,
  initial: T,
): StoreSnapshot<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);

  const refresh = useCallback((): Promise<void> => {
    const sequence = ++sequenceRef.current;
    const isCurrent = () => sequence === sequenceRef.current;
    return read(store).then(
      (next) => {
        if (!isCurrent()) return;
        setData(next);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!isCurrent()) return;
        setError(errorMessage(cause));
        setLoading(false);
      },
    );
  }, [read, store]);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      void refresh();
    });
    void refresh();
    return () => {
      unsubscribe();
      // Drop any read still in flight for this store.
      sequenceRef.current += 1;
    };
  }, [refresh, store]);

  return { data, loading, error, refresh };
}

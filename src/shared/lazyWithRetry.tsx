import { lazy, useState, type ComponentType, type LazyExoticComponent } from "react";

interface LazyWithRetryOptions {
  /** Further attempts after the first import fails, before the error surfaces. */
  retries?: number;
}

/**
 * `React.lazy` for a code-split surface whose chunk may fail to load, e.g. a
 * flaky connection or a hashed chunk a newer deploy replaced.
 *
 * A failed import is attempted again (`retries`) before the error reaches the
 * nearest error boundary. `React.lazy` remembers a rejected import forever, so
 * after a final failure the next mount starts from a fresh one: an error
 * boundary's retry, which remounts its children, really imports again.
 */
export function lazyWithRetry<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
  { retries = 1 }: LazyWithRetryOptions = {},
): ComponentType<Props> {
  let current: LazyExoticComponent<ComponentType<Props>>;
  const attempt = async (): Promise<{ default: ComponentType<Props> }> => {
    for (let failures = 0; ; failures += 1) {
      try {
        return { default: await load() };
      } catch (error) {
        if (failures >= retries) {
          current = lazy(attempt);
          throw error;
        }
      }
    }
  };
  current = lazy(attempt);

  function RetryableLazy(props: Props) {
    // Picked once per mount, so a remount after a failure gets the fresh import.
    const [Loaded] = useState(() => current);
    return <Loaded {...props} />;
  }
  return RetryableLazy;
}

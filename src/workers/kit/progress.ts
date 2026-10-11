/** Load progress aggregation shared by the browser TTS workers. */

export interface LoadProgressOptions {
  /**
   * Receives percentages inside `range`. Never called with a value at or
   * below the previous one until reset(), so a file that announces its size
   * late cannot make the bar jump backwards.
   */
  report(percent: number): void;
  /** The span downloads map onto, leaving room for later load phases. Defaults to [0, 100]. */
  range?: readonly [number, number];
  /**
   * Exact byte sizes of pinned files. Listed files weigh in from the start,
   * so a small file that finishes first cannot read as most of the download.
   * Files that are not listed count with the total they report.
   */
  expectedBytes?: Readonly<Record<string, number>>;
}

export interface LoadProgress {
  /** Bytes received so far for one file, plus its size when the response declares one. */
  update(file: string, loaded: number, total?: number): void;
  complete(file: string): void;
  /**
   * Feeds one Transformers.js progress_callback event: per-file `progress`
   * and `done` events, or the byte-weighted `progress_total` events that
   * Transformers.js 4 emits (which then take precedence).
   */
  handleTransformersEvent(info: unknown): void;
  /** Starts over, for a fallback attempt, and reports the start of the range. */
  reset(): void;
  /**
   * Stops reporting for good. A load that settled must post no more
   * progress, or hosts would show it loading again; downloads it abandoned
   * can keep reporting after it failed or fell back.
   */
  close(): void;
}

interface FileProgress {
  loaded: number;
  total: number | null;
  done: boolean;
}

function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createLoadProgress({
  report,
  range = [0, 100],
  expectedBytes = {},
}: LoadProgressOptions): LoadProgress {
  const [from, to] = range;
  const files = new Map<string, FileProgress>();
  let aggregateFraction: number | null = null;
  let lastPercent = from;
  let closed = false;

  const fileSize = (file: string, progress: FileProgress | undefined): number => {
    const expected = expectedBytes[file];
    if (expected !== undefined) return expected;
    if (progress?.total) return progress.total;
    // A file of unknown size only weighs in once it is complete.
    return progress?.done ? progress.loaded : 0;
  };

  const fraction = (): number => {
    if (aggregateFraction !== null) return aggregateFraction;
    let loaded = 0;
    let total = 0;
    for (const file of new Set([...Object.keys(expectedBytes), ...files.keys()])) {
      const progress = files.get(file);
      const size = fileSize(file, progress);
      total += size;
      if (progress) loaded += progress.done ? size : Math.min(progress.loaded, size);
    }
    return total > 0 ? loaded / total : 0;
  };

  const emit = (): void => {
    if (closed) return;
    // Hundredths of a percent are finer than any bar renders, and rounding
    // keeps float noise from posting a message per received network chunk.
    const percent = Math.round((from + clampFraction(fraction()) * (to - from)) * 100) / 100;
    if (percent <= lastPercent) return;
    lastPercent = percent;
    report(percent);
  };

  const update = (file: string, loaded: number, total?: number): void => {
    const previous = files.get(file);
    files.set(file, {
      loaded: Math.max(0, loaded),
      total: total !== undefined && Number.isFinite(total) && total > 0 ? total : previous?.total ?? null,
      done: false,
    });
    emit();
  };

  const complete = (file: string): void => {
    const previous = files.get(file);
    files.set(file, {
      loaded: previous?.loaded ?? 0,
      total: previous?.total ?? null,
      done: true,
    });
    emit();
  };

  return {
    update,
    complete,
    handleTransformersEvent(info) {
      if (!isRecord(info)) return;
      if (info.status === "progress_total" && typeof info.progress === "number") {
        aggregateFraction = clampFraction(info.progress / 100);
        emit();
        return;
      }
      if (aggregateFraction !== null || typeof info.file !== "string") return;
      if (info.status === "progress" && typeof info.loaded === "number") {
        update(info.file, info.loaded, typeof info.total === "number" ? info.total : undefined);
      } else if (info.status === "done") {
        complete(info.file);
      }
    },
    reset() {
      if (closed) return;
      files.clear();
      aggregateFraction = null;
      lastPercent = from;
      report(from);
    },
    close() {
      closed = true;
    },
  };
}

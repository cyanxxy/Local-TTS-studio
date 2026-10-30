/**
 * One subsystem's part in the quit barrier.
 */
export interface ShutdownParticipant {
  readonly name: string;
  /**
   * Called once, synchronously, when the quit starts. It must latch the
   * subsystem against new work before returning, and return the work the quit
   * has to wait for, or null when there is nothing outstanding.
   */
  beginShutdown(): Promise<unknown> | null;
  /**
   * How long the quit waits for this participant's work, when that is longer
   * than the coordinator's `timeoutMs`. Only this participant gets the longer
   * wait; the others stay bounded by `timeoutMs`.
   */
  readonly timeoutMs?: number;
}

export interface ShutdownCoordinatorOptions {
  /** Upper bound on how long the quit waits for a participant without its own `timeoutMs`. */
  timeoutMs: number;
  /** Re-issues the quit once the barrier has settled (`app.quit`). */
  quit: () => void;
  /**
   * Last work once the participants have settled or timed out, such as writing
   * out what they logged; the quit is held until it settles too. It is not
   * covered by `timeoutMs`, so it bounds itself.
   */
  finish?: () => Promise<unknown>;
  /** Told when a participant throws or its work rejects; the quit still proceeds. */
  onParticipantError?: (name: string, error: unknown) => void;
}

export interface ShutdownCoordinator {
  register(participant: ShutdownParticipant): void;
  /** True once the quit has started; it never resets. */
  readonly shuttingDown: boolean;
  /** The `before-quit` handler. */
  handleBeforeQuit(event: { preventDefault(): void }): void;
}

/**
 * Holds the first quit until every participant's outstanding work settles or
 * the timeout expires, then quits again. Participants start in registration
 * order within the same turn, so no request can slip in between two of them.
 * One participant failing never cuts the wait short for the others. Any other
 * quit while the barrier holds is held too: only the coordinator's own
 * re-issued quit gets through.
 */
export function createShutdownCoordinator({
  timeoutMs,
  quit,
  finish,
  onParticipantError,
}: ShutdownCoordinatorOptions): ShutdownCoordinator {
  const participants: ShutdownParticipant[] = [];
  let shuttingDown = false;
  // True from the moment the quit may proceed: straight away when nothing was
  // outstanding, otherwise just before the coordinator re-issues it.
  let released = false;

  const report = (name: string, error: unknown) => {
    try {
      onParticipantError?.(name, error);
    } catch {
      // Reporting must never be what strands the quit.
    }
  };

  return {
    register(participant) {
      participants.push(participant);
    },

    get shuttingDown() {
      return shuttingDown;
    },

    handleBeforeQuit(event) {
      if (shuttingDown) {
        // Once released, this is the `before-quit` of our own `quit()` below.
        // Before that it is the user asking again (a second Cmd+Q, the menu's
        // Quit, or window-all-closed quitting after they closed the window):
        // letting it through would close the windows and exit mid-flush.
        if (!released) event.preventDefault();
        return;
      }
      shuttingDown = true;

      const outstanding: Promise<void>[] = [];
      const timers: ReturnType<typeof setTimeout>[] = [];
      // Each participant's work, cut off at its own bound.
      const bounded = (work: Promise<void>, limitMs: number) => Promise.race([
        work,
        new Promise<void>((resolve) => { timers.push(setTimeout(resolve, limitMs)); }),
      ]);
      for (const participant of participants) {
        let work: Promise<unknown> | null;
        try {
          work = participant.beginShutdown();
        } catch (error) {
          report(participant.name, error);
          continue;
        }
        if (work) {
          outstanding.push(bounded(
            work.then(() => undefined, (error: unknown) => report(participant.name, error)),
            Math.max(timeoutMs, participant.timeoutMs ?? 0),
          ));
        }
      }
      if (outstanding.length === 0) {
        released = true;
        return;
      }

      // Hold the quit so the participants' kill escalations and unlinks get a
      // bounded window to run; otherwise their unref'd timers die with the
      // process and a child that ignores SIGTERM survives the app.
      event.preventDefault();
      const release = () => {
        released = true;
        quit();
      };
      // A failed `finish` still quits.
      void Promise.all(outstanding).then(() => {
        for (const timer of timers) clearTimeout(timer);
        return finish?.();
      }).then(release, release);
    },
  };
}

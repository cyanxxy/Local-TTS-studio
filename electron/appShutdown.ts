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
}

export interface ShutdownCoordinatorOptions {
  /** Upper bound on how long the quit waits for its participants. */
  timeoutMs: number;
  /** Re-issues the quit once the barrier has settled (`app.quit`). */
  quit: () => void;
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
 * One participant failing never cuts the wait short for the others.
 */
export function createShutdownCoordinator({
  timeoutMs,
  quit,
  onParticipantError,
}: ShutdownCoordinatorOptions): ShutdownCoordinator {
  const participants: ShutdownParticipant[] = [];
  let shuttingDown = false;

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
      // The second `before-quit` comes from our own `quit()` below.
      if (shuttingDown) return;
      shuttingDown = true;

      const outstanding: Promise<void>[] = [];
      for (const participant of participants) {
        let work: Promise<unknown> | null;
        try {
          work = participant.beginShutdown();
        } catch (error) {
          report(participant.name, error);
          continue;
        }
        if (work) {
          outstanding.push(work.then(() => undefined, (error: unknown) => report(participant.name, error)));
        }
      }
      if (outstanding.length === 0) return;

      // Hold the quit so the participants' kill escalations and unlinks get a
      // bounded window to run; otherwise their unref'd timers die with the
      // process and a child that ignores SIGTERM survives the app.
      event.preventDefault();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      void Promise.race([Promise.all(outstanding), timeout]).then(() => {
        clearTimeout(timer);
        quit();
      });
    },
  };
}

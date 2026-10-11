export interface RequestWatchdogOptions {
  /** Longest silence allowed: no protocol frame and no process output. */
  idleTimeoutMs: number;
  /** Longest interval without a protocol frame; process output does not count. */
  progressTimeoutMs: number;
  onIdle: () => void;
  onStalled: () => void;
}

/**
 * The two deadlines of an active request. A bridge heartbeat (any stdout or
 * stderr output) proves the process is alive and defers only the idle
 * deadline; a protocol frame proves the request is moving and defers both.
 *
 * Both timers are created once and pushed back with `refresh()`, so a busy
 * stream costs no timer allocation per frame. Each fires at most once, and
 * nothing fires after `stop()`.
 */
export class RequestWatchdog {
  readonly #idleTimer: NodeJS.Timeout;
  readonly #progressTimer: NodeJS.Timeout;
  #stopped = false;

  constructor({ idleTimeoutMs, progressTimeoutMs, onIdle, onStalled }: RequestWatchdogOptions) {
    this.#idleTimer = setTimeout(() => this.#fire(onIdle), idleTimeoutMs);
    this.#progressTimer = setTimeout(() => this.#fire(onStalled), progressTimeoutMs);
    this.#idleTimer.unref();
    this.#progressTimer.unref();
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** The process printed something. */
  outputSeen(): void {
    if (this.#stopped) return;
    this.#idleTimer.refresh();
  }

  /** A protocol frame arrived. */
  frameSeen(): void {
    if (this.#stopped) return;
    this.#idleTimer.refresh();
    this.#progressTimer.refresh();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#progressTimer);
  }

  #fire(callback: () => void): void {
    // `refresh()` on a timer that already fired re-arms it, so the first
    // deadline to fire retires both for good.
    if (this.#stopped) return;
    this.stop();
    callback();
  }
}

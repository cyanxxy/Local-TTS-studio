interface GenerateRateState {
  lastCompletedMs: number;
  inFlight: number;
  nextContinuation: GenerationContinuation | null;
}

interface CreateGenerateRateLimiterOptions {
  rateWindowMs: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export interface GenerateRateLimiter<TModel extends string> {
  run: <T>(
    model: TModel,
    task: () => Promise<T>,
    continuation?: GenerationContinuation,
  ) => Promise<T>;
}

export interface GenerationContinuation {
  jobId: string;
  sectionIndex: number;
  sectionCount: number;
}

function isExpectedContinuation(
  expected: GenerationContinuation | null,
  received: GenerationContinuation | undefined,
): boolean {
  return !!expected
    && !!received
    && expected.jobId === received.jobId
    && expected.sectionIndex === received.sectionIndex
    && expected.sectionCount === received.sectionCount;
}

export function createGenerateRateLimiter<TModel extends string>({
  rateWindowMs,
  now = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: CreateGenerateRateLimiterOptions): GenerateRateLimiter<TModel> {
  const state = new Map<TModel, GenerateRateState>();

  return {
    async run<T>(
      model: TModel,
      task: () => Promise<T>,
      continuation?: GenerationContinuation,
    ): Promise<T> {
      const cooldownLeftMs = (current: GenerateRateState) => (
        isExpectedContinuation(current.nextContinuation, continuation)
          ? 0
          : rateWindowMs - (now() - current.lastCompletedMs)
      );
      let current = state.get(model) ?? {
        lastCompletedMs: 0,
        inFlight: 0,
        nextContinuation: null,
      };
      if (current.inFlight > 0) {
        throw new Error(`A ${model} generation is already running.`);
      }
      // A new job that arrives just after another finished (the Reader's
      // look-ahead, the next audiobook section) waits out the rest of the
      // window once instead of failing; the window still caps the rate.
      const waitMs = cooldownLeftMs(current);
      if (waitMs > 0) {
        await wait(waitMs);
        current = state.get(model) ?? current;
        if (current.inFlight > 0) {
          throw new Error(`A ${model} generation is already running.`);
        }
        if (cooldownLeftMs(current) > 0) {
          throw new Error("Too many generation requests. Please wait a moment and try again.");
        }
      }
      const continuingSameJob = isExpectedContinuation(current.nextContinuation, continuation);

      current.inFlight += 1;
      if (!continuingSameJob) current.nextContinuation = null;
      state.set(model, current);

      let succeeded = false;
      try {
        const result = await task();
        succeeded = true;
        current.lastCompletedMs = now();
        current.nextContinuation = continuation && continuation.sectionIndex + 1 < continuation.sectionCount
          ? { ...continuation, sectionIndex: continuation.sectionIndex + 1 }
          : null;
        return result;
      } finally {
        current.inFlight = Math.max(0, current.inFlight - 1);
        // Only a successful generation enforces the cooldown window; a failed or
        // cancelled attempt clears it so the user can retry immediately instead
        // of hitting a confusing "Too many generation requests" error.
        if (!succeeded) {
          current.lastCompletedMs = 0;
          current.nextContinuation = null;
        }
        state.set(model, current);
      }
    },
  };
}

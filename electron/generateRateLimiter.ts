interface GenerateRateState {
  lastCompletedMs: number;
  inFlight: number;
  nextContinuation: GenerationContinuation | null;
}

interface CreateGenerateRateLimiterOptions {
  rateWindowMs: number;
  now?: () => number;
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
}: CreateGenerateRateLimiterOptions): GenerateRateLimiter<TModel> {
  const state = new Map<TModel, GenerateRateState>();

  return {
    async run<T>(
      model: TModel,
      task: () => Promise<T>,
      continuation?: GenerationContinuation,
    ): Promise<T> {
      const currentTime = now();
      const current = state.get(model) ?? {
        lastCompletedMs: 0,
        inFlight: 0,
        nextContinuation: null,
      };
      const continuingSameJob = isExpectedContinuation(current.nextContinuation, continuation);

      if (current.inFlight > 0) {
        throw new Error(`A ${model} generation is already running.`);
      }
      if (!continuingSameJob && currentTime - current.lastCompletedMs < rateWindowMs) {
        throw new Error("Too many generation requests. Please wait a moment and try again.");
      }

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

interface GenerateRateState {
  lastCallMs: number;
  inFlight: number;
}

interface CreateGenerateRateLimiterOptions {
  rateWindowMs: number;
  now?: () => number;
}

export interface GenerateRateLimiter<TModel extends string> {
  run: <T>(model: TModel, task: () => Promise<T>) => Promise<T>;
}

export function createGenerateRateLimiter<TModel extends string>({
  rateWindowMs,
  now = () => Date.now(),
}: CreateGenerateRateLimiterOptions): GenerateRateLimiter<TModel> {
  const state = new Map<TModel, GenerateRateState>();

  return {
    async run<T>(model: TModel, task: () => Promise<T>): Promise<T> {
      const currentTime = now();
      const current = state.get(model) ?? { lastCallMs: 0, inFlight: 0 };

      if (current.inFlight > 0) {
        throw new Error(`A ${model} generation is already running.`);
      }
      if (currentTime - current.lastCallMs < rateWindowMs) {
        throw new Error("Too many generation requests. Please wait a moment and try again.");
      }

      current.inFlight += 1;
      current.lastCallMs = currentTime;
      state.set(model, current);

      let succeeded = false;
      try {
        const result = await task();
        succeeded = true;
        return result;
      } finally {
        current.inFlight = Math.max(0, current.inFlight - 1);
        // Only a successful generation enforces the cooldown window; a failed or
        // cancelled attempt clears it so the user can retry immediately instead
        // of hitting a confusing "Too many generation requests" error.
        if (!succeeded) {
          current.lastCallMs = 0;
        }
        state.set(model, current);
      }
    },
  };
}

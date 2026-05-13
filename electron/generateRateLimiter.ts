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

      try {
        return await task();
      } finally {
        current.inFlight = Math.max(0, current.inFlight - 1);
        state.set(model, current);
      }
    },
  };
}

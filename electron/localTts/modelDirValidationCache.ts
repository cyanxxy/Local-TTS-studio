import type { Qwen3Profile } from "../qwen3Profiles";

// Long enough to cover a Reader session's back-to-back chunk requests, short
// enough that a folder changed outside Open TTS is re-checked soon after.
export const MODEL_DIR_VALIDATION_TTL_MS = 30 * 1000;

// Distinct (profile, folder) pairs remembered at once. Real use has one or two.
const MAX_ENTRIES = 16;

export interface ModelDirValidationCache {
  /** The validator's verdict, reusing a recent pass for the same folder and profile. */
  isValid(modelDir: string, profile: Qwen3Profile): Promise<boolean>;
  /** Forgets every pass, and any check still running; call when Open TTS changes model folders. */
  invalidate(): void;
}

export interface ModelDirValidationCacheOptions {
  validate: (modelDir: string, profile: Qwen3Profile) => Promise<boolean>;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Remembers recent passes of the per-request model-folder check, so every
 * generation of a long read does not stat each required file and parse the
 * config again. Only passes are kept: a failing folder is checked again on the
 * next request, so fixing it takes effect at once. Concurrent checks of the
 * same folder share one run.
 */
export function createModelDirValidationCache({
  validate,
  ttlMs = MODEL_DIR_VALIDATION_TTL_MS,
  now = Date.now,
}: ModelDirValidationCacheOptions): ModelDirValidationCache {
  const passedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<boolean>>();
  // Bumped by invalidate(), so a check that started before it cannot record a pass.
  let generation = 0;

  return {
    isValid(modelDir, profile) {
      const key = JSON.stringify([profile.repo, profile.revision, profile.mode, modelDir]);
      const passed = passedAt.get(key);
      if (passed !== undefined && now() - passed < ttlMs) return Promise.resolve(true);
      passedAt.delete(key);

      const running = inFlight.get(key);
      if (running) return running;
      const startedIn = generation;
      const check = validate(modelDir, profile)
        .then((valid) => {
          if (valid && startedIn === generation) {
            if (passedAt.size >= MAX_ENTRIES) passedAt.delete(passedAt.keys().next().value!);
            passedAt.set(key, now());
          }
          return valid;
        })
        .finally(() => {
          if (inFlight.get(key) === check) inFlight.delete(key);
        });
      inFlight.set(key, check);
      return check;
    },

    invalidate() {
      generation += 1;
      passedAt.clear();
      inFlight.clear();
    },
  };
}

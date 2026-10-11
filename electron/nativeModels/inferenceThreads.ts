import { execFileSync } from "child_process";
import { availableParallelism } from "os";

export interface InferenceThreadEnvironment {
  arch?: string;
  parallelism?: number;
  performanceCores?: number | null;
  platform?: NodeJS.Platform;
}

/**
 * Upper bounds on intra-op threads, measured per model: graphs stop scaling
 * well before the machine runs out of cores, and the desktop app still has a
 * UI to keep responsive.
 */
export interface InferenceThreadCaps {
  /** Apple silicon, further limited to its performance cores. */
  appleSilicon: number;
  other: number;
}

function readApplePerformanceCores(): number | null {
  try {
    const value = execFileSync(
      "/usr/sbin/sysctl",
      ["-n", "hw.perflevel0.physicalcpu"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 500 },
    );
    const count = Number.parseInt(value.trim(), 10);
    return Number.isInteger(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

/**
 * Intra-op thread count for a native model's ONNX sessions. Apple silicon is
 * split into performance and efficiency cores; scheduling inference across all
 * of them makes every op wait on the slowest core, so only performance cores
 * are counted there. Never more threads than the machine has, never fewer
 * than one.
 */
export function selectInferenceThreads(
  caps: InferenceThreadCaps,
  environment: InferenceThreadEnvironment = {},
): number {
  const parallelism = Math.max(1, Math.floor(environment.parallelism ?? availableParallelism()));
  const platform = environment.platform ?? process.platform;
  const arch = environment.arch ?? process.arch;
  if (platform === "darwin" && arch === "arm64") {
    const performanceCores = environment.performanceCores === undefined
      ? readApplePerformanceCores()
      : environment.performanceCores;
    if (performanceCores && performanceCores > 0) {
      return Math.max(1, Math.min(caps.appleSilicon, parallelism, Math.floor(performanceCores)));
    }
    return Math.max(1, Math.min(caps.appleSilicon, parallelism));
  }

  return Math.max(1, Math.min(caps.other, parallelism));
}

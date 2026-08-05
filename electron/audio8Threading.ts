import { execFileSync } from "child_process";
import { availableParallelism } from "os";

export interface Audio8ThreadEnvironment {
  arch?: string;
  parallelism?: number;
  performanceCores?: number | null;
  platform?: NodeJS.Platform;
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
 * Intra-op thread count for the Audio8 ONNX sessions. Apple silicon is split
 * into performance and efficiency cores; scheduling inference across all of
 * them makes every op wait on the slowest core. The INT4 graphs are also
 * memory-bandwidth bound: measurements on a six-performance-core M1 Pro put
 * four threads ahead of both five and six. Capping at four preserves that win
 * while automatically using fewer threads on any smaller M-series layout.
 * Elsewhere the count remains capped because the graphs stop scaling well
 * before the machine runs out of cores, and the desktop app still has a UI to
 * keep responsive.
 */
export function selectAudio8InferenceThreads(
  environment: Audio8ThreadEnvironment = {},
): number {
  const parallelism = Math.max(1, Math.floor(environment.parallelism ?? availableParallelism()));
  const platform = environment.platform ?? process.platform;
  const arch = environment.arch ?? process.arch;
  if (platform === "darwin" && arch === "arm64") {
    const performanceCores = environment.performanceCores === undefined
      ? readApplePerformanceCores()
      : environment.performanceCores;
    if (performanceCores && performanceCores > 0) {
      return Math.max(1, Math.min(4, parallelism, Math.floor(performanceCores)));
    }
    return Math.max(1, Math.min(4, parallelism));
  }

  return Math.max(1, Math.min(6, parallelism));
}

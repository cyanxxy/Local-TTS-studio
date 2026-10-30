import { promises as fs } from "fs";

/**
 * `fs.rm` options for removing a model cache tree. On Windows a file that was
 * just unmapped, or that Defender or the search indexer is scanning, refuses
 * deletion for a moment (EBUSY, EPERM, ENOTEMPTY), so Node retries there.
 * Elsewhere EPERM is a real permission error, reported at once.
 */
export function removeTreeOptions(platform: NodeJS.Platform = process.platform) {
  return platform === "win32"
    ? { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }
    : { recursive: true, force: true };
}

const TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

/**
 * `fs.rename`, retried while Windows reports the source or target as held by
 * another process. Other errors, and every error on other platforms, are
 * thrown at once.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  { attempts = 5, delayMs = 200, platform = process.platform }: { attempts?: number; delayMs?: number; platform?: NodeJS.Platform } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== "win32" || attempt >= attempts || !code || !TRANSIENT_RENAME_ERRORS.has(code)) throw error;
      await new Promise((resolve) => { setTimeout(resolve, delayMs * attempt); });
    }
  }
}

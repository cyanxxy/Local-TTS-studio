import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";

export interface HfXetProgress {
  downloadedBytes: number;
  totalBytes: number;
}

interface RunHfXetDownloaderOptions {
  binaryPath: string;
  modelRepo: string;
  revision: string;
  fileName: string;
  destination: string;
  onProgress: (downloadedBytes: number, totalBytes?: number) => void;
  signal?: AbortSignal;
  spawnProcess?: typeof spawn;
}

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const OUTPUT_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const KILL_GRACE_MS = 2_000;

export function parseHfXetProgressLine(line: string): HfXetProgress | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const downloadedBytes = Number(value.downloadedBytes);
    const totalBytes = Number(value.totalBytes);
    if (
      !Number.isFinite(downloadedBytes)
      || downloadedBytes < 0
      || !Number.isFinite(totalBytes)
      || totalBytes <= 0
    ) return null;
    return {
      downloadedBytes: Math.min(downloadedBytes, totalBytes),
      totalBytes,
    };
  } catch {
    return null;
  }
}

export function runHfXetDownloader({
  binaryPath,
  modelRepo,
  revision,
  fileName,
  destination,
  onProgress,
  signal,
  spawnProcess = spawn,
}: RunHfXetDownloaderOptions): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Qwen3 model download cancelled."));
      return;
    }
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawnProcess(binaryPath, [
        "--repo", modelRepo,
        "--revision", revision,
        "--file", fileName,
        "--destination", destination,
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let childClosed = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let terminationError: Error | null = null;

    const clearInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = null;
    };
    const armInactivityTimer = () => {
      if (terminationError) return;
      clearInactivityTimer();
      inactivityTimer = setTimeout(() => {
        terminate(new Error("Hugging Face Xet download stopped responding."));
      }, OUTPUT_INACTIVITY_TIMEOUT_MS);
      inactivityTimer.unref?.();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInactivityTimer();
      signal?.removeEventListener("abort", abortDownload);
      if (error) reject(error);
      else resolve(true);
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      clearInactivityTimer();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!childClosed) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const abortDownload = () => terminate(new Error("Qwen3 model download cancelled."));
    const consumeLine = (line: string) => {
      const progress = parseHfXetProgressLine(line.trim());
      if (progress) onProgress(progress.downloadedBytes, progress.totalBytes);
    };

    armInactivityTimer();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      armInactivityTimer();
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        consumeLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
      }
      if (stdoutBuffer.length > MAX_DIAGNOSTIC_BYTES) {
        stdoutBuffer = stdoutBuffer.slice(-MAX_DIAGNOSTIC_BYTES);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      armInactivityTimer();
      stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_BYTES);
    });
    child.on("error", (error) => {
      childClosed = true;
      if (killTimer) clearTimeout(killTimer);
      finish(terminationError ?? error);
    });
    child.on("close", (code, exitSignal) => {
      childClosed = true;
      if (killTimer) clearTimeout(killTimer);
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim() || `process exited with code ${code ?? "unknown"}${exitSignal ? ` (${exitSignal})` : ""}`;
      finish(new Error(`Hugging Face Xet download failed: ${detail}`));
    });
    signal?.addEventListener("abort", abortDownload, { once: true });
    if (signal?.aborted) abortDownload();
  });
}

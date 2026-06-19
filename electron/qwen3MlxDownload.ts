import { createWriteStream } from "fs";
import { promises as fs } from "fs";
import type { IncomingMessage } from "http";
import { request as httpsRequest } from "https";
import path from "path";

export type UrlRequest = (url: string) => Promise<IncomingMessage>;

export interface Qwen3MlxDownloadProgress {
  modelRepo: string;
  modelDir: string;
  fileName: string;
  fileIndex: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes?: number;
}

export interface Qwen3MlxDownloadResult {
  modelRepo: string;
  modelDir: string;
  downloadedFiles: number;
  skippedFiles: number;
  modelDirLooksReady: boolean;
}

export interface Qwen3MlxProgressSenderTarget {
  isDestroyed: () => boolean;
  send: (channel: string, payload: unknown) => void;
}

interface HuggingFaceSibling {
  rfilename?: unknown;
}

interface HuggingFaceModelInfo {
  siblings?: HuggingFaceSibling[];
}

// Downloads outlive the window that started them, so every progress send must
// tolerate a destroyed sender: dropping a frame is fine, crashing the main
// process via an uncaughtException is not.
export function createSafeProgressSender(
  target: Qwen3MlxProgressSenderTarget,
  channel: string,
): (progress: Qwen3MlxDownloadProgress) => void {
  return (progress) => {
    if (target.isDestroyed()) return;
    try {
      target.send(channel, progress);
    } catch {
      // The window can be destroyed between the check and the send.
    }
  };
}

export interface Qwen3MlxSetupState {
  ttsAvailable: boolean;
  apiServerAvailable: boolean;
  workerAvailable: boolean;
  modelDirLooksReady: boolean;
}

// The Rust probe can only describe configuration hypothetically ("when ... are
// configured"); the host knows what is actually installed, so it replaces the
// probe warnings with the real engine status for this machine.
export function buildQwen3SetupWarnings(setup: Qwen3MlxSetupState): string[] {
  const warnings: string[] = [];
  const mlxEngineAvailable = setup.ttsAvailable || setup.apiServerAvailable;

  if (mlxEngineAvailable && setup.modelDirLooksReady) {
    warnings.push(
      setup.apiServerAvailable
        ? "Qwen3 MLX CustomVoice (6-bit) is set up and used by default on this machine."
        : "Qwen3 MLX CustomVoice (6-bit) is set up, but the resident api_server binary is missing — every chunk falls back to the one-shot tts binary, which reloads the model each time and is much slower. Rebuild with `npm run build:qwen3-mlx-worker && npm run build:rust` to restore the fast path.",
    );
  } else if (mlxEngineAvailable) {
    warnings.push(
      "MLX CustomVoice binaries are installed, but the 6-bit model is not downloaded yet — Qwen3 uses the Candle CustomVoice engine until the model is downloaded from this page.",
    );
  } else {
    warnings.push(
      "MLX CustomVoice is not installed on this machine, so Qwen3 uses the Candle CustomVoice engine. To enable the faster MLX default, run `npm run build:qwen3-mlx-worker && npm run build:rust`, then download the model from this page.",
    );
  }

  warnings.push(
    setup.workerAvailable
      ? "Base voice cloning (pibot-tts-worker) is available when explicitly selected."
      : "Base voice cloning is unavailable until the pibot-tts-worker binary is built (`npm run build:qwen3-mlx-worker`).",
  );

  return warnings;
}

// Hugging Face file listings are remote input: reject anything that could
// escape the model directory on any platform (Windows treats "\\" as a
// separator, so "..\\evil" must fail just like "../evil").
export function isSafeHuggingFaceFileName(fileName: unknown): fileName is string {
  return typeof fileName === "string"
    && fileName.length > 0
    && !fileName.includes("\0")
    && !fileName.includes("\\")
    && fileName.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

// Containment backstop behind isSafeHuggingFaceFileName: the resolved
// destination must stay strictly inside the model directory.
export function resolveDownloadDestination(modelDir: string, fileName: string): string {
  const root = path.resolve(modelDir);
  const destination = path.resolve(root, ...fileName.split("/"));
  if (!destination.startsWith(root + path.sep)) {
    throw new Error(`Hugging Face file name escapes the model directory: ${fileName}`);
  }
  return destination;
}

export function encodeHuggingFacePath(filePath: string): string {
  return filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

// Socket inactivity deadline for a single request. A server that accepts the
// connection but never sends response headers would otherwise hang the awaited
// `request(url)` forever; this turns that into a clean rejection.
const REQUEST_IDLE_TIMEOUT_MS = 30_000;

// Body-streaming inactivity deadline (re-armed on every received chunk). Guards
// against a response whose body stalls or truncates without emitting a stream
// terminal event. Generous so a slow-but-progressing transfer is never killed.
export const IDLE_DOWNLOAD_TIMEOUT_MS = 120_000;

// The Node-side downloader runs in the main process with unrestricted host
// network access (loopback, link-local 169.254.0.0/16, RFC1918), and it is NOT
// covered by the renderer CSP. A server-controlled 3xx `Location` is followed
// verbatim, so without a destination check a redirect could point the main
// process at an internal service or the cloud-metadata endpoint (SSRF). Mirror
// the HuggingFace host posture from security.ts and only ever fetch HF hosts;
// a bare IP literal never matches these suffixes, so metadata/loopback targets
// are rejected too.
export function isAllowedHuggingFaceDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "huggingface.co"
    || host === "hf.co"
    || host.endsWith(".huggingface.co")
    || host.endsWith(".hf.co");
}

// Remote content must only ever load over HTTPS (Electron security checklist
// item 1), so plain-http URLs are rejected up front — including redirect
// targets, which re-enter this function and could otherwise downgrade an
// https download to http or redirect off the HuggingFace host allowlist.
export function requestUrl(url: string, redirectCount = 0): Promise<IncomingMessage> {
  if (redirectCount > 8) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      reject(new Error(`Refusing to download over insecure protocol: ${url}`));
      return;
    }
    if (!isAllowedHuggingFaceDownloadHost(parsed.hostname)) {
      reject(new Error(`Refusing to download from non-HuggingFace host: ${parsed.host}`));
      return;
    }
    const request = httpsRequest(
      parsed,
      {
        headers: {
          "User-Agent": "Open-TTS/1.0",
        },
        timeout: REQUEST_IDLE_TIMEOUT_MS,
      },
      (response) => {
        const location = response.headers.location;
        if (
          response.statusCode
          && response.statusCode >= 300
          && response.statusCode < 400
          && location
        ) {
          response.resume();
          void requestUrl(new URL(location, url).toString(), redirectCount + 1).then(resolve, reject);
          return;
        }
        resolve(response);
      },
    );
    // `timeout` only emits an event; the socket must be torn down explicitly so
    // the awaiting caller sees a rejection rather than a silent stall.
    request.on("timeout", () => request.destroy(new Error(`Timed out connecting to ${url}`)));
    request.on("error", reject);
    request.end();
  });
}

async function readUrlJson(url: string, request: UrlRequest): Promise<unknown> {
  const response = await request(url);
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    throw new Error(`Hugging Face request failed with status ${response.statusCode ?? "unknown"}.`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > 25_000_000) throw new Error("Hugging Face model metadata response was too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

export async function listHuggingFaceModelFiles(
  modelRepo: string,
  request: UrlRequest = requestUrl,
): Promise<string[]> {
  const info = await readUrlJson(`https://huggingface.co/api/models/${modelRepo}`, request) as HuggingFaceModelInfo;
  if (!Array.isArray(info.siblings)) {
    throw new Error("Hugging Face model metadata did not include file listings.");
  }
  const files = info.siblings
    .map((entry) => entry.rfilename)
    .filter(isSafeHuggingFaceFileName)
    .sort((left, right) => {
      const leftWeight = left.endsWith(".safetensors") ? 1 : 0;
      const rightWeight = right.endsWith(".safetensors") ? 1 : 0;
      return leftWeight - rightWeight || left.localeCompare(right);
    });
  if (files.length === 0) {
    throw new Error(`No downloadable files found for ${modelRepo}.`);
  }
  return files;
}

export async function downloadHuggingFaceFile(
  url: string,
  destination: string,
  onProgress: (downloadedBytes: number, totalBytes?: number) => void,
  request: UrlRequest = requestUrl,
): Promise<boolean> {
  const response = await request(url);
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    throw new Error(`Download failed with status ${response.statusCode ?? "unknown"} for ${url}.`);
  }

  const totalHeader = response.headers["content-length"];
  const totalBytes = typeof totalHeader === "string" ? Number(totalHeader) : undefined;
  const existing = await fs.stat(destination).then((stats) => stats, () => null);
  if (
    existing?.isFile()
    && typeof totalBytes === "number"
    && Number.isFinite(totalBytes)
    && existing.size === totalBytes
  ) {
    response.resume();
    onProgress(existing.size, totalBytes);
    return false;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.download`;
  await fs.rm(temporaryPath, { force: true });
  const output = createWriteStream(temporaryPath);
  let downloadedBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const clearIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearIdle();
        if (err) {
          response.destroy();
          output.destroy();
          reject(err);
        } else {
          resolve();
        }
      };
      // A truncated body can leave the stream silent forever — a server that
      // ends after fewer bytes than its Content-Length emits no 'end', 'error',
      // or 'finish'. An inactivity deadline (re-armed on every chunk, so an
      // actively-progressing transfer never trips it) turns that hang into a
      // clean failure instead of permanently wedging the download coordinator.
      const armIdle = () => {
        clearIdle();
        idleTimer = setTimeout(
          () => settle(new Error(`Download stalled for ${IDLE_DOWNLOAD_TIMEOUT_MS / 1000}s: ${url}`)),
          IDLE_DOWNLOAD_TIMEOUT_MS,
        );
        idleTimer.unref?.();
      };
      armIdle();
      response.on("data", (chunk: Buffer) => {
        downloadedBytes += chunk.byteLength;
        armIdle();
        onProgress(downloadedBytes, totalBytes);
      });
      response.on("aborted", () => settle(new Error(`Download connection closed early: ${url}`)));
      response.on("error", settle);
      output.on("error", settle);
      output.on("finish", () => settle());
      response.pipe(output);
    });

    // When the server declared a length, a short body is a truncated/corrupt
    // download — reject it rather than promoting the partial file to the final
    // destination where qwen3MlxModelDirLooksReady would treat it as complete.
    if (typeof totalBytes === "number" && Number.isFinite(totalBytes) && downloadedBytes !== totalBytes) {
      throw new Error(`Download incomplete for ${url}: received ${downloadedBytes} of ${totalBytes} bytes.`);
    }
  } catch (err) {
    // Drop the partial temp file so an abandoned download leaves no clutter and
    // a retry starts clean (rather than relying on the next attempt's pre-rm).
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw err;
  }

  await fs.rename(temporaryPath, destination);
  return true;
}

export async function qwen3MlxModelDirLooksReady(modelDir: string): Promise<boolean> {
  try {
    const [configStats, entries] = await Promise.all([
      fs.stat(path.join(modelDir, "config.json")),
      fs.readdir(modelDir, { withFileTypes: true }),
    ]);
    return configStats.isFile()
      && entries.some((entry) => entry.isFile() && entry.name.endsWith(".safetensors"));
  } catch {
    return false;
  }
}

export async function downloadQwen3MlxModel(
  modelRepo: string,
  modelDir: string,
  onProgress: (progress: Qwen3MlxDownloadProgress) => void,
  request: UrlRequest = requestUrl,
): Promise<Qwen3MlxDownloadResult> {
  await fs.mkdir(modelDir, { recursive: true });
  const files = await listHuggingFaceModelFiles(modelRepo, request);
  let downloadedFiles = 0;
  let skippedFiles = 0;

  for (const [index, fileName] of files.entries()) {
    const destination = resolveDownloadDestination(modelDir, fileName);
    const url = `https://huggingface.co/${modelRepo}/resolve/main/${encodeHuggingFacePath(fileName)}`;
    const downloaded = await downloadHuggingFaceFile(url, destination, (downloadedBytes, totalBytes) => {
      onProgress({
        modelRepo,
        modelDir,
        fileName,
        fileIndex: index + 1,
        totalFiles: files.length,
        downloadedBytes,
        ...(typeof totalBytes === "number" && Number.isFinite(totalBytes) ? { totalBytes } : {}),
      });
    }, request);
    if (downloaded) {
      downloadedFiles += 1;
    } else {
      skippedFiles += 1;
    }
  }

  return {
    modelRepo,
    modelDir,
    downloadedFiles,
    skippedFiles,
    modelDirLooksReady: await qwen3MlxModelDirLooksReady(modelDir),
  };
}

export interface Qwen3MlxDownloadCoordinator {
  download: (
    modelRepo: string,
    modelDir: string,
    onProgress: (progress: Qwen3MlxDownloadProgress) => void,
  ) => Promise<Qwen3MlxDownloadResult>;
}

// Two concurrent downloads into the same directory would race the same
// `.download` temp files and renames, so invokes are deduplicated per model
// directory: a second invoke while one is in flight awaits the same promise
// (progress keeps streaming to the original sender; the result is identical).
export function createQwen3MlxDownloadCoordinator(
  download: typeof downloadQwen3MlxModel = downloadQwen3MlxModel,
): Qwen3MlxDownloadCoordinator {
  const inFlight = new Map<string, Promise<Qwen3MlxDownloadResult>>();
  return {
    download(modelRepo, modelDir, onProgress) {
      const existing = inFlight.get(modelDir);
      if (existing) return existing;
      const pending = download(modelRepo, modelDir, onProgress).finally(() => {
        inFlight.delete(modelDir);
      });
      inFlight.set(modelDir, pending);
      return pending;
    },
  };
}

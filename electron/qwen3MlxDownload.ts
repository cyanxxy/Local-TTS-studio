import { createWriteStream } from "fs";
import { promises as fs } from "fs";
import { request as httpRequest, type IncomingMessage } from "http";
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

export function requestUrl(url: string, redirectCount = 0): Promise<IncomingMessage> {
  if (redirectCount > 8) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = (parsed.protocol === "http:" ? httpRequest : httpsRequest)(
      parsed,
      {
        headers: {
          "User-Agent": "Open-TTS/1.0",
        },
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

  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error) => {
      output.destroy();
      reject(err);
    };
    response.on("data", (chunk: Buffer) => {
      downloadedBytes += chunk.byteLength;
      onProgress(downloadedBytes, totalBytes);
    });
    response.on("error", fail);
    output.on("error", fail);
    output.on("finish", resolve);
    response.pipe(output);
  });
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

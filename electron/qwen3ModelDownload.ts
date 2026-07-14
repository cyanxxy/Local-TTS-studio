import { createHash } from "crypto";
import { createWriteStream } from "fs";
import { promises as fs } from "fs";
import type { IncomingMessage } from "http";
import { request as httpsRequest } from "https";
import path from "path";
import type { Qwen3Profile } from "./qwen3Profiles";

export const QWEN3_MODEL_MANIFEST = "open-tts-model.json";
export const IDLE_DOWNLOAD_TIMEOUT_MS = 120_000;
const REQUEST_IDLE_TIMEOUT_MS = 30_000;

export type UrlRequest = (url: string) => Promise<IncomingMessage>;
export type HuggingFaceXetDownloader = (input: {
  modelRepo: string;
  revision: string;
  fileName: string;
  destination: string;
  onProgress: (downloadedBytes: number, totalBytes?: number) => void;
}) => Promise<boolean>;
export type Qwen3ModelReadiness = "missing" | "structural" | "verified";

export class HuggingFaceDownloadStatusError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly url: string,
  ) {
    super(`Download failed with status ${statusCode ?? "unknown"} for ${url}.`);
    this.name = "HuggingFaceDownloadStatusError";
  }
}

export interface Qwen3ModelDownloadProgress {
  modelRepo: string;
  revision: string;
  modelDir: string;
  fileName: string;
  fileIndex: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes?: number;
}

export interface Qwen3ModelDownloadResult {
  modelRepo: string;
  revision: string;
  modelDir: string;
  downloadedFiles: number;
  skippedFiles: number;
  readiness: Qwen3ModelReadiness;
}

export interface Qwen3ModelInspection {
  readiness: Qwen3ModelReadiness;
  reason?: string;
}

export interface Qwen3ModelManifestFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface Qwen3ModelManifest {
  schemaVersion: 1;
  repo: string;
  revision: string;
  files: Qwen3ModelManifestFile[];
}

export interface Qwen3ProgressSenderTarget {
  isDestroyed: () => boolean;
  send: (channel: string, payload: unknown) => void;
}

interface HuggingFaceSibling {
  rfilename?: unknown;
  size?: unknown;
  lfs?: { oid?: unknown; size?: unknown };
}

interface HuggingFaceModelInfo {
  siblings?: HuggingFaceSibling[];
}

interface HubFile {
  path: string;
  sizeBytes?: number;
  sha256?: string;
}

interface DownloadedFile {
  downloaded: boolean;
  sizeBytes: number;
  sha256: string;
}

export function createSafeProgressSender(
  target: Qwen3ProgressSenderTarget,
  channel: string,
): (progress: Qwen3ModelDownloadProgress) => void {
  return (progress) => {
    if (target.isDestroyed()) return;
    try {
      target.send(channel, progress);
    } catch {
      // A window can be destroyed between the check and send.
    }
  };
}

export function isSafeHuggingFaceFileName(fileName: unknown): fileName is string {
  return typeof fileName === "string"
    && fileName.length > 0
    && !fileName.includes("\0")
    && !fileName.includes("\\")
    && fileName.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

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

export function isAllowedHuggingFaceDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "huggingface.co"
    || host === "hf.co"
    || host.endsWith(".huggingface.co")
    || host.endsWith(".hf.co");
}

export function requestUrl(url: string, redirectCount = 0): Promise<IncomingMessage> {
  if (redirectCount > 8) return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
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
    const request = httpsRequest(parsed, {
      headers: { "User-Agent": "Open-TTS/1.0" },
      timeout: REQUEST_IDLE_TIMEOUT_MS,
    }, (response) => {
      const location = response.headers.location;
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        void requestUrl(new URL(location, url).toString(), redirectCount + 1).then(resolve, reject);
        return;
      }
      resolve(response);
    });
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

function encodedRepo(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}

async function getRequiredHubFiles(profile: Qwen3Profile, request: UrlRequest): Promise<HubFile[]> {
  const url = `https://huggingface.co/api/models/${encodedRepo(profile.repo)}/revision/${profile.revision}?blobs=true`;
  const info = await readUrlJson(url, request) as HuggingFaceModelInfo;
  if (!Array.isArray(info.siblings)) throw new Error("Hugging Face model metadata did not include file listings.");
  const siblings = new Map<string, HuggingFaceSibling>();
  for (const sibling of info.siblings) {
    if (isSafeHuggingFaceFileName(sibling.rfilename)) siblings.set(sibling.rfilename, sibling);
  }
  return profile.requiredFiles.map((requiredPath) => {
    const sibling = siblings.get(requiredPath);
    if (!sibling) throw new Error(`Pinned Qwen3 revision is missing required file: ${requiredPath}`);
    const lfsSize = sibling.lfs?.size;
    const size = typeof lfsSize === "number" ? lfsSize : sibling.size;
    const oid = sibling.lfs?.oid;
    return {
      path: requiredPath,
      ...(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? { sizeBytes: size } : {}),
      ...(typeof oid === "string" && /^[a-f0-9]{64}$/i.test(oid) ? { sha256: oid.toLowerCase() } : {}),
    };
  });
}

async function hashFile(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

export async function downloadHuggingFaceFile(
  url: string,
  destination: string,
  onProgress: (downloadedBytes: number, totalBytes?: number) => void,
  request: UrlRequest = requestUrl,
  expected: { sizeBytes?: number; sha256?: string } = {},
): Promise<DownloadedFile> {
  const response = await request(url);
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    throw new HuggingFaceDownloadStatusError(response.statusCode, url);
  }
  const lengthHeader = response.headers["content-length"];
  const contentLength = typeof lengthHeader === "string" ? Number(lengthHeader) : undefined;
  const totalBytes = expected.sizeBytes ?? contentLength;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.download`;
  await fs.rm(temporaryPath, { force: true });
  const output = createWriteStream(temporaryPath, { flags: "wx" });
  const hash = createHash("sha256");
  let downloadedBytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (error) {
          response.destroy();
          output.destroy();
          reject(error);
        } else {
          resolve();
        }
      };
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => settle(new Error(`Download stalled for ${IDLE_DOWNLOAD_TIMEOUT_MS / 1000}s: ${url}`)),
          IDLE_DOWNLOAD_TIMEOUT_MS,
        );
        idleTimer.unref?.();
      };
      armIdle();
      response.on("data", (chunk: Buffer) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        downloadedBytes += buffer.byteLength;
        hash.update(buffer);
        armIdle();
        onProgress(downloadedBytes, totalBytes);
      });
      response.on("aborted", () => settle(new Error(`Download connection closed early: ${url}`)));
      response.on("error", settle);
      output.on("error", settle);
      output.on("finish", () => settle());
      response.pipe(output);
    });
    if (typeof contentLength === "number" && Number.isFinite(contentLength) && downloadedBytes !== contentLength) {
      throw new Error(`Download incomplete for ${url}: received ${downloadedBytes} of ${contentLength} bytes.`);
    }
    if (typeof expected.sizeBytes === "number" && downloadedBytes !== expected.sizeBytes) {
      throw new Error(`Download size mismatch for ${url}: received ${downloadedBytes} of ${expected.sizeBytes} bytes.`);
    }
    const sha256 = hash.digest("hex");
    if (expected.sha256 && sha256 !== expected.sha256) {
      throw new Error(`Download digest mismatch for ${url}.`);
    }
    await fs.rename(temporaryPath, destination);
    return { downloaded: true, sizeBytes: downloadedBytes, sha256 };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isManifest(value: unknown): value is Qwen3ModelManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<Qwen3ModelManifest>;
  return manifest.schemaVersion === 1
    && typeof manifest.repo === "string"
    && typeof manifest.revision === "string"
    && Array.isArray(manifest.files)
    && manifest.files.every((file) => (
      isSafeHuggingFaceFileName(file?.path)
      && Number.isSafeInteger(file.sizeBytes)
      && file.sizeBytes > 0
      && typeof file.sha256 === "string"
      && /^[a-f0-9]{64}$/i.test(file.sha256)
    ));
}

async function isStructurallyValid(modelDir: string, profile: Qwen3Profile): Promise<boolean> {
  try {
    for (const fileName of profile.requiredFiles) {
      const stat = await fs.stat(resolveDownloadDestination(modelDir, fileName));
      if (!stat.isFile() || stat.size === 0) return false;
    }
    const config = JSON.parse(await fs.readFile(path.join(modelDir, "config.json"), "utf-8")) as { tts_model_type?: unknown };
    return config.tts_model_type === (profile.mode === "voiceClone" ? "base" : "custom_voice");
  } catch {
    return false;
  }
}

export async function inspectQwen3ModelDir(
  modelDir: string,
  profile: Qwen3Profile,
): Promise<Qwen3ModelInspection> {
  if (!(await isStructurallyValid(modelDir, profile))) {
    return { readiness: "missing", reason: "Required model files are missing or do not match the profile." };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await fs.readFile(path.join(modelDir, QWEN3_MODEL_MANIFEST), "utf-8"));
  } catch {
    return { readiness: "structural", reason: "Model files exist but have no verified Open TTS manifest." };
  }
  if (!isManifest(decoded) || decoded.repo !== profile.repo || decoded.revision !== profile.revision) {
    return { readiness: "structural", reason: "Model manifest does not match the selected immutable revision." };
  }
  const byPath = new Map(decoded.files.map((file) => [file.path, file]));
  for (const requiredPath of profile.requiredFiles) {
    const expected = byPath.get(requiredPath);
    if (!expected) return { readiness: "structural", reason: `Manifest is missing ${requiredPath}.` };
    try {
      const actual = await hashFile(resolveDownloadDestination(modelDir, requiredPath));
      if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) {
        return { readiness: "structural", reason: `${requiredPath} does not match its manifest digest.` };
      }
    } catch {
      return { readiness: "structural", reason: `Could not verify ${requiredPath}.` };
    }
  }
  return { readiness: "verified" };
}

export async function adoptLegacyQwen3ModelDir(
  profile: Qwen3Profile,
  revisionDir: string,
  legacyDir: string,
): Promise<string> {
  if ((await inspectQwen3ModelDir(revisionDir, profile)).readiness !== "missing") return revisionDir;
  if ((await inspectQwen3ModelDir(legacyDir, profile)).readiness === "missing") return revisionDir;

  await fs.mkdir(path.dirname(revisionDir), { recursive: true });
  try {
    await fs.rename(legacyDir, revisionDir);
  } catch (error) {
    // Setup and download IPC can race during renderer startup. If another
    // caller already adopted the directory, use its result; otherwise retain
    // the original error instead of hiding a filesystem failure.
    if ((await inspectQwen3ModelDir(revisionDir, profile)).readiness === "missing") throw error;
  }
  return revisionDir;
}

async function writeManifest(modelDir: string, manifest: Qwen3ModelManifest): Promise<void> {
  const finalPath = path.join(modelDir, QWEN3_MODEL_MANIFEST);
  const temporaryPath = `${finalPath}.download`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w" });
  await fs.rename(temporaryPath, finalPath);
}

export async function downloadQwen3Model(
  profile: Qwen3Profile,
  modelDir: string,
  onProgress: (progress: Qwen3ModelDownloadProgress) => void,
  request: UrlRequest = requestUrl,
  xetDownloader?: HuggingFaceXetDownloader,
): Promise<Qwen3ModelDownloadResult> {
  await fs.mkdir(modelDir, { recursive: true });
  const hubFiles = await getRequiredHubFiles(profile, request);
  const manifestFiles: Qwen3ModelManifestFile[] = [];
  let downloadedFiles = 0;
  let skippedFiles = 0;
  for (const [index, file] of hubFiles.entries()) {
    const destination = resolveDownloadDestination(modelDir, file.path);
    const existing = await hashFile(destination).catch(() => undefined);
    if (
      existing
      && (file.sizeBytes == null || existing.sizeBytes === file.sizeBytes)
      && (file.sha256 == null || existing.sha256 === file.sha256)
    ) {
      skippedFiles += 1;
      manifestFiles.push({ path: file.path, ...existing });
      onProgress({
        modelRepo: profile.repo,
        revision: profile.revision,
        modelDir,
        fileName: file.path,
        fileIndex: index + 1,
        totalFiles: hubFiles.length,
        downloadedBytes: existing.sizeBytes,
        totalBytes: existing.sizeBytes,
      });
      continue;
    }
    const url = `https://huggingface.co/${profile.repo}/resolve/${profile.revision}/${encodeHuggingFacePath(file.path)}`;
    const reportProgress = (downloadedBytes: number, totalBytes?: number) => {
      onProgress({
        modelRepo: profile.repo,
        revision: profile.revision,
        modelDir,
        fileName: file.path,
        fileIndex: index + 1,
        totalFiles: hubFiles.length,
        downloadedBytes,
        ...(typeof totalBytes === "number" && Number.isFinite(totalBytes) ? { totalBytes } : {}),
      });
    };
    let result: DownloadedFile;
    try {
      result = await downloadHuggingFaceFile(url, destination, reportProgress, request, file);
    } catch (error) {
      const shouldUseXet = xetDownloader
        && error instanceof HuggingFaceDownloadStatusError
        && error.statusCode === 403
        && file.path.endsWith(".safetensors");
      if (!shouldUseXet) throw error;
      await fs.rm(destination, { force: true });
      const downloaded = await xetDownloader({
        modelRepo: profile.repo,
        revision: profile.revision,
        fileName: file.path,
        destination,
        onProgress: reportProgress,
      });
      const verified = await hashFile(destination);
      if (file.sizeBytes != null && verified.sizeBytes !== file.sizeBytes) {
        throw new Error(`Xet download size mismatch for ${file.path}.`);
      }
      if (file.sha256 != null && verified.sha256 !== file.sha256) {
        throw new Error(`Xet download digest mismatch for ${file.path}.`);
      }
      result = { downloaded, ...verified };
    }
    downloadedFiles += result.downloaded ? 1 : 0;
    manifestFiles.push({ path: file.path, sizeBytes: result.sizeBytes, sha256: result.sha256 });
  }
  await writeManifest(modelDir, {
    schemaVersion: 1,
    repo: profile.repo,
    revision: profile.revision,
    files: manifestFiles,
  });
  const readiness = (await inspectQwen3ModelDir(modelDir, profile)).readiness;
  if (readiness !== "verified") throw new Error("Downloaded Qwen3 model failed manifest verification.");
  return { modelRepo: profile.repo, revision: profile.revision, modelDir, downloadedFiles, skippedFiles, readiness };
}

export interface Qwen3ModelDownloadCoordinator {
  download: (
    profile: Qwen3Profile,
    modelDir: string,
    onProgress: (progress: Qwen3ModelDownloadProgress) => void,
  ) => Promise<Qwen3ModelDownloadResult>;
}

export function createQwen3ModelDownloadCoordinator(
  download: typeof downloadQwen3Model = downloadQwen3Model,
): Qwen3ModelDownloadCoordinator {
  const inFlight = new Map<string, {
    promise: Promise<Qwen3ModelDownloadResult>;
    listeners: Set<(progress: Qwen3ModelDownloadProgress) => void>;
  }>();
  return {
    download(profile, modelDir, onProgress) {
      const key = `${profile.repo}@${profile.revision}:${path.resolve(modelDir)}`;
      const existing = inFlight.get(key);
      if (existing) {
        existing.listeners.add(onProgress);
        return existing.promise;
      }
      const listeners = new Set([onProgress]);
      const promise = download(profile, modelDir, (progress) => {
        for (const listener of listeners) listener(progress);
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, { promise, listeners });
      return promise;
    },
  };
}

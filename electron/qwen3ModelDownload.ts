import { promises as fs } from "fs";
import path from "path";
import { renameWithRetry } from "./fsRetry";
import { FileDigestCache } from "./nativeModels/fileDigest";
import { readHubJson, requestUrl, type UrlRequest } from "./nativeModels/hubHttps";
import { createProgressThrottle } from "./nativeModels/progressThrottle";
import { downloadVerifiedFile, type DownloadFailure } from "./nativeModels/verifiedDownload";
import { QWEN3_OPTIONAL_MODEL_FILES, type Qwen3Profile } from "./qwen3Profiles";

// Re-exported so the main process keeps one import site for Qwen3 downloads.
export { isAllowedHuggingFaceDownloadHost, requestUrl, type UrlRequest } from "./nativeModels/hubHttps";

export const QWEN3_MODEL_MANIFEST = "open-tts-model.json";
export const IDLE_DOWNLOAD_TIMEOUT_MS = 120_000;

export type HuggingFaceXetDownloader = (input: {
  modelRepo: string;
  revision: string;
  fileName: string;
  destination: string;
  onProgress: (downloadedBytes: number, totalBytes?: number) => void;
  signal?: AbortSignal;
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

function downloadCancelledError(): Error {
  return new Error("Qwen3 model download cancelled.");
}

function throwIfDownloadCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw downloadCancelledError();
}

function encodedRepo(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}

function toHubFile(filePath: string, sibling: HuggingFaceSibling): HubFile {
  const lfsSize = sibling.lfs?.size;
  const size = typeof lfsSize === "number" ? lfsSize : sibling.size;
  const oid = sibling.lfs?.oid;
  return {
    path: filePath,
    ...(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? { sizeBytes: size } : {}),
    ...(typeof oid === "string" && /^[a-f0-9]{64}$/i.test(oid) ? { sha256: oid.toLowerCase() } : {}),
  };
}

async function getHubFiles(
  profile: Qwen3Profile,
  request: UrlRequest,
  signal?: AbortSignal,
): Promise<HubFile[]> {
  const url = `https://huggingface.co/api/models/${encodedRepo(profile.repo)}/revision/${profile.revision}?blobs=true`;
  const info = await readHubJson(url, { request, signal, cancelledError: downloadCancelledError }) as HuggingFaceModelInfo;
  if (!Array.isArray(info.siblings)) throw new Error("Hugging Face model metadata did not include file listings.");
  const siblings = new Map<string, HuggingFaceSibling>();
  for (const sibling of info.siblings) {
    if (isSafeHuggingFaceFileName(sibling.rfilename)) siblings.set(sibling.rfilename, sibling);
  }
  const files = profile.requiredFiles.map((requiredPath) => {
    const sibling = siblings.get(requiredPath);
    if (!sibling) throw new Error(`Pinned Qwen3 revision is missing required file: ${requiredPath}`);
    return toHubFile(requiredPath, sibling);
  });
  for (const optionalPath of QWEN3_OPTIONAL_MODEL_FILES) {
    if (profile.requiredFiles.includes(optionalPath)) continue;
    const sibling = siblings.get(optionalPath);
    if (sibling) files.push(toHubFile(optionalPath, sibling));
  }
  return files;
}

/**
 * Setup inspects every profile on mount and on each profile switch, and every
 * inspection used to re-read gigabytes of weights. Digests are remembered while
 * a file provably has not changed; each inspection still compares them with
 * the manifest it reads, so nothing unverified is ever reported as verified.
 */
const modelFileDigests = new FileDigestCache(downloadCancelledError);

async function digestModelFile(filePath: string, signal?: AbortSignal): Promise<{ sizeBytes: number; sha256: string }> {
  const { sizeBytes, digest } = await modelFileDigests.digest(filePath, "sha256", signal);
  return { sizeBytes, sha256: digest };
}

function describeDownloadFailure(url: string, failure: DownloadFailure): Error {
  switch (failure.kind) {
    case "status":
      return new HuggingFaceDownloadStatusError(failure.statusCode, url);
    case "stalled":
      return new Error(`Download stalled for ${failure.idleTimeoutMs / 1000}s: ${url}`);
    case "aborted":
      return new Error(`Download connection closed early: ${url}`);
    case "truncated":
      return new Error(`Download output closed early: ${url}`);
    case "incomplete":
      return new Error(`Download incomplete for ${url}: received ${failure.receivedBytes} of ${failure.contentLength} bytes.`);
    case "oversize":
    case "size":
      return new Error(`Download size mismatch for ${url}: received ${failure.receivedBytes} of ${failure.expectedBytes} bytes.`);
    case "digest":
      return new Error(`Download digest mismatch for ${url}.`);
  }
}

export async function downloadHuggingFaceFile(
  url: string,
  destination: string,
  onProgress: (downloadedBytes: number, totalBytes?: number) => void,
  request: UrlRequest = requestUrl,
  expected: { sizeBytes?: number; sha256?: string } = {},
  signal?: AbortSignal,
): Promise<DownloadedFile> {
  const { sizeBytes, digest } = await downloadVerifiedFile({
    url,
    destination,
    request,
    expected: {
      ...(typeof expected.sizeBytes === "number" ? { sizeBytes: expected.sizeBytes } : {}),
      ...(expected.sha256 ? { digest: { algorithm: "sha256", value: expected.sha256 } } : {}),
    },
    idleTimeoutMs: IDLE_DOWNLOAD_TIMEOUT_MS,
    onBytes: onProgress,
    checkContentLength: true,
    // Builds before process-unique partials used one fixed name per file.
    legacyPartialPaths: [`${destination}.download`],
    signal,
    cancelledError: downloadCancelledError,
    describeFailure: (failure) => describeDownloadFailure(url, failure),
  });
  return { downloaded: true, sizeBytes, sha256: digest };
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

export async function isStructurallyValidQwen3ModelDir(
  modelDir: string,
  profile: Qwen3Profile,
): Promise<boolean> {
  try {
    for (const fileName of profile.requiredFiles) {
      const stat = await fs.stat(resolveDownloadDestination(modelDir, fileName));
      if (!stat.isFile() || stat.size === 0) return false;
    }
    const config = JSON.parse(await fs.readFile(path.join(modelDir, "config.json"), "utf-8")) as { tts_model_type?: unknown };
    const expectedModelType = {
      customVoice: "custom_voice",
      voiceClone: "base",
      voiceDesign: "voice_design",
    }[profile.mode];
    return config.tts_model_type === expectedModelType;
  } catch {
    return false;
  }
}

export async function inspectQwen3ModelDir(
  modelDir: string,
  profile: Qwen3Profile,
  signal?: AbortSignal,
): Promise<Qwen3ModelInspection> {
  throwIfDownloadCancelled(signal);
  if (!(await isStructurallyValidQwen3ModelDir(modelDir, profile))) {
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
    throwIfDownloadCancelled(signal);
    const expected = byPath.get(requiredPath);
    if (!expected) return { readiness: "structural", reason: `Manifest is missing ${requiredPath}.` };
    try {
      const actual = await digestModelFile(resolveDownloadDestination(modelDir, requiredPath), signal);
      if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) {
        return { readiness: "structural", reason: `${requiredPath} does not match its manifest digest.` };
      }
    } catch {
      return { readiness: "structural", reason: `Could not verify ${requiredPath}.` };
    }
  }
  for (const optionalPath of QWEN3_OPTIONAL_MODEL_FILES) {
    throwIfDownloadCancelled(signal);
    let actual: { sizeBytes: number; sha256: string };
    try {
      actual = await digestModelFile(resolveDownloadDestination(modelDir, optionalPath), signal);
    } catch (error) {
      throwIfDownloadCancelled(signal);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { readiness: "structural", reason: `Could not verify ${optionalPath}.` };
    }
    const expected = byPath.get(optionalPath);
    if (!expected || actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) {
      return { readiness: "structural", reason: `${optionalPath} is present but does not match the verified manifest.` };
    }
  }
  return { readiness: "verified" };
}

/**
 * Moves a pre-revision cache directory into its revision-scoped name. The
 * decision only needs to know whether a directory has the profile's files, so
 * it uses the structural check: a full inspection answers the same question
 * after hashing every weight file, and setup asks it for every profile.
 */
export async function adoptLegacyQwen3ModelDir(
  profile: Qwen3Profile,
  revisionDir: string,
  legacyDir: string,
): Promise<string> {
  if (await isStructurallyValidQwen3ModelDir(revisionDir, profile)) return revisionDir;
  if (!(await isStructurallyValidQwen3ModelDir(legacyDir, profile))) return revisionDir;

  await fs.mkdir(path.dirname(revisionDir), { recursive: true });
  try {
    await renameWithRetry(legacyDir, revisionDir);
  } catch (error) {
    // Setup and download IPC can race during renderer startup. If another
    // caller already adopted the directory, use its result; otherwise retain
    // the original error instead of hiding a filesystem failure.
    if (!(await isStructurallyValidQwen3ModelDir(revisionDir, profile))) throw error;
  }
  return revisionDir;
}

async function writeManifest(modelDir: string, manifest: Qwen3ModelManifest): Promise<void> {
  const finalPath = path.join(modelDir, QWEN3_MODEL_MANIFEST);
  const temporaryPath = `${finalPath}.download`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w" });
  await fs.rename(temporaryPath, finalPath);
}

/** Fetches a file through Xet after the plain download was refused, then checks it against the pin. */
async function downloadViaXet(
  xetDownloader: HuggingFaceXetDownloader,
  profile: Qwen3Profile,
  file: HubFile,
  destination: string,
  onProgress: (downloadedBytes: number, totalBytes?: number) => void,
  signal?: AbortSignal,
): Promise<DownloadedFile> {
  await fs.rm(destination, { force: true });
  const downloaded = await xetDownloader({
    modelRepo: profile.repo,
    revision: profile.revision,
    fileName: file.path,
    destination,
    onProgress,
    signal,
  });
  throwIfDownloadCancelled(signal);
  const verified = await digestModelFile(destination, signal);
  if (file.sizeBytes != null && verified.sizeBytes !== file.sizeBytes) {
    throw new Error(`Xet download size mismatch for ${file.path}.`);
  }
  if (file.sha256 != null && verified.sha256 !== file.sha256) {
    throw new Error(`Xet download digest mismatch for ${file.path}.`);
  }
  return { downloaded, ...verified };
}

export async function downloadQwen3Model(
  profile: Qwen3Profile,
  modelDir: string,
  onProgress: (progress: Qwen3ModelDownloadProgress) => void,
  request: UrlRequest = requestUrl,
  xetDownloader?: HuggingFaceXetDownloader,
  signal?: AbortSignal,
): Promise<Qwen3ModelDownloadResult> {
  throwIfDownloadCancelled(signal);
  await fs.mkdir(modelDir, { recursive: true });
  const hubFiles = await getHubFiles(profile, request, signal);
  const manifestFiles: Qwen3ModelManifestFile[] = [];
  let downloadedFiles = 0;
  let skippedFiles = 0;
  for (const [index, file] of hubFiles.entries()) {
    throwIfDownloadCancelled(signal);
    const destination = resolveDownloadDestination(modelDir, file.path);
    const existing = await digestModelFile(destination, signal).catch(() => {
      throwIfDownloadCancelled(signal);
      return undefined;
    });
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
    // One throttle per file: a file's first and last updates always reach the
    // renderer, and the flush below delivers the final count even when neither
    // the pin nor the server stated a total.
    const fileProgress = createProgressThrottle(onProgress, {
      fraction: ({ downloadedBytes, totalBytes }) => (totalBytes ? downloadedBytes / totalBytes : undefined),
    });
    const reportProgress = (downloadedBytes: number, totalBytes?: number) => {
      fileProgress.push({
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
      try {
        result = await downloadHuggingFaceFile(url, destination, reportProgress, request, file, signal);
      } catch (error) {
        const shouldUseXet = xetDownloader
          && error instanceof HuggingFaceDownloadStatusError
          && error.statusCode === 403
          && file.path.endsWith(".safetensors");
        if (!shouldUseXet) throw error;
        result = await downloadViaXet(xetDownloader, profile, file, destination, reportProgress, signal);
      }
      fileProgress.flush();
    } finally {
      // Nothing about this file is reported once it has finished or failed.
      fileProgress.close();
    }
    downloadedFiles += result.downloaded ? 1 : 0;
    manifestFiles.push({ path: file.path, sizeBytes: result.sizeBytes, sha256: result.sha256 });
  }
  throwIfDownloadCancelled(signal);
  // A leftover optional file from an older revision or a manual copy is not in
  // the new manifest and would demote the directory during final verification.
  for (const optionalPath of QWEN3_OPTIONAL_MODEL_FILES) {
    if (hubFiles.some((file) => file.path === optionalPath)) continue;
    await fs.rm(resolveDownloadDestination(modelDir, optionalPath), { force: true });
  }
  await writeManifest(modelDir, {
    schemaVersion: 1,
    repo: profile.repo,
    revision: profile.revision,
    files: manifestFiles,
  });
  const readiness = (await inspectQwen3ModelDir(modelDir, profile, signal)).readiness;
  if (readiness !== "verified") throw new Error("Downloaded Qwen3 model failed manifest verification.");
  return { modelRepo: profile.repo, revision: profile.revision, modelDir, downloadedFiles, skippedFiles, readiness };
}

export interface Qwen3ModelDownloadCoordinator {
  download: (
    profile: Qwen3Profile,
    modelDir: string,
    onProgress: (progress: Qwen3ModelDownloadProgress) => void,
    signal?: AbortSignal,
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
    download(profile, modelDir, onProgress, signal) {
      const key = `${profile.repo}@${profile.revision}:${path.resolve(modelDir)}`;
      const existing = inFlight.get(key);
      if (existing) {
        existing.listeners.add(onProgress);
        return existing.promise;
      }
      const listeners = new Set([onProgress]);
      const promise = download(profile, modelDir, (progress) => {
        for (const listener of listeners) listener(progress);
      }, undefined, undefined, signal).finally(() => inFlight.delete(key));
      inFlight.set(key, { promise, listeners });
      return promise;
    },
  };
}

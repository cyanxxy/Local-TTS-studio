/**
 * Integrity guard for the Chatterbox Turbo files Transformers.js downloads.
 *
 * Transformers.js resolves model files through `env.fetch` (network) and
 * `env.customCache` (persistent store). Guarding both means only bytes that
 * match a pinned manifest (src/workers/manifests/chatterbox.ts) ever reach
 * ONNX Runtime: every URL is rewritten to the pinned revision, files of the
 * repo that the manifest does not list are answered with 404 without touching
 * the network, and cached copies are re-verified on every load.
 */
import {
  pinHuggingFaceModelUrl,
  verifyPinnedAssetIntegrity,
  type PinnedAssetIntegrity,
} from "./pinnedModelFetch";

/** The four ONNX graphs the Chatterbox Turbo export is split into. */
export const CHATTERBOX_SESSIONS = ["embed_tokens", "speech_encoder", "language_model", "conditional_decoder"] as const;
export type ChatterboxSession = (typeof CHATTERBOX_SESSIONS)[number];

/** Quantization variants the export ships, named as Transformers.js names them. */
export type ChatterboxSessionDtype = "q4" | "q4f16" | "fp16" | "q8" | "fp32";

// Transformers.js's file suffix per dtype: q8 is the `_quantized` int8 export.
const DTYPE_SUFFIX: Readonly<Record<ChatterboxSessionDtype, string>> = {
  q4: "_q4",
  q4f16: "_q4f16",
  fp16: "_fp16",
  q8: "_quantized",
  fp32: "",
};

/** The variant each graph loads. Variants are chosen per graph because backends lack different kernels. */
export type ChatterboxDtype = Readonly<Record<ChatterboxSession, ChatterboxSessionDtype>>;

export interface ChatterboxAssetCache {
  match(request: string | URL | Request): Promise<Response | undefined>;
  put(request: string | URL | Request, response: Response): Promise<void>;
  delete?(request: string | URL | Request): Promise<boolean>;
}

export interface ChatterboxAssetGuardOptions {
  modelId: string;
  revision: string;
  /** Repo-relative path -> exact size and digest. Anything else is refused. */
  files: Readonly<Record<string, PinnedAssetIntegrity>>;
  baseFetch: typeof fetch;
  /** Persistent store shared with Transformers.js, or null when none exists. */
  cache: ChatterboxAssetCache | null;
  /** Bytes received (or read back from the cache) for one pinned file. */
  onProgress?(file: string, loadedBytes: number): void;
  /** A pinned file failed to download or verify. */
  onError?(file: string, error: unknown): void;
}

export interface ChatterboxAssetGuard {
  /** Install as Transformers.js `env.fetch`. */
  fetch: typeof fetch;
  /** Install as Transformers.js `env.customCache`. */
  cache: ChatterboxAssetCache;
}

const ONNX_DIRECTORY = "onnx/";

/** Repo path of a graph's `.onnx` file; its weights are `${path}_data`. */
export function chatterboxGraphPath(session: ChatterboxSession, dtype: ChatterboxSessionDtype): string {
  return `${ONNX_DIRECTORY}${session}${DTYPE_SUFFIX[dtype]}.onnx`;
}

/** The manifest entries one dtype plan loads: every non-ONNX file plus the chosen graphs and weights. */
export function selectChatterboxAssetFiles(
  files: Readonly<Record<string, PinnedAssetIntegrity>>,
  dtype: ChatterboxDtype,
): Record<string, PinnedAssetIntegrity> {
  const graphs = new Set(CHATTERBOX_SESSIONS.flatMap((session) => {
    const graph = chatterboxGraphPath(session, dtype[session]);
    return [graph, `${graph}_data`];
  }));
  return Object.fromEntries(Object.entries(files).filter(([file]) => (
    !file.startsWith(ONNX_DIRECTORY) || graphs.has(file)
  )));
}

export function buildChatterboxAssetUrl(modelId: string, revision: string, file: string): string {
  return `https://huggingface.co/${modelId}/resolve/${revision}/${file}`;
}

function toUrl(request: string | URL | Request): string {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.toString();
  return request.url;
}

/** The repo-relative file a Hugging Face resolve URL points at, or null for any other URL. */
export function resolveChatterboxAssetPath(
  url: string,
  modelId: string,
): { revision: string; file: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "huggingface.co" && host !== "hf.co")) return null;

  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const prefix = `/${modelId}/resolve/`;
  if (!path.startsWith(prefix)) return null;
  const remainder = path.slice(prefix.length);
  const slash = remainder.indexOf("/");
  if (slash <= 0 || slash === remainder.length - 1) return null;
  return { revision: remainder.slice(0, slash), file: remainder.slice(slash + 1) };
}

/**
 * Reads a body into exactly the pinned number of bytes. The pinned size is
 * authoritative: Content-Length can be missing or count encoded bytes, and an
 * oversized body is cancelled rather than buffered.
 */
async function readPinnedBody(
  response: Response,
  file: string,
  expected: PinnedAssetIntegrity,
  onProgress?: (loadedBytes: number) => void,
): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== expected.byteLength) {
      throw new Error(`Chatterbox Turbo ${file} did not match its pinned size.`);
    }
    onProgress?.(buffer.byteLength);
    return buffer;
  }

  const bytes = new Uint8Array(expected.byteLength);
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > bytes.byteLength) {
        throw new Error(`Chatterbox Turbo ${file} exceeded its pinned size.`);
      }
      bytes.set(value, received);
      received += value.byteLength;
      onProgress?.(received);
    }
  } catch (error) {
    // Stop the download instead of draining a body that is already rejected.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (received !== bytes.byteLength) {
    throw new Error(`Chatterbox Turbo ${file} was truncated at ${received} of ${bytes.byteLength} bytes.`);
  }
  return bytes.buffer;
}

function verifiedResponse(buffer: ArrayBuffer, contentType: string | null): Response {
  return new Response(buffer, {
    status: 200,
    headers: {
      "content-type": contentType ?? "application/octet-stream",
      "content-length": String(buffer.byteLength),
    },
  });
}

/**
 * Downloads one pinned file and verifies its size and digest before anyone
 * sees the bytes. Redirects to the Hugging Face CDN are followed by fetch.
 */
export async function downloadVerifiedAsset(
  url: string,
  file: string,
  expected: PinnedAssetIntegrity,
  baseFetch: typeof fetch,
  onProgress?: (loadedBytes: number) => void,
): Promise<ArrayBuffer> {
  const response = await baseFetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to download ${file}: HTTP ${response.status}.`);
  const buffer = await readPinnedBody(response, file, expected, onProgress);
  if (!await verifyPinnedAssetIntegrity(buffer, expected)) {
    throw new Error(`Chatterbox Turbo ${file} failed integrity verification.`);
  }
  return buffer;
}

/** Reads a verified copy back from the cache; a corrupt entry is evicted. */
async function matchVerified(
  cache: ChatterboxAssetCache,
  url: string,
  expected: PinnedAssetIntegrity,
): Promise<Response | undefined> {
  const cached = await cache.match(url);
  if (!cached) return undefined;
  const buffer = await cached.arrayBuffer();
  if (!await verifyPinnedAssetIntegrity(buffer, expected)) {
    await cache.delete?.(url);
    return undefined;
  }
  return verifiedResponse(buffer, cached.headers.get("content-type"));
}

/** Cache-first load of a pinned file outside Transformers.js, such as the default voice clip. */
export async function loadVerifiedAsset(
  url: string,
  file: string,
  expected: PinnedAssetIntegrity,
  baseFetch: typeof fetch,
  cache: ChatterboxAssetCache | null,
  onProgress?: (loadedBytes: number) => void,
): Promise<ArrayBuffer> {
  const cached = cache ? await matchVerified(cache, url, expected) : undefined;
  if (cached) {
    const buffer = await cached.arrayBuffer();
    onProgress?.(buffer.byteLength);
    return buffer;
  }
  const buffer = await downloadVerifiedAsset(url, file, expected, baseFetch, onProgress);
  await cache?.put(url, verifiedResponse(buffer, null)).catch(() => undefined);
  return buffer;
}

function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Builds the `env.fetch` / `env.customCache` pair for one load. Downloads and
 * cache reads are serialized, so at most one large file is buffered for
 * hashing at a time even though Transformers.js requests them together.
 */
export function createChatterboxAssetGuard({
  modelId,
  revision,
  files,
  baseFetch,
  cache,
  onProgress,
  onError,
}: ChatterboxAssetGuardOptions): ChatterboxAssetGuard {
  const serial = createSerialQueue();
  // Transformers.js also probes local-path cache keys such as
  // "/models/<repo>/<file>"; those can never hold verified bytes.
  const isLocalRepoKey = (request: string | URL | Request) => toUrl(request).includes(`/${modelId}/`);
  const lookup = (request: string | URL | Request) => {
    const asset = resolveChatterboxAssetPath(pinHuggingFaceModelUrl(toUrl(request), modelId, revision), modelId);
    if (!asset) return null;
    const expected = Object.hasOwn(files, asset.file) ? files[asset.file] : undefined;
    return { file: asset.file, expected, url: buildChatterboxAssetUrl(modelId, revision, asset.file) };
  };
  const reportErrors = async <T>(file: string, task: () => Promise<T>): Promise<T> => {
    try {
      return await task();
    } catch (error) {
      onError?.(file, error);
      throw error;
    }
  };

  const guardedFetch: typeof fetch = async (input, init) => {
    const asset = lookup(input);
    if (!asset) return baseFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!asset.expected || method !== "GET") {
      return new Response(null, { status: 404, statusText: "Not part of the pinned Chatterbox Turbo manifest" });
    }
    const { file, expected, url } = asset;
    return serial(() => reportErrors(file, async () => {
      const buffer = await downloadVerifiedAsset(url, file, expected, baseFetch, (loaded) => onProgress?.(file, loaded));
      return verifiedResponse(buffer, null);
    }));
  };

  const guardedCache: ChatterboxAssetCache = {
    async match(request) {
      const asset = lookup(request);
      if (!asset) return isLocalRepoKey(request) ? undefined : cache?.match(request);
      if (!asset.expected || !cache) return undefined;
      const { file, expected, url } = asset;
      return serial(async () => {
        const verified = await matchVerified(cache, url, expected);
        if (verified) onProgress?.(file, expected.byteLength);
        return verified;
      });
    },
    async put(request, response) {
      if (!cache) return;
      const asset = lookup(request);
      if (asset ? !asset.expected : isLocalRepoKey(request)) return;
      await cache.put(asset?.url ?? request, response);
    },
    async delete(request) {
      return (await cache?.delete?.(request)) ?? false;
    },
  };

  return { fetch: guardedFetch, cache: guardedCache };
}

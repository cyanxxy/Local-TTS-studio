/**
 * The HTTPS reader every desktop model download goes through.
 *
 * It only speaks TLS to Hugging Face hosts, re-checks every redirect hop
 * against the same allow-list, and gives up on a connection that stays idle.
 * The caller's signal can abandon a request until its headers arrive; from
 * then on the response body is the caller's to consume or destroy.
 */

import type { IncomingMessage } from "http";
import { request as httpsRequest } from "https";

export type UrlRequest = (url: string, signal?: AbortSignal) => Promise<IncomingMessage>;

const REQUEST_IDLE_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 8;
/** Model listings are a few hundred KiB; a response this large is not metadata. */
const MAX_JSON_RESPONSE_BYTES = 25_000_000;

export function isAllowedHuggingFaceDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "huggingface.co"
    || host === "hf.co"
    || host.endsWith(".huggingface.co")
    || host.endsWith(".hf.co");
}

/**
 * Generic on purpose: every download path maps an abort to its own model's
 * cancellation message, whichever layer happened to notice it first.
 */
function requestCancelledError(): Error {
  return new Error("Hugging Face request cancelled.");
}

export function requestUrl(url: string, signal?: AbortSignal, redirectCount = 0): Promise<IncomingMessage> {
  if (redirectCount > MAX_REDIRECTS) return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(requestCancelledError());
      return;
    }
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
      signal?.removeEventListener("abort", abortRequest);
      const location = response.headers.location;
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        void requestUrl(new URL(location, url).toString(), signal, redirectCount + 1).then(resolve, reject);
        return;
      }
      resolve(response);
    });
    const abortRequest = () => request.destroy(requestCancelledError());
    signal?.addEventListener("abort", abortRequest, { once: true });
    request.on("timeout", () => request.destroy(new Error(`Timed out connecting to ${url}`)));
    request.on("error", (error) => {
      signal?.removeEventListener("abort", abortRequest);
      reject(error);
    });
    // Abort can happen after the initial guard but before listener
    // registration. Re-check only after the listener is installed so either
    // this branch or the event always destroys the request.
    if (signal?.aborted) {
      abortRequest();
      return;
    }
    request.end();
  });
}

export interface HubReadOptions {
  request: UrlRequest;
  signal?: AbortSignal;
  /** The model's own cancellation error, used for an abort at any stage. */
  cancelledError: () => Error;
}

/** Fetches and parses a Hub API JSON document, bounded in size. */
export async function readHubJson(
  url: string,
  { request, signal, cancelledError }: HubReadOptions,
): Promise<unknown> {
  const throwIfCancelled = () => {
    if (signal?.aborted) throw cancelledError();
  };
  throwIfCancelled();
  let response: IncomingMessage;
  try {
    response = await request(url, signal);
  } catch (error) {
    throwIfCancelled();
    throw error;
  }
  if (signal?.aborted) {
    response.destroy();
    throw cancelledError();
  }
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    throw new Error(`Hugging Face request failed with status ${response.statusCode ?? "unknown"}.`);
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const abortResponse = () => response.destroy(cancelledError());
  signal?.addEventListener("abort", abortResponse, { once: true });
  try {
    for await (const chunk of response) {
      throwIfCancelled();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_JSON_RESPONSE_BYTES) throw new Error("Hugging Face model metadata response was too large.");
      chunks.push(buffer);
    }
  } finally {
    signal?.removeEventListener("abort", abortResponse);
  }
  throwIfCancelled();
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

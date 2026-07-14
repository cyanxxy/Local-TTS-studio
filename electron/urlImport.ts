import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

export const MAX_URL_IMPORT_BYTES = 10 * 1024 * 1024;
export const URL_IMPORT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export interface UrlImportResult {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  html: string;
}

export interface SafeImportTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface PinnedFetchResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export type PinnedFetcher = (target: SafeImportTarget, signal: AbortSignal) => Promise<PinnedFetchResponse>;
type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupAll = (hostname) => lookup(hostname, { all: true, verbatim: true });

const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv6");
}

function isBlockedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  // Node's BlockList also maps IPv4-mapped IPv6 addresses through its IPv4 rules.
  return blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

async function resolveSafeImportTarget(rawUrl: string, resolveHost: LookupAll): Promise<SafeImportTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a complete http:// or https:// URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs can be imported.");
  }
  if (url.username || url.password) throw new Error("URLs containing credentials cannot be imported.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local-network URLs cannot be imported.");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedIp(hostname)) throw new Error("Local-network URLs cannot be imported.");
    return { url, address: hostname, family: literalFamily };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new Error(`Could not resolve ${hostname}.`);
  }
  const normalized = addresses
    .map((entry) => ({ address: entry.address, family: isIP(entry.address) }))
    .filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6);
  if (normalized.length === 0 || normalized.length !== addresses.length || normalized.some((entry) => isBlockedIp(entry.address))) {
    throw new Error("Local-network URLs cannot be imported.");
  }
  return { url, ...normalized[0] };
}

export async function assertSafeImportUrl(rawUrl: string, resolveHost: LookupAll = defaultLookup): Promise<URL> {
  return (await resolveSafeImportTarget(rawUrl, resolveHost)).url;
}

function responseHeaders(rawHeaders: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

const pinnedFetch: PinnedFetcher = (target, signal) => new Promise((resolve, reject) => {
  const hostname = target.url.hostname.replace(/^\[|\]$/g, "");
  const pinnedLookup: LookupFunction = (_requestedHostname, _options, callback) => {
    callback(null, target.address, target.family);
  };
  const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)({
    protocol: target.url.protocol,
    hostname,
    port: target.url.port || undefined,
    path: `${target.url.pathname}${target.url.search}`,
    method: "GET",
    signal,
    lookup: pinnedLookup,
    servername: target.url.protocol === "https:" && isIP(hostname) === 0 ? hostname : undefined,
    headers: {
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
      "Accept-Encoding": "identity",
    },
  }, (response) => {
    const headers = responseHeaders(response.headers);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      response.resume();
      resolve({ status, headers, body: new Uint8Array() });
      return;
    }

    const declaredLength = Number(headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_URL_IMPORT_BYTES) {
      response.destroy();
      reject(new Error("The page is too large to import (10 MB limit)."));
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    response.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > MAX_URL_IMPORT_BYTES) {
        response.destroy(new Error("The page is too large to import (10 MB limit)."));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve({ status, headers, body: new Uint8Array(Buffer.concat(chunks)) }));
    response.on("error", reject);
  });
  request.on("error", reject);
  request.end();
});

export async function importRemoteDocument(
  rawUrl: string,
  fetcher: PinnedFetcher = pinnedFetch,
  resolveHost: LookupAll = defaultLookup,
): Promise<UrlImportResult> {
  const requested = await resolveSafeImportTarget(rawUrl, resolveHost);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_IMPORT_TIMEOUT_MS);

  try {
    let current = requested;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await fetcher(current, controller.signal);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("The page redirected without a destination.");
        if (redirectCount === MAX_REDIRECTS) throw new Error("The page redirected too many times.");
        current = await resolveSafeImportTarget(new URL(location, current.url).toString(), resolveHost);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`The page returned HTTP ${response.status}.`);
      }
      const contentType = response.headers.get("content-type") ?? "text/html";
      if (!/^(text\/(html|plain)|application\/xhtml\+xml)/i.test(contentType)) {
        throw new Error(`Unsupported URL content type: ${contentType.split(";")[0]}.`);
      }
      if (response.body.byteLength > MAX_URL_IMPORT_BYTES) {
        throw new Error("The page is too large to import (10 MB limit).");
      }
      return {
        requestedUrl: requested.url.toString(),
        finalUrl: current.url.toString(),
        contentType,
        html: new TextDecoder().decode(response.body),
      };
    }
    throw new Error("The page redirected too many times.");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The URL import timed out after 30 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

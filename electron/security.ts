export const DEV_SERVER_URL = "http://localhost:5173";
const DEV_SERVER_WS_URL = DEV_SERVER_URL.replace(/^http/i, "ws");

const APP_PROTOCOL = "app:";
const APP_HOST = "-";
const HUGGING_FACE_CONNECT_SOURCES = [
  "https://huggingface.co",
  "https://cdn-lfs.huggingface.co",
  "https://cdn-lfs-us-1.hf.co",
  "https://cdn-lfs-eu-1.hf.co",
  "https://cas-bridge.xethub.hf.co",
  "https://hf.co",
];
const SAFE_EXTERNAL_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "huggingface.co",
  "www.huggingface.co",
  "hf.co",
]);

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export function isAllowedAppUrl(
  rawUrl: string,
  options: { allowDevServer?: boolean } = { allowDevServer: true },
): boolean {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return false;

  if (parsed.protocol === APP_PROTOCOL && parsed.host === APP_HOST) {
    return true;
  }

  return options.allowDevServer === true && parsed.origin === DEV_SERVER_URL;
}

export function isSafeExternalUrl(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return false;

  return parsed.protocol === "https:" && SAFE_EXTERNAL_HOSTS.has(parsed.hostname);
}

export function buildContentSecurityPolicy(isDev: boolean): string {
  const scriptSources = ["'self'", "'wasm-unsafe-eval'"];
  const connectSources = ["'self'", ...HUGGING_FACE_CONNECT_SOURCES];
  // Production renders only local (app://) and data:/blob: images, so the open
  // `https:` token would just be a CSP-bypassing exfiltration channel (an
  // injected <img src> beacons data via the URL, unconstrained by connect-src).
  // Keep the wildcard for dev tooling only.
  const imgSources = ["'self'", "data:", "blob:"];

  if (isDev) {
    scriptSources.push("'unsafe-eval'", "'unsafe-inline'", DEV_SERVER_URL);
    connectSources.push("https:", DEV_SERVER_URL, DEV_SERVER_WS_URL);
    imgSources.push("https:");
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSources.join(" ")}`,
    "font-src 'self' data:",
    "media-src 'self' blob: data:",
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function shouldGrantPermission(): boolean {
  return false;
}

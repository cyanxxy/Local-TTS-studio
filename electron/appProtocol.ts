import path from "path";

export const ELECTRON_APP_SCHEME = "app";
const ELECTRON_APP_HOST = "-";
const INDEX_FILENAME = "index.html";

const STATIC_FILE_EXTENSIONS = new Set([
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".otf",
  ".png",
  ".svg",
  ".txt",
  ".ttf",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
]);

export function getElectronAppUrl(routePath: string = "/studio"): string {
  const normalizedRoute = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${ELECTRON_APP_SCHEME}://${ELECTRON_APP_HOST}${normalizedRoute}`;
}

function sanitizeRequestPath(requestPath: string): string {
  const decoded = decodeURIComponent(requestPath || "/");
  const normalized = path.posix.normalize(decoded.replace(/\\/g, "/"));
  if (normalized === "." || normalized === "") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function isStaticFileRequest(requestPath: string): boolean {
  return STATIC_FILE_EXTENSIONS.has(path.posix.extname(requestPath).toLowerCase());
}

export function resolveElectronAppPath(distDir: string, requestUrl: string): string {
  const requestPath = sanitizeRequestPath(new URL(requestUrl).pathname);
  const distRoot = path.resolve(distDir);

  if (!isStaticFileRequest(requestPath)) {
    return path.join(distRoot, INDEX_FILENAME);
  }

  const relativePath = requestPath.replace(/^\/+/, "");
  const resolvedPath = path.resolve(distRoot, relativePath);
  if (resolvedPath !== distRoot && !resolvedPath.startsWith(`${distRoot}${path.sep}`)) {
    return path.join(distRoot, INDEX_FILENAME);
  }

  return resolvedPath;
}

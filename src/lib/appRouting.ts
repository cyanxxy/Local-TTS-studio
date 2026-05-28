export type AppPage = "studio" | "reader" | "neutts" | "kani" | "qwen3";

export const PAGE_TABS: Array<{ key: AppPage; label: string }> = [
  { key: "studio", label: "Studio" },
  { key: "reader", label: "Reader" },
  { key: "neutts", label: "NeuTTS Nano" },
  { key: "kani", label: "Kani-TTS-2" },
  { key: "qwen3", label: "Qwen3-TTS" },
];

export const PAGE_PATH: Record<AppPage, string> = {
  studio: "/studio",
  reader: "/reader",
  neutts: "/neutts",
  kani: "/kani",
  qwen3: "/qwen3",
};

function normalizePathname(pathname: string): string {
  return pathname.toLowerCase().replace(/\/+$/, "") || "/";
}

export function normalizeRouteBasePath(routeBasePath = ""): string {
  const normalized = normalizePathname(routeBasePath);
  return normalized === "/" ? "" : normalized;
}

export function stripRouteBasePath(pathname: string, routeBasePath = ""): string {
  const normalized = normalizePathname(pathname);
  const normalizedBase = normalizeRouteBasePath(routeBasePath);

  if (!normalizedBase) return normalized;
  if (normalized === normalizedBase) return "/";
  if (normalized.startsWith(`${normalizedBase}/`)) {
    return normalized.slice(normalizedBase.length) || "/";
  }

  return "/";
}

export function getPagePath(page: AppPage, routeBasePath = ""): string {
  return `${normalizeRouteBasePath(routeBasePath)}${PAGE_PATH[page]}`;
}

export function getPageFromPath(pathname: string, showDesktopTabs: boolean, routeBasePath = ""): AppPage {
  const normalized = stripRouteBasePath(pathname, routeBasePath);
  if (normalized === "/reader") return "reader";
  if (normalized === "/studio") return "studio";
  if (showDesktopTabs && normalized === "/neutts") return "neutts";
  if (showDesktopTabs && normalized === "/kani") return "kani";
  if (showDesktopTabs && normalized === "/qwen3") return "qwen3";
  return "studio";
}

export function getCanonicalPagePath(pathname: string, showDesktopTabs: boolean, routeBasePath = ""): string {
  const normalized = stripRouteBasePath(pathname, routeBasePath);
  if (normalized === "/" || normalized === "") {
    return getPagePath("studio", routeBasePath);
  }

  return getPagePath(getPageFromPath(pathname, showDesktopTabs, routeBasePath), routeBasePath);
}

export function getInitialPage(showDesktopTabs: boolean, routeBasePath = ""): AppPage {
  if (typeof window === "undefined") return "studio";
  return getPageFromPath(window.location.pathname, showDesktopTabs, routeBasePath);
}

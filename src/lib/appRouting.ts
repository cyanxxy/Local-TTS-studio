import { ENGINES, SETUP_PAGE_ENGINE_IDS, type SetupPageEngineId } from "../models/registry";

/** Studio, the Reader, the desktop Voice Library, and one desktop page per engine that has a setup page. */
export type AppPage = "studio" | "reader" | "voices" | SetupPageEngineId;

export const PAGE_TABS: Array<{ key: AppPage; label: string }> = [
  { key: "studio", label: "Studio" },
  { key: "reader", label: "Reader" },
  { key: "voices", label: "Voices" },
  ...SETUP_PAGE_ENGINE_IDS.map((id) => ({ key: id, label: ENGINES[id].setupPage.tabLabel })),
];

/** Every page lives at `/<page>`, under the entry's base path. */
export const PAGE_PATH = Object.fromEntries(
  PAGE_TABS.map(({ key }) => [key, `/${key}`]),
) as Record<AppPage, string>;

export function isSetupPage(page: AppPage): page is SetupPageEngineId {
  return (SETUP_PAGE_ENGINE_IDS as readonly AppPage[]).includes(page);
}

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
  if (normalized === PAGE_PATH.reader) return "reader";
  if (normalized === PAGE_PATH.studio) return "studio";
  if (showDesktopTabs && normalized === PAGE_PATH.voices) return "voices";
  const setupPage = showDesktopTabs
    ? SETUP_PAGE_ENGINE_IDS.find((id) => PAGE_PATH[id] === normalized)
    : undefined;
  return setupPage ?? "studio";
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

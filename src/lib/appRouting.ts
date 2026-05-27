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

export function getPageFromPath(pathname: string, showDesktopTabs: boolean): AppPage {
  const normalized = normalizePathname(pathname);
  if (normalized === "/reader") return "reader";
  if (normalized === "/studio") return "studio";
  if (showDesktopTabs && normalized === "/neutts") return "neutts";
  if (showDesktopTabs && normalized === "/kani") return "kani";
  if (showDesktopTabs && normalized === "/qwen3") return "qwen3";
  return "studio";
}

export function getCanonicalPagePath(pathname: string, showDesktopTabs: boolean): string {
  const normalized = normalizePathname(pathname);
  if (normalized === "/" || normalized === "") {
    return PAGE_PATH.studio;
  }

  return PAGE_PATH[getPageFromPath(normalized, showDesktopTabs)];
}

export function getInitialPage(showDesktopTabs: boolean): AppPage {
  if (typeof window === "undefined") return "studio";
  return getPageFromPath(window.location.pathname, showDesktopTabs);
}

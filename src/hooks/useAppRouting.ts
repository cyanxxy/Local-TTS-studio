import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getCanonicalPagePath,
  getInitialPage,
  getPagePath,
  getPageFromPath,
  PAGE_TABS,
  type AppPage,
} from "../lib/appRouting";

interface UseAppRoutingReturn {
  activePage: AppPage;
  availableTabs: Array<{ key: AppPage; label: string }>;
  isReaderPage: boolean;
  isStudioPage: boolean;
  navigateToPage: (page: AppPage) => void;
}

export function useAppRouting(showDesktopTabs: boolean, routeBasePath = ""): UseAppRoutingReturn {
  const availableTabs = useMemo(
    () => (showDesktopTabs ? PAGE_TABS : PAGE_TABS.filter((tab) => tab.key === "studio" || tab.key === "reader")),
    [showDesktopTabs],
  );
  const [activePage, setActivePage] = useState<AppPage>(() => getInitialPage(showDesktopTabs, routeBasePath));

  useEffect(() => {
    const syncFromPath = () => {
      const nextPage = getPageFromPath(window.location.pathname, showDesktopTabs, routeBasePath);
      const canonicalPath = getCanonicalPagePath(window.location.pathname, showDesktopTabs, routeBasePath);
      const normalizedPath = window.location.pathname.toLowerCase().replace(/\/+$/, "") || "/";

      if (normalizedPath !== canonicalPath) {
        window.history.replaceState(
          null,
          "",
          `${canonicalPath}${window.location.search}${window.location.hash}`,
        );
      }

      setActivePage(nextPage);
    };

    syncFromPath();
    window.addEventListener("popstate", syncFromPath);
    return () => window.removeEventListener("popstate", syncFromPath);
  }, [routeBasePath, showDesktopTabs]);

  const navigateToPage = useCallback((page: AppPage) => {
    const nextPath = getCanonicalPagePath(getPagePath(page, routeBasePath), showDesktopTabs, routeBasePath);
    const nextPage = getPageFromPath(nextPath, showDesktopTabs, routeBasePath);
    const currentPath = window.location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    if (currentPath === nextPath) {
      setActivePage(nextPage);
      return;
    }
    window.history.pushState(null, "", `${nextPath}${window.location.search}${window.location.hash}`);
    setActivePage(nextPage);
  }, [routeBasePath, showDesktopTabs]);

  return {
    activePage,
    availableTabs,
    isReaderPage: activePage === "reader",
    isStudioPage: activePage === "studio",
    navigateToPage,
  };
}

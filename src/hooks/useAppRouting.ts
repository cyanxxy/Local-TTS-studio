import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/**
 * `onHistoryLeave` runs when the browser's Back or Forward is about to take the
 * app off `from`, before the new page renders. The app's own navigation goes
 * through its handler, which does the same work first; history navigation
 * arrives here instead, and the page being left still needs to save what it
 * holds while it is still on screen.
 */
export function useAppRouting(
  showDesktopTabs: boolean,
  routeBasePath = "",
  onHistoryLeave?: (from: AppPage, to: AppPage) => void,
): UseAppRoutingReturn {
  const availableTabs = useMemo(
    () => (showDesktopTabs ? PAGE_TABS : PAGE_TABS.filter((tab) => tab.key === "studio" || tab.key === "reader")),
    [showDesktopTabs],
  );
  const [activePage, setActivePage] = useState<AppPage>(() => getInitialPage(showDesktopTabs, routeBasePath));
  // Read by the popstate listener, which is attached once per route base.
  const activePageRef = useRef(activePage);
  const onHistoryLeaveRef = useRef(onHistoryLeave);
  useEffect(() => {
    activePageRef.current = activePage;
    onHistoryLeaveRef.current = onHistoryLeave;
  });

  useEffect(() => {
    const syncFromPath = (event?: PopStateEvent) => {
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

      const previousPage = activePageRef.current;
      if (event && nextPage !== previousPage) onHistoryLeaveRef.current?.(previousPage, nextPage);
      activePageRef.current = nextPage;
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
    activePageRef.current = nextPage;
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

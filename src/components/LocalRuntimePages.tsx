import { Suspense, useMemo } from "react";
import { ENGINES } from "../models/registry";
import { isSetupPage } from "../lib/appRouting";
import { lazyWithRetry } from "../shared/lazyWithRetry";
import { useSynthesisSession } from "../shared/synthesisSessionContext";
import { SurfaceErrorBoundary } from "./SurfaceErrorBoundary";

// Each per-model setup page is a large subtree most sessions never open.
const LocalRuntimePage = lazyWithRetry(() => import("./LocalRuntimePage")
  .then((module) => module.LocalRuntimePage));

/** The setup page of the desktop model the route names, mounted only while it is routed. */
export function LocalRuntimePages({ enableDesktopRuntimes }: { enableDesktopRuntimes: boolean }) {
  const { routing, studio } = useSynthesisSession();
  const { activePage } = routing;
  const mountedPages = useMemo(() => {
    if (!enableDesktopRuntimes || !isSetupPage(activePage)) return [];
    // Local runtime pages own model/audio buffers and an active native request.
    // Unmounting the inactive page releases those resources immediately instead
    // of retaining every runtime visited during the session.
    return [activePage];
  }, [activePage, enableDesktopRuntimes]);

  return mountedPages.map((page) => {
    const config = ENGINES[page].setupPage;
    const isActive = activePage === page;
    return (
      <section
        key={page}
        data-testid={`local-runtime-panel-${page}`}
        hidden={!isActive}
        aria-hidden={!isActive}
      >
        <SurfaceErrorBoundary name={`The ${config.name} page`} resetKeys={[activePage]}>
          <Suspense fallback={null}>
            <LocalRuntimePage
              active={isActive}
              model={page}
              name={config.name}
              releaseDate={config.releaseDate}
              params={config.params}
              highlights={config.highlights}
              links={config.links}
              initialText={studio.text}
            />
          </Suspense>
        </SurfaceErrorBoundary>
      </section>
    );
  });
}

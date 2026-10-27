import { Suspense, useMemo, useState } from "react";
import { Qwen3RuntimeProvider } from "../contexts/Qwen3RuntimeContext";
import { AppFooter } from "../components/AppFooter";
import { AppHeader } from "../components/AppHeader";
import { BrowserSupportPanel } from "../components/BrowserSupportPanel";
import { ErrorBanner } from "../components/ErrorBanner";
import { LocalRuntimePages } from "../components/LocalRuntimePages";
import { ReaderSurface } from "../components/ReaderSurface";
import { StudioSurface } from "../components/StudioSurface";
import { SurfaceErrorBoundary } from "../components/SurfaceErrorBoundary";
import { getEngine } from "../models/registry";
import { lazyWithRetry } from "./lazyWithRetry";
import { SynthesisSessionProvider } from "./SynthesisSessionProvider";
import { useSynthesisShell } from "./synthesisSessionContext";

interface SynthesisAppProps {
  enableDesktopRuntimes: boolean;
  routeBasePath?: string;
  createSupertonic3Worker?: () => Worker;
}

// The Voice Library page (cloning, design, previews) is a large subtree that
// only the desktop build routes to, so it loads on first visit.
const VoicesRoute = lazyWithRetry(() => import("../components/voices/VoicesRoute")
  .then((module) => module.VoicesRoute));

// The app settings dialog is only mounted once the user asks for it. It sits
// inside a SurfaceErrorBoundary, so a failed chunk costs only the dialog.
const AppSettingsDialog = lazyWithRetry(() => import("../components/AppSettingsDialog")
  .then((module) => module.AppSettingsDialog));

function SynthesisShell({ enableDesktopRuntimes }: { enableDesktopRuntimes: boolean }) {
  // The shell's own slice of the session, so the header and footer do not
  // re-render with every keystroke, model-state tick and streamed chunk.
  const { appSettings, chrome, environment, preferences, routing, studioDesktopModel } = useSynthesisShell();
  const { browserSupport, desktopRuntimesAvailable } = environment;
  const { activePage, isReaderPage, isStudioPage } = routing;
  const isVoicesPage = activePage === "voices";
  const localInferenceSupported = browserSupport.isSupported;
  // Reader focus layout: hides the app header and page tabs for reading.
  const [readerImmersive, setReaderImmersive] = useState(false);
  const browserSupportPanel = browserSupport.message
    ? <BrowserSupportPanel message={browserSupport.message} />
    : null;
  const onSurface = isStudioPage || isReaderPage;
  const { showWasmBadge, webgpuModeNote, showSingleThreadedNote } = chrome;
  const cpuMode = useMemo(
    () => (showWasmBadge ? { note: webgpuModeNote, singleThreaded: showSingleThreadedNote } : null),
    [showSingleThreadedNote, showWasmBadge, webgpuModeNote],
  );
  // The badges name the runtimes this build ships, not the one that happens
  // to be selected, so Audio8 is listed on the same terms as the browser
  // models wherever it exists.
  const runtimeBadges = useMemo(() => (
    isStudioPage && localInferenceSupported && !browserSupport.message
      ? [
          // Supertonic 3 is the desktop build's Supertonic, so the name stays on both.
          ...new Set(["Kokoro", "Supertonic", ...browserSupport.supportedModels.map((model) => getEngine(model).label)]),
          "WebGPU · CPU",
          ...(desktopRuntimesAvailable ? ["Audio8 · Native CPU"] : []),
        ]
      : null
  ), [browserSupport.message, browserSupport.supportedModels, desktopRuntimesAvailable, isStudioPage, localInferenceSupported]);

  return (
    <div className="min-h-screen font-sans text-text-primary">
      <div className={`app-page ${isReaderPage ? "w-full px-3 py-3 sm:px-4 sm:py-4 md:px-6 md:py-6" : "w-full px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-6 lg:py-10"}`}>

        <AppHeader
          immersive={isReaderPage && readerImmersive}
          compact={isReaderPage}
          subtitle={studioDesktopModel === "audio8"
            ? "Audio8 ONNX INT4 synthesis runs locally after its one-time model download."
            : "Text to speech, entirely on your device."}
          cpuMode={cpuMode}
          onOpenSettings={appSettings.onOpen}
          tabs={routing.tabs}
          activePage={activePage}
          routeBasePath={routing.routeBasePath}
          onNavigate={routing.navigate}
        />

        {onSurface && browserSupportPanel && (
          <div className="mb-4">{browserSupportPanel}</div>
        )}

        <ErrorBanner error={localInferenceSupported && onSurface ? chrome.visibleError : null} />

        {/* The page's own content; the header, notices and footer stay outside. */}
        <main>
          {/* Studio and Reader swap in place. Keying the wrapper on the page
              replays the fade; the animation is opacity-only so the Reader's
              fixed player dock keeps the viewport as its containing block. */}
          <div key={activePage} className="animate-page-swap">
            {isStudioPage ? (
              localInferenceSupported ? <StudioSurface /> : browserSupportPanel
            ) : isReaderPage ? (
              localInferenceSupported
                ? <ReaderSurface immersive={readerImmersive} onImmersiveChange={setReaderImmersive} />
                : browserSupportPanel
            ) : null}
          </div>

          {isVoicesPage && enableDesktopRuntimes && (
            <SurfaceErrorBoundary name="The Voice Library" resetKeys={[activePage]}>
              <Suspense fallback={null}>
                <VoicesRoute />
              </Suspense>
            </SurfaceErrorBoundary>
          )}

          <LocalRuntimePages enableDesktopRuntimes={enableDesktopRuntimes} />
        </main>

        {!isReaderPage && (
          <AppFooter
            runtimeBadges={runtimeBadges}
            note={(isStudioPage ? chrome.activeModelSupportMessage ?? browserSupport.message : null)
              ?? "More local models as compatible runtimes land."}
          />
        )}

      </div>
      {appSettings.open && (
        <SurfaceErrorBoundary
          name="Settings"
          resetKeys={[]}
          onDismiss={appSettings.onClose}
          className="fixed inset-x-4 bottom-4 z-50 sm:left-auto sm:w-[420px]"
        >
          <Suspense fallback={null}>
            <AppSettingsDialog
              open={appSettings.open}
              desktopModelsAvailable={desktopRuntimesAvailable}
              preferences={preferences.value}
              onChange={preferences.update}
              onReset={preferences.reset}
              onClose={appSettings.onClose}
            />
          </Suspense>
        </SurfaceErrorBoundary>
      )}
    </div>
  );
}

export function SynthesisApp({ enableDesktopRuntimes, routeBasePath, createSupertonic3Worker }: SynthesisAppProps) {
  return (
    <Qwen3RuntimeProvider>
      <SynthesisSessionProvider
        enableDesktopRuntimes={enableDesktopRuntimes}
        routeBasePath={routeBasePath}
        createSupertonic3Worker={createSupertonic3Worker}
      >
        <SynthesisShell enableDesktopRuntimes={enableDesktopRuntimes} />
      </SynthesisSessionProvider>
    </Qwen3RuntimeProvider>
  );
}

export default SynthesisApp;

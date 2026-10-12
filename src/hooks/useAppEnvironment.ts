import { useEffect, useMemo, useState } from "react";
import { getLocalBrowserSupport, type LocalBrowserSupport } from "../lib/browserSupport";
import { getWebGPUStatus, type WebGPUStatus } from "../lib/webgpu";

export interface AppEnvironment {
  isElectronRuntime: boolean;
  /** The entry point opted into desktop runtimes and the preload bridge is live. */
  desktopRuntimesAvailable: boolean;
  /** `?profile=1` in a dev build: the model loader logs its timings. */
  debugProfiling: boolean;
  browserSupport: LocalBrowserSupport;
  /** WebGPU availability, or null until it has been probed (never probed without local inference). */
  webgpuStatus: WebGPUStatus | null;
}

/** What the app runs on: shell, desktop runtimes, browser support and WebGPU. */
export function useAppEnvironment(enableDesktopRuntimes: boolean): AppEnvironment {
  const isElectronRuntime = Boolean(window.electron?.isElectron);
  // Every desktop-only runtime needs both halves: the entry point that opts in
  // and a live preload bridge. Studio previously gated Audio8 on the bridge
  // alone, so the two surfaces could disagree about which models exist.
  const desktopRuntimesAvailable = enableDesktopRuntimes && isElectronRuntime;
  const debugProfiling = useMemo(
    () => typeof window !== "undefined"
      && import.meta.env.DEV
      && new URLSearchParams(window.location.search).get("profile") === "1",
    [],
  );
  const browserSupport = useMemo(
    () => getLocalBrowserSupport(typeof navigator === "undefined" ? undefined : navigator, isElectronRuntime),
    [isElectronRuntime],
  );
  const [webgpuStatus, setWebgpuStatus] = useState<WebGPUStatus | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const isMac = typeof navigator !== "undefined"
      && /Mac/i.test(navigator.platform || navigator.userAgent || "");
    root.classList.toggle("is-electron", isElectronRuntime);
    root.classList.toggle("is-mac", isMac);
  }, [isElectronRuntime]);

  const localInferenceSupported = browserSupport.isSupported;
  useEffect(() => {
    if (!localInferenceSupported) return;
    let cancelled = false;
    void getWebGPUStatus().then((status) => {
      if (!cancelled) setWebgpuStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [localInferenceSupported]);

  return useMemo(() => ({
    isElectronRuntime,
    desktopRuntimesAvailable,
    debugProfiling,
    browserSupport,
    webgpuStatus,
  }), [browserSupport, debugProfiling, desktopRuntimesAvailable, isElectronRuntime, webgpuStatus]);
}

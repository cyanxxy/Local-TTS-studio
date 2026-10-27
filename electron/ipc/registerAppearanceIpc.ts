import { nativeTheme } from "electron";
import { isRecord } from "../guards";
import type { TrustedIpc } from "./trusted";

const THEME_SOURCES = new Set(["system", "light", "dark"]);

/**
 * Lets the renderer hand its colour theme to the native side. The macOS
 * vibrancy material, native form controls and the window background follow
 * `nativeTheme`, not the page, so without this a Light app on a Dark Mac (or
 * the reverse) drew its text over the wrong material.
 */
export function registerAppearanceIpc(ipc: TrustedIpc): void {
  ipc.on("app:set-theme-source", (_event, request) => {
    if (!isRecord(request) || typeof request.source !== "string" || !THEME_SOURCES.has(request.source)) return;
    nativeTheme.themeSource = request.source as typeof nativeTheme.themeSource;
  });
}

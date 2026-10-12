import { useEffect, useEffectEvent } from "react";
import { isSetupPage, type AppPage } from "../lib/appRouting";
import { hasPrimaryShortcutModifier, isEditableShortcutTarget } from "../lib/appShortcuts";

/** Generate and Stop for the synthesis surface on screen. */
export interface ShortcutSurface {
  canGenerate: boolean;
  isGenerating: boolean;
  generate: () => void;
  stop: () => void;
}

interface UseAppShortcutsOptions {
  activePage: AppPage;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onNavigate: (page: AppPage) => void;
  /** Null on pages without a synthesis surface. */
  surface: ShortcutSurface | null;
  hasAudio: boolean;
  onTogglePlayback: () => void;
  onSkip: (seconds: number) => void;
}

/** The document-wide keyboard shortcuts listed in `APP_SHORTCUT_GROUPS`. */
export function useAppShortcuts(options: UseAppShortcutsOptions): void {
  // An effect event always sees the latest page, runtime and player state, so
  // the document listener below is attached once rather than on every render.
  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const { activePage, settingsOpen, surface, hasAudio } = options;
    const primaryModifier = hasPrimaryShortcutModifier(event);

    if (primaryModifier && event.key === ",") {
      event.preventDefault();
      options.onOpenSettings();
      return;
    }

    if (settingsOpen) return;

    if (primaryModifier && (event.key === "1" || event.key === "2")) {
      event.preventDefault();
      options.onNavigate(event.key === "1" ? "studio" : "reader");
      return;
    }

    if (primaryModifier && event.key === "Enter") {
      if (surface?.canGenerate && !surface.isGenerating) {
        event.preventDefault();
        surface.generate();
      }
      return;
    }

    if (primaryModifier && event.key === ".") {
      if (surface?.isGenerating) {
        event.preventDefault();
        surface.stop();
      }
      return;
    }

    if (isSetupPage(activePage) || isEditableShortcutTarget(event.target)) return;

    // A focused control keeps Space for itself: Space on Download should
    // download, not toggle playback behind the user's back.
    const onInteractiveControl = event.target instanceof Element
      && event.target.closest("button, a[href], [role='button'], [role='slider'], [role='menuitem']") !== null;
    if (!primaryModifier && !event.altKey && event.code === "Space" && hasAudio && !onInteractiveControl) {
      event.preventDefault();
      options.onTogglePlayback();
      return;
    }

    if (!primaryModifier && event.altKey && hasAudio) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        options.onSkip(-10);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        options.onSkip(10);
      }
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleShortcut(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
}

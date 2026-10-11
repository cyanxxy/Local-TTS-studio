import { useLayoutEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { getPagePath, type AppPage } from "../lib/appRouting";
import { isMacPlatform } from "../lib/appShortcuts";

export interface AppPageTab {
  key: AppPage;
  label: string;
}

interface PageTabsProps {
  tabs: readonly AppPageTab[];
  activePage: AppPage;
  routeBasePath: string;
  compact: boolean;
  onNavigate: (page: AppPage) => void;
}

/** Page navigation. One pill travels between the tabs instead of blinking out of one and into the next. */
export function PageTabs({ tabs, activePage, routeBasePath, compact, onNavigate }: PageTabsProps) {
  // Tab widths follow their labels and the row reflows between grid and inline
  // layouts, so the travelling pill is measured rather than computed from an
  // index. `animate` stays false until the first measurement lands, otherwise
  // the pill would slide in from the left edge on the very first paint.
  const navRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0, animate: false });

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const active = nav.querySelector<HTMLElement>("[data-page-tab][aria-current='page']");
      if (!active) return;
      setIndicator((previous) => {
        const left = active.offsetLeft;
        const width = active.offsetWidth;
        if (previous.left === left && previous.width === width) return previous;
        return { left, width, animate: previous.width > 0 };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    for (const tab of nav.querySelectorAll("[data-page-tab]")) observer.observe(tab);
    return () => observer.disconnect();
  }, [activePage, tabs, compact]);

  return (
    <nav
      ref={navRef}
      className={`${compact ? "mt-4" : "mt-6 lg:mt-8"} relative grid w-full grid-cols-2 gap-1 rounded-full glass p-1 sm:inline-flex sm:w-auto`}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-1 left-0 rounded-full bg-panel shadow-glass-sm ${
          indicator.animate
            ? "transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
            : ""
        } ${indicator.width > 0 ? "opacity-100" : "opacity-0"}`}
        style={{
          transform: `translateX(${indicator.left}px)`,
          width: indicator.width,
        }}
      />
      {tabs.map((tab) => (
        <a
          key={tab.key}
          href={getPagePath(tab.key, routeBasePath)}
          data-page-tab={tab.key}
          aria-current={activePage === tab.key ? "page" : undefined}
          onClick={(event) => {
            event.preventDefault();
            onNavigate(tab.key);
          }}
          className={`relative z-10 rounded-full px-5 py-2 text-center text-base font-semibold transition-colors duration-200 active:scale-[0.98] ${
            activePage === tab.key
              ? "text-text-primary"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

export interface CpuModeBadge {
  /** Why the app runs on the CPU, when the WebGPU probe gave a reason. */
  note: string | null;
  singleThreaded: boolean;
}

interface AppHeaderProps extends PageTabsProps {
  /** The Reader's focus layout, which hides the title and the tabs. */
  immersive: boolean;
  /** Shown under the title outside the compact (Reader) layout. */
  subtitle: string;
  cpuMode: CpuModeBadge | null;
  onOpenSettings: () => void;
}

export function AppHeader({
  immersive,
  subtitle,
  cpuMode,
  onOpenSettings,
  ...tabs
}: AppHeaderProps) {
  const { compact } = tabs;
  if (immersive) {
    // Kept as an empty header so the macOS title-bar strip still reserves
    // the traffic lights and stays draggable in the focus layout.
    return <header aria-hidden className="h-2" />;
  }

  return (
    <header className={compact ? "mb-4" : "mb-8 lg:mb-10"}>
      <div className={`flex flex-nowrap justify-between gap-2 sm:gap-4 ${compact ? "items-center" : "items-start"}`}>
        <div className="min-w-0 flex-1">
          <h1
            className={`${compact ? "text-3xl sm:text-4xl" : "text-[2.5rem] sm:text-6xl"} whitespace-nowrap font-display leading-none font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-text-primary to-accent/70`}
          >
            Open TTS
          </h1>
          {!compact && (
            <p className="mt-3 text-base font-medium tracking-wide text-text-secondary sm:text-lg">
              {subtitle}
            </p>
          )}
        </div>

        <div className="mt-1 flex shrink-0 items-start gap-2">
          {cpuMode && (
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-accent/25 bg-accent-light text-accent text-base font-semibold shadow-glass-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)] animate-pulse" />
                CPU mode
              </div>
              {cpuMode.note && (
                <p className="max-w-full text-left text-sm leading-4 text-text-muted sm:max-w-[240px] sm:text-right">
                  {cpuMode.note}
                </p>
              )}
              {cpuMode.singleThreaded && (
                <p className="max-w-full text-left text-sm leading-4 text-text-muted sm:max-w-[220px] sm:text-right">
                  Cross-origin isolation is off, so CPU mode runs single-threaded.
                </p>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Open app settings"
            title={`Settings (${isMacPlatform(window.electron?.platform ?? navigator.platform) ? "⌘," : "Ctrl+,"})`}
            className="glass-control no-drag flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:text-text-primary"
          >
            <Settings2 size={18} />
          </button>
        </div>
      </div>

      <PageTabs {...tabs} />
    </header>
  );
}

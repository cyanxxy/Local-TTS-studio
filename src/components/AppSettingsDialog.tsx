import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  Keyboard,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import type {
  AccentColor,
  AppPreferences,
  ColorTheme,
  InterfaceFont,
  InterfaceSize,
  ReadingFont,
} from "../lib/appPreferences";
import { APP_SHORTCUT_GROUPS } from "../lib/appShortcuts";

interface AppSettingsDialogProps {
  open: boolean;
  desktopModelsAvailable: boolean;
  preferences: AppPreferences;
  onChange: (patch: Partial<AppPreferences>) => void;
  onReset: () => void;
  onClose: () => void;
}

const THEMES: Array<{ value: ColorTheme; label: string; icon: typeof Monitor }> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const ACCENTS: Array<{ value: AccentColor; label: string; color: string }> = [
  { value: "blue", label: "Blue", color: "#0a84ff" },
  { value: "violet", label: "Violet", color: "#af52de" },
  { value: "teal", label: "Teal", color: "#00a6a6" },
  { value: "orange", label: "Orange", color: "#ff8a1f" },
];

const INTERFACE_SIZES: Array<{ value: InterfaceSize; label: string }> = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Default" },
  { value: "large", label: "Large" },
];

const INTERFACE_FONTS: Array<{ value: InterfaceFont; label: string; family: string }> = [
  { value: "inter", label: "Inter", family: '"Inter Variable", "Inter", system-ui, sans-serif' },
  { value: "system", label: "System", family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { value: "outfit", label: "Outfit", family: '"Outfit Variable", "Outfit", system-ui, sans-serif' },
];

const READING_FONTS: Array<{ value: ReadingFont; label: string; family: string }> = [
  { value: "literata", label: "Literata", family: '"Literata Variable", "Literata", Georgia, serif' },
  { value: "inter", label: "Inter", family: '"Inter Variable", "Inter", system-ui, sans-serif' },
  { value: "outfit", label: "Outfit", family: '"Outfit Variable", "Outfit", system-ui, sans-serif' },
  { value: "georgia", label: "Georgia", family: 'Georgia, "Times New Roman", serif' },
];

type SettingsSection = "appearance" | "shortcuts" | "models";

function ShortcutKeys({ keys, label }: { keys: readonly string[]; label: string }) {
  return (
    <span className="flex flex-wrap items-center justify-end gap-1" aria-label={label}>
      {keys.map((key) => (
        <kbd
          key={key}
          className="inline-flex min-h-7 min-w-7 items-center justify-center rounded-md border border-border-strong bg-panel/80 px-2 font-mono text-xs font-semibold text-text-secondary shadow-[0_1px_0_var(--color-border-strong)]"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function SettingsCheckbox({
  checked,
  title,
  description,
  onChange,
}: {
  checked: boolean;
  title: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="group flex cursor-pointer items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span className="relative mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="peer h-5 w-5 appearance-none rounded-md border border-border-strong bg-panel/70 shadow-xs transition-colors checked:border-accent checked:bg-accent"
        />
        <Check
          size={13}
          strokeWidth={3}
          className="pointer-events-none absolute text-white opacity-0 transition-opacity peer-checked:opacity-100"
        />
      </span>
      <span className="min-w-0">
        <span className="block text-base font-semibold text-text-primary">{title}</span>
        <span className="mt-0.5 block text-sm leading-5 text-text-muted">{description}</span>
      </span>
    </label>
  );
}

export function AppSettingsDialog({
  open,
  desktopModelsAvailable,
  preferences,
  onChange,
  onReset,
  onClose,
}: AppSettingsDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [section, setSection] = useState<SettingsSection>("appearance");

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => (
        element.getClientRects().length > 0
        && !element.hasAttribute("hidden")
        && element.getAttribute("aria-hidden") !== "true"
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="app-settings-overlay no-drag fixed inset-0 z-[100] flex items-center justify-center bg-black/25 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="glass-pop no-drag animate-scale-in flex max-h-[min(46rem,calc(100vh-2rem))] w-full max-w-3xl overflow-hidden rounded-[26px] outline-none"
      >
        <aside className="hidden w-48 shrink-0 border-r border-border/70 bg-surface/45 p-4 sm:block">
          <div className="mb-5 flex items-center gap-2 px-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-light text-accent">
              <Sparkles size={16} />
            </span>
            <h2 className="font-display text-xl font-semibold text-text-primary">Settings</h2>
          </div>
          <nav aria-label="Settings sections" className="space-y-1">
            <button
              type="button"
              onClick={() => setSection("appearance")}
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-base font-medium transition-colors ${section === "appearance" ? "bg-accent-light text-accent" : "text-text-secondary hover:bg-white/45"}`}
            >
              <Palette size={15} /> Appearance
            </button>
            <button
              type="button"
              onClick={() => setSection("shortcuts")}
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-base font-medium transition-colors ${section === "shortcuts" ? "bg-accent-light text-accent" : "text-text-secondary hover:bg-white/45"}`}
            >
              <Keyboard size={15} /> Shortcuts
            </button>
            {desktopModelsAvailable && (
              <button
                type="button"
                onClick={() => setSection("models")}
                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-base font-medium transition-colors ${section === "models" ? "bg-accent-light text-accent" : "text-text-secondary hover:bg-white/45"}`}
              >
                <Sparkles size={15} /> Optional models
              </button>
            )}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3 sm:px-6 sm:py-4">
            <h2 id={titleId} className="font-display text-2xl font-semibold text-text-primary">
              {section === "appearance" ? "Appearance" : section === "shortcuts" ? "Keyboard shortcuts" : "Optional models"}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="flex h-9 w-9 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-white/50 hover:text-text-primary"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex gap-1 overflow-x-auto border-b border-border/70 p-2 sm:hidden">
              <button
                type="button"
                onClick={() => setSection("appearance")}
                className={`min-w-fit flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${section === "appearance" ? "bg-accent-light text-accent" : "text-text-muted"}`}
              >
                Appearance
              </button>
            <button
              type="button"
              onClick={() => setSection("shortcuts")}
              className={`min-w-fit flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${section === "shortcuts" ? "bg-accent-light text-accent" : "text-text-muted"}`}
            >
              Shortcuts
            </button>
            {desktopModelsAvailable && (
              <button
                type="button"
                onClick={() => setSection("models")}
                className={`min-w-fit flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${section === "models" ? "bg-accent-light text-accent" : "text-text-muted"}`}
              >
                Optional models
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
            {section === "appearance" ? (
              <div className="space-y-7">
                <section aria-labelledby={`${titleId}-theme`}>
                  <h4 id={`${titleId}-theme`} className="text-xs font-semibold uppercase tracking-widest text-text-muted">Color theme</h4>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {THEMES.map(({ value, label, icon: Icon }) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={preferences.theme === value}
                        onClick={() => onChange({ theme: value })}
                        className={`flex min-h-20 flex-col items-center justify-center gap-2 rounded-2xl border text-base font-semibold transition-all ${preferences.theme === value ? "border-accent/40 bg-accent-light text-accent ring-1 ring-accent/15" : "border-border bg-panel/45 text-text-secondary hover:border-border-strong hover:bg-panel/70"}`}
                      >
                        <Icon size={19} />
                        {label}
                      </button>
                    ))}
                  </div>
                </section>

                <section aria-labelledby={`${titleId}-accent`}>
                  <h4 id={`${titleId}-accent`} className="text-xs font-semibold uppercase tracking-widest text-text-muted">Accent color</h4>
                  <div className="mt-3 flex flex-wrap gap-3">
                    {ACCENTS.map(({ value, label, color }) => (
                      <button
                        key={value}
                        type="button"
                        aria-label={`${label} accent`}
                        aria-pressed={preferences.accentColor === value}
                        onClick={() => onChange({ accentColor: value })}
                        className={`flex h-11 w-11 items-center justify-center rounded-full transition-transform hover:scale-105 ${preferences.accentColor === value ? "ring-2 ring-accent ring-offset-2 ring-offset-panel" : ""}`}
                        style={{ backgroundColor: color }}
                      >
                        {preferences.accentColor === value && <Check size={17} strokeWidth={3} className="text-white" />}
                      </button>
                    ))}
                  </div>
                </section>

                <section aria-labelledby={`${titleId}-size`}>
                  <h4 id={`${titleId}-size`} className="text-xs font-semibold uppercase tracking-widest text-text-muted">Interface size</h4>
                  <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-surface/70 p-1">
                    {INTERFACE_SIZES.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={preferences.interfaceSize === value}
                        onClick={() => onChange({ interfaceSize: value })}
                        className={`rounded-lg px-3 py-2 text-sm font-semibold transition-all ${preferences.interfaceSize === value ? "bg-panel text-text-primary shadow-glass-sm" : "text-text-muted hover:text-text-primary"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </section>

                <section aria-labelledby={`${titleId}-typography`}>
                  <h4 id={`${titleId}-typography`} className="text-xs font-semibold uppercase tracking-widest text-text-muted">Typography</h4>

                  <div className="mt-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <h5 className="text-base font-semibold text-text-primary">App font</h5>
                      <p className="text-sm text-text-muted">Menus and controls</p>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-surface/70 p-1">
                      {INTERFACE_FONTS.map(({ value, label, family }) => (
                        <button
                          key={value}
                          type="button"
                          aria-label={`App font ${label}`}
                          aria-pressed={preferences.interfaceFont === value}
                          onClick={() => onChange({ interfaceFont: value })}
                          className={`rounded-lg px-2 py-2.5 text-base transition-all ${preferences.interfaceFont === value ? "bg-panel text-text-primary shadow-glass-sm" : "text-text-muted hover:text-text-primary"}`}
                          style={{ fontFamily: family }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-5">
                    <div className="flex items-baseline justify-between gap-3">
                      <h5 className="text-base font-semibold text-text-primary">Reading font</h5>
                      <p className="text-sm text-text-muted">Reader documents</p>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {READING_FONTS.map(({ value, label, family }) => (
                        <button
                          key={value}
                          type="button"
                          aria-label={`Reading font ${label}`}
                          aria-pressed={preferences.readingFont === value}
                          onClick={() => onChange({ readingFont: value })}
                          className={`flex min-h-16 flex-col items-start justify-center rounded-xl border px-3 py-2 text-left transition-all ${preferences.readingFont === value ? "border-accent/40 bg-accent-light text-accent ring-1 ring-accent/15" : "border-border bg-panel/40 text-text-secondary hover:border-border-strong hover:bg-panel/65"}`}
                        >
                          <span className="text-sm font-semibold" style={{ fontFamily: family }}>{label}</span>
                          <span className="mt-1 truncate text-base" style={{ fontFamily: family }}>Read, learn, remember.</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>

                <section aria-labelledby={`${titleId}-effects`}>
                  <h4 id={`${titleId}-effects`} className="mb-3 text-xs font-semibold uppercase tracking-widest text-text-muted">Visual effects</h4>
                  <div className="divide-y divide-border/70">
                    <SettingsCheckbox
                      checked={preferences.reduceTransparency}
                      title="Reduce transparency"
                      description="Use more solid surfaces and remove background blur."
                      onChange={(checked) => onChange({ reduceTransparency: checked })}
                    />
                    <SettingsCheckbox
                      checked={preferences.reduceMotion}
                      title="Reduce motion"
                      description="Minimize interface animation and movement."
                      onChange={(checked) => onChange({ reduceMotion: checked })}
                    />
                  </div>
                </section>
              </div>
            ) : section === "shortcuts" ? (
              <div>
                <p className="max-w-xl text-sm leading-5 text-text-muted">
                  Shortcuts work while Open TTS is active. macOS uses Command and Option; Windows and Linux use Ctrl and Alt.
                </p>
                <div className="mt-5 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 border-b border-border/70 pb-2 text-2xs font-semibold uppercase tracking-widest text-text-muted sm:gap-x-5">
                  <span>Action</span>
                  <span className="w-[7.5rem] text-right">macOS</span>
                  <span className="w-[7.5rem] text-right">Windows</span>
                </div>
                <div className="divide-y divide-border/70">
                  {APP_SHORTCUT_GROUPS.map((group) => (
                    <section key={group.label} aria-labelledby={`${titleId}-shortcut-${group.label.toLowerCase()}`} className="py-4 first:pt-3">
                      <h4 id={`${titleId}-shortcut-${group.label.toLowerCase()}`} className="mb-2 text-xs font-semibold uppercase tracking-widest text-text-muted">
                        {group.label}
                      </h4>
                      <div className="space-y-1">
                        {group.shortcuts.map((shortcut) => (
                          <div key={shortcut.action} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 rounded-xl px-2 py-2 transition-colors hover:bg-surface/55 sm:gap-x-5">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-text-primary">{shortcut.action}</p>
                              <p className="mt-0.5 hidden text-xs leading-4 text-text-muted sm:block">{shortcut.description}</p>
                            </div>
                            <span className="w-[7.5rem]"><ShortcutKeys keys={shortcut.mac} label={`macOS: ${shortcut.mac.join(" + ")}`} /></span>
                            <span className="w-[7.5rem]"><ShortcutKeys keys={shortcut.windows} label={`Windows: ${shortcut.windows.join(" + ")}`} /></span>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            ) : (
              <section aria-labelledby={`${titleId}-models`}>
                <h4 id={`${titleId}-models`} className="text-xs font-semibold uppercase tracking-widest text-text-muted">Navigation and model access</h4>
                <p className="mt-2 max-w-lg text-sm leading-5 text-text-muted">
                  These local runtimes need additional model downloads. Keep them hidden until you want to set them up.
                </p>
                <div className="mt-5 divide-y divide-border/70">
                  <SettingsCheckbox
                    checked={preferences.showNeuTTS}
                    title="Show NeuTTS Nano"
                    description="Add the NeuTTS Nano setup page to the app navigation."
                    onChange={(checked) => onChange({ showNeuTTS: checked })}
                  />
                  <SettingsCheckbox
                    checked={preferences.showQwen3TTS}
                    title="Show Qwen3-TTS in navigation"
                    description="Qwen stays available in Studio and Reader even when its setup page is hidden here."
                    onChange={(checked) => onChange({ showQwen3TTS: checked })}
                  />
                </div>
              </section>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border/70 px-4 py-3 sm:px-6">
            <button
              type="button"
              onClick={onReset}
              className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-white/45 hover:text-text-primary"
            >
              <RotateCcw size={14} /> Reset defaults
            </button>
            <button type="button" onClick={onClose} className="glass-accent rounded-xl px-4 py-2 text-sm font-semibold text-white">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

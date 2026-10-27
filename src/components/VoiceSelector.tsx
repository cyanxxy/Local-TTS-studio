import { useState, useRef, useEffect, useId, useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import type { ModelState, ModelType } from "../types";
import { engineVoices } from "../models/registry";
import type { EngineVoice } from "../models/types";
import { ChatterboxVoiceControls } from "./ChatterboxVoiceControls";
import { PiperVoiceBrowser } from "./PiperVoiceBrowser";

/** Where the voice menu sits; fixed to the viewport so no scrolling ancestor clips it. */
interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const MENU_MAX_HEIGHT = 256;
const MENU_GAP = 6;
const MENU_EDGE = 8;

/** The menu's options, in order, for arrow-key movement. */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? [...menu.querySelectorAll<HTMLElement>("[role='menuitemradio']")] : [];
}

/** Places the menu under its trigger, or above it when the viewport has no room below. */
function placeMenu(trigger: DOMRect, naturalHeight: number): MenuPosition {
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const below = viewportHeight - trigger.bottom - MENU_GAP - MENU_EDGE;
  const above = trigger.top - MENU_GAP - MENU_EDGE;
  const wanted = Math.min(naturalHeight, MENU_MAX_HEIGHT);
  const openAbove = below < wanted && above > below;
  const maxHeight = Math.max(96, Math.min(MENU_MAX_HEIGHT, openAbove ? above : below));
  const height = Math.min(wanted, maxHeight);
  return {
    top: openAbove ? trigger.top - MENU_GAP - height : trigger.bottom + MENU_GAP,
    left: trigger.left,
    width: trigger.width,
    maxHeight,
  };
}

interface VoiceSelectorProps {
  activeModel: ModelType;
  voice: string;
  onVoiceChange: (voice: string) => void;
  /** Voices the loaded Kokoro model reported; other engines list their own. */
  kokoroVoices: string[];
  /** The active browser engine's load state; Piper reports its voice downloads through it. */
  modelState?: ModelState;
}

export function VoiceSelector({
  activeModel,
  voice,
  onVoiceChange,
  kokoroVoices,
  modelState,
}: VoiceSelectorProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  const menuId = useId();

  const voices = engineVoices(activeModel, { runtimeVoices: kokoroVoices });

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!openRef.current) return;
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // The menu portals to the body and is pinned to the trigger: inside the
  // Reader's voice popover (a scrolling container) an absolutely positioned
  // menu was clipped to the popover's edge.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const next = placeMenu(trigger.getBoundingClientRect(), menuRef.current?.scrollHeight ?? MENU_MAX_HEIGHT);
      setMenuPosition((current) => (
        current
        && current.top === next.top
        && current.left === next.left
        && current.width === next.width
        && current.maxHeight === next.maxHeight
          ? current
          : next
      ));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  // A menu button moves focus into its menu: to the chosen voice, or the
  // first one, so arrow keys work at once.
  useEffect(() => {
    if (!open) return;
    const items = menuItems(menuRef.current);
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }, [open]);

  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "Escape" || event.key === "Tab") {
      // Handled here, so a popover around the selector stays open: Escape
      // closes only the menu, the surface on top.
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  // Piper's twenty-odd voices need a browser of their own: grouped, filterable,
  // with sizes, licences and attribution.
  if (activeModel === "piper") {
    return <PiperVoiceBrowser voice={voice} onVoiceChange={onVoiceChange} modelState={modelState} />;
  }

  // Chatterbox clones a reference clip instead of choosing from a list.
  if (activeModel === "chatterbox") {
    return <ChatterboxVoiceControls voice={voice} onVoiceChange={onVoiceChange} />;
  }

  if (voices.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-text-secondary">Voice</span>
        {/* A model that failed to load will never list voices; say so rather
            than "Loading" forever. The error itself is shown with the model. */}
        {modelState?.error
          ? <span className="text-xs text-danger">Voices are unavailable because the model did not load.</span>
          : <span className="text-xs text-text-muted">Loading voices…</span>}
      </div>
    );
  }

  // A short, ungrouped catalogue reads best as buttons; a grouped one (Kokoro's
  // accents) gets a menu with a section per group.
  if (!voices.every((entry) => entry.group)) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-text-secondary">Voice</span>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {voices.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={voice === entry.id}
              onClick={() => onVoiceChange(entry.id)}
              className={`flex-1 py-2 px-3 text-sm rounded-xl border transition-all duration-200 ${
                voice === entry.id
                  ? "border-accent/40 bg-accent-light text-text-primary font-medium shadow-accent-sm"
                  : "border-border bg-text-primary/[0.03] text-text-muted hover:bg-text-primary/[0.07] hover:text-text-primary"
              }`}
            >
              {entry.label}
              {entry.detail && <span className="block text-2xs font-normal text-text-muted">{entry.detail}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const groups: Record<string, EngineVoice[]> = {};
  for (const entry of voices) {
    (groups[entry.group ?? "Other"] ??= []).push(entry);
  }
  const selectedLabel = voices.find((entry) => entry.id === voice)?.label ?? voice;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-text-secondary">Voice</span>

      <div ref={containerRef} className="relative">
        {/* Trigger */}
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
              event.preventDefault();
              setOpen(true);
            }
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm rounded-xl border border-border bg-text-primary/[0.04] text-text-primary transition-all duration-200 hover:bg-text-primary/[0.07] active:scale-[0.98]"
        >
          <span className="flex-1 text-left">{selectedLabel}</span>
          <ChevronDown
            size={14}
            className={`text-text-muted transition-transform duration-200 flex-shrink-0 ${open ? "rotate-180" : ""}`}
          />
        </button>

        {/* Dropdown */}
        {open && createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Select voice"
            data-voice-picker-menu
            onKeyDown={handleMenuKeyDown}
            className="fixed z-[200] glass-pop rounded-2xl overflow-hidden animate-scale-in"
            style={{
              top: menuPosition?.top ?? 0,
              left: menuPosition?.left ?? 0,
              width: menuPosition?.width ?? 0,
              visibility: menuPosition ? "visible" : "hidden",
            }}
          >
            <div className="overflow-y-auto" style={{ maxHeight: menuPosition?.maxHeight ?? MENU_MAX_HEIGHT }}>
              {Object.entries(groups).map(([groupLabel, groupVoices], i) => (
                <div key={groupLabel} role="group" aria-label={groupLabel}>
                  {i > 0 && <div role="separator" className="border-t border-border/60 mx-3" />}
                  <div aria-hidden="true" className="px-3 pt-2.5 pb-1 text-xs font-semibold text-text-secondary">
                    {groupLabel}
                  </div>
                  {groupVoices.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={entry.id === voice}
                      tabIndex={-1}
                      onClick={() => { onVoiceChange(entry.id); closeMenu(); }}
                      className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-[background-color,color,transform] duration-150 active:scale-[0.97] ${
                        entry.id === voice
                          ? "text-text-primary bg-accent-light font-medium"
                          : "text-text-secondary hover:bg-text-primary/[0.07] hover:text-text-primary"
                      }`}
                    >
                      {entry.label}
                      {entry.id === voice && <Check size={12} className="text-accent flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}

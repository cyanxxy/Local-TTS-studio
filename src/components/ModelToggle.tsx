import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import type { ModelType, ModelState } from "../types";
import { MODELS } from "../constants";

interface ModelToggleProps {
  activeModel: ModelType;
  onModelChange: (model: ModelType) => void;
  kokoroState: ModelState;
  supertonicState: ModelState;
  visibleModels?: readonly ModelType[];
  unavailableModels?: Partial<Record<ModelType, string>>;
  desktopModelOptions?: ModelToggleDesktopOption[];
}

export interface ModelToggleDesktopOption {
  key: string;
  label: string;
  badge?: string;
  detail?: string;
  selected?: boolean;
  onSelect: () => void;
}

interface ModelChoice {
  id: string;
  label: string;
  badge?: string;
  detail: string;
  selected: boolean;
  state?: ModelState;
  unavailableReason?: string;
  onSelect: () => void;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

const MODEL_PARAMS: Record<ModelType, string> = {
  kokoro: "82M",
  supertonic: "300M",
};
const DEFAULT_VISIBLE_MODELS: readonly ModelType[] = ["kokoro", "supertonic"];
const EMPTY_DESKTOP_MODEL_OPTIONS: ModelToggleDesktopOption[] = [];

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function statusText(state: ModelState): string {
  if (state.ready) return "Ready";
  if (state.error) return "Needs attention";
  if (state.loading) return state.downloadProgress > 0
    ? `${Math.round(state.downloadProgress)}% loaded`
    : "Loading";
  return "Preparing";
}

function StatusDot({ state, unavailable = false }: { state: ModelState; unavailable?: boolean }) {
  if (unavailable) {
    return <span data-status="unavailable" className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted/50" />;
  }
  if (state.ready) {
    return <span data-status="ready" className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" style={{ boxShadow: "0 0 6px color-mix(in srgb, var(--color-success) 60%, transparent)" }} />;
  }
  if (state.error) {
    return <span data-status="error" className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />;
  }
  return (
    <span data-status="loading" className="relative h-1.5 w-1.5 shrink-0">
      <span className="absolute inset-0 rounded-full bg-text-muted animate-ping-ring" />
      <span className="relative block h-1.5 w-1.5 rounded-full bg-text-muted" />
    </span>
  );
}

export function ModelToggle({
  activeModel,
  onModelChange,
  kokoroState,
  supertonicState,
  visibleModels = DEFAULT_VISIBLE_MODELS,
  unavailableModels,
  desktopModelOptions = EMPTY_DESKTOP_MODEL_OPTIONS,
}: ModelToggleProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const pickerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusOptionOnOpenRef = useRef(false);
  const hasSelectedDesktopModel = desktopModelOptions.some((option) => option.selected);

  const choices = useMemo<ModelChoice[]>(() => {
    const browserModels: Array<{ key: ModelType; label: string; state: ModelState }> = [
      { key: "kokoro", label: MODELS.kokoro.label, state: kokoroState },
      { key: "supertonic", label: MODELS.supertonic.label, state: supertonicState },
    ];
    return [
      ...browserModels
        .filter(({ key }) => visibleModels.includes(key))
        .map(({ key, label, state }) => ({
          id: key,
          label,
          detail: `${MODEL_PARAMS[key]} · ${statusText(state)}`,
          selected: !hasSelectedDesktopModel && activeModel === key,
          state,
          unavailableReason: unavailableModels?.[key],
          onSelect: () => onModelChange(key),
        })),
      ...desktopModelOptions.map((option) => ({
        id: `desktop-${option.key}`,
        label: option.label,
        badge: option.badge,
        detail: option.detail ?? "Local desktop model",
        selected: Boolean(option.selected),
        onSelect: option.onSelect,
      })),
    ];
  }, [activeModel, desktopModelOptions, hasSelectedDesktopModel, kokoroState, onModelChange, supertonicState, unavailableModels, visibleModels]);

  const selected = choices.find((choice) => choice.selected) ?? choices[0];

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const placeMenu = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportRight = viewportLeft + viewportWidth;
      const viewportBottom = viewportTop + viewportHeight;
      const edgePadding = 8;
      const gap = 8;
      const maximumMenuHeight = 352;
      const width = Math.min(trigger.width, Math.max(0, viewportWidth - edgePadding * 2));
      menu.style.width = `${width}px`;
      const naturalHeight = menu.scrollHeight;
      const spaceBelow = Math.max(0, viewportBottom - edgePadding - trigger.bottom - gap);
      const spaceAbove = Math.max(0, trigger.top - gap - viewportTop - edgePadding);
      const openAbove = spaceBelow < Math.min(naturalHeight, maximumMenuHeight) && spaceAbove > spaceBelow;
      const availableHeight = openAbove ? spaceAbove : spaceBelow;
      const maxHeight = Math.min(maximumMenuHeight, availableHeight);
      const renderedHeight = Math.min(naturalHeight, maxHeight);
      const left = Math.min(
        Math.max(trigger.left, viewportLeft + edgePadding),
        Math.max(viewportLeft + edgePadding, viewportRight - edgePadding - width),
      );
      const top = openAbove ? trigger.top - gap - renderedHeight : trigger.bottom + gap;

      setMenuPosition((current) => (
        current
        && current.left === left
        && current.top === top
        && current.width === width
        && current.maxHeight === maxHeight
          ? current
          : { left, top, width, maxHeight }
      ));
    };
    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    window.visualViewport?.addEventListener("resize", placeMenu);
    window.visualViewport?.addEventListener("scroll", placeMenu);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
      window.visualViewport?.removeEventListener("resize", placeMenu);
      window.visualViewport?.removeEventListener("scroll", placeMenu);
    };
  }, [choices, open]);

  const availableChoiceIndexes = choices
    .map((choice, choiceIndex) => ({ choice, choiceIndex }))
    .filter(({ choice }) => !choice.unavailableReason)
    .map(({ choiceIndex }) => choiceIndex);

  const focusRelativeChoice = (currentIndex: number, direction: -1 | 1) => {
    if (availableChoiceIndexes.length === 0) return;
    const currentPosition = availableChoiceIndexes.indexOf(currentIndex);
    const startPosition = currentPosition === -1 ? 0 : currentPosition;
    const nextPosition = (startPosition + direction + availableChoiceIndexes.length) % availableChoiceIndexes.length;
    optionRefs.current[availableChoiceIndexes[nextPosition]]?.focus();
  };

  const focusEdgeChoice = (edge: "first" | "last") => {
    const choiceIndex = edge === "first"
      ? availableChoiceIndexes[0]
      : availableChoiceIndexes.at(-1);
    if (choiceIndex !== undefined) optionRefs.current[choiceIndex]?.focus();
  };

  const closeAndMoveFocus = (backward: boolean) => {
    const trigger = triggerRef.current;
    if (!trigger) {
      setOpen(false);
      return;
    }
    const scope = trigger.closest<HTMLElement>("[role='dialog']") ?? document;
    const focusable = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      .filter((element) => !menuRef.current?.contains(element) && !element.closest("[hidden]"));
    const triggerIndex = focusable.indexOf(trigger);
    const target = triggerIndex === -1
      ? undefined
      : focusable[triggerIndex + (backward ? -1 : 1)];
    setOpen(false);
    window.requestAnimationFrame(() => target?.focus());
  };

  useLayoutEffect(() => {
    if (!open || !focusOptionOnOpenRef.current) return;
    const selectedIndex = choices.findIndex((choice) => choice.selected && !choice.unavailableReason);
    const targetIndex = selectedIndex === -1 ? availableChoiceIndexes[0] : selectedIndex;
    if (targetIndex !== undefined) optionRefs.current[targetIndex]?.focus();
    focusOptionOnOpenRef.current = false;
  }, [availableChoiceIndexes, choices, open]);

  const openAndFocusSelection = () => {
    focusOptionOnOpenRef.current = true;
    setOpen(true);
  };

  const choose = (choice: ModelChoice) => {
    if (choice.unavailableReason) return;
    if (!choice.selected) choice.onSelect();
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  if (!selected) return null;

  return (
    <div ref={rootRef} className="relative z-30 flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">
        Model
      </span>
      <button
        ref={triggerRef}
        type="button"
        data-testid="model-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${pickerId}-menu`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAndFocusSelection();
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "Tab" && open) {
            event.preventDefault();
            event.stopPropagation();
            closeAndMoveFocus(event.shiftKey);
          }
        }}
        className={`group flex min-h-[4.75rem] w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left backdrop-blur-md transition-all duration-200 ${
          open
            ? "border-accent/45 bg-accent/[0.09] shadow-accent-sm ring-2 ring-accent/10"
            : "border-white/60 bg-white/45 shadow-glass-sm hover:-translate-y-0.5 hover:border-accent/25 hover:bg-white/65"
        }`}
      >
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-base font-semibold text-text-primary">{selected.label}</span>
            {selected.badge && (
              <span className="shrink-0 rounded-full border border-accent/25 bg-accent-light px-2 py-0.5 font-mono text-2xs uppercase tracking-[0.14em] text-accent">
                {selected.badge}
              </span>
            )}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs font-medium text-text-muted">
            {selected.state && <StatusDot state={selected.state} unavailable={Boolean(selected.unavailableReason)} />}
            <span className="truncate">{selected.unavailableReason ?? selected.detail}</span>
          </span>
        </span>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/5 bg-white/50 text-text-muted transition-colors group-hover:text-accent">
          <ChevronDown aria-hidden="true" size={17} className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          id={`${pickerId}-menu`}
          role="menu"
          aria-label="Select model"
          data-model-picker-menu
          data-testid="model-picker-menu"
          className="glass-pop fixed z-[200] overflow-y-auto rounded-2xl border border-white/60 p-1.5 shadow-glass-lg animate-fade-up"
          style={{
            left: menuPosition?.left ?? 0,
            top: menuPosition?.top ?? 0,
            width: menuPosition?.width ?? 0,
            maxHeight: menuPosition?.maxHeight ?? 352,
            visibility: menuPosition ? "visible" : "hidden",
          }}
        >
          {choices.map((choice, index) => {
            const unavailable = Boolean(choice.unavailableReason);
            return (
              <button
                key={choice.id}
                ref={(element) => { optionRefs.current[index] = element; }}
                type="button"
                role="menuitemradio"
                aria-checked={choice.selected}
                disabled={unavailable}
                title={choice.unavailableReason}
                data-testid={`model-option-${choice.id}`}
                onClick={() => choose(choice)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusRelativeChoice(index, 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    focusRelativeChoice(index, -1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    focusEdgeChoice("first");
                  } else if (event.key === "End") {
                    event.preventDefault();
                    focusEdgeChoice("last");
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                    triggerRef.current?.focus();
                  } else if (event.key === "Tab") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeAndMoveFocus(event.shiftKey);
                  }
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                  unavailable
                    ? "cursor-not-allowed opacity-50"
                    : choice.selected
                    ? "bg-accent/[0.11]"
                    : "hover:bg-white/55"
                }`}
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                  choice.selected
                    ? "border-accent/30 bg-accent-light text-accent"
                    : "border-black/5 bg-white/45 text-transparent"
                }`}>
                  <Check aria-hidden="true" size={15} strokeWidth={2.5} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className={`truncate text-sm font-semibold ${choice.selected ? "text-accent" : "text-text-primary"}`}>
                      {choice.label}
                    </span>
                    {choice.badge && (
                      <span className="shrink-0 rounded-full border border-accent/20 bg-accent-light px-2 py-0.5 font-mono text-2xs uppercase tracking-[0.12em] text-accent">
                        {choice.badge}
                      </span>
                    )}
                    {unavailable && (
                      <span className="rounded-full border border-border px-2 py-0.5 text-2xs uppercase tracking-[0.12em] text-text-muted">
                        Unavailable
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
                    {choice.state && <StatusDot state={choice.state} unavailable={unavailable} />}
                    <span className="truncate">{choice.unavailableReason ?? choice.detail}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

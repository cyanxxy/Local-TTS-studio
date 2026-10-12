import { useId, useRef, type ReactNode } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { QUALITY_MAX, QUALITY_MIN, QUALITY_STEP } from "../../constants";
import type { ModelState, ModelType } from "../../types";
import { ModelToggle } from "../ModelToggle";
import { VoiceSelector } from "../VoiceSelector";
import { ViewportPopover } from "./ViewportPopover";
import { POPOVER_CLASS } from "./readerStyles";

export interface ReaderDesktopModelOption {
  key: string;
  label: string;
  badge: string;
  detail: string;
  selected?: boolean;
  onSelect: () => void;
}

interface ReaderVoiceMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Drives the status dot: ready, failed, or still loading. */
  modelState: Pick<ModelState, "ready" | "error">;
  voiceLabel: string;
  modelLabel: string;
  activeModel: ModelType;
  onModelChange: (model: ModelType) => void;
  desktopModelOptions: ReaderDesktopModelOption[];
  selectedDesktopModel: ReaderDesktopModelOption | undefined;
  desktopModelSettings?: ReactNode;
  kokoroState: ModelState;
  supertonicState: ModelState;
  /** The load state of the other browser engines (Kitten, Paradee, Piper). */
  modelStates?: Partial<Record<ModelType, ModelState>>;
  /** The selected browser engine's load state, for voice downloads. */
  browserModelState?: ModelState;
  visibleModels?: readonly ModelType[];
  unavailableModels?: Partial<Record<ModelType, string>>;
  kokoroVoices: string[];
  voice: string;
  onVoiceChange: (voice: string) => void;
  quality: number;
  onQualityChange: (quality: number) => void;
}

/** The voice button and its model, voice and quality popover. */
export function ReaderVoiceMenu({
  open,
  onOpenChange,
  modelState,
  voiceLabel,
  modelLabel,
  activeModel,
  onModelChange,
  desktopModelOptions,
  selectedDesktopModel,
  desktopModelSettings,
  kokoroState,
  supertonicState,
  modelStates,
  browserModelState,
  visibleModels,
  unavailableModels,
  kokoroVoices,
  voice,
  onVoiceChange,
  quality,
  onQualityChange,
}: ReaderVoiceMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const qualityId = useId();

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label="Voice settings"
        className="glass-control flex h-12 min-w-12 items-center justify-center gap-2 rounded-full px-4 text-sm text-text-primary"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            modelState.ready ? "bg-success" : modelState.error ? "bg-danger" : "bg-text-muted animate-pulse"
          }`}
          style={modelState.ready ? { boxShadow: "0 0 6px color-mix(in srgb, var(--color-success) 60%, transparent)" } : undefined}
        />
        <span className="hidden font-medium sm:inline">{voiceLabel}</span>
        <span className="hidden text-xs text-text-muted md:inline">{modelLabel}</span>
        <SlidersHorizontal size={13} className="text-text-muted sm:hidden" />
        <ChevronDown
          size={13}
          className={`hidden text-text-muted transition-transform duration-200 sm:block ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <ViewportPopover
          anchorRef={buttonRef}
          popoverRef={popoverRef}
          maxWidth={448}
          className={POPOVER_CLASS}
          ariaLabel="Voice settings"
          onClose={() => onOpenChange(false)}
          // ModelToggle portals its menu to document.body so it can escape
          // this scrollable popover. A press inside that menu must not close
          // and unmount the settings tree before the option's click selects
          // the new runtime.
          keepOpenWithin="[data-model-picker-menu]"
        >
          <div className="flex flex-col gap-4">
            <ModelToggle
              activeModel={activeModel}
              onModelChange={onModelChange}
              desktopModelOptions={desktopModelOptions}
              kokoroState={kokoroState}
              supertonicState={supertonicState}
              modelStates={modelStates}
              visibleModels={visibleModels}
              unavailableModels={unavailableModels}
            />

            {(selectedDesktopModel || activeModel === "chatterbox") && desktopModelSettings}

            {!selectedDesktopModel && (
              <VoiceSelector
                activeModel={activeModel}
                voice={voice}
                onVoiceChange={onVoiceChange}
                kokoroVoices={kokoroVoices}
                modelState={browserModelState}
              />
            )}

            {!selectedDesktopModel && activeModel === "supertonic" && (
              <div>
                <div className="mb-2 flex items-baseline justify-between">
                  <label htmlFor={qualityId} className="text-sm font-semibold text-text-secondary">
                    Quality
                  </label>
                  <span className="font-mono text-sm font-medium tabular-nums text-text-primary">
                    {quality} steps
                  </span>
                </div>
                <input
                  id={qualityId}
                  type="range"
                  min={QUALITY_MIN}
                  max={QUALITY_MAX}
                  step={QUALITY_STEP}
                  value={quality}
                  onChange={(event) => onQualityChange(parseInt(event.target.value))}
                />
                <div className="mt-1.5 flex justify-between">
                  <span className="text-xs text-text-muted">Faster</span>
                  <span className="text-xs text-text-muted">Higher quality</span>
                </div>
              </div>
            )}
          </div>
        </ViewportPopover>
      )}
    </div>
  );
}

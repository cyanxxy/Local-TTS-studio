import { memo, useId, useRef, useState } from "react";
import { Keyboard, Type } from "lucide-react";
import type {
  ReaderColumnWidth,
  ReaderTone,
  ReaderViewPreferences,
} from "../../lib/readerPreferences";
import { SegmentedChoice, SwitchRow } from "./ReaderControls";
import { ViewportPopover } from "./ViewportPopover";
import { POPOVER_CLASS, TOOL_BUTTON } from "./readerStyles";
import { SLEEP_TIMER_OPTIONS, type SleepTimerChoice } from "./useReaderSleepTimer";

const READER_TONE_OPTIONS: ReadonlyArray<{ value: ReaderTone; label: string }> = [
  { value: "paper", label: "Paper" },
  { value: "sepia", label: "Sepia" },
  { value: "night", label: "Night" },
];

const COLUMN_WIDTH_OPTIONS: ReadonlyArray<{ value: ReaderColumnWidth; label: string }> = [
  { value: "narrow", label: "narrow" },
  { value: "comfortable", label: "Standard" },
  { value: "wide", label: "wide" },
];

interface ReaderAppearanceMenuProps {
  viewPreferences: ReaderViewPreferences;
  onViewPreferencesChange?: (patch: Partial<ReaderViewPreferences>) => void;
  sleepTimerChoice: SleepTimerChoice;
  onSleepTimerChange: (choice: SleepTimerChoice) => void;
  onShowShortcuts: () => void;
}

/** Page tone, typography, sleep timer and listening switches. */
export const ReaderAppearanceMenu = memo(function ReaderAppearanceMenu({
  viewPreferences,
  onViewPreferencesChange,
  sleepTimerChoice,
  onSleepTimerChange,
  onShowShortcuts,
}: ReaderAppearanceMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const controlId = useId();

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Reading appearance"
        aria-expanded={open}
        title="Reading appearance"
        className={TOOL_BUTTON}
      >
        <Type size={16} />
      </button>
      {open && (
        <ViewportPopover
          anchorRef={buttonRef}
          popoverRef={popoverRef}
          maxWidth={360}
          className={POPOVER_CLASS}
          ariaLabel="Reading appearance"
          onClose={() => setOpen(false)}
        >
          <div className="space-y-4">
            <SegmentedChoice
              legend="Page"
              value={viewPreferences.tone}
              options={READER_TONE_OPTIONS}
              onChange={(tone) => onViewPreferencesChange?.({ tone })}
            />
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor={`${controlId}-font-size`} className="text-sm font-semibold text-text-secondary">
                  Text size
                </label>
                <span className="font-mono text-xs text-text-secondary">{viewPreferences.fontSize}px</span>
              </div>
              <input
                id={`${controlId}-font-size`}
                type="range"
                min={15}
                max={26}
                step={1}
                value={viewPreferences.fontSize}
                onChange={(event) => onViewPreferencesChange?.({ fontSize: Number(event.target.value) })}
              />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor={`${controlId}-line-height`} className="text-sm font-semibold text-text-secondary">
                  Line spacing
                </label>
                <span className="font-mono text-xs text-text-secondary">{viewPreferences.lineHeight.toFixed(2)}</span>
              </div>
              <input
                id={`${controlId}-line-height`}
                type="range"
                min={1.4}
                max={2.2}
                step={0.05}
                value={viewPreferences.lineHeight}
                onChange={(event) => onViewPreferencesChange?.({ lineHeight: Number(event.target.value) })}
              />
            </div>
            <SegmentedChoice
              legend="Column width"
              value={viewPreferences.columnWidth}
              options={COLUMN_WIDTH_OPTIONS}
              onChange={(columnWidth) => onViewPreferencesChange?.({ columnWidth })}
            />
            <SegmentedChoice
              legend="Sleep timer"
              value={sleepTimerChoice}
              options={SLEEP_TIMER_OPTIONS}
              onChange={onSleepTimerChange}
            />
            <SwitchRow
              label="Focus spoken text"
              checked={viewPreferences.focusMode}
              onChange={(focusMode) => onViewPreferencesChange?.({ focusMode })}
            />
            <SwitchRow
              label="Continue automatically"
              checked={viewPreferences.autoAdvance}
              onChange={(autoAdvance) => onViewPreferencesChange?.({ autoAdvance })}
            />
            <SwitchRow
              label="Prepare the next part"
              checked={viewPreferences.prepareAhead}
              onChange={(prepareAhead) => onViewPreferencesChange?.({ prepareAhead })}
            />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onShowShortcuts();
              }}
              className="flex w-full items-center gap-2 rounded-xl px-1 py-1 text-xs text-text-muted transition-colors hover:text-accent"
            >
              <Keyboard size={13} aria-hidden />
              Keyboard shortcuts
              <kbd className="ml-auto rounded border border-border px-1.5 font-mono text-2xs">?</kbd>
            </button>
          </div>
        </ViewportPopover>
      )}
    </div>
  );
});

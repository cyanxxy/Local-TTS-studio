import { memo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileAudio, Loader2 } from "lucide-react";
import type { AudiobookExport } from "../../hooks/useAudiobookExport";
import type { AudiobookFormat } from "../../lib/audiobook/exportAudiobook";
import {
  estimateAudiobookSeconds,
  formatAudiobookDuration,
  type AudiobookScope,
} from "../../lib/audiobook/plan";
import { SegmentedChoice } from "./ReaderControls";
import { ViewportPopover } from "./ViewportPopover";
import { POPOVER_CLASS, TOOL_BUTTON } from "./readerStyles";

type ScopeChoice = "chapter" | "book";

const FORMAT_OPTIONS: ReadonlyArray<{ value: AudiobookFormat; label: string }> = [
  { value: "mp3", label: "One MP3" },
  { value: "zip", label: "Chapter files" },
];

const PHASE_LABEL = {
  rendering: "Rendering",
  encoding: "Encoding",
  packaging: "Packing",
} as const;

interface ReaderExportMenuProps {
  audiobook: AudiobookExport;
  /** The chapter the listener is in, for the "this chapter" scope. */
  chapterId: string | null;
  chapterTitle: string | null;
  chapterCount: number;
}

/**
 * Exports the open book (or its current chapter) as an audiobook: one MP3 with
 * chapter markers, or a zip of numbered chapter files. Parts already rendered
 * for listening are reused, and a cancelled or failed export keeps the
 * chapters it finished.
 */
export const ReaderExportMenu = memo(function ReaderExportMenu({
  audiobook,
  chapterId,
  chapterTitle,
  chapterCount,
}: ReaderExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice>(chapterCount > 1 ? "book" : "chapter");
  const [format, setFormat] = useState<AudiobookFormat>("mp3");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { state, planFor, start, cancel, dismiss } = audiobook;
  const running = state.status === "running";

  const scope: AudiobookScope = scopeChoice === "chapter" && chapterId
    ? { kind: "chapter", chapterId }
    : { kind: "book" };
  const plan = planFor(scope);
  const hasText = (plan?.chapters.length ?? 0) > 0;
  const progress = state.progress;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={running ? "Audiobook export, in progress" : "Export audiobook"}
        aria-expanded={open}
        title="Export audiobook"
        className={TOOL_BUTTON}
      >
        {running ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <FileAudio size={16} />}
      </button>
      {open && (
        <ViewportPopover
          anchorRef={buttonRef}
          popoverRef={popoverRef}
          maxWidth={340}
          className={POPOVER_CLASS}
          ariaLabel="Export audiobook"
          onClose={() => setOpen(false)}
        >
          <div className="space-y-4">
            {chapterCount > 1 && (
              <SegmentedChoice
                legend="Export"
                value={scopeChoice}
                options={[
                  { value: "chapter", label: chapterTitle ? "This chapter" : "Chapter" },
                  { value: "book", label: "Whole book" },
                ]}
                onChange={setScopeChoice}
              />
            )}
            <SegmentedChoice legend="Format" value={format} options={FORMAT_OPTIONS} onChange={setFormat} />

            {plan && hasText && (
              <p className="text-xs text-text-muted">
                {plan.chapters.length} {plan.chapters.length === 1 ? "chapter" : "chapters"}
                {" · about "}
                {formatAudiobookDuration(estimateAudiobookSeconds(plan))}
                {" of audio. Parts already rendered for listening are reused."}
              </p>
            )}

            {running && progress && (
              <div role="status" className="space-y-1.5">
                <div
                  role="progressbar"
                  aria-label="Audiobook export progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress.fraction * 100)}
                  className="h-1.5 overflow-hidden rounded-full bg-border/80"
                >
                  <div
                    className="h-full origin-left rounded-full bg-accent transition-transform duration-300"
                    style={{ transform: `scaleX(${progress.fraction})` }}
                  />
                </div>
                <p className="text-xs text-text-secondary">
                  {PHASE_LABEL[progress.phase]} chapter {progress.chapter} of {progress.chapterCount}
                  <span className="text-text-muted">
                    {" · "}{progress.reusedSections} reused, {progress.renderedSections} rendered
                  </span>
                </p>
              </div>
            )}
            {running && !progress && (
              <p role="status" className="text-xs text-text-secondary">Starting…</p>
            )}

            {state.status === "done" && state.result && (
              <p role="status" className="flex items-start gap-2 text-xs text-text-secondary">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span>
                  Saved {state.result.fileName}: {state.result.chapters}{" "}
                  {state.result.chapters === 1 ? "chapter" : "chapters"},{" "}
                  {formatAudiobookDuration(state.result.durationSec)}.
                </span>
              </p>
            )}
            {state.status === "failed" && state.error && (
              <p role="alert" className="flex items-start gap-2 text-xs text-danger">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>{state.error} Chapters already finished are kept if you try again.</span>
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              {running ? (
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-xl border border-border px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary"
                >
                  Cancel export
                </button>
              ) : (
                <>
                  {state.status !== "idle" && (
                    <button
                      type="button"
                      onClick={dismiss}
                      className="rounded-xl px-3 py-2 text-xs font-semibold text-text-muted transition-colors hover:text-text-primary"
                    >
                      Dismiss
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!hasText}
                    onClick={() => start(scope, format)}
                    className="rounded-xl bg-accent-fill px-3.5 py-2 text-xs font-semibold text-white transition-[filter,transform] hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {state.status === "failed" ? "Try again" : "Create audiobook"}
                  </button>
                </>
              )}
            </div>
          </div>
        </ViewportPopover>
      )}
    </div>
  );
});

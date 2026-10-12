import { useLayoutEffect, useRef } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { MIN_TEXT_LENGTH } from "../constants";
import { stripSpeechBreakMarks } from "../lib/speechBreakMarks";
import { insertBreakTag } from "../lib/creator/breakInsert";
import { getMeaningfulTextLength, hasMinimumSynthesisText } from "../lib/textValidation";
import { BreakInsertMenu } from "./creator/BreakInsertMenu";

interface TextInputProps {
  text: string;
  onTextChange: (text: string) => void;
  /** Desktop-only document import (PDF/DOCX/images via LiteParse); absent on web builds. */
  onImportDocument?: () => void;
  isImportingDocument?: boolean;
  /**
   * What the engine is asked to say once pauses, cleanup and the dictionary have
   * had their way. The counter measures this, since it is what Generate needs.
   */
  spokenText?: string;
}

export function TextInput({ text, onTextChange, onImportDocument, isImportingDocument = false, spokenText }: TextInputProps) {
  // Count meaningful (trimmed) characters so the counter matches the generate gate.
  const spoken = spokenText === undefined ? text : stripSpeechBreakMarks(spokenText);
  const charCount = getMeaningfulTextLength(spoken);
  const isValid = hasMinimumSynthesisText(spoken, MIN_TEXT_LENGTH);
  const writtenCount = getMeaningfulTextLength(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once the controlled textarea shows the inserted pause.
  const pendingCaretRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    // The ref is set whenever a pause was requested: the menu lives beside the textarea.
    const textarea = textareaRef.current!;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [text]);

  const insertBreak = (seconds: number) => {
    const { selectionStart, selectionEnd } = textareaRef.current!;
    const insertion = insertBreakTag(text, selectionStart, selectionEnd, seconds);
    pendingCaretRef.current = insertion.caret;
    onTextChange(insertion.text);
  };

  return (
    <div className="flex flex-col h-full">
      <textarea
        ref={textareaRef}
        className="flex-1 w-full resize-none bg-transparent text-text-primary text-xl leading-relaxed placeholder:text-text-muted/50 outline-none font-sans selection:bg-accent/40 selection:text-white focus:ring-0"
        aria-label="Text to synthesize"
        placeholder="Type or paste your text here…"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        spellCheck={false}
      />

      <div className="mt-auto pt-4 border-t border-border/60 flex items-center justify-end gap-3">
        <div className="mr-auto flex items-center gap-2">
          {onImportDocument && (
            <button
              type="button"
              onClick={onImportDocument}
              disabled={isImportingDocument}
              aria-label="Import document"
              title="Import a document (PDF, text, Office, images)"
              className="flex items-center gap-1.5 rounded-lg border border-border bg-text-primary/[0.04] px-2.5 py-1.5 text-sm text-text-secondary transition-all duration-200 hover:bg-text-primary/[0.07] hover:text-text-primary active:scale-[0.98] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
            >
              {isImportingDocument
                ? <Loader2 size={12} className="animate-spin" />
                : <FileUp size={12} />}
              {isImportingDocument ? "Importing…" : "Import"}
            </button>
          )}
          <BreakInsertMenu onInsert={insertBreak} />
        </div>
        <span
          className={`font-mono text-sm tabular-nums flex-shrink-0 ${
            !isValid && charCount > 0 ? "text-danger" : "text-text-muted"
          }`}
        >
          {charCount} chars{writtenCount > 0 && charCount !== writtenCount ? " spoken" : ""}
          {!isValid && charCount > 0 && (
            <span className="text-text-muted"> / {MIN_TEXT_LENGTH}</span>
          )}
        </span>
        {!isValid && writtenCount >= MIN_TEXT_LENGTH && (
          <span className="text-xs text-text-muted" role="status">
            Pauses, cleanup and pronunciation rules leave fewer than {MIN_TEXT_LENGTH} characters to speak.
          </span>
        )}
      </div>
    </div>
  );
}

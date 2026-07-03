import { FileUp, Loader2 } from "lucide-react";
import { MIN_TEXT_LENGTH } from "../constants";
import { getMeaningfulTextLength, hasMinimumSynthesisText } from "../lib/textValidation";

interface TextInputProps {
  text: string;
  onTextChange: (text: string) => void;
  /** Desktop-only document import (PDF/DOCX/images via LiteParse); absent on web builds. */
  onImportDocument?: () => void;
  isImportingDocument?: boolean;
}

export function TextInput({ text, onTextChange, onImportDocument, isImportingDocument = false }: TextInputProps) {
  // Count meaningful (trimmed) characters so the counter matches the generate gate.
  const charCount = getMeaningfulTextLength(text);
  const isValid = hasMinimumSynthesisText(text, MIN_TEXT_LENGTH);

  return (
    <div className="flex flex-col h-full">
      <textarea
        className="flex-1 w-full resize-none bg-transparent text-text-primary text-xl leading-relaxed placeholder:text-text-muted/50 outline-none font-sans selection:bg-accent/40 selection:text-white focus:ring-0"
        aria-label="Text to synthesize"
        placeholder="Type or paste your text here…"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        spellCheck={false}
      />

      <div className="mt-auto pt-4 border-t border-border/60 flex items-center justify-end gap-3">
        {onImportDocument && (
          <button
            type="button"
            onClick={onImportDocument}
            disabled={isImportingDocument}
            aria-label="Import document"
            title="Import a document (PDF, text, Office, images)"
            className="mr-auto flex items-center gap-1.5 rounded-lg border border-white/55 bg-white/40 px-2.5 py-1.5 text-sm text-text-secondary shadow-glass-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-px hover:bg-white/60 hover:text-text-primary active:translate-y-0 active:scale-[0.98] disabled:cursor-default disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:bg-white/40"
          >
            {isImportingDocument
              ? <Loader2 size={12} className="animate-spin" />
              : <FileUp size={12} />}
            {isImportingDocument ? "Importing…" : "Import"}
          </button>
        )}
        <span
          className={`font-mono text-sm tabular-nums flex-shrink-0 ${
            !isValid && charCount > 0 ? "text-danger" : "text-text-muted"
          }`}
        >
          {charCount} chars
          {!isValid && charCount > 0 && (
            <span className="text-text-muted"> / {MIN_TEXT_LENGTH}</span>
          )}
        </span>
      </div>
    </div>
  );
}

import { MIN_TEXT_LENGTH } from "../constants";
import { hasMinimumSynthesisText } from "../lib/textValidation";

interface TextInputProps {
  text: string;
  onTextChange: (text: string) => void;
}

export function TextInput({ text, onTextChange }: TextInputProps) {
  const charCount = text.length;
  const isValid = hasMinimumSynthesisText(text, MIN_TEXT_LENGTH);

  return (
    <div className="flex flex-col h-full">
      <textarea
        className="flex-1 w-full resize-none bg-transparent text-text-primary text-[16px] leading-relaxed placeholder:text-text-muted/50 outline-none font-sans selection:bg-accent/40 selection:text-white focus:ring-0"
        aria-label="Text to synthesize"
        placeholder="Type or paste your text here…"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        spellCheck={false}
      />

      <div className="mt-auto pt-4 border-t border-border/60 flex items-center justify-end gap-3">
        <span
          className={`font-mono text-[11px] tabular-nums flex-shrink-0 ${
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

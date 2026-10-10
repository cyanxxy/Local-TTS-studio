import { memo, useCallback, useRef, useState, type ChangeEvent } from "react";
import { FileUp, Link2, Loader2 } from "lucide-react";
import { ViewportPopover } from "./ViewportPopover";
import { POPOVER_CLASS, TOOL_BUTTON } from "./readerStyles";

/** What the web Reader can parse itself; desktop imports go through the native picker. */
const WEB_IMPORT_ACCEPT = ".epub,.txt,.md,.html,.htm";

interface ReaderImportMenuProps {
  /** Desktop-only document import (PDF/DOCX/images via LiteParse); absent on web builds. */
  onImportDocument?: () => void;
  onImportFile?: (file: File) => Promise<void> | void;
  onImportUrl?: (url: string) => Promise<void> | void;
  isImportingDocument: boolean;
  /** Called after an article import succeeds, so its new entry can be shown. */
  onArticleImported: () => void;
}

/** Imports a file or an article URL into the library. */
export const ReaderImportMenu = memo(function ReaderImportMenu({
  onImportDocument,
  onImportFile,
  onImportUrl,
  isImportingDocument,
  onArticleImported,
}: ReaderImportMenuProps) {
  const [open, setOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlImportError, setUrlImportError] = useState<string | null>(null);
  const [urlImportBusy, setUrlImportBusy] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canImportFile = Boolean(onImportDocument || onImportFile);

  const handleFilePick = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void onImportFile?.(file);
  }, [onImportFile]);

  const handleUrlImport = useCallback(async () => {
    const url = urlInput.trim();
    if (!url || !onImportUrl || urlImportBusy) return;
    setUrlImportBusy(true);
    setUrlImportError(null);
    try {
      await onImportUrl(url);
      setUrlInput("");
      setOpen(false);
      onArticleImported();
    } catch (error) {
      setUrlImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setUrlImportBusy(false);
    }
  }, [onArticleImported, onImportUrl, urlImportBusy, urlInput]);

  return (
    <div className="relative">
      <input
        ref={fileInputRef}
        type="file"
        accept={WEB_IMPORT_ACCEPT}
        onChange={handleFilePick}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
      />
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          setUrlImportError(null);
        }}
        disabled={isImportingDocument && !open}
        aria-label="Import document"
        aria-expanded={open}
        title="Import a file or an article URL"
        className={`${TOOL_BUTTON} disabled:cursor-default disabled:opacity-60`}
      >
        {isImportingDocument
          ? <Loader2 size={15} className="animate-spin" />
          : <FileUp size={15} />}
      </button>
      {open && (
        <ViewportPopover
          anchorRef={buttonRef}
          popoverRef={popoverRef}
          maxWidth={400}
          className={POPOVER_CLASS}
          ariaLabel="Import document"
          onClose={() => setOpen(false)}
        >
          {canImportFile && (
            <button
              type="button"
              disabled={isImportingDocument}
              onClick={() => {
                setOpen(false);
                if (onImportDocument) onImportDocument();
                else fileInputRef.current?.click();
              }}
              className="flex w-full items-center gap-3 rounded-xl border border-border bg-text-primary/[0.04] px-3 py-2.5 text-left text-sm text-text-primary transition-colors hover:bg-text-primary/[0.07] disabled:cursor-default disabled:opacity-60"
            >
              <FileUp size={15} className="shrink-0 text-accent" />
              <span className="min-w-0">
                <span className="block font-semibold">Choose a file…</span>
                <span className="block text-xs text-text-muted">
                  {onImportDocument
                    ? "EPUB, PDF, text, Markdown, Office, or images"
                    : "EPUB, text, Markdown, or HTML"}
                </span>
              </span>
            </button>
          )}
          {onImportUrl && (
            <div className={canImportFile ? "mt-4 border-t border-border/50 pt-4" : undefined}>
              <label className="block text-sm font-semibold text-text-secondary">
                Article URL
                <input
                  type="url"
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleUrlImport();
                  }}
                  placeholder="https://example.com/article"
                  className="mt-2 w-full rounded-xl border border-border bg-text-primary/[0.04] px-3 py-2.5 text-sm normal-case tracking-normal text-text-primary outline-none placeholder:text-text-muted focus:border-accent/40"
                />
              </label>
              {urlImportError && <p className="mt-2 text-xs leading-5 text-danger">{urlImportError}</p>}
              <p className="mt-2 text-xs leading-5 text-text-muted">
                Article text and headings are extracted locally after download.
              </p>
              <button
                type="button"
                disabled={!urlInput.trim() || urlImportBusy}
                onClick={() => void handleUrlImport()}
                className="glass-accent mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold text-white transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {urlImportBusy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                {urlImportBusy ? "Importing article…" : "Import article"}
              </button>
            </div>
          )}
        </ViewportPopover>
      )}
    </div>
  );
});

import { Download } from "lucide-react";
import type { ReaderDocumentRecord } from "../../lib/readerDocument";
import { buildReaderAnnotationFile, type ReaderAnnotationExportFormat } from "./readerAnnotationExport";
import { downloadTextFile } from "./readerDownload";

const FORMATS: ReadonlyArray<{ format: ReaderAnnotationExportFormat; label: string }> = [
  { format: "markdown", label: "Markdown" },
  { format: "json", label: "JSON" },
];

/** Downloads every note, highlight and bookmark of the open book. */
export function ReaderAnnotationExportBar({ document }: { document: ReaderDocumentRecord }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-text-primary/[0.03] px-3 py-2">
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
        <Download size={12} aria-hidden className="shrink-0" />
        <span className="truncate">Export annotations</span>
      </span>
      <div role="group" aria-label="Export annotations" className="flex shrink-0 gap-1">
        {FORMATS.map(({ format, label }) => (
          <button
            key={format}
            type="button"
            aria-label={`Export notes, highlights and bookmarks as ${label}`}
            onClick={() => downloadTextFile(buildReaderAnnotationFile(document, format))}
            className="rounded-lg px-2 py-1 text-2xs font-semibold text-accent transition-colors hover:bg-accent-light"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

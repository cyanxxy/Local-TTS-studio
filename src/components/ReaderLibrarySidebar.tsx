import { useMemo, useState } from "react";
import {
  BookMarked,
  BookOpen,
  FilePlus2,
  Library,
  NotebookPen,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { ReaderDocumentRecord } from "../lib/readerDocument";

type ReaderSidebarTab = "library" | "contents" | "bookmarks" | "notes";

interface ReaderLibrarySidebarProps {
  open: boolean;
  documents: ReaderDocumentRecord[];
  activeDocument: ReaderDocumentRecord | null;
  currentTextOffset: number;
  currentTime: number;
  loading?: boolean;
  persistent?: boolean;
  onClose: () => void;
  onOpenDocument: (id: string) => void;
  onNewDocument: () => void;
  onDeleteDocument: (id: string) => void;
  onUpdateMetadata: (patch: Pick<Partial<ReaderDocumentRecord>, "title" | "author">) => void;
  onJumpToOffset: (offset: number, positionSec?: number) => void;
  onAddBookmark: (input: { label: string; textOffset: number; positionSec: number }) => void;
  onRemoveBookmark: (id: string) => void;
  onAddNote: (input: { text: string; quote: string; textOffset: number }) => void;
  onUpdateNote: (id: string, text: string) => void;
  onRemoveNote: (id: string) => void;
}

const TABS: Array<{ key: ReaderSidebarTab; label: string; icon: typeof Library }> = [
  { key: "library", label: "Library", icon: Library },
  { key: "contents", label: "Contents", icon: BookOpen },
  { key: "bookmarks", label: "Bookmarks", icon: BookMarked },
  { key: "notes", label: "Notes", icon: NotebookPen },
];

function formatRelativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ReaderLibrarySidebar({
  open,
  documents,
  activeDocument,
  currentTextOffset,
  currentTime,
  loading = false,
  persistent = true,
  onClose,
  onOpenDocument,
  onNewDocument,
  onDeleteDocument,
  onUpdateMetadata,
  onJumpToOffset,
  onAddBookmark,
  onRemoveBookmark,
  onAddNote,
  onUpdateNote,
  onRemoveNote,
}: ReaderLibrarySidebarProps) {
  const [tab, setTab] = useState<ReaderSidebarTab>("library");
  const [noteText, setNoteText] = useState("");
  const currentChapter = useMemo(() => activeDocument?.chapters.find(
    (chapter) => currentTextOffset >= chapter.start && currentTextOffset < chapter.end,
  ) ?? activeDocument?.chapters.at(-1) ?? null, [activeDocument, currentTextOffset]);

  if (!open) return null;

  return (
    <aside
      aria-label="Reader library"
      className="glass-pop fixed inset-y-3 left-3 z-50 flex w-[min(23rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[26px] shadow-glass-lg md:absolute md:inset-y-0 md:left-0 md:w-[22rem] md:rounded-[28px]"
    >
      <div className="flex items-center justify-between border-b border-black/5 px-4 py-3">
        <div>
          <p className="font-display text-lg font-semibold text-text-primary">Your Reader</p>
          <p className="text-xs text-text-muted">
            {persistent ? "Saved on this device" : "Temporary session"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Reader library"
          className="flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-white/55 hover:text-text-primary active:scale-[0.98]"
        >
          <X size={17} />
        </button>
      </div>

      <div className="grid grid-cols-4 gap-1 border-b border-black/5 p-2">
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              aria-pressed={tab === item.key}
              className={`flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-2xs font-medium transition-all active:scale-[0.98] ${
                tab === item.key
                  ? "bg-accent-light text-accent shadow-glass-sm"
                  : "text-text-muted hover:bg-white/45 hover:text-text-secondary"
              }`}
            >
              <Icon size={14} />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "library" && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={onNewDocument}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-accent/25 bg-accent-light px-3 py-2.5 text-sm font-semibold text-accent transition-all hover:-translate-y-px active:translate-y-0 active:scale-[0.98]"
            >
              <FilePlus2 size={15} />
              New document
            </button>

            {loading ? (
              <div className="space-y-2" aria-label="Loading documents">
                {[0, 1, 2].map((item) => (
                  <div key={item} className="h-20 animate-pulse rounded-2xl bg-white/35" />
                ))}
              </div>
            ) : documents.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border p-5 text-center">
                <Library size={20} className="mx-auto text-text-muted" />
                <p className="mt-2 text-sm font-medium text-text-secondary">Your library is empty</p>
                <p className="mt-1 text-xs text-text-muted">Create or import a document to begin.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {documents.map((document) => (
                  <div
                    key={document.id}
                    className={`group rounded-2xl border p-3 transition-all ${
                      document.id === activeDocument?.id
                        ? "border-accent/30 bg-accent/[0.08] shadow-accent-sm"
                        : "border-white/45 bg-white/30 hover:bg-white/50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenDocument(document.id)}
                      className="w-full text-left active:scale-[0.99]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-text-primary">{document.title}</p>
                          <p className="mt-0.5 truncate text-xs text-text-muted">
                            {document.author || document.sourceName || "Personal document"}
                          </p>
                        </div>
                        <span className="shrink-0 font-mono text-2xs text-text-muted">
                          {Math.round(document.progress.percent)}%
                        </span>
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${document.progress.percent}%` }} />
                      </div>
                      <p className="mt-2 text-2xs text-text-muted">Opened {formatRelativeTime(document.lastOpenedAt)}</p>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${document.title}`}
                      onClick={() => onDeleteDocument(document.id)}
                      className="mt-2 flex items-center gap-1 text-2xs text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Trash2 size={11} />
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "contents" && activeDocument && (
          <div>
            <div className="mb-4 space-y-2">
              <label className="block text-2xs font-semibold uppercase tracking-widest text-text-muted">
                Title
                <input
                  value={activeDocument.title}
                  onChange={(event) => onUpdateMetadata({ title: event.target.value })}
                  className="mt-1.5 w-full rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-sm normal-case tracking-normal text-text-primary outline-none focus:border-accent/40"
                />
              </label>
              <label className="block text-2xs font-semibold uppercase tracking-widest text-text-muted">
                Author
                <input
                  value={activeDocument.author}
                  placeholder="Unknown author"
                  onChange={(event) => onUpdateMetadata({ author: event.target.value })}
                  className="mt-1.5 w-full rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-sm normal-case tracking-normal text-text-primary outline-none placeholder:text-text-muted focus:border-accent/40"
                />
              </label>
            </div>
            <p className="mb-2 text-2xs font-semibold uppercase tracking-widest text-text-muted">Table of contents</p>
            <div className="space-y-1">
              {activeDocument.chapters.map((chapter) => (
                <button
                  key={chapter.id}
                  type="button"
                  onClick={() => onJumpToOffset(chapter.start)}
                  aria-current={chapter.id === currentChapter?.id ? "location" : undefined}
                  className={`flex w-full items-center gap-2 rounded-xl py-2 pr-2 text-left text-sm transition-all active:scale-[0.99] ${
                    chapter.id === currentChapter?.id
                      ? "bg-accent-light font-semibold text-accent"
                      : "text-text-secondary hover:bg-white/45 hover:text-text-primary"
                  }`}
                  style={{ paddingLeft: `${8 + Math.min(3, chapter.level - 1) * 12}px` }}
                >
                  <span className="w-5 shrink-0 text-right font-mono text-2xs text-text-muted">{chapter.order + 1}</span>
                  <span className="truncate">{chapter.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === "bookmarks" && activeDocument && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => onAddBookmark({
                label: currentChapter?.title || `Bookmark ${activeDocument.bookmarks.length + 1}`,
                textOffset: currentTextOffset,
                positionSec: currentTime,
              })}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-accent/25 bg-accent-light px-3 py-2.5 text-sm font-semibold text-accent transition-all active:scale-[0.98]"
            >
              <Plus size={15} />
              Bookmark this position
            </button>
            {activeDocument.bookmarks.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border p-5 text-center text-sm text-text-muted">
                Saved positions appear here.
              </p>
            ) : activeDocument.bookmarks.map((bookmark) => (
              <div key={bookmark.id} className="rounded-2xl border border-white/45 bg-white/30 p-3">
                <button
                  type="button"
                  onClick={() => onJumpToOffset(bookmark.textOffset, bookmark.positionSec)}
                  className="w-full text-left active:scale-[0.99]"
                >
                  <p className="text-sm font-semibold text-text-primary">{bookmark.label}</p>
                  <p className="mt-1 font-mono text-2xs text-text-muted">
                    {Math.floor(bookmark.positionSec / 60)}:{Math.floor(bookmark.positionSec % 60).toString().padStart(2, "0")}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveBookmark(bookmark.id)}
                  className="mt-2 text-2xs text-text-muted hover:text-danger"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === "notes" && activeDocument && (
          <div className="space-y-3">
            <label className="block text-2xs font-semibold uppercase tracking-widest text-text-muted">
              New note at current position
              <textarea
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                placeholder="Capture a thought about this passage…"
                className="mt-1.5 min-h-24 w-full resize-y rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-sm normal-case tracking-normal text-text-primary outline-none placeholder:text-text-muted focus:border-accent/40"
              />
            </label>
            <button
              type="button"
              disabled={!noteText.trim()}
              onClick={() => {
                onAddNote({ text: noteText, quote: "", textOffset: currentTextOffset });
                setNoteText("");
              }}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-accent/25 bg-accent-light px-3 py-2.5 text-sm font-semibold text-accent transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <NotebookPen size={15} />
              Save note
            </button>
            {activeDocument.notes.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border p-5 text-center text-sm text-text-muted">
                Notes stay attached to this document.
              </p>
            ) : activeDocument.notes.map((note) => (
              <div key={note.id} className="rounded-2xl border border-white/45 bg-white/30 p-3">
                <button
                  type="button"
                  onClick={() => onJumpToOffset(note.textOffset)}
                  className="mb-2 text-left text-2xs font-medium text-accent"
                >
                  Jump to passage
                </button>
                <textarea
                  aria-label="Edit note"
                  value={note.text}
                  onChange={(event) => onUpdateNote(note.id, event.target.value)}
                  className="min-h-16 w-full resize-y rounded-lg border border-transparent bg-transparent text-sm leading-5 text-text-primary outline-none focus:border-accent/30 focus:bg-white/30"
                />
                <button
                  type="button"
                  onClick={() => onRemoveNote(note.id)}
                  className="mt-1 text-2xs text-text-muted hover:text-danger"
                >
                  Delete note
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

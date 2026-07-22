import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookMarked,
  BookOpen,
  FilePlus2,
  Library,
  NotebookPen,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { ReaderDocumentRecord } from "../lib/readerDocument";

export type ReaderSidebarTab = "library" | "contents" | "search" | "bookmarks" | "notes";

interface SearchResult {
  offset: number;
  before: string;
  match: string;
  after: string;
}

const SEARCH_RESULT_LIMIT = 50;

function findDocumentMatches(text: string, query: string): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length < 2) return [];
  const haystack = text.toLocaleLowerCase();
  const results: SearchResult[] = [];
  let cursor = 0;
  while (results.length < SEARCH_RESULT_LIMIT) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) break;
    const end = at + needle.length;
    results.push({
      offset: at,
      before: text.slice(Math.max(0, at - 40), at).replace(/\s+/g, " ").trimStart(),
      match: text.slice(at, end),
      after: text.slice(end, end + 60).replace(/\s+/g, " ").trimEnd(),
    });
    cursor = end;
  }
  return results;
}

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
  selectedPassage?: { quote: string; textOffset: number } | null;
  tab: ReaderSidebarTab;
  onTabChange: (tab: ReaderSidebarTab) => void;
}

const TABS: Array<{ key: ReaderSidebarTab; label: string; icon: typeof Library }> = [
  { key: "library", label: "Library", icon: Library },
  { key: "contents", label: "Contents", icon: BookOpen },
  { key: "search", label: "Search", icon: Search },
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

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

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
  selectedPassage = null,
  tab,
  onTabChange,
}: ReaderLibrarySidebarProps) {
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [contentsQuery, setContentsQuery] = useState("");
  const [searchDrafts, setSearchDrafts] = useState<Record<string, string>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const activeDocumentId = activeDocument?.id ?? "";
  const noteText = activeDocumentId ? noteDrafts[activeDocumentId] ?? "" : "";
  const setNoteText = (value: string) => {
    if (!activeDocumentId) return;
    setNoteDrafts((drafts) => ({ ...drafts, [activeDocumentId]: value }));
  };
  const currentChapter = useMemo(() => activeDocument?.chapters.find(
    (chapter) => currentTextOffset >= chapter.start && currentTextOffset < chapter.end,
  ) ?? activeDocument?.chapters.at(-1) ?? null, [activeDocument, currentTextOffset]);
  const visibleChapters = useMemo(() => {
    const query = contentsQuery.trim().toLocaleLowerCase();
    if (!activeDocument || !query) return activeDocument?.chapters ?? [];
    return activeDocument.chapters.filter((chapter) => chapter.title.toLocaleLowerCase().includes(query));
  }, [activeDocument, contentsQuery]);
  const searchQuery = activeDocumentId ? searchDrafts[activeDocumentId] ?? "" : "";
  const setSearchQuery = (value: string) => {
    if (!activeDocumentId) return;
    setSearchDrafts((drafts) => ({ ...drafts, [activeDocumentId]: value }));
  };
  const searchResults = useMemo(
    () => activeDocument ? findDocumentMatches(activeDocument.text, searchQuery) : [],
    [activeDocument, searchQuery],
  );

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => {
      const focusable = sidebarRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (focusable ?? sidebarRef.current)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !sidebarRef.current) return;
      const focusable = [...sidebarRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        .filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) {
        event.preventDefault();
        sidebarRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <aside
      ref={sidebarRef}
      role="dialog"
      aria-modal="true"
      aria-label="Reader library"
      tabIndex={-1}
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
              onClick={() => onTabChange(item.key)}
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
                      onClick={() => {
                        setContentsQuery("");
                        onOpenDocument(document.id);
                      }}
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
                    {pendingDeleteId === document.id ? (
                      <div className="mt-2 flex items-center gap-2 text-2xs">
                        <span className="text-text-secondary">Delete document and cached audio?</span>
                        <button
                          type="button"
                          onClick={() => {
                            setPendingDeleteId(null);
                            onDeleteDocument(document.id);
                          }}
                          className="font-semibold text-danger"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDeleteId(null)}
                          className="text-text-muted hover:text-text-primary"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${document.title}`}
                        onClick={() => setPendingDeleteId(document.id)}
                        className="mt-2 flex items-center gap-1 text-2xs text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Trash2 size={11} />
                        Delete
                      </button>
                    )}
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
            {activeDocument.chapters.length > 8 && (
              <label className="mb-2 flex items-center gap-2 rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-text-muted focus-within:border-accent/40">
                <Search size={13} aria-hidden />
                <span className="sr-only">Search chapters</span>
                <input
                  type="search"
                  value={contentsQuery}
                  onChange={(event) => setContentsQuery(event.target.value)}
                  placeholder="Search chapters"
                  className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                />
              </label>
            )}
            <div className="space-y-1">
              {visibleChapters.map((chapter) => (
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
              {visibleChapters.length === 0 && (
                <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
                  No chapter matches “{contentsQuery.trim()}”.
                </p>
              )}
            </div>
          </div>
        )}

        {tab === "search" && activeDocument && (
          <div className="space-y-3">
            <label className="flex items-center gap-2 rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-text-muted focus-within:border-accent/40">
              <Search size={13} aria-hidden />
              <span className="sr-only">Search this document</span>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search this document"
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
              />
            </label>
            {searchQuery.trim().length < 2 ? (
              <p className="rounded-2xl border border-dashed border-border p-5 text-center text-sm text-text-muted">
                Type at least two characters to search the full text.
              </p>
            ) : searchResults.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border p-5 text-center text-sm text-text-muted">
                No matches for “{searchQuery.trim()}”.
              </p>
            ) : (
              <div className="space-y-1">
                {searchResults.map((result) => {
                  const chapter = activeDocument.chapters.find(
                    (entry) => result.offset >= entry.start && result.offset < entry.end,
                  );
                  return (
                    <button
                      key={result.offset}
                      type="button"
                      onClick={() => onJumpToOffset(result.offset)}
                      className="w-full rounded-xl px-3 py-2 text-left transition-all hover:bg-white/45 active:scale-[0.99]"
                    >
                      {chapter && (
                        <p className="truncate text-2xs font-medium text-text-muted">{chapter.title}</p>
                      )}
                      <p className="text-xs leading-5 text-text-secondary">
                        …{result.before}
                        <mark className="rounded bg-accent-light px-0.5 font-semibold text-accent">
                          {result.match}
                        </mark>
                        {result.after}…
                      </p>
                    </button>
                  );
                })}
                {searchResults.length === SEARCH_RESULT_LIMIT && (
                  <p className="px-3 py-1 text-2xs text-text-muted">
                    Showing the first {SEARCH_RESULT_LIMIT} matches.
                  </p>
                )}
              </div>
            )}
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
            ) : activeDocument.bookmarks.map((bookmark) => {
              const snippet = activeDocument.text
                .slice(bookmark.textOffset, bookmark.textOffset + 120)
                .replace(/\s+/g, " ")
                .trim();
              const percent = activeDocument.text.length > 0
                ? Math.round((bookmark.textOffset / activeDocument.text.length) * 100)
                : 0;
              return (
                <div key={bookmark.id} className="rounded-2xl border border-white/45 bg-white/30 p-3">
                  <button
                    type="button"
                    onClick={() => onJumpToOffset(bookmark.textOffset, bookmark.positionSec)}
                    className="w-full text-left active:scale-[0.99]"
                  >
                    <p className="text-sm font-semibold text-text-primary">{bookmark.label}</p>
                    {snippet && (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-secondary">“{snippet}…”</p>
                    )}
                    <p className="mt-1 font-mono text-2xs text-text-muted">
                      {percent}% through
                      {bookmark.positionSec > 0
                        ? ` · ${Math.floor(bookmark.positionSec / 60)}:${Math.floor(bookmark.positionSec % 60).toString().padStart(2, "0")}`
                        : ""}
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
              );
            })}
          </div>
        )}

        {tab === "notes" && activeDocument && (
          <div className="space-y-3">
            <label className="block text-2xs font-semibold uppercase tracking-widest text-text-muted">
              {selectedPassage ? "New note for selected passage" : "New note at current position"}
              {selectedPassage && (
                <span className="mt-1.5 block rounded-xl border-l-2 border-accent/40 bg-accent/[0.06] px-3 py-2 text-xs font-normal normal-case leading-5 tracking-normal text-text-secondary">
                  “{selectedPassage.quote}”
                </span>
              )}
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
                onAddNote({
                  text: noteText,
                  quote: selectedPassage?.quote ?? "",
                  textOffset: selectedPassage?.textOffset ?? currentTextOffset,
                });
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
                {note.quote && (
                  <blockquote className="mb-2 border-l-2 border-accent/30 pl-2 text-xs leading-5 text-text-muted">
                    {note.quote}
                  </blockquote>
                )}
                {/* Uncontrolled on purpose: committing per keystroke churns
                    persistence, so the note is saved once on blur. */}
                <textarea
                  key={`${note.id}-${note.updatedAt}`}
                  aria-label="Edit note"
                  defaultValue={note.text}
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    if (value !== note.text) onUpdateNote(note.id, value);
                  }}
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

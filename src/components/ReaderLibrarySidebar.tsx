import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
import type { PlaybackClock } from "../lib/playbackClock";
import type { ReaderChapter, ReaderDocumentRecord } from "../lib/readerDocument";
import { findDocumentMatches } from "../lib/readerSearch";

export type ReaderSidebarTab = "library" | "contents" | "search" | "bookmarks" | "notes";

const SEARCH_RESULT_LIMIT = 50;
/** Full-text search folds the entire document, so keystrokes are coalesced. */
const SEARCH_DEBOUNCE_MS = 200;
/** Metadata edits re-sort the library and hit IndexedDB; commit on a pause. */
const METADATA_COMMIT_MS = 400;
/** "Just now" only has to become "1m ago" eventually, not precisely. */
const RELATIVE_TIME_REFRESH_MS = 60_000;
const BOOKMARK_LABEL_LIMIT = 40;

const SIDEBAR_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Stable empty array so chapter memos keep their identity without a document. */
const NO_CHAPTERS: ReaderChapter[] = [];

interface ReaderLibrarySidebarProps {
  open: boolean;
  documents: ReaderDocumentRecord[];
  activeDocument: ReaderDocumentRecord | null;
  currentTextOffset: number;
  clock: PlaybackClock;
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

function formatRelativeTime(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Trails `value` by `delayMs`. Lets an input stay fully controlled (and so
 * fully responsive) while the expensive consumer only sees settled values.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(debounced, value)) return;
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [debounced, delayMs, value]);
  return debounced;
}

interface DocumentCardProps {
  record: ReaderDocumentRecord;
  active: boolean;
  openedLabel: string;
  confirmingDelete: boolean;
  onOpen: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
}

/**
 * Memoised because playback rewrites the active document record roughly once a
 * second; without this every card in the library re-renders on each progress
 * sample. All props are primitives or parent-stable callbacks so the comparison
 * actually holds.
 */
const DocumentCard = memo(function DocumentCard({
  record,
  active,
  openedLabel,
  confirmingDelete,
  onOpen,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: DocumentCardProps) {
  return (
    <div
      className={`group rounded-2xl border p-3 transition-all ${
        active
          ? "border-accent/30 bg-accent/[0.08] shadow-accent-sm"
          : "border-white/45 bg-white/30 hover:bg-white/50"
      }`}
    >
      <button
        type="button"
        onClick={() => onOpen(record.id)}
        className="w-full text-left active:scale-[0.99]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text-primary">{record.title}</p>
            <p className="mt-0.5 truncate text-xs text-text-muted">
              {record.author || record.sourceName || "Personal document"}
            </p>
          </div>
          <span className="shrink-0 font-mono text-2xs text-text-muted">
            {Math.round(record.progress.percent)}%
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-accent" style={{ width: `${record.progress.percent}%` }} />
        </div>
        <p className="mt-2 text-2xs text-text-muted">Opened {openedLabel}</p>
      </button>
      {confirmingDelete ? (
        <div className="mt-2 flex items-center gap-2 text-2xs">
          <span className="text-text-secondary">Delete document and cached audio?</span>
          <button
            type="button"
            onClick={() => onConfirmDelete(record.id)}
            className="font-semibold text-danger"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={onCancelDelete}
            className="text-text-muted hover:text-text-primary"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Delete ${record.title}`}
          onClick={() => onRequestDelete(record.id)}
          className="mt-2 flex items-center gap-1 text-2xs text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 size={11} />
          Delete
        </button>
      )}
    </div>
  );
});

export function ReaderLibrarySidebar({
  open,
  documents,
  activeDocument,
  currentTextOffset,
  clock,
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
  // `null` means "no edit in flight", so an external title change still shows.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [authorDraft, setAuthorDraft] = useState<string | null>(null);
  const [draftScope, setDraftScope] = useState({ open, tab, documentId: activeDocument?.id ?? "" });
  const [now, setNow] = useState(() => Date.now());
  const sidebarRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const keyboardTabNavRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onOpenDocumentRef = useRef(onOpenDocument);
  const onDeleteDocumentRef = useRef(onDeleteDocument);
  const onUpdateMetadataRef = useRef(onUpdateMetadata);
  useEffect(() => {
    onCloseRef.current = onClose;
    onOpenDocumentRef.current = onOpenDocument;
    onDeleteDocumentRef.current = onDeleteDocument;
    onUpdateMetadataRef.current = onUpdateMetadata;
  });
  const tabsId = useId();
  const activeDocumentId = activeDocument?.id ?? "";
  const documentText = activeDocument?.text ?? "";
  // Every memo below keys on the fields it reads rather than on the record:
  // playback mints a fresh document object per progress sample, and the whole
  // record as a dependency would recompute chapter lookups and full-text
  // search on every one of them.
  const chapters = activeDocument?.chapters ?? NO_CHAPTERS;
  const activeTitle = activeDocument?.title ?? "";
  const activeAuthor = activeDocument?.author ?? "";
  const metadataDraftRef = useRef({ titleDraft, authorDraft, activeTitle, activeAuthor });
  useLayoutEffect(() => {
    metadataDraftRef.current = { titleDraft, authorDraft, activeTitle, activeAuthor };
  }, [activeAuthor, activeTitle, authorDraft, titleDraft]);
  const noteText = activeDocumentId ? noteDrafts[activeDocumentId] ?? "" : "";
  const setNoteText = (value: string) => {
    if (!activeDocumentId) return;
    setNoteDrafts((drafts) => ({ ...drafts, [activeDocumentId]: value }));
  };
  const currentChapter = useMemo(() => chapters.find(
    (chapter) => currentTextOffset >= chapter.start && currentTextOffset < chapter.end,
  ) ?? chapters.at(-1) ?? null, [chapters, currentTextOffset]);
  const visibleChapters = useMemo(() => {
    const query = contentsQuery.trim().toLocaleLowerCase();
    if (!query) return chapters;
    return chapters.filter((chapter) => chapter.title.toLocaleLowerCase().includes(query));
  }, [chapters, contentsQuery]);
  const searchQuery = activeDocumentId ? searchDrafts[activeDocumentId] ?? "" : "";
  const setSearchQuery = (value: string) => {
    if (!activeDocumentId) return;
    setSearchDrafts((drafts) => ({ ...drafts, [activeDocumentId]: value }));
  };
  const settledSearchQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);
  const searchResults = useMemo(
    () => findDocumentMatches(documentText, settledSearchQuery, SEARCH_RESULT_LIMIT),
    [documentText, settledSearchQuery],
  );

  const flushMetadataDrafts = useCallback(() => {
    const drafts = metadataDraftRef.current;
    if (drafts.titleDraft !== null && drafts.titleDraft !== drafts.activeTitle) {
      onUpdateMetadataRef.current({ title: drafts.titleDraft });
    }
    if (drafts.authorDraft !== null && drafts.authorDraft !== drafts.activeAuthor) {
      onUpdateMetadataRef.current({ author: drafts.authorDraft });
    }
    setTitleDraft(null);
    setAuthorDraft(null);
  }, []);
  const handleClose = useCallback(() => {
    flushMetadataDrafts();
    onCloseRef.current();
  }, [flushMetadataDrafts]);
  const handleTabChange = useCallback((nextTab: ReaderSidebarTab) => {
    if (nextTab !== tab) flushMetadataDrafts();
    onTabChange(nextTab);
  }, [flushMetadataDrafts, onTabChange, tab]);
  const handleOpenDocument = useCallback((id: string) => {
    setContentsQuery("");
    onOpenDocumentRef.current(id);
  }, []);
  const handleConfirmDelete = useCallback((id: string) => {
    setPendingDeleteId(null);
    onDeleteDocumentRef.current(id);
  }, []);
  const handleCancelDelete = useCallback(() => setPendingDeleteId(null), []);

  // Resetting during render rather than in an effect: these are derived
  // resets, and an effect would render the stale drafts once before clearing.
  // A confirm armed before closing must not still be armed on reopen, and it
  // must not follow the user across tabs either; likewise a half-typed title
  // must never leak into the next document's field.
  if (draftScope.open !== open || draftScope.tab !== tab || draftScope.documentId !== activeDocumentId) {
    setDraftScope({ open, tab, documentId: activeDocumentId });
    setPendingDeleteId(null);
    setTitleDraft(null);
    setAuthorDraft(null);
  }

  // Relative times are rendered from a clock snapshot, so without a ticker
  // "Just now" would survive until some unrelated render refreshed it. The
  // frame callback re-reads the clock on open, where the snapshot is stalest.
  useEffect(() => {
    if (!open) return;
    const refresh = () => setNow(Date.now());
    const frame = window.requestAnimationFrame(refresh);
    const timer = window.setInterval(refresh, RELATIVE_TIME_REFRESH_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, [open]);

  // Committing per keystroke re-sorts the library and schedules a write for
  // every character; the draft settles first and blur flushes it immediately.
  useEffect(() => {
    if (titleDraft === null || titleDraft === activeTitle) return;
    const timer = window.setTimeout(
      () => onUpdateMetadataRef.current({ title: titleDraft }),
      METADATA_COMMIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [activeTitle, titleDraft]);
  useEffect(() => {
    if (authorDraft === null || authorDraft === activeAuthor) return;
    const timer = window.setTimeout(
      () => onUpdateMetadataRef.current({ author: authorDraft }),
      METADATA_COMMIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [activeAuthor, authorDraft]);
  const commitTitle = () => {
    if (titleDraft !== null && titleDraft !== activeTitle) onUpdateMetadata({ title: titleDraft });
    setTitleDraft(null);
  };
  const commitAuthor = () => {
    if (authorDraft !== null && authorDraft !== activeAuthor) onUpdateMetadata({ author: authorDraft });
    setAuthorDraft(null);
  };

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      // The drawer floats above the page, so an untrapped Tab walks into
      // controls the user cannot see behind it. Mirrors the reader popovers.
      if (event.key !== "Tab" || !sidebarRef.current) return;
      const focusable = [...sidebarRef.current.querySelectorAll<HTMLElement>(SIDEBAR_FOCUSABLE_SELECTOR)]
        .filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) {
        event.preventDefault();
        sidebarRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !sidebarRef.current.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !sidebarRef.current.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, [handleClose, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      // Arrow-key tab navigation already placed focus on the tab itself; the
      // search field must not steal it back or the next arrow types instead.
      if (keyboardTabNavRef.current) {
        keyboardTabNavRef.current = false;
        return;
      }
      if (tab === "search") {
        searchInputRef.current?.focus();
      } else if (!sidebarRef.current?.contains(document.activeElement)) {
        closeButtonRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, tab]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    let next = -1;
    if (step !== 0) {
      const index = TABS.findIndex((item) => item.key === tab);
      next = (index + step + TABS.length) % TABS.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = TABS.length - 1;
    }
    if (next === -1) return;
    event.preventDefault();
    keyboardTabNavRef.current = true;
    handleTabChange(TABS[next].key);
    // Roving tabIndex moves with the selection, so focus has to follow it.
    sidebarRef.current?.querySelectorAll<HTMLElement>("[role='tab']")[next]?.focus();
  };

  if (!open) return null;

  const activeTabLabel = TABS.find((item) => item.key === tab)?.label ?? "Library";
  const chapterSpan = currentChapter ? currentChapter.end - currentChapter.start : 0;
  const chapterPercent = chapterSpan > 0 && currentChapter
    ? Math.round(((currentTextOffset - currentChapter.start) / chapterSpan) * 100)
    : null;
  const bookmarkChapterLabel = currentChapter && currentChapter.title.length > BOOKMARK_LABEL_LIMIT
    ? `${currentChapter.title.slice(0, BOOKMARK_LABEL_LIMIT).trimEnd()}…`
    : currentChapter?.title ?? "";

  return (
    <>
      {/* Click-away close and a mobile scrim. Desktop keeps the reader legible
          beside the drawer, so the scrim is transparent there — it still
          catches the click that dismisses the drawer.
          z-45 sits above the reader's fullscreen player dock (z-40, and later in
          the DOM) so the dock cannot stay clickable through the scrim, and below
          the drawer itself (z-50). */}
      <div
        aria-hidden
        onClick={handleClose}
        className="fixed inset-0 z-[45] bg-black/20 md:bg-transparent"
      />
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
            ref={closeButtonRef}
            type="button"
            onClick={handleClose}
            aria-label="Close Reader library"
            className="flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-white/55 hover:text-text-primary active:scale-[0.98]"
          >
            <X size={17} />
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Reader library sections"
          className="grid grid-cols-5 gap-1 border-b border-black/5 p-2"
        >
          {TABS.map((item) => {
            const Icon = item.icon;
            const selected = tab === item.key;
            return (
              <button
                key={item.key}
                id={`${tabsId}-tab-${item.key}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${tabsId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => handleTabChange(item.key)}
                onKeyDown={handleTabKeyDown}
                className={`flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-2xs font-medium transition-all active:scale-[0.98] ${
                  selected
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

        <div
          id={`${tabsId}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto p-3"
        >
          {tab !== "library" && !activeDocument && (
            <div className="rounded-2xl border border-dashed border-border p-5 text-center">
              <BookOpen size={20} className="mx-auto text-text-muted" />
              <p className="mt-2 text-sm font-medium text-text-secondary">No document open</p>
              <p className="mt-1 text-xs text-text-muted">
                Open a document from the Library tab to use {activeTabLabel.toLocaleLowerCase()}.
              </p>
            </div>
          )}

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
                  {documents.map((record) => (
                    <DocumentCard
                      key={record.id}
                      record={record}
                      active={record.id === activeDocumentId}
                      openedLabel={formatRelativeTime(record.lastOpenedAt, now)}
                      confirmingDelete={pendingDeleteId === record.id}
                      onOpen={handleOpenDocument}
                      onRequestDelete={setPendingDeleteId}
                      onCancelDelete={handleCancelDelete}
                      onConfirmDelete={handleConfirmDelete}
                    />
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
                    value={titleDraft ?? activeTitle}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onBlur={commitTitle}
                    className="mt-1.5 w-full rounded-xl border border-white/50 bg-white/40 px-3 py-2 text-sm normal-case tracking-normal text-text-primary outline-none focus:border-accent/40"
                  />
                </label>
                <label className="block text-2xs font-semibold uppercase tracking-widest text-text-muted">
                  Author
                  <input
                    value={authorDraft ?? activeAuthor}
                    placeholder="Unknown author"
                    onChange={(event) => setAuthorDraft(event.target.value)}
                    onBlur={commitAuthor}
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
                  ref={searchInputRef}
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search this document"
                  className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                />
              </label>
              {settledSearchQuery.trim().length < 2 ? (
                <p className="rounded-2xl border border-dashed border-border p-5 text-center text-sm text-text-muted">
                  Type at least two characters to search the full text.
                </p>
              ) : searchResults.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border p-5 text-center text-sm text-text-muted">
                  No matches for “{settledSearchQuery.trim()}”.
                </p>
              ) : (
                <div className="space-y-1">
                  {searchResults.map((result) => {
                    const chapter = chapters.find(
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
                  // Bookmarks landing in the same chapter would otherwise all read
                  // as the chapter title; the position within it tells them apart.
                  label: bookmarkChapterLabel
                    ? `${bookmarkChapterLabel}${chapterPercent === null ? "" : ` · ${chapterPercent}%`}`
                    : `Bookmark ${activeDocument.bookmarks.length + 1}`,
                  textOffset: currentTextOffset,
                  positionSec: clock.getTime(),
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
    </>
  );
}

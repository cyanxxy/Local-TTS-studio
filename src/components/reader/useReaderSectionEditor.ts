import { useCallback, useEffect, useRef, useState } from "react";

/** Re-sectioning the document on every keystroke is expensive, so commits settle first. */
export const READER_EDIT_COMMIT_DELAY_MS = 400;

interface UseReaderSectionEditorOptions {
  /** The open document; an edit belongs to the document it started in. */
  documentId: string | null;
  /** The active section's text, which seeds the draft. */
  text: string;
  onTextChange: (text: string) => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
}

export interface ReaderSectionEditor {
  editing: boolean;
  /** The text being edited; only meaningful while `editing`. */
  draft: string;
  startEditing: () => void;
  /** Commits the draft and leaves the editor. A no-op when not editing. */
  finishEditing: () => void;
  /** Updates the draft and schedules a debounced upstream commit. */
  changeDraft: (value: string) => void;
  /** Commits the draft now without leaving the editor, e.g. on blur. */
  commitDraft: () => void;
}

interface EditSession {
  documentId: string | null;
  draft: string;
}

/**
 * The Reader's in-place section editor. The session is tagged with the document
 * it started in, so a switch to another book ends it by derivation instead of an
 * effect resetting state a frame late; an in-progress edit still survives the
 * section id churn that re-chaptering the same book causes.
 */
export function useReaderSectionEditor({
  documentId,
  text,
  onTextChange,
  onEditStart,
  onEditEnd,
}: UseReaderSectionEditorOptions): ReaderSectionEditor {
  const [session, setSession] = useState<EditSession | null>(null);
  const editing = session !== null && session.documentId === documentId;
  const draft = editing ? session.draft : "";
  const commitTimerRef = useRef<number | null>(null);
  // Teardown runs outside render and must see the latest session and handlers.
  const latestRef = useRef({ editing, draft, onTextChange, onEditEnd });
  useEffect(() => {
    latestRef.current = { editing, draft, onTextChange, onEditEnd };
  });

  const cancelCommit = useCallback(() => {
    if (commitTimerRef.current === null) return false;
    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    return true;
  }, []);

  const startEditing = useCallback(() => {
    setSession({ documentId, draft: text });
    onEditStart?.();
  }, [documentId, onEditStart, text]);

  const finishEditing = useCallback(() => {
    if (!editing) return;
    cancelCommit();
    onTextChange(draft);
    onEditEnd?.();
    latestRef.current = { ...latestRef.current, editing: false };
    setSession(null);
  }, [cancelCommit, draft, editing, onEditEnd, onTextChange]);

  const changeDraft = useCallback((value: string) => {
    setSession((current) => (current ? { ...current, draft: value } : current));
    cancelCommit();
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null;
      latestRef.current.onTextChange(value);
    }, READER_EDIT_COMMIT_DELAY_MS);
  }, [cancelCommit]);

  const commitDraft = useCallback(() => {
    if (!editing) return;
    cancelCommit();
    onTextChange(draft);
  }, [cancelCommit, draft, editing, onTextChange]);

  // Leaving the Reader keeps the edit: the pending commit is flushed into the
  // document it was typed in before the editor goes away.
  useEffect(() => () => {
    const latest = latestRef.current;
    if (cancelCommit() && latest.editing) latest.onTextChange(latest.draft);
    if (latest.editing) latest.onEditEnd?.();
    latestRef.current = { ...latest, editing: false };
  }, [cancelCommit]);

  // A document switch driven from outside the Reader's own controls (those
  // finish the edit first) ends the session. A pending commit belongs to the
  // previous document; letting it fire now would write stale text into the
  // newly opened one.
  useEffect(() => () => {
    const latest = latestRef.current;
    cancelCommit();
    if (latest.editing) latest.onEditEnd?.();
    latestRef.current = { ...latest, editing: false };
  }, [cancelCommit, documentId]);

  return { editing, draft, startEditing, finishEditing, changeDraft, commitDraft };
}

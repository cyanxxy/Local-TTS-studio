import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentsBridge } from "../electron";
import { unwrapHardLineBreaks, type ReaderDocumentInput } from "../lib/readerDocument";

// Document import pulls in Readability and a zip reader — roughly a tenth of the
// entry chunk — but is only ever reached from a user-initiated import, which is
// already asynchronous. Load it on demand instead of at startup.
const loadReaderImport = () => import("../lib/readerImport");

interface UseDocumentImportOptions {
  /** The desktop import bridge; web builds have none. */
  documentsBridge: DocumentsBridge | undefined;
  /** Imports become Reader documents on the Reader and the Studio script elsewhere. */
  isReaderPage: boolean;
  createReaderDocument: (input: ReaderDocumentInput) => Promise<unknown>;
  /** Replaces the Studio script with imported text. */
  onStudioText: (text: string) => void;
  /** Receives an import failure, or null when a new import starts. */
  setImportError: (message: string | null) => void;
}

export interface UseDocumentImportReturn {
  isImportingDocument: boolean;
  /** Opens the desktop import dialog; undefined on builds without the bridge. */
  importDocument: (() => Promise<void>) | undefined;
  importReaderFile: (file: File) => Promise<void>;
  /** Rejects with a readable message: the Reader's URL popover owns the failure. */
  importReaderUrl: (url: string) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Imports files, desktop documents and article URLs. One import runs at a time. */
export function useDocumentImport({
  documentsBridge,
  isReaderPage,
  createReaderDocument,
  onStudioText,
  setImportError,
}: UseDocumentImportOptions): UseDocumentImportReturn {
  const [isImportingDocument, setIsImportingDocument] = useState(false);
  const importInFlightRef = useRef(false);

  // An import can take minutes (OCR); by then the click-time Studio handler is
  // stale and would read audio/generation state from before the import
  // started, skipping the cancel-and-reset it exists to guarantee. Always apply
  // the result through the latest handler.
  const onStudioTextRef = useRef(onStudioText);
  useEffect(() => {
    onStudioTextRef.current = onStudioText;
  }, [onStudioText]);

  const beginImport = useCallback(() => {
    importInFlightRef.current = true;
    setImportError(null);
    setIsImportingDocument(true);
  }, [setImportError]);

  const endImport = useCallback(() => {
    importInFlightRef.current = false;
    setIsImportingDocument(false);
  }, []);

  const importDesktopDocument = useCallback(async () => {
    if (!documentsBridge || importInFlightRef.current) return;
    beginImport();
    try {
      const result = await documentsBridge.importDocument();
      if (result.canceled) return;
      if (result.epubBytes) {
        const { parseEpubDocument } = await loadReaderImport();
        const document = parseEpubDocument(new Uint8Array(result.epubBytes), result.fileName);
        if (isReaderPage) await createReaderDocument(document);
        else onStudioTextRef.current(document.text);
      } else if (isReaderPage && /\.md$/i.test(result.fileName)) {
        const { parseMarkdownReaderDocument } = await loadReaderImport();
        await createReaderDocument(parseMarkdownReaderDocument(result.text, result.fileName));
      } else {
        // PDF and OCR text arrives hard-wrapped at the page's line width.
        const text = /\.(pdf|png|jpe?g|tiff?|webp)$/i.test(result.fileName)
          ? unwrapHardLineBreaks(result.text)
          : result.text;
        if (isReaderPage) {
          await createReaderDocument({
            title: result.fileName.replace(/\.[^.]+$/, ""),
            description: result.pageCount ? `${result.pageCount} pages` : "",
            sourceType: "file",
            sourceName: result.fileName,
            text,
          });
        } else {
          onStudioTextRef.current(text);
        }
      }
    } catch (error) {
      // ipcRenderer.invoke wraps main-process errors in a remote-method prefix;
      // strip it so users see only the actionable message.
      setImportError(errorMessage(error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    } finally {
      endImport();
    }
  }, [beginImport, createReaderDocument, documentsBridge, endImport, isReaderPage, setImportError]);

  const importReaderFile = useCallback(async (file: File) => {
    if (importInFlightRef.current) return;
    beginImport();
    try {
      const { importReaderFile: parseReaderFile } = await loadReaderImport();
      await createReaderDocument(await parseReaderFile(file));
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      endImport();
    }
  }, [beginImport, createReaderDocument, endImport, setImportError]);

  const importReaderUrl = useCallback(async (url: string) => {
    if (importInFlightRef.current) throw new Error("Another document import is still running.");
    beginImport();
    try {
      const { fetchRemoteDocument, parseHtmlReaderDocument } = await loadReaderImport();
      const payload = documentsBridge?.importUrl
        ? await documentsBridge.importUrl(url)
        : await fetchRemoteDocument(url);
      await createReaderDocument(parseHtmlReaderDocument(payload));
    } catch (error) {
      let message = errorMessage(error);
      if (!documentsBridge && /failed to fetch|networkerror|load failed/i.test(message)) {
        message = "This site blocks direct browser imports. Use the desktop app for cross-origin article URLs.";
      }
      // AdvancedReaderPage owns URL-import failures while its popover remains
      // open. Storing the same rejection here also renders the global banner,
      // duplicating the message and leaving it behind after the popover closes.
      throw new Error(message, { cause: error });
    } finally {
      endImport();
    }
  }, [beginImport, createReaderDocument, documentsBridge, endImport]);

  return {
    isImportingDocument,
    importDocument: documentsBridge ? importDesktopDocument : undefined,
    importReaderFile,
    importReaderUrl,
  };
}

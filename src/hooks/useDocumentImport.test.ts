import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentImportResult, DocumentsBridge } from "../electron";
import { useDocumentImport } from "./useDocumentImport";

const readerImport = vi.hoisted(() => ({
  parseEpubDocument: vi.fn((_bytes: Uint8Array, fileName: string) => ({ title: fileName, text: "EPUB body text." })),
  parseMarkdownReaderDocument: vi.fn((text: string, fileName: string) => ({ title: fileName, text })),
  importReaderFile: vi.fn(async (file: File) => ({ title: file.name, text: "File text." })),
  fetchRemoteDocument: vi.fn(async (url: string) => ({ requestedUrl: url, finalUrl: url, contentType: "text/html", html: "<p>Hi</p>" })),
  parseHtmlReaderDocument: vi.fn((payload: { finalUrl: string }) => ({ title: payload.finalUrl, text: "Article text." })),
}));

vi.mock("../lib/readerImport", () => readerImport);

function bridge(result: DocumentImportResult | Error): DocumentsBridge {
  return {
    importDocument: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    importUrl: vi.fn(async (url: string) => ({ requestedUrl: url, finalUrl: url, contentType: "text/html", html: "" })),
  };
}

function setup(options: Partial<Parameters<typeof useDocumentImport>[0]> = {}) {
  const props = {
    documentsBridge: undefined as DocumentsBridge | undefined,
    isReaderPage: true,
    createReaderDocument: vi.fn(async () => undefined),
    onStudioText: vi.fn(),
    setImportError: vi.fn(),
    ...options,
  };
  const hook = renderHook((current: typeof props) => useDocumentImport(current), { initialProps: props });
  return { props, ...hook };
}

describe("useDocumentImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers the desktop dialog only with a documents bridge", () => {
    expect(setup().result.current.importDocument).toBeUndefined();
    expect(setup({ documentsBridge: bridge({ canceled: true }) }).result.current.importDocument).toBeTypeOf("function");
  });

  it("creates Reader documents from desktop PDFs, Markdown and EPUBs", async () => {
    const pdf = setup({
      documentsBridge: bridge({ canceled: false, fileName: "Report.pdf", text: "Line one\nline two.", pageCount: 3 }),
    });
    await act(() => pdf.result.current.importDocument!());
    expect(pdf.props.createReaderDocument).toHaveBeenCalledWith({
      title: "Report",
      description: "3 pages",
      sourceType: "file",
      sourceName: "Report.pdf",
      text: "Line one line two.",
    });
    expect(pdf.props.setImportError).toHaveBeenCalledWith(null);

    const markdown = setup({ documentsBridge: bridge({ canceled: false, fileName: "notes.md", text: "# Notes" }) });
    await act(() => markdown.result.current.importDocument!());
    expect(markdown.props.createReaderDocument).toHaveBeenCalledWith({ title: "notes.md", text: "# Notes" });

    const epub = setup({
      documentsBridge: bridge({ canceled: false, fileName: "book.epub", text: "", epubBytes: new Uint8Array([1]) }),
    });
    await act(() => epub.result.current.importDocument!());
    expect(epub.props.createReaderDocument).toHaveBeenCalledWith({ title: "book.epub", text: "EPUB body text." });
  });

  it("puts desktop imports into the Studio script through the latest handler", async () => {
    let finishImport: (result: DocumentImportResult) => void = () => undefined;
    const documentsBridge = bridge({ canceled: true });
    vi.mocked(documentsBridge.importDocument).mockReturnValue(new Promise((resolve) => {
      finishImport = resolve;
    }));
    const { props, result, rerender } = setup({ documentsBridge, isReaderPage: false });

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.importDocument!();
    });
    expect(result.current.isImportingDocument).toBe(true);
    const latest = vi.fn();
    rerender({ ...props, onStudioText: latest });
    await act(async () => {
      finishImport({ canceled: false, fileName: "scan.png", text: "Scanned\ntext." });
      await pending;
    });

    expect(props.onStudioText).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith("Scanned text.");
    expect(result.current.isImportingDocument).toBe(false);
  });

  it("parses a Studio EPUB into the script and ignores a cancelled dialog", async () => {
    const epub = setup({
      isReaderPage: false,
      documentsBridge: bridge({ canceled: false, fileName: "book.epub", text: "", epubBytes: new Uint8Array([1]) }),
    });
    await act(() => epub.result.current.importDocument!());
    expect(epub.props.onStudioText).toHaveBeenCalledWith("EPUB body text.");

    const cancelled = setup({ isReaderPage: false, documentsBridge: bridge({ canceled: true }) });
    await act(() => cancelled.result.current.importDocument!());
    expect(cancelled.props.onStudioText).not.toHaveBeenCalled();
    expect(cancelled.props.createReaderDocument).not.toHaveBeenCalled();
  });

  it("reports desktop failures without the IPC wrapper", async () => {
    const { props, result } = setup({
      documentsBridge: bridge(new Error("Error invoking remote method 'documents:import': Error: OCR failed")),
    });
    await act(() => result.current.importDocument!());

    expect(props.setImportError).toHaveBeenLastCalledWith("OCR failed");
    expect(result.current.isImportingDocument).toBe(false);
  });

  it("imports a dropped file and reports its failure", async () => {
    const { props, result } = setup();
    await act(() => result.current.importReaderFile(new File(["x"], "book.txt")));
    expect(props.createReaderDocument).toHaveBeenCalledWith({ title: "book.txt", text: "File text." });

    readerImport.importReaderFile.mockRejectedValueOnce(new Error("Unsupported file"));
    await act(() => result.current.importReaderFile(new File(["x"], "book.bin")));
    expect(props.setImportError).toHaveBeenLastCalledWith("Unsupported file");
  });

  it("runs one import at a time", async () => {
    let finishFile: () => void = () => undefined;
    readerImport.importReaderFile.mockReturnValueOnce(new Promise((resolve) => {
      finishFile = () => resolve({ title: "slow", text: "Slow file." });
    }));
    const { props, result } = setup();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.importReaderFile(new File(["x"], "slow.txt"));
    });

    await act(() => result.current.importReaderFile(new File(["x"], "second.txt")));
    await expect(result.current.importReaderUrl("https://example.com")).rejects.toThrow(
      "Another document import is still running.",
    );
    await act(async () => {
      finishFile();
      await pending;
    });
    expect(props.createReaderDocument).toHaveBeenCalledTimes(1);
  });

  it("imports URLs through the desktop bridge, or fetches them on the web", async () => {
    const documentsBridge = bridge({ canceled: true });
    const desktop = setup({ documentsBridge });
    await act(() => desktop.result.current.importReaderUrl("https://example.com/a"));
    expect(documentsBridge.importUrl).toHaveBeenCalledWith("https://example.com/a");
    expect(readerImport.fetchRemoteDocument).not.toHaveBeenCalled();
    expect(desktop.props.createReaderDocument).toHaveBeenCalledWith({ title: "https://example.com/a", text: "Article text." });

    const web = setup();
    await act(() => web.result.current.importReaderUrl("https://example.com/b"));
    expect(readerImport.fetchRemoteDocument).toHaveBeenCalledWith("https://example.com/b");
  });

  it("rejects URL failures for the Reader popover instead of the banner", async () => {
    const web = setup();
    readerImport.fetchRemoteDocument.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => {
      await expect(web.result.current.importReaderUrl("https://blocked.example")).rejects.toThrow(
        "This site blocks direct browser imports.",
      );
    });
    expect(web.props.setImportError).not.toHaveBeenCalledWith(expect.stringContaining("blocks"));
    expect(web.result.current.isImportingDocument).toBe(false);

    const documentsBridge = bridge({ canceled: true });
    vi.mocked(documentsBridge.importUrl).mockRejectedValueOnce(new Error("Failed to fetch"));
    const desktop = setup({ documentsBridge });
    await act(async () => {
      await expect(desktop.result.current.importReaderUrl("https://down.example")).rejects.toThrow("Failed to fetch");
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  IMPORT_DIALOG_FILTERS,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_TEXT_CHARS,
  importDocumentFromDialog,
  importDocumentFromPath,
  isSupportedImportExtension,
  type DocumentParser,
  type ImportFs,
} from "./documentImport";

function makeFs(overrides: Partial<ImportFs> = {}): ImportFs {
  return {
    stat: vi.fn().mockResolvedValue({ size: 1024 }),
    readFile: vi.fn().mockResolvedValue("plain file text"),
    ...overrides,
  };
}

function makeParserFactory(parser: DocumentParser) {
  return vi.fn().mockResolvedValue(parser);
}

const passthroughParser: DocumentParser = {
  parse: vi.fn().mockResolvedValue({ text: "parsed document text", pageCount: 3 }),
};

describe("isSupportedImportExtension", () => {
  it("accepts the documented extensions", () => {
    for (const ext of [".pdf", ".txt", ".md", ".docx", ".pptx", ".odt", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"]) {
      expect(isSupportedImportExtension(ext)).toBe(true);
    }
  });

  it("rejects unknown extensions", () => {
    expect(isSupportedImportExtension(".epub")).toBe(false);
    expect(isSupportedImportExtension("")).toBe(false);
  });

  it("matches the dialog filter list", () => {
    const documents = IMPORT_DIALOG_FILTERS[0];
    for (const ext of documents.extensions) {
      expect(isSupportedImportExtension(`.${ext}`)).toBe(true);
    }
  });
});

describe("importDocumentFromPath", () => {
  it("reads plain text files without invoking the parser", async () => {
    const parserFactory = makeParserFactory(passthroughParser);
    const fsApi = makeFs({ readFile: vi.fn().mockResolvedValue("hello reader\r\nnext line") });
    const result = await importDocumentFromPath("/tmp/story.txt", parserFactory, fsApi);
    expect(result).toEqual({
      canceled: false,
      fileName: "story.txt",
      text: "hello reader\nnext line",
      pageCount: undefined,
    });
    expect(parserFactory).not.toHaveBeenCalled();
  });

  it("parses PDFs through the parser factory and reports page count", async () => {
    const parserFactory = makeParserFactory(passthroughParser);
    const result = await importDocumentFromPath("/tmp/paper.PDF", parserFactory, makeFs());
    expect(result.canceled).toBe(false);
    expect(result.text).toBe("parsed document text");
    expect(result.pageCount).toBe(3);
    expect(passthroughParser.parse).toHaveBeenCalledWith("/tmp/paper.PDF");
  });

  it("collapses excess blank lines and trims parser output", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockResolvedValue({ text: "\n\npage one\n\n\n\npage two\n\n" }),
    };
    const result = await importDocumentFromPath("/tmp/doc.pdf", makeParserFactory(parser), makeFs());
    expect(result.text).toBe("page one\n\npage two");
  });

  it("rejects unsupported extensions without touching the filesystem", async () => {
    const fsApi = makeFs();
    await expect(
      importDocumentFromPath("/tmp/book.epub", makeParserFactory(passthroughParser), fsApi),
    ).rejects.toThrow("Unsupported file type: .epub");
    expect(fsApi.stat).not.toHaveBeenCalled();
  });

  it("rejects oversized files before parsing", async () => {
    const fsApi = makeFs({ stat: vi.fn().mockResolvedValue({ size: MAX_IMPORT_FILE_BYTES + 1 }) });
    const parserFactory = makeParserFactory(passthroughParser);
    await expect(
      importDocumentFromPath("/tmp/huge.pdf", parserFactory, fsApi),
    ).rejects.toThrow('"huge.pdf" is too large to import (limit 100 MB).');
    expect(parserFactory).not.toHaveBeenCalled();
  });

  it("errors when no readable text is found", async () => {
    const parser: DocumentParser = { parse: vi.fn().mockResolvedValue({ text: "  \n\n " }) };
    await expect(
      importDocumentFromPath("/tmp/scan.pdf", makeParserFactory(parser), makeFs()),
    ).rejects.toThrow('No readable text found in "scan.pdf".');
  });

  it("maps LibreOffice failures for office documents to an actionable message", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockRejectedValue(new Error("soffice binary not found in PATH")),
    };
    await expect(
      importDocumentFromPath("/tmp/report.docx", makeParserFactory(parser), makeFs()),
    ).rejects.toThrow("Importing .docx files requires LibreOffice. Install LibreOffice and try again.");
  });

  it("maps ImageMagick failures for images to an actionable message", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockRejectedValue(new Error("ImageMagick convert failed")),
    };
    await expect(
      importDocumentFromPath("/tmp/page.png", makeParserFactory(parser), makeFs()),
    ).rejects.toThrow("Importing .png images requires ImageMagick. Install ImageMagick and try again.");
  });

  it("rejects results that exceed the text cap", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockResolvedValue({ text: "a".repeat(MAX_IMPORT_TEXT_CHARS + 1) }),
    };
    await expect(
      importDocumentFromPath("/tmp/tome.pdf", makeParserFactory(parser), makeFs()),
    ).rejects.toThrow('"tome.pdf" contains too much text to import (limit 1,500,000 characters).');
  });

  it("maps Ghostscript failures to an actionable message", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockRejectedValue(new Error("Ghostscript is required to convert this file")),
    };
    await expect(
      importDocumentFromPath("/tmp/page.tif", makeParserFactory(parser), makeFs()),
    ).rejects.toThrow('Importing "page.tif" requires Ghostscript. Install Ghostscript and try again.');
  });

  it("maps failed tessdata downloads to an actionable offline message", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockRejectedValue(new Error('failed to download tessdata for language "eng"')),
    };
    await expect(
      importDocumentFromPath("/tmp/scan.pdf", makeParserFactory(parser), makeFs()),
    ).rejects.toThrow(
      "Reading scanned pages needs a one-time download of OCR language data, which failed. Check your internet connection and try again.",
    );
  });

  it("only treats encryption errors as password protection for PDFs", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockRejectedValue(new Error("Microsoft Encrypted File System stub")),
    };
    await expect(
      importDocumentFromPath("/tmp/deck.pptx", makeParserFactory(parser), makeFs()),
    ).rejects.toThrow('Failed to import "deck.pptx": Microsoft Encrypted File System stub');
  });

  it("maps encrypted-document failures to an actionable message", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockRejectedValue(new Error("document is encrypted")),
    };
    await expect(
      importDocumentFromPath("/tmp/secret.pdf", makeParserFactory(parser), makeFs()),
    ).rejects.toThrow('"secret.pdf" is password protected and cannot be imported.');
  });

  it("wraps other parser failures with the file name", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockRejectedValue(new Error("corrupt xref table")),
    };
    await expect(
      importDocumentFromPath("/tmp/broken.pdf", makeParserFactory(parser), makeFs()),
    ).rejects.toThrow('Failed to import "broken.pdf": corrupt xref table');
  });

  it("surfaces parser-load failures through the same normalization", async () => {
    const parserFactory = vi.fn().mockRejectedValue(new Error("Cannot find module"));
    await expect(
      importDocumentFromPath("/tmp/doc.pdf", parserFactory, makeFs()),
    ).rejects.toThrow('Failed to import "doc.pdf": Cannot find module');
  });
});

describe("importDocumentFromDialog", () => {
  it("returns canceled when the user dismisses the dialog", async () => {
    const dialogApi = {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    };
    const parserFactory = makeParserFactory(passthroughParser);
    const result = await importDocumentFromDialog(dialogApi, parserFactory, makeFs());
    expect(result).toEqual({ canceled: true });
    expect(parserFactory).not.toHaveBeenCalled();
  });

  it("opens a single-file dialog with the documented filters and imports the pick", async () => {
    const dialogApi = {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ["/tmp/pick.txt"] }),
    };
    const fsApi = makeFs({ readFile: vi.fn().mockResolvedValue("picked text") });
    const result = await importDocumentFromDialog(dialogApi, makeParserFactory(passthroughParser), fsApi);
    expect(dialogApi.showOpenDialog).toHaveBeenCalledWith({
      title: "Import document",
      properties: ["openFile"],
      filters: IMPORT_DIALOG_FILTERS,
    });
    expect(result).toEqual({
      canceled: false,
      fileName: "pick.txt",
      text: "picked text",
      pageCount: undefined,
    });
  });
});

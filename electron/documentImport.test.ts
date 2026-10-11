import { describe, expect, it, vi } from "vitest";
import {
  IMPORT_DIALOG_FILTERS,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_TEXT_CHARS,
  importDocumentFromDialog,
  importDocumentFromPath,
  isSupportedImportExtension,
  stripPageFurniture,
  type DocumentParser,
  type ImportFs,
} from "./documentImport";

function makeFs(overrides: Partial<ImportFs> = {}): ImportFs {
  return {
    stat: vi.fn().mockResolvedValue({ size: 1024 }),
    readFile: vi.fn().mockResolvedValue("plain file text"),
    readBinaryFile: vi.fn().mockResolvedValue(new Uint8Array([80, 75, 3, 4])),
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
    for (const ext of [".epub", ".pdf", ".txt", ".md", ".docx", ".pptx", ".odt", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"]) {
      expect(isSupportedImportExtension(ext)).toBe(true);
    }
  });

  it("rejects unknown extensions", () => {
    expect(isSupportedImportExtension(".mobi")).toBe(false);
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

  it("returns EPUB bytes for structured parsing in the renderer", async () => {
    const fsApi = makeFs({ readBinaryFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])) });
    const result = await importDocumentFromPath("/tmp/book.epub", makeParserFactory(passthroughParser), fsApi);
    expect(result).toEqual({
      canceled: false,
      fileName: "book.epub",
      text: "",
      epubBytes: new Uint8Array([1, 2, 3]),
    });
  });

  it("rejects unsupported extensions without touching the filesystem", async () => {
    const fsApi = makeFs();
    await expect(
      importDocumentFromPath("/tmp/book.mobi", makeParserFactory(passthroughParser), fsApi),
    ).rejects.toThrow("Unsupported file type: .mobi");
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

const BODY_WORDS = [
  "amber", "birch", "cedar", "delta", "ember", "fjord", "grove", "harbor", "inlet", "juniper", "kestrel", "lagoon",
];

// Body lines differ by words, not digits, because furniture matching groups
// lines that differ only by their digits; real prose never repeats line for
// line across pages.
function bodyLines(index: number): string {
  const word = BODY_WORDS[index];
  return `The ${word} paragraph begins on this page and\ncontinues the ${word} story to its end.`;
}

const RUNNING_HEADER = (page: number) => `The Lighthouse Keeper   Chapter ${Math.ceil(page / 4)}`;

// A book fixture: every page carries a running header, a body, and a footer
// page number, as LiteParse reports them for a typeset PDF.
function bookPages(count = 10): string[] {
  return Array.from({ length: count }, (_, index) => {
    const page = index + 1;
    return [RUNNING_HEADER(page), "", bodyLines(index), "", `Page ${page} of ${count}`].join("\n");
  });
}

describe("stripPageFurniture", () => {
  it("removes running headers and footers that repeat at page edges, keeping the first page's header", () => {
    const pages = bookPages().map((page) => `${page}\n© 2026 Lighthouse Press`);
    const stripped = stripPageFurniture(pages);
    expect(stripped).toHaveLength(10);
    expect(stripped[0].trim()).toBe(`${RUNNING_HEADER(1)}\n\n${bodyLines(0)}`);
    for (const [index, page] of stripped.slice(1).entries()) {
      expect(page.trim()).toBe(bodyLines(index + 1));
    }
  });

  it("removes page numbers that advance with the page, in every supported format", () => {
    const roman = ["i", "ii", "iii", "iv", "v", "vi"];
    const formats: ((page: number) => string)[] = [
      (page) => `${page + 11}`,
      (page) => `- ${page + 3} -`,
      (page) => `Page ${page + 1}`,
      (page) => `${page + 40} / 300`,
      (page) => `— ${page + 7} —`,
      (page) => `p. ${page + 2}`,
      (page) => roman[page],
      (page) => `- ${roman[page]} -`,
      (page) => `Page ${page + 1} of 6`,
    ];
    for (const format of formats) {
      // Numbers alternate between page tops and bottoms, like a two-sided book.
      const pages = Array.from({ length: 6 }, (_, page) => (
        page % 2 === 0 ? `${format(page)}\n${bodyLines(page)}` : `${bodyLines(page)}\n${format(page)}`
      ));
      expect(stripPageFurniture(pages)).toEqual(pages.map((_, page) => bodyLines(page)));
    }
  });

  it("removes page numbers set apart from a running title", () => {
    const pages = Array.from({ length: 6 }, (_, page) => (
      page % 2 === 0
        ? `${page + 12}     THE LIGHTHOUSE KEEPER\n${bodyLines(page)}`
        : `Chapter One | ${page + 12}\n${bodyLines(page)}`
    ));
    expect(stripPageFurniture(pages)).toEqual(pages.map((_, page) => bodyLines(page)));
  });

  it("keeps edge numbers that do not advance with the page", () => {
    const pages = Array.from({ length: 6 }, (_, page) => `${bodyLines(page)}\n${page + 1}`);
    pages[2] = "1984";
    pages[3] = `Year founded\n1887\n${4}`;
    const stripped = stripPageFurniture(pages);
    expect(stripped[2]).toBe("1984");
    expect(stripped[3]).toBe("Year founded\n1887");
    expect(stripped[4]).toBe(bodyLines(4));
  });

  it("keeps numbers that never repeat as a page-number sequence", () => {
    const pages = ["1984\nA novel opens here.", "Second page body.", "Third page body.", "Year founded\n1887"];
    expect(stripPageFurniture(pages)).toEqual(pages);
  });

  it("keeps per-page headings whose number changes on every page", () => {
    for (const heading of [(n: number) => `Question ${n}`, (n: number) => `Step ${n}: Mix`, (n: number) => `Day ${n}`]) {
      const pages = Array.from({ length: 6 }, (_, page) => `${heading(page + 1)}\n${bodyLines(page)}`);
      expect(stripPageFurniture(pages)).toEqual(pages);
    }
  });

  it("keeps the document title on its first page when the running header repeats it", () => {
    const pages = [
      "",
      "The Lighthouse Keeper\nA Novel",
      ...Array.from({ length: 5 }, (_, page) => `The Lighthouse Keeper\n${bodyLines(page)}`),
    ];
    expect(stripPageFurniture(pages)).toEqual([
      "",
      "The Lighthouse Keeper\nA Novel",
      ...Array.from({ length: 5 }, (_, page) => bodyLines(page)),
    ]);
  });

  it("keeps numbers and roman-letter words that sit inside the body or are not page numbers", () => {
    const pages = [
      "Intro line\n12\nThe body keeps an inner 12.\nMore body\nOutro line",
      "mix\nA lone word made of roman letters stays.",
      "I\nA capital pronoun stays too.",
    ];
    expect(stripPageFurniture(pages)).toEqual(pages);
  });

  it("keeps an edge line that repeats on only a minority of pages", () => {
    const pages = Array.from({ length: 10 }, (_, index) => (
      index < 3 ? `Part One\n${bodyLines(index)}` : bodyLines(index)
    ));
    expect(stripPageFurniture(pages)).toEqual(pages);
  });

  it("leaves documents shorter than three pages untouched", () => {
    const pages = ["Header\nFirst body.\n1", "Header\nSecond body.\n2"];
    expect(stripPageFurniture(pages)).toEqual(pages);
  });

  it("never empties a page whose only text is furniture", () => {
    const pages = [
      `Shared title\n${bodyLines(0)}\n1`,
      `Shared title\n${bodyLines(1)}\n2`,
      `Shared title\n${bodyLines(2)}\n3`,
      "Shared title\n4",
      "5",
    ];
    expect(stripPageFurniture(pages)).toEqual([
      `Shared title\n${bodyLines(0)}`,
      bodyLines(1),
      bodyLines(2),
      "Shared title",
      "5",
    ]);
  });
});

describe("importDocumentFromPath page cleanup", () => {
  it("strips page furniture from per-page parser output before joining pages", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockResolvedValue({ pages: bookPages(5), pageCount: 5 }),
    };
    const result = await importDocumentFromPath("/tmp/book.pdf", makeParserFactory(parser), makeFs());
    expect(result.pageCount).toBe(5);
    expect(result.text).not.toMatch(/Page \d of/);
    expect(result.text.split("\n\n")).toEqual([
      RUNNING_HEADER(1),
      ...Array.from({ length: 5 }, (_, index) => bodyLines(index)),
    ]);
  });

  it("joins short per-page output without removing anything", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockResolvedValue({ pages: ["Title\nOne\n1", "Title\nTwo\n2"], pageCount: 2 }),
    };
    const result = await importDocumentFromPath("/tmp/memo.pdf", makeParserFactory(parser), makeFs());
    expect(result.text).toBe("Title\nOne\n1\n\nTitle\nTwo\n2");
  });

  it("still enforces the text cap on per-page output", async () => {
    const parser: DocumentParser = {
      parse: vi.fn().mockResolvedValue({ pages: ["a".repeat(MAX_IMPORT_TEXT_CHARS + 1)], pageCount: 1 }),
    };
    await expect(
      importDocumentFromPath("/tmp/tome.pdf", makeParserFactory(parser), makeFs()),
    ).rejects.toThrow("contains too much text to import");
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

import { promises as fsPromises } from "fs";
import path from "path";

export interface DocumentImportSuccess {
  canceled: false;
  fileName: string;
  text: string;
  pageCount?: number;
  epubBytes?: Uint8Array;
}

export type DocumentImportResult = { canceled: true } | DocumentImportSuccess;

/**
 * A parser returns either joined text or, when it knows the page layout,
 * per-page text so running headers, footers, and page numbers can be removed
 * before the pages are joined.
 */
export type DocumentParseOutcome =
  | { text: string; pageCount?: number }
  | { pages: readonly string[]; pageCount?: number };

export interface DocumentParser {
  parse: (filePath: string) => Promise<DocumentParseOutcome>;
}

export type DocumentParserFactory = () => Promise<DocumentParser>;

export interface ImportOpenDialog {
  // Method syntax (not a property arrow) so Electron's more narrowly typed
  // dialog module is assignable under strictFunctionTypes.
  showOpenDialog(options: {
    title: string;
    properties: ["openFile"];
    filters: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface ImportFs {
  stat: (filePath: string) => Promise<{ size: number }>;
  readFile: (filePath: string, encoding: "utf8") => Promise<string>;
  readBinaryFile: (filePath: string) => Promise<Uint8Array>;
}

const defaultImportFs: ImportFs = {
  stat: (filePath) => fsPromises.stat(filePath),
  readFile: (filePath, encoding) => fsPromises.readFile(filePath, encoding),
  readBinaryFile: async (filePath) => new Uint8Array(await fsPromises.readFile(filePath)),
};

export const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_IMPORT_PAGES = 800;
// Caps the extracted text, not the file: the text becomes React state backing a
// controlled textarea plus the reader overlay, so an unbounded paste-equivalent
// would freeze or OOM the renderer. 1.5M chars is far beyond any TTS-able document.
export const MAX_IMPORT_TEXT_CHARS = 1_500_000;

const PLAIN_TEXT_EXTENSIONS = new Set([".txt", ".md"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
// LiteParse converts office/OpenDocument formats through LibreOffice and
// standalone images through ImageMagick; both are best-effort and surface an
// actionable error when the external tool is missing.
const OFFICE_EXTENSIONS = new Set([".docx", ".pptx", ".odt"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"]);
const EPUB_EXTENSIONS = new Set([".epub"]);

export const IMPORT_DIALOG_FILTERS = [
  {
    name: "Documents",
    extensions: ["epub", "pdf", "txt", "md", "docx", "pptx", "odt", "png", "jpg", "jpeg", "tif", "tiff", "webp"],
  },
  { name: "eBooks", extensions: ["epub"] },
  { name: "PDF", extensions: ["pdf"] },
  { name: "Plain text", extensions: ["txt", "md"] },
  { name: "Office documents", extensions: ["docx", "pptx", "odt"] },
  { name: "Images", extensions: ["png", "jpg", "jpeg", "tif", "tiff", "webp"] },
];

export function isSupportedImportExtension(extension: string): boolean {
  return (
    PLAIN_TEXT_EXTENSIONS.has(extension) ||
    EPUB_EXTENSIONS.has(extension) ||
    PDF_EXTENSIONS.has(extension) ||
    OFFICE_EXTENSIONS.has(extension) ||
    IMAGE_EXTENSIONS.has(extension)
  );
}

function normalizeImportedText(text: string): string {
  // Collapse runs of 3+ newlines so page breaks don't leave large gaps, and
  // normalize CRLF so chunking sees consistent boundaries.
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Running headers and footers live in the first and last few non-empty lines
// of a page. A line there counts as furniture when its digit-insensitive form
// recurs on at least FURNITURE_PAGE_RATIO of the pages, and never on fewer than
// MIN_FURNITURE_PAGES pages, so short documents are left untouched.
const PAGE_EDGE_LINES = 2;
const MIN_FURNITURE_PAGES = 3;
const FURNITURE_PAGE_RATIO = 0.4;
// "12", "- 12 -", "Page 12", "p. 12", "12 / 300", "Page 3 of 20".
const ARABIC_PAGE_NUMBER_LINE =
  /^(?:[-–—]\s*)?(?:(?:page|p\.)\s*)?\d{1,4}(?:\s*(?:\/|of)\s*\d{1,4})?(?:\s*[-–—])?$/i;
// Front-matter numbering such as "iv" or "- xii -": lowercase, well formed,
// and below 100, so a lone "I" or a word made of roman letters ("mix", "civil")
// is kept.
const ROMAN_PAGE_NUMBER_LINE = /^(?:[-–—]\s*)?([ivxlc]{1,8})(?:\s*[-–—])?$/;
const ROMAN_NUMERAL = /^(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;

function isPageNumberLine(line: string): boolean {
  const trimmed = line.trim();
  if (ARABIC_PAGE_NUMBER_LINE.test(trimmed)) return true;
  const numeral = trimmed.match(ROMAN_PAGE_NUMBER_LINE)?.[1];
  return numeral !== undefined && ROMAN_NUMERAL.test(numeral);
}

function furnitureKey(line: string): string {
  return line.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

function pageEdgeLineIndexes(lines: readonly string[]): number[] {
  const nonEmpty = lines.flatMap((line, index) => (line.trim() ? [index] : []));
  if (nonEmpty.length <= PAGE_EDGE_LINES * 2) return nonEmpty;
  return [...nonEmpty.slice(0, PAGE_EDGE_LINES), ...nonEmpty.slice(-PAGE_EDGE_LINES)];
}

/**
 * Peels furniture lines off each page edge, walking inward and stopping at
 * the first line that is not furniture, so body text between furniture lines
 * is never touched. Repeated lines are kept when removing them would leave the
 * page with no text at all.
 */
function peelPageFurniture(page: string, repeatedKeys: ReadonlySet<string>): string {
  const lines = page.split("\n");
  const nonEmpty = lines.flatMap((line, index) => (line.trim() ? [index] : []));
  const pageNumbers = new Set<number>();
  const repeated = new Set<number>();
  const peel = (order: readonly number[]) => {
    for (const index of order.slice(0, PAGE_EDGE_LINES)) {
      if (isPageNumberLine(lines[index])) pageNumbers.add(index);
      else if (repeatedKeys.has(furnitureKey(lines[index]))) repeated.add(index);
      else break;
    }
  };
  peel(nonEmpty);
  peel([...nonEmpty].reverse());

  const keepsText = nonEmpty.some((index) => !pageNumbers.has(index) && !repeated.has(index));
  const removed = keepsText ? new Set([...pageNumbers, ...repeated]) : pageNumbers;
  return lines.filter((_, index) => !removed.has(index)).join("\n");
}

/** Removes running headers, footers, and page numbers from parsed pages. */
export function stripPageFurniture(pages: readonly string[]): string[] {
  if (pages.length < MIN_FURNITURE_PAGES) return [...pages];
  const normalizedPages = pages.map((page) => page.replace(/\r\n?/g, "\n"));
  const pageCounts = new Map<string, number>();
  for (const page of normalizedPages) {
    const lines = page.split("\n");
    const keys = new Set(pageEdgeLineIndexes(lines).map((index) => furnitureKey(lines[index])));
    for (const key of keys) pageCounts.set(key, (pageCounts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(MIN_FURNITURE_PAGES, Math.ceil(pages.length * FURNITURE_PAGE_RATIO));
  const repeatedKeys = new Set(
    [...pageCounts].filter(([, count]) => count >= threshold).map(([key]) => key),
  );
  return normalizedPages.map((page) => peelPageFurniture(page, repeatedKeys));
}

function describeParseFailure(fileName: string, extension: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (
    OFFICE_EXTENSIONS.has(extension) &&
    (lowered.includes("libreoffice") || lowered.includes("soffice"))
  ) {
    return new Error(
      `Importing ${extension} files requires LibreOffice. Install LibreOffice and try again.`,
    );
  }
  if (
    IMAGE_EXTENSIONS.has(extension) &&
    (lowered.includes("imagemagick") || lowered.includes("magick"))
  ) {
    return new Error(
      `Importing ${extension} images requires ImageMagick. Install ImageMagick and try again.`,
    );
  }
  if (lowered.includes("ghostscript")) {
    return new Error(
      `Importing "${fileName}" requires Ghostscript. Install Ghostscript and try again.`,
    );
  }
  // Tesseract language data is fetched once on first OCR use; offline machines
  // hit this instead of a cryptic native error.
  if (lowered.includes("tessdata")) {
    return new Error(
      `Reading scanned pages needs a one-time download of OCR language data, which failed. Check your internet connection and try again.`,
    );
  }
  if (PDF_EXTENSIONS.has(extension) && (lowered.includes("password") || lowered.includes("encrypt"))) {
    return new Error(`"${fileName}" is password protected and cannot be imported.`);
  }
  return new Error(`Failed to import "${fileName}": ${message}`);
}

export async function importDocumentFromPath(
  filePath: string,
  parserFactory: DocumentParserFactory,
  fsApi: ImportFs = defaultImportFs,
): Promise<DocumentImportSuccess> {
  const fileName = path.basename(filePath);
  const extension = path.extname(filePath).toLowerCase();
  if (!isSupportedImportExtension(extension)) {
    throw new Error(`Unsupported file type: ${extension || fileName}`);
  }

  const stats = await fsApi.stat(filePath);
  if (stats.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error(
      `"${fileName}" is too large to import (limit ${Math.floor(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB).`,
    );
  }

  let text: string;
  let pageCount: number | undefined;
  if (EPUB_EXTENSIONS.has(extension)) {
    const epubBytes = await fsApi.readBinaryFile(filePath);
    return { canceled: false, fileName, text: "", epubBytes };
  } else if (PLAIN_TEXT_EXTENSIONS.has(extension)) {
    text = await fsApi.readFile(filePath, "utf8");
  } else {
    let outcome: DocumentParseOutcome;
    try {
      const parser = await parserFactory();
      outcome = await parser.parse(filePath);
    } catch (error) {
      throw describeParseFailure(fileName, extension, error);
    }
    // Pages are joined the way LiteParse joins its own text output.
    text = "pages" in outcome ? stripPageFurniture(outcome.pages).join("\n\n") : outcome.text;
    pageCount = outcome.pageCount;
  }

  const normalized = normalizeImportedText(text);
  if (!normalized) {
    throw new Error(`No readable text found in "${fileName}".`);
  }
  if (normalized.length > MAX_IMPORT_TEXT_CHARS) {
    throw new Error(
      `"${fileName}" contains too much text to import (limit ${MAX_IMPORT_TEXT_CHARS.toLocaleString("en-US")} characters).`,
    );
  }
  return { canceled: false, fileName, text: normalized, pageCount };
}

export async function importDocumentFromDialog(
  dialogApi: ImportOpenDialog,
  parserFactory: DocumentParserFactory,
  fsApi: ImportFs = defaultImportFs,
): Promise<DocumentImportResult> {
  const result = await dialogApi.showOpenDialog({
    title: "Import document",
    properties: ["openFile"],
    filters: IMPORT_DIALOG_FILTERS,
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return importDocumentFromPath(result.filePaths[0], parserFactory, fsApi);
}

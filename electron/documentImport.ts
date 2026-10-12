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

// Running headers, footers and page numbers live in the first and last few
// non-empty lines of a page. Detection is deliberately conservative, because a
// false positive deletes real text:
// - A repeated line is furniture when it recurs on at least
//   FURNITURE_PAGE_RATIO of the pages (never fewer than MIN_FURNITURE_PAGES).
//   Lines that differ only by their digits ("Chapter 1" ... "Chapter 3") group
//   together, but only when most of the group repeats word for word, so
//   per-page headings such as "Question 1", "Question 2" are kept.
// - A page number ("12", "Page 12 of 300", "xiv", "Title   12") is furniture
//   only when it advances in step with the page index, at the same edge and in
//   the same format, on another page, and enough pages carry one. A lone
//   number such as a "1984" chapter title is never mistaken for one.
// - The first page with text keeps its top lines, so a running header that
//   repeats the document title does not take the title page's title with it.
// - No page is ever emptied.
const PAGE_EDGE_LINES = 2;
const MIN_FURNITURE_PAGES = 3;
const FURNITURE_PAGE_RATIO = 0.4;
// "12", "- 12 -", "Page 12", "p. 12", "12 / 300", "Page 3 of 20".
const ARABIC_PAGE_NUMBER_LINE =
  /^(?:[-–—]\s*)?(?:(?:page|p\.)\s*)?(\d{1,4})(?:\s*(?:\/|of)\s*\d{1,4})?(?:\s*[-–—])?$/i;
// Front-matter numbering such as "iv" or "- xii -": lowercase, well formed,
// and below 100, so a lone "I" or a word made of roman letters ("mix", "civil")
// is kept.
const ROMAN_PAGE_NUMBER_LINE = /^((?:[-–—]\s*)?)([ivxlc]{1,8})((?:\s*[-–—])?)$/;
const ROMAN_NUMERAL = /^(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;
const ROMAN_DIGITS: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
// A page number set apart from a running title by a wide gap or a separator,
// as in "The Lighthouse Keeper     12" or "12 | Chapter One". A single space
// ("Question 12") reads as a heading, not furniture.
const SEPARATED_PAGE_NUMBER_SUFFIX = /^(.*\p{L}.*?)(?:\t|\s{3,}|\s+[|·•]\s+)(\d{1,4})$/u;
const SEPARATED_PAGE_NUMBER_PREFIX = /^(\d{1,4})(?:\t|\s{3,}|\s+[|·•]\s+)(.*\p{L}.*)$/u;

type PageEdge = "top" | "bottom";

interface PageNumber {
  /** The line's format with the number masked, so formats never mix. */
  format: string;
  value: number;
}

interface EdgeLine {
  page: number;
  index: number;
  edge: PageEdge;
}

function romanValue(numeral: string): number {
  let total = 0;
  for (let index = 0; index < numeral.length; index += 1) {
    const value = ROMAN_DIGITS[numeral[index]];
    const next = ROMAN_DIGITS[numeral[index + 1]] ?? 0;
    total += value < next ? -value : value;
  }
  return total;
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim().toLowerCase();
}

function digitInsensitiveKey(line: string): string {
  return normalizeLine(line.replace(/\d+/g, "#"));
}

function parsePageNumber(line: string): PageNumber | undefined {
  const trimmed = line.trim();
  const arabic = trimmed.match(ARABIC_PAGE_NUMBER_LINE);
  if (arabic) return { format: digitInsensitiveKey(trimmed), value: Number(arabic[1]) };
  const roman = trimmed.match(ROMAN_PAGE_NUMBER_LINE);
  if (roman && ROMAN_NUMERAL.test(roman[2])) {
    return { format: normalizeLine(`${roman[1]}%${roman[3]}`), value: romanValue(roman[2]) };
  }
  const suffix = trimmed.match(SEPARATED_PAGE_NUMBER_SUFFIX);
  if (suffix) return { format: `${digitInsensitiveKey(suffix[1])} | #`, value: Number(suffix[2]) };
  const prefix = trimmed.match(SEPARATED_PAGE_NUMBER_PREFIX);
  if (prefix) return { format: `# | ${digitInsensitiveKey(prefix[2])}`, value: Number(prefix[1]) };
  return undefined;
}

function nonEmptyLineIndexes(lines: readonly string[]): number[] {
  return lines.flatMap((line, index) => (line.trim() ? [index] : []));
}

/** The outermost lines of a page, each tagged with the edge it sits on. */
function pageEdgeLines(page: number, lines: readonly string[]): EdgeLine[] {
  const nonEmpty = nonEmptyLineIndexes(lines);
  return nonEmpty.flatMap((index, position) => {
    const fromBottom = nonEmpty.length - 1 - position;
    if (position >= PAGE_EDGE_LINES && fromBottom >= PAGE_EDGE_LINES) return [];
    return [{ page, index, edge: position < nonEmpty.length / 2 ? "top" : "bottom" } satisfies EdgeLine];
  });
}

const edgeLineId = (page: number, index: number) => `${page}:${index}`;

/** Page-number lines that advance with the page index, by edge-line id. */
function findPageNumbers(pageLines: readonly string[][], edgeLines: readonly EdgeLine[], threshold: number) {
  // A run of page numbers shares one offset between printed number and page
  // index; a restart (front matter, a new volume) simply starts another run.
  const runs = new Map<string, Set<number>>();
  const candidates: { page: number; id: string; run: string }[] = [];
  for (const { page, index, edge } of edgeLines) {
    const pageNumber = parsePageNumber(pageLines[page][index]);
    if (!pageNumber) continue;
    const run = `${edge}\n${pageNumber.format}\n${pageNumber.value - page}`;
    runs.set(run, (runs.get(run) ?? new Set()).add(page));
    candidates.push({ page, id: edgeLineId(page, index), run });
  }
  const confirmed = candidates.filter(({ run }) => (runs.get(run)?.size ?? 0) >= 2);
  const pages = new Set(confirmed.map(({ page }) => page));
  return new Set(pages.size >= threshold ? confirmed.map(({ id }) => id) : []);
}

/** Digit-insensitive keys of lines that repeat at page edges. */
function findRepeatedKeys(pageLines: readonly string[][], edgeLines: readonly EdgeLine[], threshold: number) {
  const groups = new Map<string, { pages: Set<number>; texts: Set<string> }>();
  for (const { page, index } of edgeLines) {
    const line = pageLines[page][index];
    if (parsePageNumber(line)) continue;
    const key = digitInsensitiveKey(line);
    const group = groups.get(key) ?? { pages: new Set(), texts: new Set() };
    group.pages.add(page);
    group.texts.add(normalizeLine(line));
    groups.set(key, group);
  }
  return new Set(
    [...groups]
      .filter(([, { pages, texts }]) => pages.size >= threshold && texts.size * 2 <= pages.size)
      .map(([key]) => key),
  );
}

/** Removes running headers, footers, and page numbers from parsed pages. */
export function stripPageFurniture(pages: readonly string[]): string[] {
  if (pages.length < MIN_FURNITURE_PAGES) return [...pages];
  const pageLines = pages.map((page) => page.replace(/\r\n?/g, "\n").split("\n"));
  const edgesByPage = pageLines.map((lines, page) => pageEdgeLines(page, lines));
  const edgeLines = edgesByPage.flat();
  const threshold = Math.max(MIN_FURNITURE_PAGES, Math.ceil(pages.length * FURNITURE_PAGE_RATIO));
  const pageNumbers = findPageNumbers(pageLines, edgeLines, threshold);
  const repeatedKeys = findRepeatedKeys(pageLines, edgeLines, threshold);
  const titlePage = pageLines.findIndex((lines) => nonEmptyLineIndexes(lines).length > 0);

  return pageLines.map((lines, page) => {
    const edges = edgesByPage[page];
    const numbers = new Set<number>();
    const repeated = new Set<number>();
    // Peel inward from each edge and stop at the first line that is not
    // furniture, so body text between furniture lines is never touched.
    const peel = (order: readonly EdgeLine[]) => {
      for (const { index, edge } of order) {
        if (pageNumbers.has(edgeLineId(page, index))) numbers.add(index);
        else if (!(page === titlePage && edge === "top") && repeatedKeys.has(digitInsensitiveKey(lines[index]))) {
          repeated.add(index);
        } else break;
      }
    };
    peel(edges.filter(({ edge }) => edge === "top"));
    peel(edges.filter(({ edge }) => edge === "bottom").reverse());

    const nonEmpty = nonEmptyLineIndexes(lines);
    const keeps = (removed: ReadonlySet<number>) => nonEmpty.some((index) => !removed.has(index));
    const all = new Set([...numbers, ...repeated]);
    const removed = keeps(all) ? all : keeps(numbers) ? numbers : new Set<number>();
    return lines.filter((_, index) => !removed.has(index)).join("\n");
  });
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

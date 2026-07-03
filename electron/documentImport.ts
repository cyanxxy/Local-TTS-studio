import { promises as fsPromises } from "fs";
import path from "path";

export interface DocumentImportSuccess {
  canceled: false;
  fileName: string;
  text: string;
  pageCount?: number;
}

export type DocumentImportResult = { canceled: true } | DocumentImportSuccess;

export interface DocumentParseOutcome {
  text: string;
  pageCount?: number;
}

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
}

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

export const IMPORT_DIALOG_FILTERS = [
  {
    name: "Documents",
    extensions: ["pdf", "txt", "md", "docx", "pptx", "odt", "png", "jpg", "jpeg", "tif", "tiff", "webp"],
  },
  { name: "PDF", extensions: ["pdf"] },
  { name: "Plain text", extensions: ["txt", "md"] },
  { name: "Office documents", extensions: ["docx", "pptx", "odt"] },
  { name: "Images", extensions: ["png", "jpg", "jpeg", "tif", "tiff", "webp"] },
];

export function isSupportedImportExtension(extension: string): boolean {
  return (
    PLAIN_TEXT_EXTENSIONS.has(extension) ||
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
  fsApi: ImportFs = fsPromises,
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
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) {
    text = await fsApi.readFile(filePath, "utf8");
  } else {
    let outcome: DocumentParseOutcome;
    try {
      const parser = await parserFactory();
      outcome = await parser.parse(filePath);
    } catch (error) {
      throw describeParseFailure(fileName, extension, error);
    }
    text = outcome.text;
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
  fsApi: ImportFs = fsPromises,
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

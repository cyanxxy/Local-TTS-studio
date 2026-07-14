import { Readability } from "@mozilla/readability";
import { strFromU8, unzipSync, type UnzipFileInfo } from "fflate";
import {
  createReaderDocument,
  deriveDocumentTitle,
  type ReaderChapter,
  type ReaderDocumentRecord,
} from "./readerDocument";

const MAX_URL_BYTES = 10 * 1024 * 1024;
const MAX_READER_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_READER_TEXT_CHARS = 1_500_000;
const MAX_EPUB_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_EPUB_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_EPUB_ENTRIES = 10_000;
const URL_TIMEOUT_MS = 30_000;

class ReaderImportLimitError extends Error {}

function assertReaderTextLimit(text: string): void {
  if (text.length > MAX_READER_TEXT_CHARS) {
    throw new ReaderImportLimitError("The imported document exceeds the 1.5 million character limit.");
  }
}

interface EpubExpansionBudget {
  remaining: number;
}

function unzipSelectedEntries(
  archive: Uint8Array,
  selectedPaths: ReadonlySet<string>,
  budget: EpubExpansionBudget,
  inspectEntryCount = false,
): Record<string, Uint8Array> {
  let entryCount = 0;
  return unzipSync(archive, {
    filter: (entry: UnzipFileInfo) => {
      entryCount += 1;
      if (inspectEntryCount && entryCount > MAX_EPUB_ENTRIES) {
        throw new ReaderImportLimitError(`The EPUB contains more than ${MAX_EPUB_ENTRIES.toLocaleString()} entries.`);
      }
      if (!selectedPaths.has(entry.name)) return false;
      if (entry.originalSize > MAX_EPUB_ENTRY_BYTES) {
        throw new ReaderImportLimitError(`The EPUB entry "${entry.name}" exceeds the 8 MB expansion limit.`);
      }
      if (entry.originalSize > budget.remaining) {
        throw new ReaderImportLimitError("The EPUB expands beyond the 32 MB readable-content limit.");
      }
      budget.remaining -= entry.originalSize;
      return true;
    },
  });
}

export interface RemoteDocumentPayload {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  html: string;
}

interface ExtractedSection {
  title: string;
  level: number;
  text: string;
}

function cleanText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fileStem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled document";
}

function parseMarkup(markup: string, contentType: DOMParserSupportedType): Document {
  const document = new DOMParser().parseFromString(markup, contentType);
  if (contentType !== "text/html" && document.querySelector("parsererror")) {
    throw new Error("The document contains invalid XML markup.");
  }
  return document;
}

function blockText(element: Element): string {
  if (element.tagName.toLowerCase() === "li") {
    return `• ${cleanText(element.textContent ?? "")}`;
  }
  return cleanText(element.textContent ?? "");
}

function extractSections(root: ParentNode, fallbackTitle: string): ExtractedSection[] {
  const blocks = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre")];
  const sections: ExtractedSection[] = [];
  let current: ExtractedSection = { title: fallbackTitle, level: 1, text: "" };

  const flush = () => {
    const text = cleanText(current.text);
    if (text) sections.push({ ...current, text });
  };

  for (const element of blocks) {
    const tag = element.tagName.toLowerCase();
    const text = blockText(element);
    if (!text) continue;

    if (/^h[1-6]$/.test(tag)) {
      if (cleanText(current.text)) flush();
      current = { title: text.slice(0, 160), level: Number(tag.slice(1)), text: text };
      continue;
    }

    current.text += `${current.text ? "\n\n" : ""}${text}`;
  }
  flush();

  if (sections.length === 0) {
    const text = cleanText(root.textContent ?? "");
    if (text) sections.push({ title: fallbackTitle, level: 1, text });
  }
  return sections;
}

function sectionsToDocumentParts(sections: readonly ExtractedSection[]): {
  text: string;
  chapters: ReaderChapter[];
} {
  let text = "";
  const chapters: ReaderChapter[] = [];

  for (const section of sections) {
    if (text) {
      text += "\n\n";
      const previousChapter = chapters.at(-1);
      if (previousChapter) previousChapter.end = text.length;
    }
    const adjustedStart = text.length;
    text += cleanText(section.text);
    if (text.length <= adjustedStart) continue;
    chapters.push({
      id: `chapter-${chapters.length + 1}`,
      title: section.title || `Chapter ${chapters.length + 1}`,
      order: chapters.length,
      start: adjustedStart,
      end: text.length,
      level: Math.max(1, Math.min(6, section.level)),
    });
  }

  return { text, chapters };
}

function zipPath(basePath: string, relativePath: string): string {
  const base = `https://epub.local/${basePath.replace(/^\/+/, "")}`;
  const resolved = new URL(relativePath, base).pathname.replace(/^\/+/, "");
  try {
    return decodeURIComponent(resolved);
  } catch {
    return resolved;
  }
}

function findZipEntry(files: Record<string, Uint8Array>, path: string): Uint8Array | undefined {
  return files[path] ?? files[encodeURI(path)] ?? files[decodeURI(path)];
}

function xmlLocalText(document: Document, localName: string): string {
  const nodes = document.getElementsByTagNameNS("*", localName);
  return cleanText(nodes[0]?.textContent ?? "");
}

function epubNavigationLabels(
  files: Record<string, Uint8Array>,
  manifest: Map<string, { href: string; mediaType: string; properties: string }>,
  opfPath: string,
): Map<string, string> {
  const labels = new Map<string, string>();
  const navigation = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes("nav"));
  if (!navigation) return labels;
  const navPath = zipPath(opfPath, navigation.href);
  const bytes = findZipEntry(files, navPath);
  if (!bytes) return labels;

  const document = parseMarkup(strFromU8(bytes), "text/html");
  for (const link of document.querySelectorAll("nav a[href], a[href]")) {
    const href = link.getAttribute("href");
    const label = cleanText(link.textContent ?? "");
    if (!href || !label) continue;
    labels.set(zipPath(navPath, href.split("#")[0]), label.slice(0, 160));
  }
  return labels;
}

export function parseEpubDocument(bytes: Uint8Array, fileName: string): ReaderDocumentRecord {
  if (bytes.byteLength > MAX_READER_FILE_BYTES) {
    throw new ReaderImportLimitError(`"${fileName}" exceeds the 100 MB file limit.`);
  }

  const budget: EpubExpansionBudget = { remaining: MAX_EPUB_EXPANDED_BYTES };
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSelectedEntries(bytes, new Set(["META-INF/container.xml"]), budget, true);
  } catch (error) {
    if (error instanceof ReaderImportLimitError) throw error;
    throw new Error(`"${fileName}" is not a valid EPUB archive.`);
  }

  const containerBytes = findZipEntry(files, "META-INF/container.xml");
  if (!containerBytes) throw new Error(`"${fileName}" does not contain an EPUB container manifest.`);
  const container = parseMarkup(strFromU8(containerBytes), "application/xml");
  const rootfile = container.getElementsByTagNameNS("*", "rootfile")[0];
  const opfPath = rootfile?.getAttribute("full-path")?.replace(/^\/+/, "");
  if (!opfPath) throw new Error(`"${fileName}" does not identify its package document.`);

  let opfFiles: Record<string, Uint8Array>;
  try {
    opfFiles = unzipSelectedEntries(bytes, new Set([opfPath, encodeURI(opfPath)]), budget);
  } catch (error) {
    if (error instanceof ReaderImportLimitError) throw error;
    throw new Error(`"${fileName}" is not a valid EPUB archive.`);
  }
  files = { ...files, ...opfFiles };
  const opfBytes = findZipEntry(files, opfPath);
  if (!opfBytes) throw new Error(`"${fileName}" is missing its package document.`);
  const opf = parseMarkup(strFromU8(opfBytes), "application/xml");
  const title = xmlLocalText(opf, "title") || fileStem(fileName);
  const author = xmlLocalText(opf, "creator");
  const language = xmlLocalText(opf, "language");
  const description = xmlLocalText(opf, "description");

  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const item of opf.getElementsByTagNameNS("*", "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, {
      href,
      mediaType: item.getAttribute("media-type") ?? "",
      properties: item.getAttribute("properties") ?? "",
    });
  }

  const contentPaths = new Set<string>();
  for (const item of manifest.values()) {
    const isNavigation = item.properties.split(/\s+/).includes("nav");
    if (isNavigation || item.mediaType.includes("html") || /\.x?html?$/i.test(item.href)) {
      const path = zipPath(opfPath, item.href);
      contentPaths.add(path);
      contentPaths.add(encodeURI(path));
    }
  }
  try {
    files = { ...files, ...unzipSelectedEntries(bytes, contentPaths, budget) };
  } catch (error) {
    if (error instanceof ReaderImportLimitError) throw error;
    throw new Error(`"${fileName}" is not a valid EPUB archive.`);
  }

  const navigationLabels = epubNavigationLabels(files, manifest, opfPath);
  const sections: ExtractedSection[] = [];
  const itemRefs = [...opf.getElementsByTagNameNS("*", "itemref")];
  for (const itemRef of itemRefs) {
    const idref = itemRef.getAttribute("idref");
    const item = idref ? manifest.get(idref) : undefined;
    if (!item || (!item.mediaType.includes("html") && !/\.x?html?$/i.test(item.href))) continue;
    const contentPath = zipPath(opfPath, item.href);
    const contentBytes = findZipEntry(files, contentPath);
    if (!contentBytes) continue;
    const contentDocument = parseMarkup(strFromU8(contentBytes), "text/html");
    const fallbackTitle = navigationLabels.get(contentPath)
      || cleanText(contentDocument.querySelector("title")?.textContent ?? "")
      || `Chapter ${sections.length + 1}`;
    const extracted = extractSections(contentDocument.body, fallbackTitle);
    if (extracted.length === 0) continue;
    if (extracted.length === 1) extracted[0].title = fallbackTitle;
    sections.push(...extracted);
  }

  const parts = sectionsToDocumentParts(sections);
  if (!parts.text) throw new Error(`No readable text found in "${fileName}".`);
  assertReaderTextLimit(parts.text);
  return createReaderDocument({
    title,
    author,
    language,
    description,
    sourceType: "epub",
    sourceName: fileName,
    text: parts.text,
    chapters: parts.chapters,
  });
}

export function parseHtmlReaderDocument(payload: RemoteDocumentPayload): ReaderDocumentRecord {
  const sourceDocument = parseMarkup(payload.html, "text/html");
  const readable = new Readability(sourceDocument, { charThreshold: 80 }).parse();
  const title = cleanText(readable?.title ?? sourceDocument.title) || new URL(payload.finalUrl).hostname;
  const author = cleanText(readable?.byline ?? "");
  const description = cleanText(readable?.excerpt ?? "");
  const articleDocument = readable?.content
    ? parseMarkup(`<article>${readable.content}</article>`, "text/html")
    : sourceDocument;
  const root = articleDocument.querySelector("article") ?? articleDocument.body;
  const sections = extractSections(root, title);
  const parts = sectionsToDocumentParts(sections);
  if (!parts.text) throw new Error("No readable article text was found at this URL.");
  assertReaderTextLimit(parts.text);

  return createReaderDocument({
    title,
    author,
    description,
    sourceType: "url",
    sourceName: new URL(payload.finalUrl).hostname,
    sourceUrl: payload.finalUrl,
    text: parts.text,
    chapters: parts.chapters,
  });
}

export async function fetchRemoteDocument(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<RemoteDocumentPayload> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a complete http:// or https:// URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs can be imported.");
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    const response = await fetcher(url.toString(), {
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
    });
    if (!response.ok) throw new Error(`The page returned HTTP ${response.status}.`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > MAX_URL_BYTES) {
      throw new Error("The page is too large to import (10 MB limit).");
    }
    const html = await response.text();
    if (new Blob([html]).size > MAX_URL_BYTES) throw new Error("The page is too large to import (10 MB limit).");
    return {
      requestedUrl: url.toString(),
      finalUrl: response.url || url.toString(),
      contentType: response.headers.get("content-type") ?? "text/html",
      html,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The URL import timed out after 30 seconds.");
    }
    if (error instanceof Error) throw error;
    throw new Error("The URL could not be imported.");
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function importReaderFile(file: File): Promise<ReaderDocumentRecord> {
  if (file.size > MAX_READER_FILE_BYTES) {
    throw new ReaderImportLimitError(`"${file.name}" exceeds the 100 MB file limit.`);
  }
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  if (extension === ".epub") {
    return parseEpubDocument(new Uint8Array(await file.arrayBuffer()), file.name);
  }
  if (![".txt", ".md", ".html", ".htm"].includes(extension)) {
    throw new Error("The web Reader supports EPUB, TXT, Markdown, and HTML files. The desktop app also supports PDF, Office, and image imports.");
  }
  const raw = await file.text();
  assertReaderTextLimit(raw);
  if (extension === ".html" || extension === ".htm") {
    return parseHtmlReaderDocument({
      requestedUrl: file.name,
      finalUrl: `https://local.invalid/${encodeURIComponent(file.name)}`,
      contentType: "text/html",
      html: raw,
    });
  }
  return createReaderDocument({
    title: deriveDocumentTitle(raw, fileStem(file.name)),
    sourceType: "file",
    sourceName: file.name,
    text: raw,
  });
}

import { Readability } from "@mozilla/readability";
import { strFromU8, unzipSync, type UnzipFileInfo } from "fflate";
import {
  createReaderDocument,
  deriveDocumentTitle,
  isReaderDocumentCover,
  normalizeReaderText,
  READER_COVER_MAX_DATA_URL_CHARS,
  type ReaderChapter,
  type ReaderDocumentCover,
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

// Elements that start a new paragraph. Text owned directly by any of these
// (text nodes or inline children) becomes one block, so wrappers such as
// <blockquote><p> or <li><p> yield their text once and plain <div> paragraphs
// are kept alongside <p> siblings.
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "dialog",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
  "h6", "header", "hgroup", "hr", "legend", "li", "main", "menu", "nav", "ol", "p", "pre", "section",
  "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
// Never readable: code, styling, ruby annotations (which would read furigana
// twice), embedded media and graphics (whose fallback or label text is not
// prose), and form controls. MathML reads its alttext when it has one.
const SKIPPED_TAGS = new Set([
  "audio", "button", "canvas", "embed", "iframe", "noscript", "object", "option", "rp", "rt", "script",
  "select", "style", "svg", "template", "textarea", "video",
]);

/** One line of text, for titles and labels lifted from markup. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

interface ExtractedBlock {
  /** The nearest block element that owns the text. */
  owner: Element;
  text: string;
}

/**
 * Splits `root` into leaf text blocks in document order. Mixed content such as
 * `<div>Lead<p>Body</p>Tail</div>` yields "Lead", "Body", and "Tail".
 * Recursion depth follows element nesting, which the HTML parser bounds.
 */
function extractBlocks(root: Element): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  const walk = (owner: Element) => {
    let buffer = "";
    const flush = () => {
      const text = cleanText(buffer);
      buffer = "";
      if (text) blocks.push({ owner, text });
    };
    const visit = (node: Node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
          buffer += (child as CharacterData).data;
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const element = child as Element;
        const tag = element.localName.toLowerCase();
        if (SKIPPED_TAGS.has(tag)) continue;
        if (tag === "math") {
          const alttext = singleLine(element.getAttribute("alttext") ?? "");
          if (alttext) buffer += ` ${alttext} `;
        } else if (tag === "br") {
          buffer += "\n";
        } else if (BLOCK_TAGS.has(tag)) {
          flush();
          walk(element);
        } else {
          visit(element);
        }
      }
    };
    visit(owner);
    flush();
  };
  walk(root);
  return blocks;
}

function extractSections(root: Element, fallbackTitle: string): ExtractedSection[] {
  const sections: ExtractedSection[] = [];
  let current: ExtractedSection = { title: fallbackTitle, level: 1, text: "" };
  // A list item's bullet goes on its first block only, so <li><p>A</p><p>B</p>
  // reads as one item and a nested list's items get their own bullets.
  const bulletedItems = new Set<Element>();

  const flush = () => {
    const text = cleanText(current.text);
    if (text) sections.push({ ...current, text });
  };

  for (const { owner, text: blockText } of extractBlocks(root)) {
    const tag = owner.localName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      if (cleanText(current.text)) flush();
      current = { title: singleLine(blockText).slice(0, 160), level: Number(tag.slice(1)), text: blockText };
      continue;
    }

    const item = owner.closest("li");
    let text = blockText;
    if (item && root.contains(item) && !bulletedItems.has(item)) {
      bulletedItems.add(item);
      text = `• ${text}`;
    }
    current.text += `${current.text ? "\n\n" : ""}${text}`;
  }
  flush();
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

interface EpubManifestItem {
  href: string;
  mediaType: string;
  properties: string;
}

function epubNavigationLabels(
  files: Record<string, Uint8Array>,
  manifest: Map<string, EpubManifestItem>,
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
    const label = singleLine(link.textContent ?? "");
    if (!href || !label) continue;
    labels.set(zipPath(navPath, href.split("#")[0]), label.slice(0, 160));
  }
  return labels;
}

type CoverImageType = "jpeg" | "png" | "gif" | "webp";

// Declared media types worth reading. "image/jpg" is a common mislabel of
// JPEG in real-world EPUBs; the bytes decide the final type either way.
const COVER_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isCoverMediaType(mediaType: string): boolean {
  return COVER_MEDIA_TYPES.has(mediaType.trim().toLowerCase());
}

// The longest data-URL prefix ("jpeg"/"webp") bounds the raw bytes that can
// still fit the record's cover cap once base64-encoded.
const MAX_COVER_BYTES = Math.floor(
  (READER_COVER_MAX_DATA_URL_CHARS - "data:image/jpeg;base64,".length) / 4,
) * 3;

function hasPrefix(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

/** Identifies a raster image by its magic bytes rather than trusting the manifest. */
function sniffCoverImageType(bytes: Uint8Array): CoverImageType | null {
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "gif";
  }
  if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/** Base64-encodes in chunks so large images never overflow the argument stack. */
function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// "cover" as a word of its own: "cover.jpg" and "book-cover" match, while
// "discover.png" and "recovery-map.png" do not.
const COVER_NAME = /(?<!\p{L})cover(?!\p{L})/iu;
// Bounds how many images a book can make the importer inflate for its cover.
const MAX_COVER_CANDIDATES = 4;

/**
 * Raster cover candidates in order of trust: the EPUB 3 `cover-image`
 * property, then the EPUB 2 `<meta name="cover">` reference, then manifest
 * items named "cover". The first that decodes wins.
 */
function findEpubCoverItems(opf: Document, manifest: Map<string, EpubManifestItem>): EpubManifestItem[] {
  const items = [...manifest.entries()];
  const coverMeta = [...opf.getElementsByTagNameNS("*", "meta")]
    .find((meta) => meta.getAttribute("name") === "cover");
  const metaItem = manifest.get(coverMeta?.getAttribute("content") ?? "");
  const candidates = [
    ...items.filter(([, item]) => item.properties.split(/\s+/).includes("cover-image")).map(([, item]) => item),
    ...(metaItem ? [metaItem] : []),
    ...items.filter(([id, item]) => COVER_NAME.test(`${id} ${item.href}`)).map(([, item]) => item),
  ];
  return [...new Set(candidates)].filter((item) => isCoverMediaType(item.mediaType)).slice(0, MAX_COVER_CANDIDATES);
}

/**
 * Reads the EPUB's raster cover as a data URL. A cover is optional: anything
 * unexpected (SVG, mismatched bytes, oversized, missing, corrupt) skips it
 * instead of failing the import.
 */
function readEpubCover(
  archive: Uint8Array,
  opf: Document,
  opfPath: string,
  manifest: Map<string, EpubManifestItem>,
  budget: EpubExpansionBudget,
): ReaderDocumentCover | undefined {
  const coverPaths = findEpubCoverItems(opf, manifest).map((item) => zipPath(opfPath, item.href));
  if (coverPaths.length === 0) return undefined;
  const entryNames = new Set(coverPaths.flatMap((path) => [path, encodeURI(path)]));

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive, {
      filter: (entry: UnzipFileInfo) => {
        if (!entryNames.has(entry.name)) return false;
        if (entry.originalSize > MAX_COVER_BYTES || entry.originalSize > budget.remaining) return false;
        budget.remaining -= entry.originalSize;
        return true;
      },
    });
  } catch {
    return undefined;
  }
  for (const path of coverPaths) {
    const bytes = findZipEntry(files, path);
    // The declared size gated inflation; the inflated bytes are what count.
    if (!bytes || bytes.length > MAX_COVER_BYTES) continue;
    const type = sniffCoverImageType(bytes);
    if (!type) continue;
    const cover = { dataUrl: `data:image/${type};base64,${bytesToBase64(bytes)}` };
    if (isReaderDocumentCover(cover)) return cover;
  }
  return undefined;
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

  const manifest = new Map<string, EpubManifestItem>();
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
      || singleLine(contentDocument.querySelector("title")?.textContent ?? "")
      || `Chapter ${sections.length + 1}`;
    const extracted = extractSections(contentDocument.body, fallbackTitle);
    if (extracted.length === 0) continue;
    if (extracted.length === 1) extracted[0].title = fallbackTitle;
    sections.push(...extracted);
  }

  const parts = sectionsToDocumentParts(sections);
  if (!parts.text) throw new Error(`No readable text found in "${fileName}".`);
  assertReaderTextLimit(parts.text);
  const cover = readEpubCover(bytes, opf, opfPath, manifest, budget);
  return createReaderDocument({
    title,
    author,
    language,
    description,
    sourceType: "epub",
    sourceName: fileName,
    text: parts.text,
    chapters: parts.chapters,
    ...(cover ? { cover } : {}),
  });
}

export function parseHtmlReaderDocument(payload: RemoteDocumentPayload): ReaderDocumentRecord {
  const sourceDocument = parseMarkup(payload.html, "text/html");
  // Read before Readability, which rewrites the document in place.
  const declaredLanguage = sourceDocument.documentElement.getAttribute("lang") ?? "";
  const readable = new Readability(sourceDocument, { charThreshold: 80 }).parse();
  const title = cleanText(readable?.title ?? sourceDocument.title) || new URL(payload.finalUrl).hostname;
  const author = cleanText(readable?.byline ?? "");
  const description = cleanText(readable?.excerpt ?? "");
  const language = cleanText(readable?.lang || declaredLanguage);
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
    language,
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

/** Strips inline Markdown syntax so neither the page nor the voice sees it. */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1");
}

interface MarkdownHeading {
  title: string;
  level: number;
}

/**
 * Turns Markdown into the plain reading text the Reader renders and speaks.
 * Heading markers become chapter boundaries instead of `#` glyphs, and a lone
 * leading H1 is lifted into the document title rather than becoming a
 * one-line first page.
 */
export function parseMarkdownReaderDocument(raw: string, fileName: string): ReaderDocumentRecord {
  const output: string[] = [];
  const headings: MarkdownHeading[] = [];
  // Output line index of each heading, parallel to `headings`.
  const headingLines: number[] = [];
  let fence: string | null = null;

  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) {
      output.push(line);
      continue;
    }

    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
    if (atx) {
      const title = stripInlineMarkdown(atx[2]).trim();
      if (title) {
        headings.push({ title, level: atx[1].length });
        headingLines.push(output.length);
        output.push(title);
      }
      continue;
    }

    const previous = output.at(-1) ?? "";
    const previousIsHeading = headingLines.at(-1) === output.length - 1;
    const setext = line.match(/^\s{0,3}(=+|-+)\s*$/);
    if (setext && previous.trim() && !previousIsHeading) {
      headings.push({ title: previous.trim(), level: setext[1][0] === "=" ? 1 : 2 });
      headingLines.push(output.length - 1);
      output[output.length - 1] = previous.trim();
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      output.push("");
      continue;
    }
    if (/^\s{0,3}\[[^\]]+\]:\s+\S+/.test(line)) continue;

    const body = line
      .replace(/^(\s{0,3}>\s?)+/, "")
      .replace(/^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?/, "$1");
    output.push(stripInlineMarkdown(body));
  }

  let title = "";
  const levelOneCount = headings.filter((heading) => heading.level === 1).length;
  const firstHeadingLine = headingLines[0];
  if (
    headings[0]?.level === 1
    && levelOneCount === 1
    && output.slice(0, firstHeadingLine).every((line) => !line.trim())
  ) {
    title = headings[0].title;
    output.splice(firstHeadingLine, 1);
    headings.shift();
    headingLines.shift();
  }

  const plain = output.join("\n");
  assertReaderTextLimit(plain);
  const text = normalizeReaderText(plain);
  const documentTitle = title || deriveDocumentTitle(text, fileStem(fileName));

  // Offsets are only final after normalization, so headings are located in
  // the normalized text, in order, one line at a time.
  const chapters: ReaderChapter[] = [];
  let cursor = 0;
  let headingIndex = 0;
  for (const line of text.split("\n")) {
    const heading = headings[headingIndex];
    if (heading && line.trim() === heading.title) {
      chapters.push({ id: "", title: heading.title, order: chapters.length, start: cursor, end: cursor, level: heading.level });
      headingIndex += 1;
    }
    cursor += line.length + 1;
  }
  if (chapters.length > 0 && text.slice(0, chapters[0].start).trim()) {
    chapters.unshift({ id: "", title: "Introduction", order: 0, start: 0, end: 0, level: 1 });
  }
  chapters.forEach((chapter, index) => {
    chapter.order = index;
    chapter.end = chapters[index + 1]?.start ?? text.length;
  });

  return createReaderDocument({
    title: documentTitle,
    sourceType: "file",
    sourceName: fileName,
    text,
    ...(chapters.length > 0 ? { chapters } : {}),
  });
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
  if (extension === ".md") return parseMarkdownReaderDocument(raw, file.name);
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

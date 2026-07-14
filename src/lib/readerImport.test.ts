import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_READER_TEXT_CHARS,
  fetchRemoteDocument,
  parseEpubDocument,
  parseHtmlReaderDocument,
} from "./readerImport";

function sampleEpub(): Uint8Array {
  return zipSync({
    "mimetype": strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
      <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
      </container>`),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>The Local Book</dc:title><dc:creator>A. Reader</dc:creator><dc:language>en</dc:language>
        </metadata>
        <manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
          <item id="one" href="one.xhtml" media-type="application/xhtml+xml" />
          <item id="two" href="two.xhtml" media-type="application/xhtml+xml" />
        </manifest>
        <spine><itemref idref="one" /><itemref idref="two" /></spine>
      </package>`),
    "OEBPS/nav.xhtml": strToU8(`<html><body><nav><ol>
      <li><a href="one.xhtml">Opening</a></li><li><a href="two.xhtml">Conclusion</a></li>
    </ol></nav></body></html>`),
    "OEBPS/one.xhtml": strToU8(`<html><body><h1>Opening</h1><p>The first preserved chapter has enough readable text.</p></body></html>`),
    "OEBPS/two.xhtml": strToU8(`<html><body><h1>Conclusion</h1><p>The second preserved chapter completes the book.</p></body></html>`),
  });
}

describe("readerImport", () => {
  it("preserves EPUB metadata, spine order, headings, and chapter offsets", () => {
    const document = parseEpubDocument(sampleEpub(), "local.epub");
    expect(document).toMatchObject({
      title: "The Local Book",
      author: "A. Reader",
      language: "en",
      sourceType: "epub",
    });
    expect(document.chapters.map((chapter) => chapter.title)).toEqual(["Opening", "Conclusion"]);
    expect(document.text.slice(document.chapters[0].start, document.chapters[0].end)).toContain("first preserved chapter");
    expect(document.text.slice(document.chapters[1].start, document.chapters[1].end)).toContain("second preserved chapter");
  });

  it("extracts a readable URL article and keeps its heading structure", () => {
    const document = parseHtmlReaderDocument({
      requestedUrl: "https://example.com/article",
      finalUrl: "https://example.com/article",
      contentType: "text/html",
      html: `<html><head><title>Fallback</title></head><body><article>
        <h1>Reader Architecture</h1>
        <p>Local document libraries preserve ownership and make long-form reading reliable across sessions.</p>
        <h2>Indexed storage</h2>
        <p>Audio chunks, notes, bookmarks, progress, and metadata remain attached to the original document.</p>
      </article></body></html>`,
    });
    expect(document.sourceType).toBe("url");
    expect(document.sourceUrl).toBe("https://example.com/article");
    expect(document.chapters.map((chapter) => chapter.title)).toContain("Indexed storage");
    expect(document.text).toContain("bookmarks");
  });

  it("checks URL response status and returns bounded HTML", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("<article>Readable body</article>", {
      status: 200,
      headers: { "content-type": "text/html", "content-length": "32" },
    }));
    const result = await fetchRemoteDocument("https://example.com/story", fetcher);
    expect(result.finalUrl).toBe("https://example.com/story");
    expect(result.html).toContain("Readable body");
    expect(fetcher).toHaveBeenCalledWith("https://example.com/story", expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it("rejects an oversized EPUB entry before inflating it", () => {
    const archive = zipSync({
      "META-INF/container.xml": new Uint8Array(8 * 1024 * 1024 + 1),
    }, { level: 9 });
    expect(() => parseEpubDocument(archive, "bomb.epub")).toThrow("8 MB expansion limit");
  });

  it("enforces the shared extracted-text cap for HTML imports", () => {
    expect(() => parseHtmlReaderDocument({
      requestedUrl: "https://example.com/huge",
      finalUrl: "https://example.com/huge",
      contentType: "text/html",
      html: `<html><head><title>Huge</title></head><body><article><p>${"a".repeat(MAX_READER_TEXT_CHARS + 1)}</p></article></body></html>`,
    })).toThrow("1.5 million character limit");
  });
});

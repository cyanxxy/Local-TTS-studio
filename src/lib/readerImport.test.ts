import { strToU8, zipSync, type ZippableFile } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { READER_COVER_MAX_DATA_URL_CHARS } from "./readerDocument";
import {
  MAX_READER_TEXT_CHARS,
  fetchRemoteDocument,
  parseEpubDocument,
  parseHtmlReaderDocument,
  parseMarkdownReaderDocument,
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

interface EpubFixture {
  /** Body markup of each spine document, in reading order. */
  chapters: string[];
  manifest?: string;
  metadata?: string;
  files?: Record<string, ZippableFile>;
}

function buildEpub({ chapters, manifest = "", metadata = "", files = {} }: EpubFixture): Uint8Array {
  const chapterEntries = Object.fromEntries(chapters.map((body, index) => [
    `OEBPS/chapter-${index + 1}.xhtml`,
    strToU8(`<html><head><title>Chapter ${index + 1}</title></head><body>${body}</body></html>`),
  ]));
  return zipSync({
    "mimetype": strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
      <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
      </container>`),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>Fixture Book</dc:title><dc:language>nl</dc:language>${metadata}
        </metadata>
        <manifest>
          ${chapters.map((_, index) => `<item id="c${index + 1}" href="chapter-${index + 1}.xhtml" media-type="application/xhtml+xml" />`).join("")}
          ${manifest}
        </manifest>
        <spine>${chapters.map((_, index) => `<itemref idref="c${index + 1}" />`).join("")}</spine>
      </package>`),
    ...chapterEntries,
    ...files,
  });
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(PNG_SIGNATURE);
  for (let index = PNG_SIGNATURE.length; index < length; index += 1) bytes[index] = index % 251;
  return bytes;
}

function dataUrl(type: string, bytes: Uint8Array): string {
  return `data:image/${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Rewrites the uncompressed size a stored (uncompressed) zip entry declares,
 * in both its local and central headers, so a test can make an entry lie
 * about how large it inflates.
 */
function declareStoredSize(archive: Uint8Array, name: string, size: number): Uint8Array {
  const patched = archive.slice();
  const view = new DataView(patched.buffer);
  const nameBytes = strToU8(name);
  const matchesName = (offset: number) => nameBytes.every((byte, index) => patched[offset + index] === byte);
  for (let offset = 0; offset + 46 < patched.length; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50 && view.getUint16(offset + 26, true) === nameBytes.length && matchesName(offset + 30)) {
      view.setUint32(offset + 22, size, true);
    } else if (signature === 0x02014b50 && view.getUint16(offset + 28, true) === nameBytes.length && matchesName(offset + 46)) {
      view.setUint32(offset + 24, size, true);
    }
  }
  return patched;
}

function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

describe("readerImport", () => {
  it("turns Markdown headings into chapters without leaving syntax in the text", () => {
    const document = parseMarkdownReaderDocument([
      "# The Keeper",
      "",
      "## Chapter 1: The Stairs",
      "",
      "The **keeper** climbed the [stairs](https://example.com) with `care`.",
      "",
      "- a snake_case_name item",
      "",
      "Chapter Two",
      "-----------",
      "",
      "> Quoted *line* here.",
    ].join("\n"), "the-keeper.md");

    expect(document.title).toBe("The Keeper");
    expect(document.text).not.toMatch(/[#*`[\]>]/);
    expect(document.text).toContain("The keeper climbed the stairs with care.");
    expect(document.text).toContain("a snake_case_name item");
    expect(document.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter 1: The Stairs",
      "Chapter Two",
    ]);
    for (const chapter of document.chapters) {
      expect(document.text.slice(chapter.start).startsWith(chapter.title)).toBe(true);
    }
  });

  it("keeps preamble before the first Markdown heading as an introduction", () => {
    const document = parseMarkdownReaderDocument(
      "Some opening words before any heading.\n\n## First\n\nBody text.",
      "notes.md",
    );
    expect(document.chapters.map((chapter) => chapter.title)).toEqual(["Introduction", "First"]);
  });

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

  it("reads text inside nested blocks exactly once", () => {
    const document = parseEpubDocument(buildEpub({
      chapters: [`
        <blockquote><p>A quoted paragraph.</p></blockquote>
        <ul>
          <li><p>An item paragraph.</p><p>Its continuation.</p></li>
          <li>A parent item
            <ol><li>A child item</li><li><p>A wrapped child</p></li></ol>
          </li>
        </ul>`],
    }), "nested.epub");
    expect(document.text).toBe([
      "A quoted paragraph.",
      "• An item paragraph.",
      "Its continuation.",
      "• A parent item",
      "• A child item",
      "• A wrapped child",
    ].join("\n\n"));
  });

  it("keeps an EPUB chapter whose paragraphs are only divs", () => {
    const document = parseEpubDocument(buildEpub({
      chapters: [
        "<div>The first div paragraph.</div><div><div>The second, nested div paragraph.</div></div>",
        "<p>An ordinary paragraph chapter.</p>",
      ],
    }), "divs.epub");
    expect(document.text).toContain("The first div paragraph.\n\nThe second, nested div paragraph.");
    expect(document.text).toContain("An ordinary paragraph chapter.");
  });

  it("keeps div, p, and mixed-content text together in document order", () => {
    const document = parseEpubDocument(buildEpub({
      chapters: [`
        <h2>The Harbor</h2>
        <div class="para">A div paragraph opens the section.</div>
        <p>A <em>p</em> paragraph follows it.</p>
        <div>Lead-in text<p>An inner paragraph.</p>Trailing text<br/>after a break.</div>
        <section><dl><dt>Term</dt><dd>Definition</dd></dl><figure><figcaption>A caption</figcaption></figure></section>
        <p>Ruby <ruby>漢<rt>kan</rt></ruby> text.</p><script>never read()</script>`],
    }), "mixed.epub");
    expect(document.text).toBe([
      "The Harbor",
      "A div paragraph opens the section.",
      "A p paragraph follows it.",
      "Lead-in text",
      "An inner paragraph.",
      "Trailing text\nafter a break.",
      "Term",
      "Definition",
      "A caption",
      "Ruby 漢 text.",
    ].join("\n\n"));
    expect(occurrences(document.text, "inner paragraph")).toBe(1);
  });

  it("flows source-wrapped paragraph lines and keeps only real line breaks", () => {
    const document = parseEpubDocument(buildEpub({
      chapters: [`
        <p>
Alice took down a jar from one of the
shelves as she passed; it was labelled
\t“ORANGE MARMALADE”.
</p>
        <p>A stanza line<br/>
          and the next line.</p>
        <pre>keep  this
  layout</pre>`],
    }), "wrapped.epub");
    expect(document.text).toBe([
      "Alice took down a jar from one of the shelves as she passed; it was labelled “ORANGE MARMALADE”.",
      "A stanza line\nand the next line.",
      "keep this\nlayout",
    ].join("\n\n"));

    const article = parseHtmlReaderDocument({
      requestedUrl: "https://example.com/wrapped",
      finalUrl: "https://example.com/wrapped",
      contentType: "text/html",
      html: "<html><body><article><p>One sentence\n  wrapped in the source.</p></article></body></html>",
    });
    expect(article.text).toContain("One sentence wrapped in the source.");
  });

  it("skips embedded media, graphics and form controls, and reads math by its alttext", () => {
    const document = parseEpubDocument(buildEpub({
      chapters: [`
        <p>Press <button>Click me</button>to begin<svg><title>Logo</title><text>SVG label</text></svg>.</p>
        <p>The area is <math alttext="pi r squared"><mi>π</mi><msup><mi>r</mi><mn>2</mn></msup></math>, and <math><mi>x</mi></math>is unnamed.</p>
        <video><p>Your reader cannot play this video.</p></video><audio>Audio fallback</audio>
        <object>Object fallback</object><embed src="x.swf"/><iframe>Frame text</iframe><canvas>Canvas text</canvas>
        <form><select><option>First option</option></select><textarea>Draft text</textarea></form>
        <p>The end.</p>`],
    }), "media.epub");
    expect(document.text).toBe([
      "Press to begin.",
      "The area is pi r squared , and is unnamed.",
      "The end.",
    ].join("\n\n"));
  });

  it("keeps chapter titles on one line when headings or labels contain breaks", () => {
    const document = parseEpubDocument(buildEpub({
      chapters: [
        "<h2>Part One<br/>The\n  Harbor</h2><p>The harbor chapter body.</p><h2>Ashore</h2><p>The landing.</p>",
        "<p>A chapter titled by its navigation label.</p>",
      ],
      manifest: `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />`,
      files: {
        "OEBPS/nav.xhtml": strToU8(`<html><body><nav><ol>
          <li><a href="chapter-2.xhtml">The Second
            Chapter</a></li>
        </ol></nav></body></html>`),
      },
    }), "titles.epub");
    expect(document.chapters.map((chapter) => chapter.title)).toEqual([
      "Part One The Harbor",
      "Ashore",
      "The Second Chapter",
    ]);
  });

  it("reads an EPUB 3 cover-image as a data URL", () => {
    const cover = pngBytes();
    const document = parseEpubDocument(buildEpub({
      chapters: ["<p>Body.</p>"],
      manifest: `<item id="art" href="images/front.png" media-type="image/png" properties="cover-image" />`,
      files: { "OEBPS/images/front.png": cover },
    }), "cover3.epub");
    expect(document.cover).toEqual({ dataUrl: dataUrl("png", cover) });
  });

  it("reads an EPUB 2 meta cover and trusts the image bytes over the declared type", () => {
    const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const document = parseEpubDocument(buildEpub({
      chapters: ["<p>Body.</p>"],
      metadata: `<meta name="cover" content="front-image" />`,
      manifest: `<item id="front-image" href="../art/front.jpg" media-type="image/png" />`,
      files: { "art/front.jpg": cover },
    }), "cover2.epub");
    expect(document.cover).toEqual({ dataUrl: dataUrl("jpeg", cover) });
  });

  it("skips covers that are SVG, oversized, mislabeled, or missing without failing the import", () => {
    const svg = parseEpubDocument(buildEpub({
      chapters: ["<p>Body.</p>"],
      manifest: `<item id="art" href="cover.svg" media-type="image/svg+xml" properties="cover-image" />`,
      files: { "OEBPS/cover.svg": strToU8(`<svg xmlns="http://www.w3.org/2000/svg"/>`) },
    }), "svg.epub");
    expect(svg.cover).toBeUndefined();

    const oversizedBytes = pngBytes(Math.ceil(READER_COVER_MAX_DATA_URL_CHARS * 0.75) + 1);
    const oversized = parseEpubDocument(buildEpub({
      chapters: ["<p>Body.</p>"],
      manifest: `<item id="art" href="cover.png" media-type="image/png" properties="cover-image" />`,
      files: { "OEBPS/cover.png": oversizedBytes },
    }), "large.epub");
    expect(oversized.cover).toBeUndefined();
    expect(oversized.text).toBe("Body.");

    const mislabeled = parseEpubDocument(buildEpub({
      chapters: ["<p>Body.</p>"],
      manifest: `<item id="cover" href="cover.jpg" media-type="image/jpeg" />`,
      files: { "OEBPS/cover.jpg": strToU8("<html>not an image</html>") },
    }), "fake.epub");
    expect(mislabeled.cover).toBeUndefined();

    const missing = parseEpubDocument(buildEpub({
      chapters: ["<p>Body.</p>"],
      manifest: `<item id="art" href="gone.png" media-type="image/png" properties="cover-image" />`,
    }), "missing.epub");
    expect(missing.cover).toBeUndefined();
  });

  it("tries the next cover candidate when the first cannot be read", () => {
    const cover = pngBytes(48);
    const document = parseEpubDocument(buildEpub({
      chapters: ["<p>Body.</p>"],
      metadata: `<meta name="cover" content="front" />`,
      manifest: `
        <item id="art" href="images/missing.png" media-type="image/png" properties="cover-image" />
        <item id="front" href="images/front.png" media-type="image/png" />`,
      files: { "OEBPS/images/front.png": cover },
    }), "fallback.epub");
    expect(document.cover).toEqual({ dataUrl: dataUrl("png", cover) });
  });

  it("matches \"cover\" only as a word of its own in manifest names", () => {
    const document = parseEpubDocument(buildEpub({
      chapters: ["<p>Body.</p>"],
      manifest: `<item id="map" href="images/discover.png" media-type="image/png" />`,
      files: { "OEBPS/images/discover.png": pngBytes(32) },
    }), "discover.epub");
    expect(document.cover).toBeUndefined();
  });

  it("rejects a cover that inflates past the cap before encoding it, whatever size it declares", () => {
    const oversizedBytes = pngBytes(Math.ceil(READER_COVER_MAX_DATA_URL_CHARS * 0.75) + 1);
    const archive = buildEpub({
      chapters: ["<p>Body.</p>"],
      manifest: `<item id="art" href="cover.png" media-type="image/png" properties="cover-image" />`,
      // Stored, so the inflated size is simply the bytes on disk.
      files: { "OEBPS/cover.png": [oversizedBytes, { level: 0 }] },
    });
    const encode = vi.spyOn(globalThis, "btoa");
    try {
      const document = parseEpubDocument(declareStoredSize(archive, "OEBPS/cover.png", 64), "liar.epub");
      expect(document.text).toBe("Body.");
      expect(document.cover).toBeUndefined();
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("falls back to a raster manifest item named cover", () => {
    const cover = pngBytes(32);
    const document = parseEpubDocument(buildEpub({
      chapters: ["<p>Body.</p>"],
      manifest: `<item id="img1" href="images/Cover.png" media-type="image/png" />`,
      files: { "OEBPS/images/Cover.png": cover },
    }), "named.epub");
    expect(document.cover).toEqual({ dataUrl: dataUrl("png", cover) });
  });

  it("propagates the EPUB and HTML document language", () => {
    expect(parseEpubDocument(buildEpub({ chapters: ["<p>Hallo.</p>"] }), "nl.epub").language).toBe("nl");
    const article = parseHtmlReaderDocument({
      requestedUrl: "https://example.com/fr",
      finalUrl: "https://example.com/fr",
      contentType: "text/html",
      html: `<html lang="fr-CA"><head><title>Titre</title></head><body><article>
        <p>Une bibliothèque locale garde les documents, les signets et la progression de lecture ensemble.</p>
      </article></body></html>`,
    });
    expect(article.language).toBe("fr-CA");
  });

  it("does not repeat quoted paragraphs in URL articles", () => {
    const document = parseHtmlReaderDocument({
      requestedUrl: "https://example.com/quotes",
      finalUrl: "https://example.com/quotes",
      contentType: "text/html",
      html: `<html><head><title>Quotes</title></head><body><article>
        <p>Local document libraries preserve ownership and make long-form reading reliable across sessions.</p>
        <blockquote><p>Quoted paragraphs inside a blockquote should be read aloud exactly one time.</p></blockquote>
      </article></body></html>`,
    });
    expect(occurrences(document.text, "Quoted paragraphs")).toBe(1);
  });
});

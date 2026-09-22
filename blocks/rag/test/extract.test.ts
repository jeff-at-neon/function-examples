import { describe, expect, it } from "vitest";
import { extractText, normalizeText, stripHtml } from "../src/extract.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("extractText", () => {
  it("extracts plain text", () => {
    const result = extractText({ key: "notes.txt", body: bytes("hello world") });
    expect(result).toMatchObject({ status: "extracted", kind: "text", text: "hello world" });
  });

  it("extracts markdown as text", () => {
    const result = extractText({ key: "readme.md", body: bytes("# Title\n\nBody text.") });
    expect(result.status).toBe("extracted");
  });

  // The honest-failure requirement: a PDF must not land in `ready` with zero chunks, because a
  // silent success is far worse than a clear "not yet".
  it("reports PDFs as needing a parser rather than returning empty text", () => {
    const result = extractText({ key: "report.pdf", body: bytes("%PDF-1.7\nbinary junk") });
    expect(result.status).toBe("needsParser");
    if (result.status === "needsParser") {
      expect(result.parser).toBe("pdf");
      expect(result.reason).toMatch(/unpdf|WASM/);
    }
  });

  it("detects PDFs by magic bytes even with a misleading extension", () => {
    const result = extractText({ key: "actually-a-pdf.bin", body: bytes("%PDF-1.4 content") });
    expect(result.status).toBe("needsParser");
  });

  it("reports DOCX as needing a parser", () => {
    const result = extractText({ key: "contract.docx", body: bytes("PK") });
    expect(result).toMatchObject({ status: "needsParser", parser: "docx" });
  });

  // Storage triggers have no suffix filter, so non-documents arrive here by design.
  it("skips images with an explanatory reason", () => {
    const result = extractText({ key: "photo.jpg", body: bytes("\xff\xd8\xff junk") });
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toMatch(/not a text-bearing document/);
    }
  });

  it("skips files that decode to nothing", () => {
    const result = extractText({ key: "empty.txt", body: bytes("   \n\n  ") });
    expect(result).toMatchObject({ status: "skipped", reason: "file decoded to empty text" });
  });

  it("converts HTML to readable text", () => {
    const html = "<html><body><h1>Title</h1><p>First para.</p><p>Second para.</p></body></html>";
    const result = extractText({ key: "page.html", body: bytes(html) });
    expect(result.status).toBe("extracted");
    if (result.status === "extracted") {
      expect(result.text).toContain("Title");
      expect(result.text).toContain("First para.");
      expect(result.text).not.toContain("<p>");
    }
  });

  it("truncates at maxChars instead of risking an OOM", () => {
    const result = extractText({ key: "big.txt", body: bytes("x".repeat(5_000)), maxChars: 100 });
    expect(result.status).toBe("extracted");
    if (result.status === "extracted") expect(result.text).toHaveLength(100);
  });

  it("tolerates invalid UTF-8 rather than failing the whole document", () => {
    const invalid = new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x21]);
    const result = extractText({ key: "mixed.txt", body: invalid });
    expect(result.status).toBe("extracted");
  });
});

describe("stripHtml", () => {
  // Embedding minified JavaScript actively poisons retrieval, so this is a correctness
  // requirement rather than cosmetic cleanup.
  it("removes script and style content entirely", () => {
    const html = "<style>.a{color:red}</style><script>var x=1;</script><p>Real text</p>";
    const stripped = stripHtml(html);
    expect(stripped).toContain("Real text");
    expect(stripped).not.toContain("color:red");
    expect(stripped).not.toContain("var x");
  });

  it("turns block closers into paragraph breaks so the chunker has boundaries", () => {
    expect(stripHtml("<p>One</p><p>Two</p>")).toMatch(/One\s*\n\n\s*Two/);
  });

  it("decodes common entities", () => {
    expect(stripHtml("<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>")).toContain('a & b <c> "d"');
  });

  it("drops comments", () => {
    expect(stripHtml("<!-- hidden --><p>shown</p>")).not.toContain("hidden");
  });
});

describe("normalizeText", () => {
  it("collapses excess blank lines but preserves paragraph structure", () => {
    expect(normalizeText("a\n\n\n\n\nb")).toBe("a\n\nb");
    expect(normalizeText("a\n\nb")).toBe("a\n\nb");
  });

  it("normalizes CRLF and strips trailing whitespace", () => {
    expect(normalizeText("a  \r\nb\t\t")).toBe("a\nb");
  });

  // Escapes, not literals: a raw NBSP in a test file is invisible and can silently assert the
  // wrong thing. The bug this covers replaced NBSP with "" instead of " ", welding words.
  it("folds unicode spaces to ordinary spaces without welding words together", () => {
    expect(normalizeText("a\u00a0b")).toBe("a b");
    expect(normalizeText("a\u3000b")).toBe("a b");
    expect(normalizeText("a\u2009b")).toBe("a b");
  });

  it("strips zero-width characters entirely", () => {
    expect(normalizeText("a\u200bb")).toBe("ab");
    expect(normalizeText("\ufeffheading")).toBe("heading");
  });
});

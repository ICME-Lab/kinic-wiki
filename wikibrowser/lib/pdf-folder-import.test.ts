import { describe, expect, it } from "vitest";
import { pdfPagesToMarkdown, pdfTextItemsToPlainText } from "@/lib/pdf-folder-import";

describe("PDF folder import formatting", () => {
  it("preserves text item contents and uses only explicit line endings", () => {
    expect(pdfTextItemsToPlainText([
      { str: "日", hasEOL: false },
      { str: "本", hasEOL: false },
      { str: "語", hasEOL: true },
      { str: "Hello ", hasEOL: false },
      { str: "world", hasEOL: false },
      { str: ",", hasEOL: false }
    ])).toBe("日本語\nHello world,");
    expect(pdfTextItemsToPlainText([
      { str: " leading and trailing ", hasEOL: false }
    ])).toBe(" leading and trailing ");
  });

  it("renders deterministic page sections and marks empty pages", () => {
    expect(pdfPagesToMarkdown("manual.pdf", ["First page", ""])).toBe([
      "# manual",
      "<!-- Text extracted locally from manual.pdf. Original PDF is not stored. -->",
      "## Page 1\n\nFirst page",
      "## Page 2\n\n_No extractable text on this page._"
    ].join("\n\n"));
  });
});

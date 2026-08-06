import { describe, expect, it } from "vitest";
import { pdfPagesToMarkdown, pdfTextItemsToPlainText } from "@/lib/pdf-folder-import";

describe("PDF folder import formatting", () => {
  it("preserves text item order and explicit line endings", () => {
    expect(pdfTextItemsToPlainText([
      { str: "Hello", hasEOL: false },
      { str: "world", hasEOL: true },
      { str: "次の行", hasEOL: false }
    ])).toBe("Hello world\n次の行");
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

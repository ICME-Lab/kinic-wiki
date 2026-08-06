export const PDF_IMPORT_EXTRACTOR = "pdfjs-dist@6.1.200";

export type ExtractedPdfImport = {
  content: string;
  metadataJson: string;
  pageCount: number;
};

type PdfTextItem = {
  str: string;
  hasEOL: boolean;
};

export async function extractPdfForFolderImport(
  file: Pick<File, "name" | "arrayBuffer">,
  signal?: AbortSignal
): Promise<ExtractedPdfImport> {
  throwIfAborted(signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);
  // PDF.js transfers the supplied buffer to its worker, so hash it before the
  // underlying ArrayBuffer can become detached.
  const sourceSha256 = await sha256Hex(bytes);
  throwIfAborted(signal);
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  ]);
  throwIfAborted(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const loadingTask = pdfjs.getDocument({ data: bytes });
  let destroyPromise: Promise<void> | null = null;
  const abortLoadingTask = () => {
    destroyPromise ??= loadingTask.destroy();
  };
  signal?.addEventListener("abort", abortLoadingTask, { once: true });

  try {
    throwIfAborted(signal);
    const document = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await document.getPage(pageNumber);
      try {
        const text = await page.getTextContent();
        throwIfAborted(signal);
        const items = text.items.flatMap((item) => "str" in item ? [{ str: item.str, hasEOL: item.hasEOL }] : []);
        pages.push(pdfTextItemsToPlainText(items));
      } finally {
        page.cleanup();
      }
    }

    if (!pages.some((page) => page.trim().length > 0)) {
      throw new Error("OCR required: the PDF contains no extractable text.");
    }

    return {
      content: pdfPagesToMarkdown(file.name, pages),
      metadataJson: JSON.stringify({
        import_type: "pdf_text",
        source_filename: file.name,
        source_sha256: sourceSha256,
        page_count: document.numPages,
        extractor: PDF_IMPORT_EXTRACTOR
      }),
      pageCount: document.numPages
    };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (isPasswordError(error)) {
      throw new Error("Password-protected PDFs are not supported.");
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortLoadingTask);
    await (destroyPromise ?? loadingTask.destroy());
  }
}

export function pdfTextItemsToPlainText(items: PdfTextItem[]): string {
  let output = "";
  for (const item of items) {
    output += item.str;
    if (item.hasEOL && !output.endsWith("\n")) output += "\n";
  }
  return output;
}

export function pdfPagesToMarkdown(fileName: string, pages: string[]): string {
  const title = fileName.replace(/\.pdf$/i, "").replace(/[\r\n]+/g, " ").trim() || "Imported PDF";
  const sections = pages.map((page, index) => {
    const body = page.trim() || "_No extractable text on this page._";
    return `## Page ${index + 1}\n\n${body}`;
  });
  return [
    `# ${title}`,
    `<!-- Text extracted locally from ${fileName.replace(/[\r\n]+/g, " ")}. Original PDF is not stored. -->`,
    ...sections
  ].join("\n\n");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function isPasswordError(error: unknown): boolean {
  return error instanceof Error && (error.name === "PasswordException" || /password/i.test(error.message));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("Folder import was cancelled.", "AbortError");
}

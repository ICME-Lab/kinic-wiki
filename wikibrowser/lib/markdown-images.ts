// Where: wikibrowser/lib/markdown-images.ts
// What: Markdown image source policy helpers.
// Why: WikiBrowser renders external Markdown images directly, so only explicit HTTPS URLs should become img src values.

export function safeMarkdownImageSrc(src: unknown): string | null {
  if (typeof src !== "string") return null;
  const trimmed = src.trim();
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

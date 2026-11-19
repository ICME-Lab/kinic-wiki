// Where: wikibrowser/lib/markdown-wikilinks.ts
// What: Convert Obsidian-style wikilinks into ordinary Markdown links.
// Why: react-markdown only parses CommonMark/GFM links, while stored notes may use [[target|label]].

export function renderWikilinksAsMarkdown(content: string): string {
  return walkLinesSkippingCode(content, (line) => renderLineWikilinks(line));
}

export function renderWikilinksAsMarkdownWithSourceOffsets(content: string) {
  const rewrites: { renderedStart: number; renderedEnd: number; sourceEnd: number }[] = [];
  const markdown = walkLinesSkippingCode(content, (line, sourceLineStart, renderedLineStart) =>
    renderLineWikilinks(line, (sourceEnd, renderedStart, renderedEnd) => {
      rewrites.push({
        renderedStart: renderedLineStart + renderedStart,
        renderedEnd: renderedLineStart + renderedEnd,
        sourceEnd: sourceLineStart + sourceEnd,
      });
    }));

  return {
    markdown,
    sourceOffsetAt(renderedOffset: number): number | undefined {
      let shift = 0;
      for (const rewrite of rewrites) {
        if (renderedOffset < rewrite.renderedStart) break;
        // Generated Markdown inside this rewrite has no exact source offset.
        if (renderedOffset < rewrite.renderedEnd) return;
        shift = rewrite.renderedEnd - rewrite.sourceEnd;
      }
      return renderedOffset - shift;
    },
  };
}

export function renderWikilinksAsText(content: string): string {
  return walkLinesSkippingCode(content, renderLineWikilinksText);
}

function walkLinesSkippingCode(content: string, transform: (line: string, sourceStart: number, renderedStart: number) => string): string {
  const lines = content.split("\n");
  let sourceOffset = 0;
  let shift = 0;
  let fence: MarkdownFence | null = null;
  return lines.map((line) => {
    const start = sourceOffset;
    sourceOffset += line.length + 1;
    if (fence) {
      if (isClosingFenceLine(line, fence)) {
        fence = null;
      }
      return line;
    }
    const nextFence = parseOpeningFenceLine(line);
    if (nextFence) {
      fence = nextFence;
      return line;
    }
    if (isIndentedCodeLine(line)) {
      return line;
    }
    const rendered = transform(line, start, start + shift);
    shift += rendered.length - line.length;
    return rendered;
  }).join("\n");
}

function parseWikilink(raw: string): { target: string; label: string } | null {
  const separator = raw.indexOf("|");
  const target = (separator === -1 ? raw : raw.slice(0, separator)).trim();
  const alias = separator === -1 ? "" : raw.slice(separator + 1).trim();
  if (!target) {
    return null;
  }
  return { target, label: alias || target };
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]|])/g, "\\$1");
}

function escapeMarkdownDestination(value: string): string {
  return value.replace(/([\\<>])/g, "\\$1");
}

type ReportRewrite = (sourceEnd: number, renderedStart: number, renderedEnd: number) => void;

function renderLineWikilinks(line: string, reportRewrite?: ReportRewrite): string {
  return transformLineWikilinks(line, renderWikilink, { embeds: false, reportRewrite });
}

function renderLineWikilinksText(line: string): string {
  return transformLineWikilinks(line, (raw) => {
    const parsed = parseWikilink(raw);
    const label = parsed?.label.replace(/[!-/:-@[-`{-~]/g, "\\$&");
    return parsed ? `[${label}](#kinic-wikilink-literal)` : null;
  }, { embeds: true });
}

function transformLineWikilinks(
  line: string,
  render: (raw: string) => string | null,
  { embeds, reportRewrite }: { embeds: boolean; reportRewrite?: ReportRewrite },
): string {
  let output = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "`") {
      const inlineCodeEnd = findInlineCodeEnd(line, index);
      if (inlineCodeEnd !== -1) {
        output += line.slice(index, inlineCodeEnd);
        index = inlineCodeEnd;
        continue;
      }
    }
    const isEmbed = embeds && line.startsWith("![[", index);
    const isLink = line.startsWith("[[", index) && (embeds || line[index - 1] !== "!");
    if (isEmbed || isLink) {
      const contentStart = isEmbed ? index + 3 : index + 2;
      const close = line.indexOf("]]", contentStart);
      if (close === -1) {
        output += line.slice(index);
        break;
      }
      const raw = line.slice(contentStart, close);
      const rendered = render(raw);
      if (rendered !== null) reportRewrite?.(close + 2, output.length, output.length + rendered.length);
      output += rendered ?? line.slice(index, close + 2);
      index = close + 2;
      continue;
    }
    output += line[index];
    index += 1;
  }
  return output;
}

function renderWikilink(raw: string): string | null {
  const parsed = parseWikilink(raw);
  if (!parsed) {
    return null;
  }
  return `[${escapeMarkdownLabel(parsed.label)}](<${escapeMarkdownDestination(parsed.target)}>)`;
}

function findInlineCodeEnd(line: string, start: number): number {
  const runLength = countBacktickRun(line, start);
  const closing = line.indexOf("`".repeat(runLength), start + runLength);
  return closing === -1 ? -1 : closing + runLength;
}

function countBacktickRun(line: string, start: number): number {
  let index = start;
  while (line[index] === "`") {
    index += 1;
  }
  return index - start;
}

function parseOpeningFenceLine(line: string): MarkdownFence | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return null;
  }
  const fence = match[2];
  const marker = fence[0] === "`" ? "`" : "~";
  return { marker, length: fence.length };
}

function isClosingFenceLine(line: string, fence: MarkdownFence): boolean {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(normalized);
  if (!match) {
    return false;
  }
  const closingFence = match[2];
  return closingFence[0] === fence.marker && closingFence.length >= fence.length;
}

function isIndentedCodeLine(line: string): boolean {
  return line.startsWith("\t") || line.startsWith("    ");
}

type MarkdownFence = {
  marker: "`" | "~";
  length: number;
};

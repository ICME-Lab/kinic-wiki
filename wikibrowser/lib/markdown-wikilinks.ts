// Where: wikibrowser/lib/markdown-wikilinks.ts
// What: Convert Obsidian-style wikilinks into ordinary Markdown links.
// Why: react-markdown only parses CommonMark/GFM links, while stored notes may use [[target|label]].

export function renderWikilinksAsMarkdown(content: string): string {
  const lines = content.split("\n");
  let fence: MarkdownFence | null = null;
  return lines.map((line) => {
    const nextFence = parseFenceLine(line);
    if (fence) {
      if (nextFence && nextFence.marker === fence.marker && nextFence.length >= fence.length) {
        fence = null;
      }
      return line;
    }
    if (nextFence) {
      fence = nextFence;
      return line;
    }
    if (isIndentedCodeLine(line)) {
      return line;
    }
    return renderLineWikilinks(line);
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

function renderLineWikilinks(line: string): string {
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
    if (line.startsWith("[[", index) && line[index - 1] !== "!") {
      const close = line.indexOf("]]", index + 2);
      if (close === -1) {
        output += line.slice(index);
        break;
      }
      const raw = line.slice(index + 2, close);
      const rendered = renderWikilink(raw);
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

function parseFenceLine(line: string): MarkdownFence | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return null;
  }
  const fence = match[2];
  const marker = fence[0] === "`" ? "`" : "~";
  return { marker, length: fence.length };
}

function isIndentedCodeLine(line: string): boolean {
  return line.startsWith("\t") || line.startsWith("    ");
}

type MarkdownFence = {
  marker: "`" | "~";
  length: number;
};

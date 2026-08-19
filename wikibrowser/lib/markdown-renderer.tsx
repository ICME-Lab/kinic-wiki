// Where: wikibrowser/lib/markdown-renderer.tsx
// What: Minimal self-built Markdown renderer (CommonMark + GFM subset) used in place of
//       react-markdown + remark-gfm + @flowershow/remark-wiki-link.
// Why: Avoid the large unified/remark dependency tree in the SSR and client bundles.
import { Fragment, type ReactNode } from "react";

type ElementProps = {
  href?: string;
  title?: string;
  src?: string;
  alt?: string;
  className?: string;
  start?: number;
  checked?: boolean;
  disabled?: boolean;
  align?: "left" | "center" | "right";
};

export type MarkdownComponentProps = ElementProps & { children?: ReactNode };

export type MarkdownComponents = Partial<Record<MarkdownTag, (props: MarkdownComponentProps) => ReactNode>>;

export type MarkdownTag =
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "p" | "a" | "img" | "ul" | "ol" | "li" | "blockquote"
  | "pre" | "code" | "table" | "thead" | "tbody" | "tr" | "th" | "td"
  | "em" | "strong" | "del" | "hr" | "br" | "input";

type InlineNode = string | InlineElement;
type InlineElement = {
  tag: MarkdownTag;
  props: ElementProps;
  children: InlineNode[];
};

type Block =
  | { type: "heading"; level: number; inline: InlineNode[] }
  | { type: "paragraph"; inline: InlineNode[] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "blockquote"; blocks: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[]; loose: boolean }
  | { type: "table"; headers: InlineNode[][]; rows: InlineNode[][][]; aligns: (("left" | "center" | "right") | undefined)[] }
  | { type: "hr" };

type ListItem = {
  task: boolean;
  checked: boolean;
  blocks: Block[];
  internalBlank: boolean;
};

const ESCAPE_RE = /\\([\\`*_{}[\]<>()#+\-.!|])/;

export function Markdown({ children, components }: { children: string; components?: MarkdownComponents }): ReactNode {
  const source = normalize(children);
  const refs = extractReferences(source);
  return renderBlocks(parseBlocks(source, refs), components ?? {});
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

type ReferenceMap = Map<string, { href: string; title?: string }>;

const LINK_REFERENCE_RE = /^ {0,3}\[([^\]]+)\]:[ \t]*(\S+)(?:[ \t]+(?:["'(](.*?)["')]|\((.*?)\)))?[ \t]*$/;

function extractReferences(source: string): ReferenceMap {
  const refs: ReferenceMap = new Map();
  for (const line of source.split("\n")) {
    const match = LINK_REFERENCE_RE.exec(line);
    if (match) {
      refs.set(match[1].toLowerCase(), { href: match[2], title: match[3] ?? match[4] });
    }
  }
  return refs;
}

function parseBlocks(source: string, refs: ReferenceMap): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let index = 0;
  const isBlank = (line: string) => line.trim() === "";

  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    if (LINK_REFERENCE_RE.test(line)) {
      index += 1;
      continue;
    }

    const fence = parseFence(line);
    if (fence) {
      const { lang, text, consumed } = readFencedCode(lines, index, fence.marker, fence.length);
      blocks.push({ type: "code", lang, text });
      index += consumed;
      continue;
    }

    if (isIndentedCode(line)) {
      const { text, consumed } = readIndentedCode(lines, index);
      blocks.push({ type: "code", lang: null, text });
      index += consumed;
      continue;
    }

    const heading = parseAtxHeading(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, inline: parseInline(heading.content, refs) });
      index += 1;
      continue;
    }

    const setext = parseSetextHeading(lines, index);
    if (setext) {
      blocks.push({ type: "heading", level: setext.level, inline: parseInline(setext.content, refs) });
      index += 2;
      continue;
    }

    if (/^ {0,3}> ?/.test(line)) {
      const { blocks: inner, consumed } = readBlockquote(lines, index, refs);
      blocks.push({ type: "blockquote", blocks: inner });
      index += consumed;
      continue;
    }

    const list = parseList(lines, index, refs);
    if (list) {
      blocks.push(list.block);
      index += list.consumed;
      continue;
    }

    if (/^ {0,3}(---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    const table = parseTable(lines, index, refs);
    if (table) {
      blocks.push(table.block);
      index += table.consumed;
      continue;
    }

    const paragraph = readParagraph(lines, index);
    blocks.push({ type: "paragraph", inline: parseInline(paragraph.text, refs) });
    index += paragraph.consumed;
  }
  return blocks;
}

function parseFence(line: string): { marker: "`" | "~"; length: number; lang: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const fence = match[1];
  const marker = fence[0] === "`" ? "`" : "~";
  return { marker, length: fence.length, lang: match[2].trim() };
}

function readFencedCode(lines: string[], index: number, marker: "`" | "~", length: number): { lang: string | null; text: string; consumed: number } {
  const lang = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[index])?.[2] ?? "";
  const body: string[] = [];
  let cursor = index + 1;
  while (cursor < lines.length) {
    const normalized = lines[cursor].endsWith("\r") ? lines[cursor].slice(0, -1) : lines[cursor];
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(normalized);
    if (closing && closing[1][0] === marker && closing[1].length >= length) {
      cursor += 1;
      break;
    }
    body.push(lines[cursor]);
    cursor += 1;
  }
  return { lang: lang || null, text: body.join("\n"), consumed: cursor - index };
}

function isIndentedCode(line: string): boolean {
  return line.startsWith("\t") || line.startsWith("    ");
}

function readIndentedCode(lines: string[], index: number): { text: string; consumed: number } {
  const body: string[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim() === "") {
      body.push("");
      cursor += 1;
      continue;
    }
    if (isIndentedCode(line)) {
      body.push(line.replace(/^(?: {4}|\t)/, ""));
      cursor += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  return { text: body.join("\n"), consumed: cursor - index };
}

function parseAtxHeading(line: string): { level: number; content: string } | null {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, content: match[2] ?? "" };
}

function parseSetextHeading(lines: string[], index: number): { level: number; content: string } | null {
  const next = lines[index + 1];
  if (next === undefined) return null;
  const current = lines[index];
  if (current.trim() === "") return null;
  if (listMarker(current) || parseFence(current) || /^ {0,3}> ?/.test(current)) return null;
  if (/^=+[ \t]*$/.test(next)) return { level: 1, content: current.trim() };
  if (/^-+[ \t]*$/.test(next)) return { level: 2, content: current.trim() };
  return null;
}

function readBlockquote(lines: string[], index: number, refs: ReferenceMap): { blocks: Block[]; consumed: number } {
  const raw: string[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (/^ {0,3}> ?/.test(line)) {
      raw.push(line.replace(/^ {0,3}> ?/, ""));
      cursor += 1;
      continue;
    }
    if (line.trim() === "" && cursor + 1 < lines.length && /^ {0,3}> ?/.test(lines[cursor + 1])) {
      raw.push("");
      cursor += 1;
      continue;
    }
    break;
  }
  return { blocks: parseBlocks(raw.join("\n"), refs), consumed: cursor - index };
}

function parseList(lines: string[], index: number, refs: ReferenceMap): { block: Block; consumed: number } | null {
  const first = listMarker(lines[index]);
  if (!first) return null;
  const ordered = first.ordered;
  const start = first.ordered ? first.start : 1;
  const items: ListItem[] = [];
  let cursor = index;
  let sawBlank = false;

  while (cursor < lines.length) {
    const marker = listMarker(lines[cursor]);
    if (!marker || marker.ordered !== ordered) break;
    const itemIndent = marker.indent;
    const itemStart = lines[cursor];
    const itemContent = removeListMarker(itemStart, marker);
    const markerEnd = itemIndent + marker.marker.length;
    const contentIndent = markerEnd + (/^[ \t]*/.exec(itemStart.slice(markerEnd))?.[0].length ?? 0);
    const task = parseTaskMarker(itemContent);
    const itemLines: string[] = [];
    itemLines.push(itemContent);
    let itemInternalBlank = false;
    cursor += 1;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() === "") {
        const next = lines[cursor + 1];
        if (next !== undefined && next.trim() !== "") {
          const nextMarker = listMarker(next);
          if (nextMarker && nextMarker.ordered === ordered) {
            sawBlank = true;
            itemLines.push("");
            cursor += 1;
            continue;
          }
          if (!nextMarker && /^[ \t]/.test(next)) {
            itemInternalBlank = true;
            itemLines.push("");
            cursor += 1;
            continue;
          }
        }
        break;
      }
      const markerAtLine = listMarker(line);
      if (markerAtLine) {
        if (markerAtLine.indent <= itemIndent) break;
      } else if (!isContinuation(line, contentIndent)) {
        break;
      }
      itemLines.push(line.slice(itemIndent));
      cursor += 1;
    }
    while (itemLines.length > 0 && itemLines[itemLines.length - 1] === "") itemLines.pop();
    const taskContent = task ? task.content : itemLines[0] ?? "";
    const inner = task
      ? parseBlocks([taskContent, ...itemLines.slice(1)].join("\n"), refs)
      : parseBlocks(itemLines.join("\n"), refs);
    items.push({ task: Boolean(task), checked: task?.checked ?? false, blocks: inner, internalBlank: itemInternalBlank });
  }

  if (items.length === 0) return null;
  const loose = sawBlank || items.some((item) => item.internalBlank);
  return { block: { type: "list", ordered, start, items, loose }, consumed: cursor - index };
}

function isContinuation(line: string, indent: number): boolean {
  if (line.trim() === "") return true;
  return line.startsWith(" ".repeat(indent)) || line.startsWith("\t");
}

function listMarker(line: string): { ordered: boolean; start: number; indent: number; marker: string } | null {
  const unordered = /^( {0,3})([-*+])([ \t]+)/.exec(line);
  if (unordered) return { ordered: false, start: 1, indent: unordered[1].length, marker: unordered[2] };
  const ordered = /^( {0,3})(\d{1,9})([.)])([ \t]+)/.exec(line);
  if (ordered) return { ordered: true, start: Number(ordered[2]), indent: ordered[1].length, marker: `${ordered[2]}${ordered[3]}` };
  return null;
}

function removeListMarker(line: string, marker: { indent: number; marker: string }): string {
  return line.slice(marker.indent + marker.marker.length).replace(/^[ \t]+/, "");
}

function parseTaskMarker(content: string): { checked: boolean; content: string } | null {
  const match = /^\[([ xX])\][ \t]+/.exec(content);
  if (!match) return null;
  return { checked: match[1] !== " ", content: content.slice(match[0].length) };
}

function parseTable(lines: string[], index: number, refs: ReferenceMap): { block: Block; consumed: number } | null {
  const header = lines[index];
  const separator = lines[index + 1];
  if (header === undefined || separator === undefined) return null;
  const headerCells = splitTableRow(header);
  if (headerCells.length === 0) return null;
  const parsedAligns = splitTableRow(separator).map((cell) => {
    const trimmed = cell.trim();
    if (!/^:?-{1,}:?$/.test(trimmed)) return null;
    if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center" as const;
    if (trimmed.endsWith(":")) return "right" as const;
    return undefined;
  });
  if (!parsedAligns.length || parsedAligns.some((a) => a === null)) return null;
  const aligns = parsedAligns as (("left" | "center" | "right") | undefined)[];

  const headers = headerCells.map((cell) => parseInline(cell.trim(), refs));
  const rows: InlineNode[][][] = [];
  let cursor = index + 2;
  while (cursor < lines.length && lines[cursor].trim() !== "" && lines[cursor].includes("|")) {
    rows.push(splitTableRow(lines[cursor]).map((cell) => parseInline(cell.trim(), refs)));
    cursor += 1;
  }
  return { block: { type: "table", headers, rows, aligns }, consumed: cursor - index };
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, "");
  if (!trimmed.includes("|")) return [trimmed];
  return trimmed.split("|");
}

function readParagraph(lines: string[], index: number): { text: string; consumed: number } {
  const parts: string[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim() === "") break;
    if (/^ {0,3}(#{1,6})[ \t]/.test(line)) break;
    if (parseFence(line)) break;
    if (listMarker(line)) break;
    if (/^ {0,3}> ?/.test(line)) break;
    if (/^ {0,3}(---+|\*\*\*+|___+)\s*$/.test(line)) break;
    parts.push(line);
    cursor += 1;
  }
  return { text: parts.join("\n"), consumed: cursor - index };
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

function parseInline(source: string, refs: ReferenceMap): InlineNode[] {
  return parseInlineRange(source, 0, source.length, refs, false);
}

function parseInlineRange(source: string, from: number, to: number, refs: ReferenceMap, inLink = false): InlineNode[] {
  const nodes: InlineNode[] = [];
  let cursor = from;
  while (cursor < to) {
    const char = source[cursor];

    if (char === "\n") {
      const isBackslashBreak = cursor > from && source[cursor - 1] === "\\";
      const isDoubleSpaceBreak = cursor >= from + 2 && source[cursor - 2] === " " && source[cursor - 1] === " ";
      if (isBackslashBreak) {
        popTrailingChar(nodes);
        nodes.push({ tag: "br", props: {}, children: [] });
        cursor += 1;
        continue;
      }
      if (isDoubleSpaceBreak) {
        trimTrailingSpaces(nodes);
        nodes.push({ tag: "br", props: {}, children: [] });
        cursor += 1;
        continue;
      }
    }

    if (char === "`") {
      const code = readCodeSpan(source, cursor);
      if (code) {
        nodes.push({ tag: "code", props: {}, children: [code.text] });
        cursor = code.next;
        continue;
      }
    }

    if (char === "!") {
      const image = readImage(source, cursor, refs);
      if (image) {
        nodes.push({ tag: "img", props: { src: image.src, alt: image.alt }, children: [] });
        cursor = image.next;
        continue;
      }
    }

    if (char === "[") {
      const link = readLink(source, cursor, refs);
      if (link) {
        nodes.push({ tag: "a", props: { href: link.href, title: link.title }, children: link.children });
        cursor = link.next;
        continue;
      }
      const reference = readReferenceLink(source, cursor, refs);
      if (reference) {
        nodes.push({ tag: "a", props: { href: reference.href, title: reference.title }, children: reference.children });
        cursor = reference.next;
        continue;
      }
    }

    if (char === "<") {
      const autolink = readAutolink(source, cursor);
      if (autolink) {
        nodes.push({ tag: "a", props: { href: autolink }, children: [autolink] });
        cursor += autolink.length + 2;
        continue;
      }
    }

    if (char === "\\") {
      const escaped = source[cursor + 1];
      if (escaped && ESCAPE_RE.test(`\\${escaped}`)) {
        appendText(nodes, escaped);
        cursor += 2;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const emphasis = readEmphasis(source, cursor, char, refs, inLink, to);
      if (emphasis) {
        nodes.push(emphasis.node);
        cursor = emphasis.next;
        continue;
      }
    }

    if (char === "~" && source[cursor + 1] === "~") {
      const strike = readStrikethrough(source, cursor, refs, inLink, to);
      if (strike) {
        nodes.push({ tag: "del", props: {}, children: strike.children });
        cursor = strike.next;
        continue;
      }
    }

    if (!inLink) {
      const bare = readBareUrl(source, cursor);
      if (bare) {
        nodes.push({ tag: "a", props: { href: bare.href }, children: [bare.text] });
        cursor = bare.next;
        continue;
      }
    }

    appendText(nodes, char);
    cursor += 1;
  }
  return nodes;
}

function appendText(nodes: InlineNode[], text: string): void {
  const last = nodes[nodes.length - 1];
  if (typeof last === "string") {
    nodes[nodes.length - 1] = last + text;
  } else {
    nodes.push(text);
  }
}

function popTrailingChar(nodes: InlineNode[]): void {
  const last = nodes[nodes.length - 1];
  if (typeof last === "string" && last.length > 0) {
    nodes[nodes.length - 1] = last.slice(0, -1);
  }
}

function trimTrailingSpaces(nodes: InlineNode[]): void {
  const last = nodes[nodes.length - 1];
  if (typeof last === "string") {
    nodes[nodes.length - 1] = last.replace(/ +$/, "");
  }
}

function readCodeSpan(source: string, start: number): { text: string; next: number } | null {
  let run = 0;
  while (source[start + run] === "`") run += 1;
  const close = source.indexOf("`".repeat(run), start + run);
  if (close === -1) return null;
  let text = source.slice(start + run, close);
  if (text.startsWith(" ") && text.endsWith(" ") && text.length > 2 && text.trim() !== "") {
    text = text.slice(1, -1);
  }
  return { text, next: close + run };
}

function readImage(source: string, start: number, refs: ReferenceMap): { src: string; alt: string; next: number } | null {
  const link = readLink(source, start + 1, refs);
  if (!link) return null;
  return { src: link.href, alt: link.children.map(plainText).join(""), next: link.next };
}

function readLink(source: string, start: number, refs: ReferenceMap): { href: string; title?: string; children: InlineNode[]; next: number } | null {
  const closeBracket = findClosingBracket(source, start);
  if (closeBracket === -1) return null;
  if (source[closeBracket + 1] !== "(") return null;
  const openParen = closeBracket + 1;
  const closeParen = findClosingParen(source, openParen);
  if (closeParen === -1) return null;
  const destination = source.slice(openParen + 1, closeParen).trim();
  const parsed = parseDestination(destination);
  if (!parsed) return null;
  return {
    href: parsed.href,
    title: parsed.title,
    children: parseInlineRange(source, start + 1, closeBracket, refs, true),
    next: closeParen + 1
  };
}

function readReferenceLink(source: string, start: number, refs: ReferenceMap): { href: string; title?: string; children: InlineNode[]; next: number } | null {
  const closeBracket = findClosingBracket(source, start);
  if (closeBracket === -1) return null;
  const label = source.slice(start + 1, closeBracket);
  let refLabel = label;
  let next = closeBracket + 1;
  if (source[closeBracket + 1] === "[") {
    const refEnd = source.indexOf("]", closeBracket + 2);
    if (refEnd === -1) return null;
    const explicitRef = source.slice(closeBracket + 2, refEnd);
    refLabel = explicitRef === "" ? label : explicitRef;
    next = refEnd + 1;
  }
  const definition = refs.get(refLabel.toLowerCase());
  if (!definition) return null;
  return {
    href: definition.href,
    title: definition.title,
    children: parseInlineRange(source, start + 1, closeBracket, refs, true),
    next
  };
}

function findClosingBracket(source: string, start: number): number {
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "]") return cursor;
  }
  return -1;
}

function findClosingParen(source: string, open: number): number {
  for (let cursor = open + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === ")") return cursor;
  }
  return -1;
}

function parseDestination(value: string): { href: string; title?: string } | null {
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    if (end === -1) return null;
    return { href: value.slice(1, end), title: undefined };
  }
  const match = /^(\S+?)(?:[ \t]+["'(](.+?)["')])?$/.exec(value);
  if (!match || !match[1]) return null;
  return { href: match[1], title: match[2] };
}

function readAutolink(source: string, start: number): string | null {
  const end = source.indexOf(">", start + 1);
  if (end === -1) return null;
  const content = source.slice(start + 1, end);
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s<>]+$/i.test(content)) return content;
  return null;
}

function readBareUrl(source: string, start: number): { href: string; text: string; next: number } | null {
  const rest = source.slice(start);
  if (/^(?:https?|ftp):\/\//i.test(rest)) {
    const text = scanBareUrlText(rest);
    if (!text) return null;
    return { href: text, text, next: start + text.length };
  }
  if (/^www\./i.test(rest)) {
    const text = scanBareUrlText(rest);
    if (text.length <= 4) return null;
    return { href: `http://${text}`, text, next: start + text.length };
  }
  const email = /^[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(rest);
  if (!email) return null;
  return { href: `mailto:${email[0]}`, text: email[0], next: start + email[0].length };
}

function scanBareUrlText(rest: string): string {
  let text = /^[^\s<>]+/.exec(rest)?.[0] ?? "";
  text = text.replace(/[.,;:!?'"\]]+$/, "");
  const opens = (text.match(/\(/g) ?? []).length;
  const closes = (text.match(/\)/g) ?? []).length;
  if (closes > opens && text.endsWith(")")) {
    text = text.slice(0, -1);
  }
  return text;
}

function readEmphasis(source: string, start: number, marker: string, refs: ReferenceMap, inLink: boolean, to: number): { node: InlineElement; next: number } | null {
  if (source[start + 1] === marker) {
    const close = findClosingMarker(source, start + 2, marker + marker, to);
    if (close !== -1) {
      return { node: { tag: "strong", props: {}, children: parseInlineRange(source, start + 2, close, refs, inLink) }, next: close + 2 };
    }
  }
  const close = findClosingMarker(source, start + 1, marker, to);
  if (close !== -1) {
    return { node: { tag: "em", props: {}, children: parseInlineRange(source, start + 1, close, refs, inLink) }, next: close + 1 };
  }
  return null;
}

function findClosingMarker(source: string, from: number, marker: string, to: number): number {
  const index = source.indexOf(marker, from);
  if (index === -1 || index >= to) return -1;
  if (index > 0 && source[index - 1] === "\\") return -1;
  return index;
}

function readStrikethrough(source: string, start: number, refs: ReferenceMap, inLink: boolean, to: number): { children: InlineNode[]; next: number } | null {
  const close = source.indexOf("~~", start + 2);
  if (close === -1 || close >= to) return null;
  return { children: parseInlineRange(source, start + 2, close, refs, inLink), next: close + 2 };
}

function plainText(nodes: InlineNode | InlineNode[]): string {
  if (Array.isArray(nodes)) return nodes.map(plainText).join("");
  if (typeof nodes === "string") return nodes;
  return nodes.children.map(plainText).join("");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks: Block[], components: MarkdownComponents): ReactNode {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "heading":
        return renderElement(`h${block.level}` as MarkdownTag, {}, renderInline(block.inline, components), components, index);
      case "paragraph":
        return renderElement("p", {}, renderInline(block.inline, components), components, index);
      case "code":
        return renderElement("pre", {}, renderElement("code", { className: block.lang ? `language-${block.lang}` : undefined }, block.text, components, index), components, index);
      case "blockquote":
        return renderElement("blockquote", {}, <>{renderBlocks(block.blocks, components)}</>, components, index);
      case "list":
        return renderList(block, components, index);
      case "table":
        return renderTable(block, components, index);
      case "hr":
        return renderElement("hr", {}, null, components, index);
    }
  });
}

function renderList(block: Extract<Block, { type: "list" }>, components: MarkdownComponents, index: number): ReactNode {
  const listProps: ElementProps = block.ordered && block.start !== 1 ? { start: block.start } : {};
  const items = block.items.map((item, itemIndex) => {
    const content = item.task
      ? <><input type="checkbox" checked={item.checked} disabled />{renderItemBlocks(item.blocks, block.loose, components)}</>
      : renderItemBlocks(item.blocks, block.loose, components);
    return renderElement("li", {}, content, components, itemIndex);
  });
  return renderElement(block.ordered ? "ol" : "ul", listProps, <>{items}</>, components, index);
}

function renderItemBlocks(blocks: Block[], loose: boolean, components: MarkdownComponents): ReactNode {
  if (loose) return <>{renderBlocks(blocks, components)}</>;
  return (
    <>
      {blocks.map((block, index) =>
        block.type === "paragraph"
          ? <Fragment key={index}>{renderInline(block.inline, components)}</Fragment>
          : <Fragment key={index}>{renderBlocks([block], components)}</Fragment>
      )}
    </>
  );
}

function renderTable(block: Extract<Block, { type: "table" }>, components: MarkdownComponents, index: number): ReactNode {
  const head = renderElement("thead", {}, renderElement("tr", {}, <>{block.headers.map((cell, i) => renderElement("th", { align: block.aligns[i] }, renderInline(cell, components), components, i))}</>, components, 0), components, 0);
  const body = renderElement("tbody", {}, <>{block.rows.map((row, r) => renderElement("tr", {}, <>{row.map((cell, c) => renderElement("td", { align: block.aligns[c] }, renderInline(cell, components), components, c))}</>, components, r))}</>, components, 1);
  return renderElement("table", {}, <>{head}{body}</>, components, index);
}

function renderInline(nodes: InlineNode[], components: MarkdownComponents): ReactNode {
  return nodes.map((node, index) => {
    if (typeof node === "string") return decodeEntities(node);
    return renderElement(node.tag, node.props, renderInline(node.children, components), components, index);
  });
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  micro: "µ",
  para: "¶",
  sect: "§",
  dagger: "†",
  Dagger: "‡",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup2: "²",
  sup3: "³",
  acute: "´",
  cedil: "¸",
  curren: "¤",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢"
};

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isNaN(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

function renderElement(
  tag: MarkdownTag,
  props: ElementProps,
  children: ReactNode,
  components: MarkdownComponents,
  key: number
): ReactNode {
  const override = components[tag];
  if (override) {
    return <Fragment key={key}>{override({ ...elementPropsFor(tag, props), children: children ?? undefined })}</Fragment>;
  }
  return <DefaultElement key={key} tag={tag} props={props}>{children}</DefaultElement>;
}

function elementPropsFor(tag: MarkdownTag, props: ElementProps): ElementProps {
  switch (tag) {
    case "a":
      return { href: props.href, title: props.title };
    case "img":
      return { src: props.src, alt: props.alt, title: props.title };
    case "ol":
      return { start: props.start };
    case "code":
      return { className: props.className };
    case "th":
    case "td":
      return { align: props.align };
    case "input":
      return { checked: props.checked, disabled: true };
    default:
      return {};
  }
}

function alignStyle(align: "left" | "center" | "right" | undefined): React.CSSProperties | undefined {
  if (!align) return undefined;
  return { textAlign: align };
}

function DefaultElement({ tag, props, children }: { tag: MarkdownTag; props: ElementProps; children: ReactNode }): ReactNode {
  switch (tag) {
    case "a":
      return <a href={props.href} title={props.title}>{children}</a>;
    case "img":
      return <img src={props.src} alt={props.alt ?? ""} />;
    case "code":
      return <code className={props.className}>{children}</code>;
    case "input":
      return <input type="checkbox" checked={props.checked} disabled />;
    case "h1": return <h1>{children}</h1>;
    case "h2": return <h2>{children}</h2>;
    case "h3": return <h3>{children}</h3>;
    case "h4": return <h4>{children}</h4>;
    case "h5": return <h5>{children}</h5>;
    case "h6": return <h6>{children}</h6>;
    case "p": return <p>{children}</p>;
    case "ul": return <ul>{children}</ul>;
    case "ol": return props.start !== undefined ? <ol start={props.start}>{children}</ol> : <ol>{children}</ol>;
    case "li": return <li>{children}</li>;
    case "blockquote": return <blockquote>{children}</blockquote>;
    case "pre": return <pre>{children}</pre>;
    case "table": return <table>{children}</table>;
    case "thead": return <thead>{children}</thead>;
    case "tbody": return <tbody>{children}</tbody>;
    case "tr": return <tr>{children}</tr>;
    case "th": return <th style={alignStyle(props.align)}>{children}</th>;
    case "td": return <td style={alignStyle(props.align)}>{children}</td>;
    case "em": return <em>{children}</em>;
    case "strong": return <strong>{children}</strong>;
    case "del": return <del>{children}</del>;
    case "hr": return <hr />;
    case "br": return <br />;
  }
}

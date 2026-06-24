export type LintSeverity = "warning" | "error" | "ok";

export type LintHint = {
  severity: LintSeverity;
  title: string;
  detail: string;
  line: number | null;
  preview: string | null;
};

const futurePattern = /\b(deadline|meeting|check-?in|pending|tomorrow|next\s+\w+|will|plan to|scheduled)\b/i;
const exactValuePattern = /(\b\d{4}-\d{2}-\d{2}\b|\b[A-Z]{2,}-?\d{4,}\b|\$\d|¥\d|\b\d{1,2}:\d{2}\b)/;
const filePathPattern = /(`[^`]+\.[a-z0-9]+`|\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)/;
const sourcePathPattern = /\/Sources\/(?!raw\/|sessions\/|skill-runs\/|ingest-requests\/)[a-z0-9]{1,32}\/(?![A-Za-z0-9._-]*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md/;

export function collectLintHints(path: string, content: string): LintHint[] {
  const role = path.split("/").at(-1) ?? "";
  const hints: LintHint[] = [];
  if (role === "facts.md") {
    hints.push(...findLineHints(content, futurePattern, "Possible future or pending item", "facts.md should hold stable facts, not schedules, pending decisions, or next actions."));
  }
  if (role === "summary.md") {
    hints.push(...findLineHints(content, exactValuePattern, "Possible exact evidence leak", "summary.md should recap; exact dates, money, receipts, or IDs belong in canonical notes or raw sources."));
  }
  if (role === "open_questions.md") {
    hints.push(...findLineHints(content, /\b(done|resolved|decided|completed)\b/i, "Possible resolved item", "open_questions.md should hold unresolved questions and verification gaps, not completed decisions."));
  }
  if (role === "preferences.md") {
    hints.push(...findLineHints(content, /\b(todo|next action|deadline|scheduled)\b/i, "Possible action item", "preferences.md should hold decision criteria and choices; pending work belongs in plans.md."));
  }
  if (role === "provenance.md" && !sourcePathPattern.test(content)) {
    hints.push({
      severity: "warning",
      title: "Missing raw source path",
      detail: "provenance.md should link organized wiki content back to /Sources/<provider> evidence.",
      line: null,
      preview: null
    });
  }
  hints.push(...findCodeNoteHints(path, content));
  return hints;
}

function findLineHints(content: string, pattern: RegExp, title: string, detail: string): LintHint[] {
  return content
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter((entry) => pattern.test(entry.line))
    .slice(0, 8)
    .map((entry) => ({
      severity: "warning",
      title,
      detail,
      line: entry.index + 1,
      preview: entry.line.trim()
    }));
}

function findCodeNoteHints(path: string, content: string): LintHint[] {
  const hints: LintHint[] = [];
  const codeBlocks = content.match(/```[\s\S]*?```/g) ?? [];
  for (const block of codeBlocks) {
    if (block.split("\n").length > 12) {
      hints.push({
        severity: "warning",
        title: "Long code block",
        detail: "Wiki code notes should point to source paths and decisions, not store long implementation copies.",
        line: firstLineOf(content, block),
        preview: block.split("\n").slice(0, 2).join(" ").trim()
      });
      break;
    }
  }
  if (isCodeNote(path, content) && filePathPattern.test(content) && !hasDecisionContext(content)) {
    hints.push({
      severity: "warning",
      title: "Code note lacks decision context",
      detail: "Add Why or Verification so the note records judgment, not just a file pointer.",
      line: null,
      preview: firstMatchingLine(content, filePathPattern)
    });
  }
  return hints;
}

export function rawSourceLinksFor(path: string, content: string): string[] {
  const links = new Set<string>();
  if (sourcePathPattern.test(path)) {
    links.add(path);
  }
  if (path.endsWith("/provenance.md")) {
    for (const line of content.split("\n")) {
      const sourcePath = line.match(sourcePathPattern)?.[0];
      if (sourcePath) links.add(sourcePath);
    }
  }
  for (const match of content.matchAll(new RegExp(sourcePathPattern.source, "g"))) {
    links.add(match[0]);
  }
  return [...links].slice(0, 8);
}

export function provenancePathFor(path: string): string | null {
  if (!path.startsWith("/Wiki/") || path.endsWith("/provenance.md")) {
    return null;
  }
  const index = path.lastIndexOf("/");
  if (index <= 0) {
    return null;
  }
  return `${path.slice(0, index)}/provenance.md`;
}

function isCodeNote(path: string, content: string): boolean {
  return path.toLowerCase().includes("code") || /Source of Truth|Implementation:|Tests:/i.test(content);
}

function hasDecisionContext(content: string): boolean {
  return /(^|\n)##\s+(Why|Verification|Current Decision)\b/i.test(content);
}

function firstLineOf(content: string, needle: string): number {
  return content.slice(0, content.indexOf(needle)).split("\n").length;
}

function firstMatchingLine(content: string, pattern: RegExp): string | null {
  return content.split("\n").find((line) => pattern.test(line))?.trim() ?? null;
}

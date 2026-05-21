import type { NodeKind, SearchNodeHit, SearchPreview, SearchPreviewField } from "@/lib/types";

type Variant = Record<string, null>;

export type RawSearchPreview = {
  field: Variant;
  char_offset: number;
  match_reason: string;
  excerpt: [] | [string];
};

export type RawSearchHit = {
  path: string;
  kind: Variant;
  snippet: [] | [string];
  preview: [] | [RawSearchPreview];
  score: number;
  match_reasons: string[];
};

export function normalizeSearchHit(raw: RawSearchHit): SearchNodeHit {
  return {
    path: raw.path,
    kind: normalizeNodeKind(raw.kind),
    snippet: raw.snippet[0] ?? null,
    preview: raw.preview[0] ? normalizeSearchPreview(raw.preview[0]) : null,
    score: raw.score,
    matchReasons: raw.match_reasons
  };
}

function normalizeSearchPreview(raw: RawSearchPreview): SearchPreview {
  return {
    field: normalizePreviewField(raw.field),
    charOffset: raw.char_offset,
    matchReason: raw.match_reason,
    excerpt: raw.excerpt[0] ?? null
  };
}

function normalizeNodeKind(kind: Variant): NodeKind {
  if ("Folder" in kind) return "folder";
  return "Source" in kind ? "source" : "file";
}

function normalizePreviewField(field: Variant): SearchPreviewField {
  return "Path" in field ? "path" : "content";
}

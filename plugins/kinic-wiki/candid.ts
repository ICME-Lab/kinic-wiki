// Where: plugins/kinic-wiki/candid.ts
// What: Candid IDL and raw-to-plugin normalization for direct canister calls.
// Why: The plugin should absorb bigint and variant details in one place instead of leaking Candid wire shapes into sync logic.
import { Actor } from "@dfinity/agent";

import {
  CommitPageChange,
  CommitWikiChangesResponse,
  ExportWikiSnapshotResponse,
  FetchWikiUpdatesResponse,
  PluginPageType,
  StatusResponse,
  isCommitWikiChangesResponse,
  isExportSnapshotResponse,
  isFetchWikiUpdatesResponse,
  isStatusResponse
} from "./types";

type RawWikiPageType =
  | { Entity: null }
  | { Concept: null }
  | { Overview: null }
  | { Comparison: null }
  | { QueryNote: null }
  | { SourceSummary: null };

type RawResult<T> = { Ok: T } | { Err: string };

type RawSectionHashEntry = { section_path: string; content_hash: string };
type RawManifestEntry = {
  page_id: string;
  slug: string;
  revision_id: string;
  updated_at: bigint;
};
type RawSystemPage = { slug: string; markdown: string; updated_at: bigint; etag: string };
type RawPageSnapshot = {
  page_id: string;
  slug: string;
  title: string;
  page_type: RawWikiPageType;
  revision_id: string;
  updated_at: bigint;
  markdown: string;
  section_hashes: RawSectionHashEntry[];
};
type RawExportResponse = {
  snapshot_revision: string;
  pages: RawPageSnapshot[];
  system_pages: RawSystemPage[];
  manifest: unknown;
};
type RawFetchResponse = {
  snapshot_revision: string;
  changed_pages: RawPageSnapshot[];
  removed_page_ids: string[];
  system_pages: RawSystemPage[];
  manifest_delta: {
    upserted_pages: RawManifestEntry[];
    removed_page_ids: string[];
  };
};
type RawCommitResponse = {
  committed_pages: Array<{
    page_id: string;
    revision_id: string;
    section_hashes: RawSectionHashEntry[];
  }>;
  rejected_pages: Array<{
    page_id: string;
    reason: string;
    conflicting_section_paths: string[];
    local_changed_section_paths: string[];
    remote_changed_section_paths: string[];
    conflict_markdown: [] | [string];
  }>;
  snapshot_revision: string;
  snapshot_was_stale: boolean;
  system_pages: RawSystemPage[];
  manifest_delta: {
    upserted_pages: RawManifestEntry[];
    removed_page_ids: string[];
  };
};
type RawStatus = { page_count: bigint; source_count: bigint; system_page_count: bigint };

export interface KinicCanisterApi {
  status: () => Promise<RawStatus>;
  export_wiki_snapshot: (request: {
    include_system_pages: boolean;
    page_slugs: [] | [string[]];
  }) => Promise<RawResult<RawExportResponse>>;
  fetch_wiki_updates: (request: {
    known_snapshot_revision: string;
    known_page_revisions: Array<{ page_id: string; revision_id: string }>;
    include_system_pages: boolean;
  }) => Promise<RawResult<RawFetchResponse>>;
  commit_wiki_changes: (request: {
    base_snapshot_revision: string;
    page_changes: Array<{
      change_type: { Update: null } | { Delete: null };
      page_id: string;
      base_revision_id: string;
      new_markdown: [] | [string];
    }>;
  }) => Promise<RawResult<RawCommitResponse>>;
}

type ActorFactory = Parameters<typeof Actor.createActor<KinicCanisterApi>>[0];

export const idlFactory: ActorFactory = ({ IDL: candid }) => {
  const WikiPageType = candid.Variant({
    Entity: candid.Null,
    Concept: candid.Null,
    Overview: candid.Null,
    Comparison: candid.Null,
    QueryNote: candid.Null,
    SourceSummary: candid.Null
  });
  const SectionHashEntry = candid.Record({
    section_path: candid.Text,
    content_hash: candid.Text
  });
  const WikiPageSnapshot = candid.Record({
    page_id: candid.Text,
    slug: candid.Text,
    title: candid.Text,
    page_type: WikiPageType,
    revision_id: candid.Text,
    updated_at: candid.Int64,
    markdown: candid.Text,
    section_hashes: candid.Vec(SectionHashEntry)
  });
  const SystemPageSnapshot = candid.Record({
    slug: candid.Text,
    markdown: candid.Text,
    updated_at: candid.Int64,
    etag: candid.Text
  });
  const WikiSyncManifestEntry = candid.Record({
    page_id: candid.Text,
    slug: candid.Text,
    revision_id: candid.Text,
    updated_at: candid.Int64
  });
  const WikiSyncManifestDelta = candid.Record({
    upserted_pages: candid.Vec(WikiSyncManifestEntry),
    removed_page_ids: candid.Vec(candid.Text)
  });
  const ExportRequest = candid.Record({
    include_system_pages: candid.Bool,
    page_slugs: candid.Opt(candid.Vec(candid.Text))
  });
  const ExportResponse = candid.Record({
    snapshot_revision: candid.Text,
    pages: candid.Vec(WikiPageSnapshot),
    system_pages: candid.Vec(SystemPageSnapshot),
    manifest: candid.Record({
      snapshot_revision: candid.Text,
      pages: candid.Vec(WikiSyncManifestEntry)
    })
  });
  const FetchRequest = candid.Record({
    known_snapshot_revision: candid.Text,
    known_page_revisions: candid.Vec(
      candid.Record({ page_id: candid.Text, revision_id: candid.Text })
    ),
    include_system_pages: candid.Bool
  });
  const FetchResponse = candid.Record({
    snapshot_revision: candid.Text,
    changed_pages: candid.Vec(WikiPageSnapshot),
    removed_page_ids: candid.Vec(candid.Text),
    system_pages: candid.Vec(SystemPageSnapshot),
    manifest_delta: WikiSyncManifestDelta
  });
  const CommitRequest = candid.Record({
    base_snapshot_revision: candid.Text,
    page_changes: candid.Vec(
      candid.Record({
        change_type: candid.Variant({ Update: candid.Null, Delete: candid.Null }),
        page_id: candid.Text,
        base_revision_id: candid.Text,
        new_markdown: candid.Opt(candid.Text)
      })
    )
  });
  const CommitResponse = candid.Record({
    committed_pages: candid.Vec(
      candid.Record({
        page_id: candid.Text,
        revision_id: candid.Text,
        section_hashes: candid.Vec(SectionHashEntry)
      })
    ),
    rejected_pages: candid.Vec(
      candid.Record({
        page_id: candid.Text,
        reason: candid.Text,
        conflicting_section_paths: candid.Vec(candid.Text),
        local_changed_section_paths: candid.Vec(candid.Text),
        remote_changed_section_paths: candid.Vec(candid.Text),
        conflict_markdown: candid.Opt(candid.Text)
      })
    ),
    snapshot_revision: candid.Text,
    snapshot_was_stale: candid.Bool,
    system_pages: candid.Vec(SystemPageSnapshot),
    manifest_delta: WikiSyncManifestDelta
  });
  return candid.Service({
    status: candid.Func([], [candid.Record({
      page_count: candid.Nat64,
      source_count: candid.Nat64,
      system_page_count: candid.Nat64
    })], ["query"]),
    export_wiki_snapshot: candid.Func([ExportRequest], [candid.Variant({ Ok: ExportResponse, Err: candid.Text })], ["query"]),
    fetch_wiki_updates: candid.Func([FetchRequest], [candid.Variant({ Ok: FetchResponse, Err: candid.Text })], ["query"]),
    commit_wiki_changes: candid.Func([CommitRequest], [candid.Variant({ Ok: CommitResponse, Err: candid.Text })], [])
  });
};

export function normalizeStatus(raw: RawStatus): StatusResponse {
  return validate("status", {
    page_count: toNumber(raw.page_count),
    source_count: toNumber(raw.source_count),
    system_page_count: toNumber(raw.system_page_count)
  }, isStatusResponse);
}

export function normalizeExportResponse(raw: RawResult<RawExportResponse>): ExportWikiSnapshotResponse {
  const ok = unwrapResult(raw);
  return validate("export_wiki_snapshot", {
    snapshot_revision: ok.snapshot_revision,
    pages: ok.pages.map(normalizePageSnapshot),
    system_pages: ok.system_pages.map(normalizeSystemPage)
  }, isExportSnapshotResponse);
}

export function normalizeFetchResponse(raw: RawResult<RawFetchResponse>): FetchWikiUpdatesResponse {
  const ok = unwrapResult(raw);
  return validate("fetch_wiki_updates", {
    snapshot_revision: ok.snapshot_revision,
    changed_pages: ok.changed_pages.map(normalizePageSnapshot),
    removed_page_ids: ok.removed_page_ids,
    system_pages: ok.system_pages.map(normalizeSystemPage),
    manifest_delta: {
      upserted_pages: ok.manifest_delta.upserted_pages.map(normalizeManifestEntry),
      removed_page_ids: ok.manifest_delta.removed_page_ids
    }
  }, isFetchWikiUpdatesResponse);
}

export function normalizeCommitResponse(raw: RawResult<RawCommitResponse>): CommitWikiChangesResponse {
  const ok = unwrapResult(raw);
  return validate("commit_wiki_changes", {
    committed_pages: ok.committed_pages.map((entry) => ({
      page_id: entry.page_id,
      revision_id: entry.revision_id,
      section_hashes: entry.section_hashes.map(normalizeSectionHashEntry)
    })),
    rejected_pages: ok.rejected_pages.map((entry) => ({
      page_id: entry.page_id,
      reason: entry.reason,
      conflicting_section_paths: entry.conflicting_section_paths,
      local_changed_section_paths: entry.local_changed_section_paths,
      remote_changed_section_paths: entry.remote_changed_section_paths,
      conflict_markdown: entry.conflict_markdown[0] ?? null
    })),
    snapshot_revision: ok.snapshot_revision,
    snapshot_was_stale: ok.snapshot_was_stale,
    system_pages: ok.system_pages.map(normalizeSystemPage),
    manifest_delta: {
      upserted_pages: ok.manifest_delta.upserted_pages.map(normalizeManifestEntry),
      removed_page_ids: ok.manifest_delta.removed_page_ids
    }
  }, isCommitWikiChangesResponse);
}

export function toRawCommitChanges(baseSnapshotRevision: string, pageChanges: CommitPageChange[]) {
  return {
    base_snapshot_revision: baseSnapshotRevision,
    page_changes: pageChanges.map((change) => ({
      change_type: change.change_type === "Delete" ? { Delete: null } : { Update: null },
      page_id: change.page_id,
      base_revision_id: change.base_revision_id,
      new_markdown: toOptionalText(change.new_markdown)
    }))
  };
}

export function localReplicaHost(host: string): boolean {
  const url = new URL(host);
  return ["localhost", "127.0.0.1"].includes(url.hostname);
}

function unwrapResult<T>(raw: RawResult<T>): T {
  if ("Err" in raw) {
    throw new Error(raw.Err);
  }
  return raw.Ok;
}

function normalizePageSnapshot(raw: RawPageSnapshot) {
  return {
    page_id: raw.page_id,
    slug: raw.slug,
    title: raw.title,
    page_type: normalizePageType(raw.page_type),
    revision_id: raw.revision_id,
    updated_at: toNumber(raw.updated_at),
    markdown: raw.markdown,
    section_hashes: raw.section_hashes.map(normalizeSectionHashEntry)
  };
}

function normalizeSystemPage(raw: RawSystemPage) {
  return {
    slug: raw.slug,
    markdown: raw.markdown,
    updated_at: toNumber(raw.updated_at),
    etag: raw.etag
  };
}

function normalizeManifestEntry(raw: RawManifestEntry) {
  return {
    page_id: raw.page_id,
    slug: raw.slug,
    revision_id: raw.revision_id,
    updated_at: toNumber(raw.updated_at)
  };
}

function normalizeSectionHashEntry(raw: RawSectionHashEntry) {
  return { section_path: raw.section_path, content_hash: raw.content_hash };
}

export function normalizePageType(raw: RawWikiPageType): PluginPageType {
  const label = Object.keys(raw)[0];
  switch (label) {
    case "Entity": return "entity";
    case "Concept": return "concept";
    case "Overview": return "overview";
    case "Comparison": return "comparison";
    case "QueryNote": return "query_note";
    case "SourceSummary": return "source_summary";
    default: throw new Error(`Unknown page type: ${label}`);
  }
}

function toNumber(value: bigint): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`Integer is outside JS safe range: ${value.toString()}`);
  }
  return asNumber;
}

function validate<T>(methodName: string, value: unknown, guard: (input: unknown) => input is T): T {
  if (!guard(value)) {
    throw new Error(`Invalid normalized payload for ${methodName}`);
  }
  return value;
}

function toOptionalText(value: string | null): [] | [string] {
  return value === null ? [] : [value];
}

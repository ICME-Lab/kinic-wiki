// Where: plugins/kinic-wiki/candid.ts
// What: Candid IDL and raw-to-plugin normalization for FS-first canister calls.
// Why: The plugin should normalize bigint and variant details once at the wire boundary.
import { Actor } from "@dfinity/agent";

import {
  DeleteNodeResult,
  ExportSnapshotResponse,
  FetchUpdatesResponse,
  NodeEntry,
  NodeEntryKind,
  NodeKind,
  NodeSnapshot,
  SearchNodeHit,
  StatusResponse,
  WriteNodeResult,
  isDeleteNodeResult,
  isExportSnapshotResponse,
  isFetchUpdatesResponse,
  isNodeEntry,
  isNodeSnapshot,
  isSearchNodeHit,
  isStatusResponse,
  isWriteNodeResult
} from "./types";

type RawResult<T> = { Ok: T } | { Err: string };
type RawNodeKind = { File: null } | { Source: null };
type RawNodeEntryKind = { Directory: null } | RawNodeKind;
type RawNode = {
  path: string;
  kind: RawNodeKind;
  content: string;
  created_at: bigint;
  updated_at: bigint;
  etag: string;
  deleted_at: [] | [bigint];
  metadata_json: string;
};
type RawNodeEntry = {
  path: string;
  kind: RawNodeEntryKind;
  updated_at: bigint;
  etag: string;
  deleted_at: [] | [bigint];
  has_children: boolean;
};
type RawSearchNodeHit = {
  path: string;
  kind: RawNodeKind;
  snippet: string;
  score: number;
  match_reasons: string[];
};
type RawStatus = { file_count: bigint; source_count: bigint; deleted_count: bigint };

export interface KinicCanisterApi {
  status: () => Promise<RawStatus>;
  read_node: (path: string) => Promise<RawResult<[] | [RawNode]>>;
  list_nodes: (request: {
    prefix: string;
    recursive: boolean;
    include_deleted: boolean;
  }) => Promise<RawResult<RawNodeEntry[]>>;
  write_node: (request: {
    path: string;
    kind: RawNodeKind;
    content: string;
    metadata_json: string;
    expected_etag: [] | [string];
  }) => Promise<RawResult<{ node: RawNode; created: boolean }>>;
  delete_node: (request: {
    path: string;
    expected_etag: [] | [string];
  }) => Promise<RawResult<{ path: string; etag: string; deleted_at: bigint }>>;
  search_nodes: (request: {
    query_text: string;
    prefix: [] | [string];
    top_k: number;
  }) => Promise<RawResult<RawSearchNodeHit[]>>;
  export_snapshot: (request: {
    prefix: [] | [string];
    include_deleted: boolean;
  }) => Promise<RawResult<{ snapshot_revision: string; nodes: RawNode[] }>>;
  fetch_updates: (request: {
    known_snapshot_revision: string;
    prefix: [] | [string];
    include_deleted: boolean;
  }) => Promise<RawResult<{ snapshot_revision: string; changed_nodes: RawNode[]; removed_paths: string[] }>>;
}

type ActorFactory = Parameters<typeof Actor.createActor<KinicCanisterApi>>[0];

export const idlFactory: ActorFactory = ({ IDL: candid }) => {
  const NodeKind = candid.Variant({ File: candid.Null, Source: candid.Null });
  const NodeEntryKind = candid.Variant({
    Directory: candid.Null,
    File: candid.Null,
    Source: candid.Null
  });
  const Node = candid.Record({
    path: candid.Text,
    kind: NodeKind,
    content: candid.Text,
    created_at: candid.Int64,
    updated_at: candid.Int64,
    etag: candid.Text,
    deleted_at: candid.Opt(candid.Int64),
    metadata_json: candid.Text
  });
  const NodeEntry = candid.Record({
    path: candid.Text,
    kind: NodeEntryKind,
    updated_at: candid.Int64,
    etag: candid.Text,
    deleted_at: candid.Opt(candid.Int64),
    has_children: candid.Bool
  });
  const SearchNodeHit = candid.Record({
    path: candid.Text,
    kind: NodeKind,
    snippet: candid.Text,
    score: candid.Float32,
    match_reasons: candid.Vec(candid.Text)
  });
  return candid.Service({
    status: candid.Func([], [candid.Record({
      file_count: candid.Nat64,
      source_count: candid.Nat64,
      deleted_count: candid.Nat64
    })], ["query"]),
    read_node: candid.Func([candid.Text], [candid.Variant({ Ok: candid.Opt(Node), Err: candid.Text })], ["query"]),
    list_nodes: candid.Func([candid.Record({
      prefix: candid.Text,
      recursive: candid.Bool,
      include_deleted: candid.Bool
    })], [candid.Variant({ Ok: candid.Vec(NodeEntry), Err: candid.Text })], ["query"]),
    write_node: candid.Func([candid.Record({
      path: candid.Text,
      kind: NodeKind,
      content: candid.Text,
      metadata_json: candid.Text,
      expected_etag: candid.Opt(candid.Text)
    })], [candid.Variant({ Ok: candid.Record({ node: Node, created: candid.Bool }), Err: candid.Text })], []),
    delete_node: candid.Func([candid.Record({
      path: candid.Text,
      expected_etag: candid.Opt(candid.Text)
    })], [candid.Variant({ Ok: candid.Record({ path: candid.Text, etag: candid.Text, deleted_at: candid.Int64 }), Err: candid.Text })], []),
    search_nodes: candid.Func([candid.Record({
      query_text: candid.Text,
      prefix: candid.Opt(candid.Text),
      top_k: candid.Nat32
    })], [candid.Variant({ Ok: candid.Vec(SearchNodeHit), Err: candid.Text })], ["query"]),
    export_snapshot: candid.Func([candid.Record({
      prefix: candid.Opt(candid.Text),
      include_deleted: candid.Bool
    })], [candid.Variant({ Ok: candid.Record({ snapshot_revision: candid.Text, nodes: candid.Vec(Node) }), Err: candid.Text })], ["query"]),
    fetch_updates: candid.Func([candid.Record({
      known_snapshot_revision: candid.Text,
      prefix: candid.Opt(candid.Text),
      include_deleted: candid.Bool
    })], [candid.Variant({ Ok: candid.Record({ snapshot_revision: candid.Text, changed_nodes: candid.Vec(Node), removed_paths: candid.Vec(candid.Text) }), Err: candid.Text })], ["query"])
  });
};

export function normalizeStatus(raw: RawStatus): StatusResponse {
  return validate("status", {
    file_count: toNumber(raw.file_count),
    source_count: toNumber(raw.source_count),
    deleted_count: toNumber(raw.deleted_count)
  }, isStatusResponse);
}

export function normalizeReadNode(raw: RawResult<[] | [RawNode]>): NodeSnapshot | null {
  const ok = unwrapResult(raw);
  return ok.length === 0 ? null : normalizeNode(ok[0]);
}

export function normalizeListNodes(raw: RawResult<RawNodeEntry[]>): NodeEntry[] {
  return unwrapResult(raw).map(normalizeNodeEntry);
}

export function normalizeWriteNodeResult(raw: RawResult<{ node: RawNode; created: boolean }>): WriteNodeResult {
  return validate("write_node", {
    node: normalizeNode(unwrapResult(raw).node),
    created: unwrapResult(raw).created
  }, isWriteNodeResult);
}

export function normalizeDeleteNodeResult(raw: RawResult<{ path: string; etag: string; deleted_at: bigint }>): DeleteNodeResult {
  const ok = unwrapResult(raw);
  return validate("delete_node", {
    path: ok.path,
    etag: ok.etag,
    deleted_at: toNumber(ok.deleted_at)
  }, isDeleteNodeResult);
}

export function normalizeSearchNodeHits(raw: RawResult<RawSearchNodeHit[]>): SearchNodeHit[] {
  return unwrapResult(raw).map((entry) =>
    validate("search_nodes", {
      path: entry.path,
      kind: normalizeNodeKind(entry.kind),
      snippet: entry.snippet,
      score: entry.score,
      match_reasons: entry.match_reasons
    }, isSearchNodeHit)
  );
}

export function normalizeExportResponse(raw: RawResult<{ snapshot_revision: string; nodes: RawNode[] }>): ExportSnapshotResponse {
  const ok = unwrapResult(raw);
  return validate("export_snapshot", {
    snapshot_revision: ok.snapshot_revision,
    nodes: ok.nodes.map(normalizeNode)
  }, isExportSnapshotResponse);
}

export function normalizeFetchResponse(raw: RawResult<{ snapshot_revision: string; changed_nodes: RawNode[]; removed_paths: string[] }>): FetchUpdatesResponse {
  const ok = unwrapResult(raw);
  return validate("fetch_updates", {
    snapshot_revision: ok.snapshot_revision,
    changed_nodes: ok.changed_nodes.map(normalizeNode),
    removed_paths: ok.removed_paths
  }, isFetchUpdatesResponse);
}

export function normalizeNodeKind(raw: RawNodeKind): NodeKind {
  return "File" in raw ? "file" : "source";
}

export function localReplicaHost(host: string): boolean {
  return host.includes("127.0.0.1") || host.includes("localhost");
}

function normalizeNode(raw: RawNode): NodeSnapshot {
  return validate("node", {
    path: raw.path,
    kind: normalizeNodeKind(raw.kind),
    content: raw.content,
    created_at: toNumber(raw.created_at),
    updated_at: toNumber(raw.updated_at),
    etag: raw.etag,
    deleted_at: raw.deleted_at.length === 0 ? null : toNumber(raw.deleted_at[0]),
    metadata_json: raw.metadata_json
  }, isNodeSnapshot);
}

function normalizeNodeEntry(raw: RawNodeEntry): NodeEntry {
  return validate("node_entry", {
    path: raw.path,
    kind: normalizeNodeEntryKind(raw.kind),
    updated_at: toNumber(raw.updated_at),
    etag: raw.etag,
    deleted_at: raw.deleted_at.length === 0 ? null : toNumber(raw.deleted_at[0]),
    has_children: raw.has_children
  }, isNodeEntry);
}

function normalizeNodeEntryKind(raw: RawNodeEntryKind): NodeEntryKind {
  if ("Directory" in raw) {
    return "directory";
  }
  return normalizeNodeKind(raw);
}

function unwrapResult<T>(raw: RawResult<T>): T {
  if ("Err" in raw) {
    throw new Error(raw.Err);
  }
  return raw.Ok;
}

function validate<T>(label: string, value: T, guard: (input: unknown) => input is T): T {
  if (!guard(value)) {
    throw new Error(`invalid ${label} response`);
  }
  return value;
}

function toNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new Error(`bigint overflow: ${value.toString()}`);
  }
  return result;
}

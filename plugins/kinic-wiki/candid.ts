// Where: plugins/kinic-wiki/candid.ts
// What: Candid IDL and raw-to-plugin normalization for FS-first canister calls.
// Why: The plugin should normalize bigint and variant details once at the wire boundary.
import { Actor } from "@dfinity/agent";

import {
  EditNodeResult,
  DeleteNodeResult,
  ExportSnapshotResponse,
  FetchUpdatesResponse,
  GlobNodeHit,
  MoveNodeResult,
  MkdirNodeResult,
  MultiEditNodeResult,
  NodeMutationAck,
  NodeEntry,
  NodeEntryKind,
  NodeKind,
  NodeSnapshot,
  RecentNodeHit,
  SearchNodeHit,
  StatusResponse,
  WriteNodeResult,
  isDeleteNodeResult,
  isEditNodeResult,
  isExportSnapshotResponse,
  isFetchUpdatesResponse,
  isGlobNodeHit,
  isMkdirNodeResult,
  isMoveNodeResult,
  isMultiEditNodeResult,
  isNodeMutationAck,
  isNodeEntry,
  isNodeSnapshot,
  isRecentNodeHit,
  isSearchNodeHit,
  isStatusResponse,
  isWriteNodeResult
} from "./types";

type RawResult<T> = { Ok: T } | { Err: string };
type RawNodeKind = { File: null } | { Source: null };
type RawNodeEntryKind = { Directory: null } | RawNodeKind;
type RawGlobNodeType = { File: null } | { Directory: null } | { Any: null };
type RawNode = {
  path: string;
  kind: RawNodeKind;
  content: string;
  created_at: bigint;
  updated_at: bigint;
  etag: string;
  metadata_json: string;
};
type RawNodeMutationAck = {
  path: string;
  kind: RawNodeKind;
  updated_at: bigint;
  etag: string;
};
type RawNodeEntry = {
  path: string;
  kind: RawNodeEntryKind;
  updated_at: bigint;
  etag: string;
  has_children: boolean;
};
type RawGlobNodeHit = {
  path: string;
  kind: RawNodeEntryKind;
  has_children: boolean;
};
type RawSearchNodeHit = {
  path: string;
  kind: RawNodeKind;
  snippet: string;
  score: number;
  match_reasons: string[];
};
type RawStatus = { file_count: bigint; source_count: bigint };

export interface KinicCanisterApi {
  status: () => Promise<RawStatus>;
  read_node: (path: string) => Promise<RawResult<[] | [RawNode]>>;
  list_nodes: (request: {
    prefix: string;
    recursive: boolean;
  }) => Promise<RawResult<RawNodeEntry[]>>;
  write_node: (request: {
    path: string;
    kind: RawNodeKind;
    content: string;
    metadata_json: string;
    expected_etag: [] | [string];
  }) => Promise<RawResult<{ node: RawNodeMutationAck; created: boolean }>>;
  append_node: (request: {
    path: string;
    content: string;
    expected_etag: [] | [string];
    separator: [] | [string];
    metadata_json: [] | [string];
    kind: [] | [RawNodeKind];
  }) => Promise<RawResult<{ node: RawNodeMutationAck; created: boolean }>>;
  edit_node: (request: {
    path: string;
    old_text: string;
    new_text: string;
    expected_etag: [] | [string];
    replace_all: boolean;
  }) => Promise<RawResult<{ node: RawNodeMutationAck; replacement_count: number }>>;
  delete_node: (request: {
    path: string;
    expected_etag: [] | [string];
  }) => Promise<RawResult<{ path: string }>>;
  mkdir_node: (request: {
    path: string;
  }) => Promise<RawResult<{ path: string; created: boolean }>>;
  move_node: (request: {
    from_path: string;
    to_path: string;
    expected_etag: [] | [string];
    overwrite: boolean;
  }) => Promise<RawResult<{ node: RawNodeMutationAck; from_path: string; overwrote: boolean }>>;
  glob_nodes: (request: {
    pattern: string;
    path: [] | [string];
    node_type: [] | [RawGlobNodeType];
  }) => Promise<RawResult<RawGlobNodeHit[]>>;
  recent_nodes: (request: {
    limit: number;
    path: [] | [string];
  }) => Promise<RawResult<Array<{
    path: string;
    kind: RawNodeKind;
    updated_at: bigint;
    etag: string;
  }>>>;
  multi_edit_node: (request: {
    path: string;
    edits: Array<{ old_text: string; new_text: string }>;
    expected_etag: [] | [string];
  }) => Promise<RawResult<{ node: RawNodeMutationAck; replacement_count: number }>>;
  search_nodes: (request: {
    query_text: string;
    prefix: [] | [string];
    top_k: number;
  }) => Promise<RawResult<RawSearchNodeHit[]>>;
  search_node_paths: (request: {
    query_text: string;
    prefix: [] | [string];
    top_k: number;
  }) => Promise<RawResult<RawSearchNodeHit[]>>;
  export_snapshot: (request: {
    prefix: [] | [string];
  }) => Promise<RawResult<{ snapshot_revision: string; nodes: RawNode[] }>>;
  fetch_updates: (request: {
    known_snapshot_revision: string;
    prefix: [] | [string];
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
  const GlobNodeType = candid.Variant({
    File: candid.Null,
    Directory: candid.Null,
    Any: candid.Null
  });
  const Node = candid.Record({
    path: candid.Text,
    kind: NodeKind,
    content: candid.Text,
    created_at: candid.Int64,
    updated_at: candid.Int64,
    etag: candid.Text,
    metadata_json: candid.Text
  });
  const NodeMutationAck = candid.Record({
    path: candid.Text,
    kind: NodeKind,
    updated_at: candid.Int64,
    etag: candid.Text
  });
  const NodeEntry = candid.Record({
    path: candid.Text,
    kind: NodeEntryKind,
    updated_at: candid.Int64,
    etag: candid.Text,
    has_children: candid.Bool
  });
  const GlobNodeHit = candid.Record({
    path: candid.Text,
    kind: NodeEntryKind,
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
      source_count: candid.Nat64
    })], ["query"]),
    read_node: candid.Func([candid.Text], [candid.Variant({ Ok: candid.Opt(Node), Err: candid.Text })], ["query"]),
    list_nodes: candid.Func([candid.Record({
      prefix: candid.Text,
      recursive: candid.Bool
    })], [candid.Variant({ Ok: candid.Vec(NodeEntry), Err: candid.Text })], ["query"]),
    write_node: candid.Func([candid.Record({
      path: candid.Text,
      kind: NodeKind,
      content: candid.Text,
      metadata_json: candid.Text,
      expected_etag: candid.Opt(candid.Text)
    })], [candid.Variant({ Ok: candid.Record({ node: NodeMutationAck, created: candid.Bool }), Err: candid.Text })], []),
    append_node: candid.Func([candid.Record({
      path: candid.Text,
      content: candid.Text,
      expected_etag: candid.Opt(candid.Text),
      separator: candid.Opt(candid.Text),
      metadata_json: candid.Opt(candid.Text),
      kind: candid.Opt(NodeKind)
    })], [candid.Variant({ Ok: candid.Record({ node: NodeMutationAck, created: candid.Bool }), Err: candid.Text })], []),
    edit_node: candid.Func([candid.Record({
      path: candid.Text,
      old_text: candid.Text,
      new_text: candid.Text,
      expected_etag: candid.Opt(candid.Text),
      replace_all: candid.Bool
    })], [candid.Variant({ Ok: candid.Record({ node: NodeMutationAck, replacement_count: candid.Nat32 }), Err: candid.Text })], []),
    delete_node: candid.Func([candid.Record({
      path: candid.Text,
      expected_etag: candid.Opt(candid.Text)
    })], [candid.Variant({ Ok: candid.Record({ path: candid.Text }), Err: candid.Text })], []),
    mkdir_node: candid.Func([candid.Record({
      path: candid.Text
    })], [candid.Variant({ Ok: candid.Record({ path: candid.Text, created: candid.Bool }), Err: candid.Text })], ["query"]),
    move_node: candid.Func([candid.Record({
      from_path: candid.Text,
      to_path: candid.Text,
      expected_etag: candid.Opt(candid.Text),
      overwrite: candid.Bool
    })], [candid.Variant({ Ok: candid.Record({ node: NodeMutationAck, from_path: candid.Text, overwrote: candid.Bool }), Err: candid.Text })], []),
    glob_nodes: candid.Func([candid.Record({
      pattern: candid.Text,
      path: candid.Opt(candid.Text),
      node_type: candid.Opt(GlobNodeType)
    })], [candid.Variant({ Ok: candid.Vec(GlobNodeHit), Err: candid.Text })], ["query"]),
    recent_nodes: candid.Func([candid.Record({
      limit: candid.Nat32,
      path: candid.Opt(candid.Text)
    })], [candid.Variant({ Ok: candid.Vec(candid.Record({
      path: candid.Text,
      kind: NodeKind,
      updated_at: candid.Int64,
      etag: candid.Text
    })), Err: candid.Text })], ["query"]),
    multi_edit_node: candid.Func([candid.Record({
      path: candid.Text,
      edits: candid.Vec(candid.Record({
        old_text: candid.Text,
        new_text: candid.Text
      })),
      expected_etag: candid.Opt(candid.Text)
    })], [candid.Variant({ Ok: candid.Record({ node: NodeMutationAck, replacement_count: candid.Nat32 }), Err: candid.Text })], []),
    search_nodes: candid.Func([candid.Record({
      query_text: candid.Text,
      prefix: candid.Opt(candid.Text),
      top_k: candid.Nat32
    })], [candid.Variant({ Ok: candid.Vec(SearchNodeHit), Err: candid.Text })], ["query"]),
    search_node_paths: candid.Func([candid.Record({
      query_text: candid.Text,
      prefix: candid.Opt(candid.Text),
      top_k: candid.Nat32
    })], [candid.Variant({ Ok: candid.Vec(SearchNodeHit), Err: candid.Text })], ["query"]),
    export_snapshot: candid.Func([candid.Record({
      prefix: candid.Opt(candid.Text)
    })], [candid.Variant({ Ok: candid.Record({ snapshot_revision: candid.Text, nodes: candid.Vec(Node) }), Err: candid.Text })], ["query"]),
    fetch_updates: candid.Func([candid.Record({
      known_snapshot_revision: candid.Text,
      prefix: candid.Opt(candid.Text)
    })], [candid.Variant({ Ok: candid.Record({ snapshot_revision: candid.Text, changed_nodes: candid.Vec(Node), removed_paths: candid.Vec(candid.Text) }), Err: candid.Text })], ["query"])
  });
};

export function normalizeStatus(raw: RawStatus): StatusResponse {
  return validate("status", {
    file_count: toNumber(raw.file_count),
    source_count: toNumber(raw.source_count)
  }, isStatusResponse);
}

export function normalizeReadNode(raw: RawResult<[] | [RawNode]>): NodeSnapshot | null {
  const ok = unwrapResult(raw);
  return ok.length === 0 ? null : normalizeNode(ok[0]);
}

export function normalizeListNodes(raw: RawResult<RawNodeEntry[]>): NodeEntry[] {
  return unwrapResult(raw).map(normalizeNodeEntry);
}

export function normalizeWriteNodeResult(raw: RawResult<{ node: RawNodeMutationAck; created: boolean }>): WriteNodeResult {
  const ok = unwrapResult(raw);
  return validate("write_node", {
    node: normalizeNodeMutationAck(ok.node),
    created: ok.created
  }, isWriteNodeResult);
}

export function normalizeEditNodeResult(raw: RawResult<{ node: RawNodeMutationAck; replacement_count: number }>): EditNodeResult {
  const ok = unwrapResult(raw);
  return validate("edit_node", {
    node: normalizeNodeMutationAck(ok.node),
    replacement_count: ok.replacement_count
  }, isEditNodeResult);
}

export function normalizeDeleteNodeResult(raw: RawResult<{ path: string }>): DeleteNodeResult {
  const ok = unwrapResult(raw);
  return validate("delete_node", {
    path: ok.path
  }, isDeleteNodeResult);
}

export function normalizeMkdirNodeResult(raw: RawResult<{ path: string; created: boolean }>): MkdirNodeResult {
  const ok = unwrapResult(raw);
  return validate("mkdir_node", {
    path: ok.path,
    created: ok.created
  }, isMkdirNodeResult);
}

export function normalizeMoveNodeResult(raw: RawResult<{ node: RawNodeMutationAck; from_path: string; overwrote: boolean }>): MoveNodeResult {
  const ok = unwrapResult(raw);
  return validate("move_node", {
    node: normalizeNodeMutationAck(ok.node),
    from_path: ok.from_path,
    overwrote: ok.overwrote
  }, isMoveNodeResult);
}

export function normalizeGlobNodeHits(raw: RawResult<RawGlobNodeHit[]>): GlobNodeHit[] {
  return unwrapResult(raw).map((entry) =>
    validate("glob_nodes", {
      path: entry.path,
      kind: normalizeNodeEntryKind(entry.kind),
      has_children: entry.has_children
    }, isGlobNodeHit)
  );
}

export function normalizeRecentNodeHits(raw: RawResult<Array<{
  path: string;
  kind: RawNodeKind;
  updated_at: bigint;
  etag: string;
}>>): RecentNodeHit[] {
  return unwrapResult(raw).map((entry) =>
    validate("recent_nodes", {
      path: entry.path,
      kind: normalizeNodeKind(entry.kind),
      updated_at: toNumber(entry.updated_at),
      etag: entry.etag
    }, isRecentNodeHit)
  );
}

export function normalizeMultiEditNodeResult(raw: RawResult<{ node: RawNodeMutationAck; replacement_count: number }>): MultiEditNodeResult {
  const ok = unwrapResult(raw);
  return validate("multi_edit_node", {
    node: normalizeNodeMutationAck(ok.node),
    replacement_count: ok.replacement_count
  }, isMultiEditNodeResult);
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
    metadata_json: raw.metadata_json
  }, isNodeSnapshot);
}

function normalizeNodeMutationAck(raw: RawNodeMutationAck): NodeMutationAck {
  return validate("node_mutation_ack", {
    path: raw.path,
    kind: normalizeNodeKind(raw.kind),
    updated_at: toNumber(raw.updated_at),
    etag: raw.etag
  }, isNodeMutationAck);
}

function normalizeNodeEntry(raw: RawNodeEntry): NodeEntry {
  return validate("node_entry", {
    path: raw.path,
    kind: normalizeNodeEntryKind(raw.kind),
    updated_at: toNumber(raw.updated_at),
    etag: raw.etag,
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

// Where: workers/wiki-generator/src/vfs.ts
// What: Minimal authenticated VFS canister client for the generator.
// Why: Worker code only needs source reads, wiki writes, search, and sync paging.
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { identityFromPem } from "./identity-pem.js";
import { idlFactory } from "./vfs-idl.js";
import type { ExportSnapshotPage, FetchUpdatesPage, MkdirNodeRequest, NodeKind, SearchNodeHit, WikiNode, WorkerConfig, WriteNodeAck, WriteNodeRequest } from "./types.js";

type Variant = Record<string, null>;

type RawNode = {
  path: string;
  kind: Variant;
  content: string;
  created_at: bigint;
  updated_at: bigint;
  etag: string;
  metadata_json: string;
};

type RawSearchPreview = {
  excerpt: [] | [string];
};

type RawSearchNodeHit = {
  path: string;
  kind: Variant;
  snippet: [] | [string];
  preview: [] | [RawSearchPreview];
};

type RawExportSnapshotPage = {
  snapshot_revision: string;
  nodes: RawNode[];
  next_cursor: [] | [string];
};

type RawFetchUpdatesPage = {
  snapshot_revision: string;
  changed_nodes: RawNode[];
  removed_paths: string[];
  next_cursor: [] | [string];
};

type RawWriteNodeRequest = {
  database_id: string;
  path: string;
  kind: Variant;
  content: string;
  metadata_json: string;
  expected_etag: [] | [string];
};

type RawRecentNodeHit = {
  path: string;
  kind: Variant;
  etag: string;
  updated_at: bigint;
};

type RawWriteNodeResult = {
  created: boolean;
  node: RawRecentNodeHit;
};

type RawMkdirNodeRequest = {
  database_id: string;
  path: string;
};

type RawMkdirNodeResult = {
  created: boolean;
  path: string;
};

type Result<T> = { Ok: T } | { Err: string };

type VfsActor = {
  read_node: (databaseId: string, path: string) => Promise<Result<[] | [RawNode]>>;
  mkdir_node: (request: RawMkdirNodeRequest) => Promise<Result<RawMkdirNodeResult>>;
  write_node: (request: RawWriteNodeRequest) => Promise<Result<RawWriteNodeResult>>;
  search_nodes: (request: {
    database_id: string;
    query_text: string;
    prefix: [] | [string];
    top_k: number;
    preview_mode: [] | [Variant];
  }) => Promise<Result<RawSearchNodeHit[]>>;
  export_snapshot: (request: {
    database_id: string;
    prefix: [] | [string];
    limit: number;
    cursor: [] | [string];
    snapshot_revision: [] | [string];
    snapshot_session_id: [];
  }) => Promise<Result<RawExportSnapshotPage>>;
  fetch_updates: (request: {
    database_id: string;
    prefix: [] | [string];
    limit: number;
    cursor: [] | [string];
    known_snapshot_revision: string;
    target_snapshot_revision: [] | [string];
  }) => Promise<Result<RawFetchUpdatesPage>>;
};

export type VfsClient = {
  readNode(databaseId: string, path: string): Promise<WikiNode | null>;
  mkdirNode(request: MkdirNodeRequest): Promise<void>;
  writeNode(request: WriteNodeRequest): Promise<WriteNodeAck>;
  searchNodes(databaseId: string, queryText: string, limit: number, prefix: string): Promise<SearchNodeHit[]>;
  exportSnapshot(databaseId: string, prefix: string, cursor: string | null, snapshotRevision: string | null): Promise<ExportSnapshotPage>;
  fetchUpdates(databaseId: string, prefix: string, knownRevision: string, cursor: string | null, targetRevision: string | null): Promise<FetchUpdatesPage>;
};

export async function createVfsClient(config: WorkerConfig, identityPem: string): Promise<VfsClient> {
  const identity = identityFromPem(identityPem);
  const agent = HttpAgent.createSync({ host: config.icHost, identity });
  if (isLocalHost(config.icHost)) {
    await agent.fetchRootKey();
  }
  const actor = Actor.createActor<VfsActor>((idl) => idlFactory(idl), {
    agent,
    canisterId: Principal.fromText(config.canisterId)
  });
  return {
    readNode: async (databaseId, path) => normalizeOptionalNode(await unwrap(actor.read_node(databaseId, path))),
    mkdirNode: async (request) => {
      await unwrap(actor.mkdir_node({ database_id: request.databaseId, path: request.path }));
    },
    writeNode: async (request) => normalizeWriteNodeAck((await unwrap(actor.write_node(toRawWriteNodeRequest(request)))).node),
    searchNodes: async (databaseId, queryText, limit, prefix) =>
      (await unwrap(
        actor.search_nodes({
          database_id: databaseId,
          query_text: queryText,
          prefix: [prefix],
          top_k: limit,
          preview_mode: [{ ContentStart: null }]
        })
      )).map(normalizeSearchHit),
    exportSnapshot: async (databaseId, prefix, cursor, snapshotRevision) =>
      normalizeExportSnapshotPage(
        await unwrap(
          actor.export_snapshot({
            database_id: databaseId,
            prefix: [prefix],
            limit: 100,
            cursor: optionalText(cursor),
            snapshot_revision: optionalText(snapshotRevision),
            snapshot_session_id: []
          })
        )
      ),
    fetchUpdates: async (databaseId, prefix, knownRevision, cursor, targetRevision) =>
      normalizeFetchUpdatesPage(
        await unwrap(
          actor.fetch_updates({
            database_id: databaseId,
            prefix: [prefix],
            limit: 100,
            cursor: optionalText(cursor),
            known_snapshot_revision: knownRevision,
            target_snapshot_revision: optionalText(targetRevision)
          })
        )
      )
  };
}

export async function ensureParentFolders(vfs: VfsClient, databaseId: string, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    await vfs.mkdirNode({ databaseId, path: current });
  }
}

async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const resolved = await result;
  if ("Err" in resolved) {
    throw new Error(resolved.Err);
  }
  return resolved.Ok;
}

function normalizeOptionalNode(raw: [] | [RawNode]): WikiNode | null {
  const node = raw[0];
  return node ? normalizeNode(node) : null;
}

function normalizeNode(raw: RawNode): WikiNode {
  return {
    path: raw.path,
    kind: normalizeKind(raw.kind),
    content: raw.content,
    etag: raw.etag,
    metadataJson: raw.metadata_json
  };
}

function normalizeWriteNodeAck(raw: RawRecentNodeHit): WriteNodeAck {
  return {
    path: raw.path,
    kind: normalizeKind(raw.kind),
    etag: raw.etag
  };
}

function normalizeSearchHit(raw: RawSearchNodeHit): SearchNodeHit {
  return {
    path: raw.path,
    kind: normalizeKind(raw.kind),
    snippet: raw.snippet[0] ?? null,
    previewExcerpt: raw.preview[0]?.excerpt[0] ?? null
  };
}

function normalizeExportSnapshotPage(raw: RawExportSnapshotPage): ExportSnapshotPage {
  return {
    snapshotRevision: raw.snapshot_revision,
    nodes: raw.nodes.map(normalizeNode),
    nextCursor: raw.next_cursor[0] ?? null
  };
}

function normalizeFetchUpdatesPage(raw: RawFetchUpdatesPage): FetchUpdatesPage {
  return {
    snapshotRevision: raw.snapshot_revision,
    changedNodes: raw.changed_nodes.map(normalizeNode),
    removedPaths: raw.removed_paths,
    nextCursor: raw.next_cursor[0] ?? null
  };
}

function normalizeKind(kind: Variant): NodeKind {
  if ("Folder" in kind) return "folder";
  if ("File" in kind) return "file";
  if ("Source" in kind) return "source";
  throw new Error("unknown node kind");
}

function kindVariant(kind: NodeKind): Variant {
  if (kind === "folder") return { Folder: null };
  return kind === "source" ? { Source: null } : { File: null };
}

function toRawWriteNodeRequest(request: WriteNodeRequest): RawWriteNodeRequest {
  return {
    database_id: request.databaseId,
    path: request.path,
    kind: kindVariant(request.kind),
    content: request.content,
    metadata_json: request.metadataJson,
    expected_etag: optionalText(request.expectedEtag)
  };
}

function optionalText(value: string | null): [] | [string] {
  return value ? [value] : [];
}

function isLocalHost(host: string): boolean {
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?/i.test(host);
}

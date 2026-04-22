// Where: plugins/kinic-wiki/client.ts
// What: Direct canister client for the Kinic plugin.
// Why: The plugin now talks to FS-first node methods instead of wiki-specific sync APIs.
import { Actor, HttpAgent } from "@dfinity/agent";

import {
  idlFactory,
  normalizeGlobNodeHits,
  normalizeMoveNodeResult,
  normalizeMultiEditNodeResult,
  normalizeEditNodeResult,
  localReplicaHost,
  normalizeDeleteNodeResult,
  normalizeExportResponse,
  normalizeFetchResponse,
  normalizeListNodes,
  normalizeMkdirNodeResult,
  normalizeRecentNodeHits,
  normalizeReadNode,
  normalizeSearchNodeHits,
  normalizeStatus,
  normalizeWriteNodeResult,
  type KinicCanisterApi
} from "./candid";
import {
  DeleteNodeResult,
  EditNodeResult,
  ExportSnapshotResponse,
  FetchUpdatesResponse,
  GlobNodeHit,
  GlobNodeType,
  MkdirNodeResult,
  MoveNodeResult,
  MultiEdit,
  MultiEditNodeResult,
  NodeEntry,
  NodeKind,
  NodeSnapshot,
  RecentNodeHit,
  SearchNodeHit,
  StatusResponse,
  WriteNodeResult
} from "./types";

const cachedAgents = new Map<string, Promise<HttpAgent>>();

export class KinicCanisterClient {
  constructor(
    private readonly replicaHost: string,
    private readonly canisterId: string
  ) {}

  async status(): Promise<StatusResponse> {
    const actor = await this.actor();
    return normalizeStatus(await actor.status());
  }

  async readNode(path: string): Promise<NodeSnapshot | null> {
    const actor = await this.actor();
    return normalizeReadNode(await actor.read_node(path));
  }

  async listNodes(prefix: string, recursive: boolean): Promise<NodeEntry[]> {
    const actor = await this.actor();
    return normalizeListNodes(await actor.list_nodes({
      prefix,
      recursive
    }));
  }

  async writeNode(path: string, kind: NodeKind, content: string, expectedEtag: string | null): Promise<WriteNodeResult> {
    const actor = await this.actor();
    return normalizeWriteNodeResult(await actor.write_node({
      path,
      kind: kind === "file" ? { File: null } : { Source: null },
      content,
      metadata_json: "{}",
      expected_etag: expectedEtag === null ? [] : [expectedEtag]
    }));
  }

  async appendNode(
    path: string,
    content: string,
    expectedEtag: string | null,
    separator: string | null
  ): Promise<WriteNodeResult> {
    const actor = await this.actor();
    return normalizeWriteNodeResult(await actor.append_node({
      path,
      content,
      expected_etag: expectedEtag === null ? [] : [expectedEtag],
      separator: separator === null ? [] : [separator],
      metadata_json: [],
      kind: []
    }));
  }

  async editNode(
    path: string,
    oldText: string,
    newText: string,
    expectedEtag: string | null,
    replaceAll: boolean
  ): Promise<EditNodeResult> {
    const actor = await this.actor();
    return normalizeEditNodeResult(await actor.edit_node({
      path,
      old_text: oldText,
      new_text: newText,
      expected_etag: expectedEtag === null ? [] : [expectedEtag],
      replace_all: replaceAll
    }));
  }

  async deleteNode(path: string, expectedEtag: string): Promise<DeleteNodeResult> {
    const actor = await this.actor();
    return normalizeDeleteNodeResult(await actor.delete_node({
      path,
      expected_etag: [expectedEtag]
    }));
  }

  async mkdirNode(path: string): Promise<MkdirNodeResult> {
    const actor = await this.actor();
    return normalizeMkdirNodeResult(await actor.mkdir_node({ path }));
  }

  async moveNode(
    fromPath: string,
    toPath: string,
    expectedEtag: string | null,
    overwrite: boolean
  ): Promise<MoveNodeResult> {
    const actor = await this.actor();
    return normalizeMoveNodeResult(await actor.move_node({
      from_path: fromPath,
      to_path: toPath,
      expected_etag: expectedEtag === null ? [] : [expectedEtag],
      overwrite
    }));
  }

  async globNodes(pattern: string, path: string, nodeType: GlobNodeType | null): Promise<GlobNodeHit[]> {
    const actor = await this.actor();
    return normalizeGlobNodeHits(await actor.glob_nodes({
      pattern,
      path: [path],
      node_type: nodeType === null ? [] : [toRawGlobNodeType(nodeType)]
    }));
  }

  async recentNodes(limit: number, path: string): Promise<RecentNodeHit[]> {
    const actor = await this.actor();
    return normalizeRecentNodeHits(await actor.recent_nodes({
      limit,
      path: [path]
    }));
  }

  async multiEditNode(
    path: string,
    edits: MultiEdit[],
    expectedEtag: string | null
  ): Promise<MultiEditNodeResult> {
    const actor = await this.actor();
    return normalizeMultiEditNodeResult(await actor.multi_edit_node({
      path,
      edits,
      expected_etag: expectedEtag === null ? [] : [expectedEtag]
    }));
  }

  async searchNodes(queryText: string, prefix: string): Promise<SearchNodeHit[]> {
    const actor = await this.actor();
    return normalizeSearchNodeHits(await actor.search_nodes({
      query_text: queryText,
      prefix: [prefix],
      top_k: 10
    }));
  }

  async searchNodePaths(queryText: string, prefix: string): Promise<SearchNodeHit[]> {
    const actor = await this.actor();
    return normalizeSearchNodeHits(await actor.search_node_paths({
      query_text: queryText,
      prefix: [prefix],
      top_k: 10
    }));
  }

  async exportSnapshot(
    cursor: string | null,
    snapshotRevision: string | null,
    snapshotSessionId: string | null,
    limit: number
  ): Promise<ExportSnapshotResponse> {
    const actor = await this.actor();
    return normalizeExportResponse(await actor.export_snapshot({
      prefix: ["/Wiki"],
      limit,
      cursor: cursor === null ? [] : [cursor],
      snapshot_revision: snapshotRevision === null ? [] : [snapshotRevision],
      snapshot_session_id: snapshotSessionId === null ? [] : [snapshotSessionId]
    }));
  }

  async fetchUpdates(
    lastSnapshotRevision: string,
    cursor: string | null,
    targetSnapshotRevision: string | null,
    limit: number
  ): Promise<FetchUpdatesResponse> {
    const actor = await this.actor();
    return normalizeFetchResponse(await actor.fetch_updates({
      known_snapshot_revision: lastSnapshotRevision,
      prefix: ["/Wiki"],
      limit,
      cursor: cursor === null ? [] : [cursor],
      target_snapshot_revision: targetSnapshotRevision === null ? [] : [targetSnapshotRevision]
    }));
  }

  private async actor(): Promise<KinicCanisterApi> {
    const host = trimTrailingSlash(this.replicaHost);
    const agent = await cachedAgent(host);
    return Actor.createActor<KinicCanisterApi>(idlFactory, {
      agent,
      canisterId: this.canisterId
    });
  }
}

function trimTrailingSlash(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

async function cachedAgent(host: string): Promise<HttpAgent> {
  const existing = cachedAgents.get(host);
  if (existing !== undefined) {
    return existing;
  }
  const created = createAgent(host);
  cachedAgents.set(host, created);
  return created;
}

async function createAgent(host: string): Promise<HttpAgent> {
  const agent = new HttpAgent({ host });
  if (localReplicaHost(host)) {
    await agent.fetchRootKey();
  }
  return agent;
}

function toRawGlobNodeType(nodeType: GlobNodeType): { File: null } | { Directory: null } | { Any: null } {
  switch (nodeType) {
    case "file":
      return { File: null };
    case "directory":
      return { Directory: null };
    case "any":
      return { Any: null };
  }
}

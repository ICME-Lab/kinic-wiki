// Where: plugins/kinic-wiki/client.ts
// What: Direct canister client for the Kinic plugin.
// Why: The plugin now talks to FS-first node methods instead of wiki-specific sync APIs.
import { Actor, HttpAgent } from "@dfinity/agent";

import {
  idlFactory,
  localReplicaHost,
  normalizeDeleteNodeResult,
  normalizeExportResponse,
  normalizeFetchResponse,
  normalizeListNodes,
  normalizeReadNode,
  normalizeSearchNodeHits,
  normalizeStatus,
  normalizeWriteNodeResult,
  type KinicCanisterApi
} from "./candid";
import {
  DeleteNodeResult,
  ExportSnapshotResponse,
  FetchUpdatesResponse,
  NodeEntry,
  NodeKind,
  NodeSnapshot,
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

  async listNodes(prefix: string, recursive: boolean, includeDeleted: boolean): Promise<NodeEntry[]> {
    const actor = await this.actor();
    return normalizeListNodes(await actor.list_nodes({
      prefix,
      recursive,
      include_deleted: includeDeleted
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

  async deleteNode(path: string, expectedEtag: string): Promise<DeleteNodeResult> {
    const actor = await this.actor();
    return normalizeDeleteNodeResult(await actor.delete_node({
      path,
      expected_etag: [expectedEtag]
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

  async exportSnapshot(): Promise<ExportSnapshotResponse> {
    const actor = await this.actor();
    return normalizeExportResponse(await actor.export_snapshot({
      prefix: ["/Wiki"],
      include_deleted: false
    }));
  }

  async fetchUpdates(lastSnapshotRevision: string): Promise<FetchUpdatesResponse> {
    const actor = await this.actor();
    return normalizeFetchResponse(await actor.fetch_updates({
      known_snapshot_revision: lastSnapshotRevision,
      prefix: ["/Wiki"],
      include_deleted: false
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

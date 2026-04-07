// Where: plugins/kinic-wiki/client.ts
// What: Direct canister client for the Kinic wiki plugin.
// Why: The plugin should talk to the canister over query/update calls without a local HTTP adapter.
import { Actor, HttpAgent } from "@dfinity/agent";

import {
  normalizeCommitResponse,
  normalizeExportResponse,
  normalizeFetchResponse,
  normalizeStatus,
  idlFactory,
  localReplicaHost,
  toRawCommitChanges,
  type KinicCanisterApi
} from "./candid";
import {
  CommitPageChange,
  CommitWikiChangesResponse,
  ExportWikiSnapshotResponse,
  FetchWikiUpdatesResponse,
  MirrorFrontmatter,
  StatusResponse
} from "./types";

const cachedAgents = new Map<string, Promise<HttpAgent>>();

export class KinicCanisterClient {
  constructor(
    private readonly replicaHost: string,
    private readonly canisterId: string
  ) {}

  async exportWikiSnapshot(): Promise<ExportWikiSnapshotResponse> {
    const actor = await this.actor();
    return normalizeExportResponse(
      await actor.export_wiki_snapshot({
        include_system_pages: true,
        page_slugs: []
      })
    );
  }

  async fetchWikiUpdates(
    lastSnapshotRevision: string,
    knownPages: MirrorFrontmatter[]
  ): Promise<FetchWikiUpdatesResponse> {
    const actor = await this.actor();
    return normalizeFetchResponse(
      await actor.fetch_wiki_updates({
        known_snapshot_revision: lastSnapshotRevision,
        known_page_revisions: knownPages.map((page) => ({
          page_id: page.page_id,
          revision_id: page.revision_id
        })),
        include_system_pages: true
      })
    );
  }

  async commitWikiChanges(
    baseSnapshotRevision: string,
    pageChanges: CommitPageChange[]
  ): Promise<CommitWikiChangesResponse> {
    const actor = await this.actor();
    return normalizeCommitResponse(
      await actor.commit_wiki_changes(toRawCommitChanges(baseSnapshotRevision, pageChanges))
    );
  }

  async status(): Promise<StatusResponse> {
    const actor = await this.actor();
    return normalizeStatus(await actor.status());
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

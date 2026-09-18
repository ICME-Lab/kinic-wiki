// Where: workers/wiki-generator/tests/nns-fixtures.ts
// What: In-memory VFS and Queue doubles for NNS audit tests.
// Why: Discovery, leases, checkpoints, votes, and partial commits are all Wiki-backed.
import { NodeMutationError, type VfsClient } from "../src/vfs.js";
import type { NnsRuntimeEnv } from "../src/nns-env.js";
import type { NnsProposalReviewFailureMessage, NnsProposalReviewQueueMessage } from "../src/types.js";
import { TestQueue } from "./source-capture-fixtures.js";
import type {
  ExportSnapshotPage,
  FetchUpdatesPage,
  MkdirNodeRequest,
  PublicDatabaseSummary,
  SearchNodeHit,
  WikiNode,
  WriteNodeAck,
  WriteNodeRequest
} from "../src/types.js";

export function nnsTestEnv(
  queue: TestQueue<NnsProposalReviewQueueMessage> = new TestQueue<NnsProposalReviewQueueMessage>(),
  dlq: TestQueue<NnsProposalReviewFailureMessage> = new TestQueue<NnsProposalReviewFailureMessage>()
): NnsRuntimeEnv {
  return {
    NNS_PROPOSAL_REVIEW_QUEUE: queue,
    NNS_PROPOSAL_REVIEW_DLQ: dlq,
    NNS_VOTE_QUEUE: new TestQueue(),
    KINIC_WIKI_CANISTER_ID: "6emaw-iyaaa-aaaay-aacka-cai",
    KINIC_WIKI_IC_HOST: "https://icp0.io",
    KINIC_NNS_API_BASE_URL: "https://ic-api.internetcomputer.org/api/v3",
    KINIC_NNS_REVIEW_MODEL: "deepseek-v4-flash",
    DEEPSEEK_API_KEY: "deepseek-key",
    TYPESAFE_API_KEY: "typesafe-key",
    KINIC_NNS_WORKER_IDENTITY_PEM: "identity-pem",
    KINIC_NNS_AUDIT_DATABASE_ID: "nns-db"
  };
}

export class NnsTestVfs implements VfsClient {
  readonly nodes = new Map<string, WikiNode>();
  readonly writeCycleChecks: string[] = [];
  readonly exportPrefixes: string[] = [];
  failWritePath: string | null = null;
  failWritePathOnce: string | null = null;
  failWritePathOnAttempt: { path: string; attempt: number } | null = null;
  etagConflictPathOnce: string | null = null;
  private etagCounter = 0;
  private readonly pathWriteCounts = new Map<string, number>();

  async listPublicDatabases(): Promise<PublicDatabaseSummary[]> {
    return [];
  }

  async checkDatabaseWriteCycles(databaseId: string): Promise<void> {
    this.writeCycleChecks.push(databaseId);
  }

  async checkSourceRunSession(): Promise<void> {}

  async checkSourceCaptureTriggerSession(): Promise<void> {}

  async readNode(_databaseId: string, path: string): Promise<WikiNode | null> {
    return this.nodes.get(path) ?? null;
  }

  async mkdirNode(_request: MkdirNodeRequest): Promise<void> {}

  async writeNode(request: WriteNodeRequest): Promise<WriteNodeAck> {
    const pathAttempt = (this.pathWriteCounts.get(request.path) ?? 0) + 1;
    this.pathWriteCounts.set(request.path, pathAttempt);
    if (this.failWritePath === request.path) throw new Error("simulated persistent VFS outage");
    if (this.failWritePathOnAttempt?.path === request.path && this.failWritePathOnAttempt.attempt === pathAttempt) {
      throw new Error("simulated VFS outage on selected write");
    }
    if (this.failWritePathOnce === request.path) {
      this.failWritePathOnce = null;
      throw new Error("simulated VFS outage");
    }
    if (this.etagConflictPathOnce === request.path) {
      this.etagConflictPathOnce = null;
      throw new NodeMutationError("etag_conflict", null, request.path, `simulated etag conflict: ${request.path}`);
    }
    const existing = this.nodes.get(request.path);
    if ((existing?.etag ?? null) !== request.expectedEtag) {
      throw new NodeMutationError("etag_conflict", null, request.path, `etag conflict: ${request.path}`);
    }
    const etag = `etag-${++this.etagCounter}`;
    this.nodes.set(request.path, {
      path: request.path,
      kind: request.kind,
      content: request.content,
      etag,
      metadataJson: request.metadataJson
    });
    return { path: request.path, kind: request.kind, etag };
  }

  async searchNodes(): Promise<SearchNodeHit[]> {
    return [];
  }

  async exportSnapshot(_databaseId: string, prefix: string): Promise<ExportSnapshotPage> {
    this.exportPrefixes.push(prefix);
    return { snapshotRevision: "rev", nodes: [...this.nodes.values()].filter((node) => node.path.startsWith(prefix)), nextCursor: null };
  }

  async fetchUpdates(): Promise<FetchUpdatesPage> {
    return { snapshotRevision: "rev", changedNodes: [], removedPaths: [], nextCursor: null };
  }
}

// Where: workers/wiki-generator/tests/nns-fixtures.ts
// What: SQLite-backed D1 and in-memory VFS doubles for NNS audit tests.
// Why: Discovery, leases, checkpoints, and partial VFS commits need realistic state transitions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
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

export class SqliteD1 implements D1Database {
  private readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec(readFileSync(join(process.cwd(), "nns-migrations", "0001_nns_proposal_reviews.sql"), "utf8"));
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.sqlite.prepare(query));
  }

  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.sqlite.close();
  }
}

export function nnsTestEnv(
  db: D1Database,
  queue: TestQueue<NnsProposalReviewQueueMessage> = new TestQueue<NnsProposalReviewQueueMessage>(),
  dlq: TestQueue<NnsProposalReviewFailureMessage> = new TestQueue<NnsProposalReviewFailureMessage>()
): NnsRuntimeEnv {
  return {
    DB: db,
    NNS_PROPOSAL_REVIEW_QUEUE: queue,
    NNS_PROPOSAL_REVIEW_DLQ: dlq,
    KINIC_WIKI_CANISTER_ID: "6emaw-iyaaa-aaaay-aacka-cai",
    KINIC_WIKI_IC_HOST: "https://icp0.io",
    KINIC_NNS_API_BASE_URL: "https://ic-api.internetcomputer.org/api/v3",
    KINIC_NNS_REVIEW_MODEL: "deepseek-v4-flash",
    DEEPSEEK_API_KEY: "deepseek-key",
    KINIC_NNS_WORKER_IDENTITY_PEM: "identity-pem",
    KINIC_NNS_AUDIT_DATABASE_ID: "nns-db"
  };
}

class SqliteD1Statement implements D1PreparedStatement {
  private values: D1Value[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.statement.get(...toSqliteValues(this.values)) as T | undefined) ?? null;
  }

  async run(): Promise<unknown> {
    const result = this.statement.run(...toSqliteValues(this.values));
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) }
    };
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return {
      results: this.statement.all(...toSqliteValues(this.values)) as T[]
    };
  }
}

function toSqliteValues(values: D1Value[]): (string | number | bigint | Uint8Array | null)[] {
  return values.map((value) => {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  });
}

export class NnsTestVfs implements VfsClient {
  readonly nodes = new Map<string, WikiNode>();
  readonly writeCycleChecks: string[] = [];
  failWritePath: string | null = null;
  failWritePathOnce: string | null = null;
  etagConflictPathOnce: string | null = null;
  private etagCounter = 0;

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
    if (this.failWritePath === request.path) throw new Error("simulated persistent VFS outage");
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

  async exportSnapshot(): Promise<ExportSnapshotPage> {
    return { snapshotRevision: "rev", nodes: [], nextCursor: null };
  }

  async fetchUpdates(): Promise<FetchUpdatesPage> {
    return { snapshotRevision: "rev", changedNodes: [], removedPaths: [], nextCursor: null };
  }
}

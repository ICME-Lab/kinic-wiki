// Where: workers/wiki-generator/tests/source-capture-fixtures.ts
// What: Test doubles for source capture worker tests.
// Why: source capture state tests need VFS, D1, Queue, and fetch fixtures without bloating the spec file.
import type { RuntimeEnv } from "../src/env.js";
import { parseSourceCaptureRequest } from "../src/source-capture.js";
import type {
  ExportSnapshotPage,
  FetchUpdatesPage,
  NodeKind,
  QueueMessage,
  SearchNodeHit,
  SourceCaptureRequest,
  WikiNode,
  WorkerConfig,
  WriteNodeAck,
  WriteNodeRequest
} from "../src/types.js";
import type { VfsClient } from "../src/vfs.js";

export function workerConfig(): WorkerConfig {
  return {
    canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
    icHost: "https://icp0.io",
    model: "deepseek-v4-flash",
    targetRoot: "/Knowledge/conversations",
    sourcePrefix: "/Sources",
    contextPrefix: "/",
    maxRawChars: 120_000,
    maxFetchedBytes: 5_000_000,
    maxSourceChars: 300_000,
    maxContextHits: 8,
    maxOutputTokens: 6_000
  };
}

export function testEnv(queue: TestQueue): RuntimeEnv {
  return {
    DB: new TestD1(),
    WIKI_GENERATION_QUEUE: queue,
    KINIC_WIKI_CANISTER_ID: "6emaw-iyaaa-aaaay-aacka-cai",
    KINIC_WIKI_IC_HOST: "https://icp0.io",
    KINIC_WIKI_WORKER_MODEL: "deepseek-v4-flash",
    KINIC_WIKI_WORKER_TARGET_ROOT: "/Knowledge/conversations",
    KINIC_WIKI_WORKER_SOURCE_PREFIX: "/Sources",
    KINIC_WIKI_WORKER_CONTEXT_PREFIX: "/",
    DEEPSEEK_API_KEY: "deepseek-key",
    KINIC_WIKI_WORKER_TOKEN: "worker-token",
    KINIC_WIKI_WORKER_IDENTITY_PEM: "identity-pem"
  };
}

export async function withFetchedPage(run: () => Promise<void>, html = "<html><head><title>Fetched Title</title></head><body>Hello source</body></html>"): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> =>
    new Response(html, {
      headers: { "content-type": "text/html" }
    });
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export class TestVfsClient implements VfsClient {
  existingSource: WikiNode | null = null;
  sourceNodes = new Map<string, WikiNode>();
  requestNode: WikiNode | null = null;
  failSessionCheck = false;
  sessionChecks: { databaseId: string; requestPath: string; sessionNonce: string }[] = [];
  sourceSessionChecks: { databaseId: string; sourcePath: string; sourceEtag: string; sessionNonce: string }[] = [];
  writeCycleChecks: string[] = [];
  failExpectedEtagOnce = false;
  sourceAckKind: NodeKind = "source";
  sourceReadsBeforeWrite = 0;
  sourceReadsAfterWrite = 0;
  requestReads = 0;
  sourceWrites = 0;
  sourceWriteEtags: string[] = [];
  lastRequest: SourceCaptureRequest | null = null;
  lastSourceWrite: WriteNodeRequest | null = null;

  async checkDatabaseWriteCycles(databaseId: string): Promise<void> {
    this.writeCycleChecks.push(databaseId);
  }

  async checkSourceRunSession(databaseId: string, sourcePath: string, sourceEtag: string, sessionNonce: string): Promise<void> {
    this.sourceSessionChecks.push({ databaseId, sourcePath, sourceEtag, sessionNonce });
  }

  async checkSourceCaptureTriggerSession(databaseId: string, requestPath: string, sessionNonce: string): Promise<void> {
    this.sessionChecks.push({ databaseId, requestPath, sessionNonce });
    if (this.failSessionCheck) throw new Error("session denied");
  }

  async readNode(_databaseId: string, path: string): Promise<WikiNode | null> {
    if (path.startsWith("/Sources/source-capture-requests/")) {
      this.requestReads += 1;
      return this.requestNode;
    }
    if (path.startsWith("/Sources/")) {
      if (this.sourceWrites > 0) this.sourceReadsAfterWrite += 1;
      else this.sourceReadsBeforeWrite += 1;
      return this.sourceNodes.get(path) ?? (this.existingSource?.path === path ? this.existingSource : null);
    }
    this.requestReads += 1;
    return this.requestNode;
  }

  async writeNode(request: WriteNodeRequest): Promise<WriteNodeAck> {
    const etag = request.kind === "source" ? (this.sourceWriteEtags.shift() ?? "etag-source-write") : `etag-file-${request.path}-${request.content.length}`;
    if (this.failExpectedEtagOnce && request.kind === "file") {
      this.failExpectedEtagOnce = false;
      throw new Error(`expected_etag does not match current etag: ${request.path}`);
    }
    if (request.kind === "source") {
      this.sourceWrites += 1;
      this.lastSourceWrite = request;
      this.sourceNodes.set(request.path, {
        path: request.path,
        kind: "source",
        content: request.content,
        etag,
        metadataJson: request.metadataJson
      });
      return { path: request.path, kind: this.sourceAckKind, etag };
    }
    this.requestNode = {
      path: request.path,
      kind: "file",
      content: request.content,
      etag,
      metadataJson: request.metadataJson
    };
    const parsed = parseSourceCaptureRequest({
      path: request.path,
      kind: "file",
      content: request.content,
      etag,
      metadataJson: request.metadataJson
    });
    if (parsed) this.lastRequest = parsed;
    return { path: request.path, kind: "file", etag };
  }

  async mkdirNode(): Promise<void> {}

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

export class TestQueue implements Queue {
  messages: QueueMessage[] = [];
  failSend = false;

  async send(message: unknown): Promise<void> {
    if (this.failSend) throw new Error("queue unavailable");
    if (isQueueMessage(message)) this.messages.push(message);
  }
}

class TestD1 implements D1Database {
  prepare(query: string): D1PreparedStatement {
    return new TestD1Statement(query);
  }
}

class TestD1Statement implements D1PreparedStatement {
  private values: D1Value[] = [];

  constructor(private readonly query: string) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("SELECT database_id, source_path, source_etag, status, target_path")) {
      return completedJobFromQueue(this.values) as T | null;
    }
    return null;
  }

  async run(): Promise<unknown> {
    return { query: this.query, values: this.values };
  }
}

function completedJobFromQueue(values: D1Value[]): unknown {
  const sourcePath = values[1];
  if (sourcePath !== "/Sources/existing/existing.md") return null;
  return {
    database_id: values[0],
    source_path: sourcePath,
    source_etag: "etag-existing-source",
    status: "completed",
    target_path: "/Knowledge/conversations/a.md",
    attempts: 1,
    last_error: null,
    updated_at: "2026-05-12T00:00:00.000Z"
  };
}

function isQueueMessage(value: unknown): value is QueueMessage {
  if (typeof value !== "object" || value === null) return false;
  if ("kind" in value && value.kind === "source") {
    return (
      "databaseId" in value &&
      "sourcePath" in value &&
      "sourceEtag" in value &&
      typeof value.databaseId === "string" &&
      typeof value.sourcePath === "string" &&
      typeof value.sourceEtag === "string"
    );
  }
  if ("kind" in value && value.kind === "source_capture") {
    return (
      "canisterId" in value &&
      "databaseId" in value &&
      "requestPath" in value &&
      "sessionNonce" in value &&
      typeof value.canisterId === "string" &&
      typeof value.databaseId === "string" &&
      typeof value.requestPath === "string" &&
      typeof value.sessionNonce === "string"
    );
  }
  return false;
}

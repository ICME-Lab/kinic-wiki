// Where: workers/wiki-generator/tests/url-ingest-fixtures.ts
// What: Test doubles for URL ingest worker tests.
// Why: URL ingest state tests need VFS, D1, Queue, and fetch fixtures without bloating the spec file.
import type { RuntimeEnv } from "../src/env.js";
import { parseUrlIngestRequest } from "../src/url-ingest.js";
import type {
  ExportSnapshotPage,
  FetchUpdatesPage,
  NodeKind,
  QueueMessage,
  SearchNodeHit,
  UrlIngestRequest,
  WikiNode,
  WorkerConfig,
  WriteNodeAck,
  WriteNodeRequest
} from "../src/types.js";
import type { VfsClient } from "../src/vfs.js";

export function workerConfig(): WorkerConfig {
  return {
    canisterId: "xis3j-paaaa-aaaai-axumq-cai",
    icHost: "https://icp0.io",
    model: "deepseek-v4-flash",
    targetRoot: "/Wiki/conversations",
    sourcePrefix: "/Sources/raw",
    contextPrefix: "/Wiki",
    maxRawChars: 120_000,
    maxFetchedBytes: 1_000_000,
    maxContextHits: 8,
    maxOutputTokens: 6_000
  };
}

export function testEnv(queue: TestQueue): RuntimeEnv {
  return {
    DB: new TestD1(),
    WIKI_GENERATION_QUEUE: queue,
    KINIC_WIKI_CANISTER_ID: "xis3j-paaaa-aaaai-axumq-cai",
    KINIC_WIKI_IC_HOST: "https://icp0.io",
    KINIC_WIKI_WORKER_MODEL: "deepseek-v4-flash",
    KINIC_WIKI_WORKER_TARGET_ROOT: "/Wiki/conversations",
    KINIC_WIKI_WORKER_SOURCE_PREFIX: "/Sources/raw",
    KINIC_WIKI_WORKER_CONTEXT_PREFIX: "/Wiki",
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
  requestNode: WikiNode | null = null;
  failExpectedEtagOnce = false;
  sourceAckKind: NodeKind = "source";
  sourceReadsBeforeWrite = 0;
  sourceReadsAfterWrite = 0;
  requestReads = 0;
  sourceWrites = 0;
  lastRequest: UrlIngestRequest | null = null;
  lastSourceWrite: WriteNodeRequest | null = null;

  async readNode(_databaseId: string, path: string): Promise<WikiNode | null> {
    if (path.startsWith("/Sources/raw/")) {
      if (this.sourceWrites > 0) this.sourceReadsAfterWrite += 1;
      else this.sourceReadsBeforeWrite += 1;
      return this.existingSource;
    }
    this.requestReads += 1;
    return this.requestNode;
  }

  async writeNode(request: WriteNodeRequest): Promise<WriteNodeAck> {
    const etag = request.kind === "source" ? "etag-source-write" : `etag-file-${request.path}-${request.content.length}`;
    if (this.failExpectedEtagOnce && request.kind === "file") {
      this.failExpectedEtagOnce = false;
      throw new Error(`expected_etag does not match current etag: ${request.path}`);
    }
    if (request.kind === "source") {
      this.sourceWrites += 1;
      this.lastSourceWrite = request;
      return { path: request.path, kind: this.sourceAckKind, etag };
    }
    this.requestNode = {
      path: request.path,
      kind: "file",
      content: request.content,
      etag,
      metadataJson: request.metadataJson
    };
    const parsed = parseUrlIngestRequest({
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

  async send(message: unknown): Promise<void> {
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
  if (sourcePath !== "/Sources/raw/existing/existing.md") return null;
  return {
    database_id: values[0],
    source_path: sourcePath,
    source_etag: "etag-existing-source",
    status: "completed",
    target_path: "/Wiki/conversations/a.md",
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
  if ("kind" in value && value.kind === "url_ingest") {
    return (
      "canisterId" in value &&
      "databaseId" in value &&
      "requestPath" in value &&
      typeof value.canisterId === "string" &&
      typeof value.databaseId === "string" &&
      typeof value.requestPath === "string"
    );
  }
  return false;
}

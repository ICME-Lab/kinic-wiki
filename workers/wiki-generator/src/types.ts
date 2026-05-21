// Where: workers/wiki-generator/src/types.ts
// What: Shared worker contracts and normalized VFS types.
// Why: Queue, D1, VFS, and LLM code need one small typed vocabulary.
export const SCHEMA_VERSION = 1;

export type NodeKind = "file" | "source" | "folder";

export type WikiNode = {
  path: string;
  kind: NodeKind;
  content: string;
  etag: string;
  metadataJson: string;
};

export type SearchNodeHit = {
  path: string;
  kind: NodeKind;
  snippet: string | null;
  previewExcerpt: string | null;
};

export type WriteNodeRequest = {
  databaseId: string;
  path: string;
  kind: NodeKind;
  content: string;
  metadataJson: string;
  expectedEtag: string | null;
};

export type WriteNodeAck = {
  path: string;
  kind: NodeKind;
  etag: string;
};

export type MkdirNodeRequest = {
  databaseId: string;
  path: string;
};

export type ExportSnapshotPage = {
  snapshotRevision: string;
  nodes: WikiNode[];
  nextCursor: string | null;
};

export type FetchUpdatesPage = {
  snapshotRevision: string;
  changedNodes: WikiNode[];
  removedPaths: string[];
  nextCursor: string | null;
};

export type WikiDraftItem = {
  text: string;
  source_path: string;
};

export type WikiDraft = {
  title: string;
  slug: string;
  summary: string;
  key_facts: WikiDraftItem[];
  decisions: WikiDraftItem[];
  open_questions: WikiDraftItem[];
  follow_ups: WikiDraftItem[];
};

export type SourceQueueMessage = {
  kind: "source";
  databaseId: string;
  sourcePath: string;
  sourceEtag: string;
  requestPath?: string;
};

export type UrlIngestQueueMessage = UrlIngestTriggerInput & {
  kind: "url_ingest";
};

export type QueueMessage = SourceQueueMessage | UrlIngestQueueMessage;

export type ManualRunInput = {
  databaseId: string;
  sourcePath: string;
  dryRun: boolean;
};

export type WorkerConfig = {
  canisterId: string;
  icHost: string;
  model: string;
  targetRoot: string;
  sourcePrefix: string;
  contextPrefix: string;
  maxRawChars: number;
  maxFetchedBytes: number;
  maxContextHits: number;
  maxOutputTokens: number;
};

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export type SourceJob = {
  database_id: string;
  source_path: string;
  source_etag: string;
  status: JobStatus;
  target_path: string | null;
  attempts: number;
  last_error: string | null;
  updated_at: string;
};

export type IngestRequestStatus = "queued" | "fetching" | "source_written" | "generating" | "completed" | "failed";

export type UrlIngestRequest = {
  path: string;
  etag: string;
  status: IngestRequestStatus;
  url: string;
  requestedBy: string;
  requestedAt: string;
  claimedAt: string | null;
  sourcePath: string | null;
  targetPath: string | null;
  finishedAt: string | null;
  error: string | null;
  metadataJson: string;
};

export type UrlIngestTriggerInput = {
  canisterId: string;
  databaseId: string;
  requestPath: string;
};

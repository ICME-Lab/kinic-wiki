export type NodeKind = "file" | "source" | "folder";
export type NodeEntryKind = "file" | "source" | "directory" | "folder";

export type WikiNode = {
  path: string;
  kind: NodeKind;
  content: string;
  createdAt: string;
  updatedAt: string;
  etag: string;
  metadataJson: string;
};

export type WriteNodeRequest = {
  databaseId: string;
  path: string;
  kind: NodeKind;
  content: string;
  metadataJson: string;
  expectedEtag: string | null;
};

export type WriteNodeResult = {
  created: boolean;
  node: RecentNode;
};

export type DeleteNodeRequest = {
  databaseId: string;
  path: string;
  expectedEtag: string;
  expectedFolderIndexEtag: string | null;
};

export type DeleteNodeResult = {
  path: string;
};

export type MkdirNodeRequest = {
  databaseId: string;
  path: string;
};

export type MkdirNodeResult = {
  path: string;
  created: boolean;
};

export type MoveNodeRequest = {
  databaseId: string;
  fromPath: string;
  toPath: string;
  expectedEtag: string | null;
  overwrite: boolean;
};

export type MoveNodeResult = {
  fromPath: string;
  node: RecentNode;
  overwrote: boolean;
};

export type UrlIngestTriggerSessionRequest = {
  databaseId: string;
  sessionNonce: string;
};

export type UrlIngestTriggerSessionCheckRequest = {
  databaseId: string;
  requestPath: string;
  sessionNonce: string;
};

export type QueryAnswerSessionRequest = {
  databaseId: string;
  sessionNonce: string;
};

export type QueryAnswerSessionCheckRequest = {
  databaseId: string;
  sessionNonce: string;
};

export type QueryAnswerSessionCheckResult = {
  principal: string;
};

export type CanisterHealth = {
  cyclesBalance: bigint;
};

export type DatabaseRole = "reader" | "writer" | "owner";
export type DatabaseStatus = "hot" | "restoring" | "archiving" | "archived" | "deleted";

export type DatabaseSummary = {
  databaseId: string;
  name: string;
  role: DatabaseRole;
  status: DatabaseStatus;
  logicalSizeBytes: string;
  archivedAtMs: string | null;
  deletedAtMs: string | null;
};

export type DatabaseMember = {
  databaseId: string;
  principal: string;
  role: DatabaseRole;
  createdAtMs: string;
};

export type ChildNode = {
  path: string;
  name: string;
  kind: NodeEntryKind;
  updatedAt: string | null;
  etag: string | null;
  sizeBytes: string | null;
  isVirtual: boolean;
  hasChildren: boolean;
};

export type RecentNode = {
  path: string;
  kind: NodeKind;
  updatedAt: string;
  etag: string;
};

export type LinkEdge = {
  sourcePath: string;
  targetPath: string;
  rawHref: string;
  linkText: string;
  linkKind: string;
  updatedAt: string;
};

export type NodeContext = {
  node: WikiNode;
  incomingLinks: LinkEdge[];
  outgoingLinks: LinkEdge[];
};

export type QueryContext = {
  namespace: string;
  task: string;
  searchHits: SearchNodeHit[];
  nodes: NodeContext[];
  graphLinks: LinkEdge[];
  truncated: boolean;
};

export type SearchPreviewField = "path" | "content";

export type SearchPreview = {
  field: SearchPreviewField;
  charOffset: number;
  matchReason: string;
  excerpt: string | null;
};

export type SearchNodeHit = {
  path: string;
  kind: NodeKind;
  snippet: string | null;
  preview: SearchPreview | null;
  score: number;
  matchReasons: string[];
};

export type NodeKind = "file" | "source";
export type NodeEntryKind = "file" | "source" | "directory";

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

export type CanisterHealth = {
  cyclesBalance: bigint;
};

export type DatabaseRole = "reader" | "writer" | "owner";
export type DatabaseStatus = "hot" | "restoring" | "archiving" | "archived" | "deleted";

export type DatabaseSummary = {
  databaseId: string;
  displayName: string;
  role: DatabaseRole;
  status: DatabaseStatus;
  logicalSizeBytes: string;
  billingBalanceE8s: string;
  billingSuspendedAtMs: string | null;
  archivedAtMs: string | null;
  deletedAtMs: string | null;
};

export type DatabaseMember = {
  databaseId: string;
  principal: string;
  role: DatabaseRole;
  createdAtMs: string;
};

export type BillingTransferResult = {
  blockIndex: string;
  balanceE8s: string;
};

export type PrincipalBillingSummary = {
  principal: string;
  balanceE8s: string;
};

export type PrincipalBillingEntry = {
  entryId: string;
  principal: string;
  kind: string;
  amountE8s: string;
  balanceAfterE8s: string;
  databaseId: string | null;
  ledgerBlockIndex: string | null;
  createdAtMs: string;
};

export type PrincipalBillingEntryPage = {
  entries: PrincipalBillingEntry[];
  nextCursor: string | null;
};

export type DatabaseBillingEntry = {
  entryId: string;
  databaseId: string;
  kind: string;
  amountE8s: string;
  balanceAfterE8s: string;
  caller: string;
  method: string | null;
  cyclesDelta: string | null;
  rateNumeratorE8s: string | null;
  rateDenominatorCycles: string | null;
  fixedUpdateFeeE8s: string | null;
  usageEventId: string | null;
  createdAtMs: string;
};

export type DatabaseBillingEntryPage = {
  entries: DatabaseBillingEntry[];
  nextCursor: string | null;
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

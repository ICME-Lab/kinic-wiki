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

export type WriteSourceForGenerationRequest = {
  databaseId: string;
  path: string;
  content: string;
  metadataJson: string;
  expectedEtag: string | null;
  sessionNonce: string;
};

export type WriteSourceForGenerationResult = {
  write: WriteNodeResult;
  sessionNonce: string;
};

export type SourceRunSessionCheckRequest = {
  databaseId: string;
  sourcePath: string;
  sourceEtag: string;
  sessionNonce: string;
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
export type DatabaseStatus = "pending" | "active" | "restoring" | "archiving" | "archived" | "deleted";

export type DatabaseSummary = {
  databaseId: string;
  name: string;
  role: DatabaseRole;
  status: DatabaseStatus;
  logicalSizeBytes: string;
  cyclesBalance: string;
  cyclesSuspendedAtMs: string | null;
  archivedAtMs: string | null;
  deletedAtMs: string | null;
};

export type DeleteDatabaseRequest = {
  databaseId: string;
};

export type CyclesBillingConfig = {
  kinicLedgerCanisterId: string;
  billingAuthorityId: string;
  cyclesPerKinic: string;
  minUpdateCycles: string;
};

export type CyclesPurchaseResult = {
  blockIndex: string;
  amountCycles: string;
  balanceCycles: string;
};

export type DatabaseCycleEntry = {
  entryId: string;
  databaseId: string;
  kind: string;
  amountCycles: string;
  balanceAfterCycles: string;
  caller: string;
  method: string | null;
  ledgerBlockIndex: string | null;
  paymentAmountE8s: string | null;
  cyclesPerKinic: string | null;
  cyclesDelta: string | null;
  createdAtMs: string;
};

export type DatabaseCycleEntryPage = {
  entries: DatabaseCycleEntry[];
  nextCursor: string | null;
};

export type DatabaseCyclesPendingPurchase = {
  operationId: string;
  databaseId: string;
  status: string;
  amountCycles: string;
  paymentAmountE8s: string;
  ledgerBlockIndex: string | null;
  createdAtMs: string;
  requiredAction: string;
};

export type MarketListingStatus = "Active" | "Paused";

export type MarketListing = {
  listingId: string;
  sellerPrincipal: string;
  payoutPrincipal: string;
  databaseId: string;
  title: string;
  description: string;
  llmSummary: string | null;
  tagsJson: string;
  priceE8s: string;
  status: MarketListingStatus;
  revision: string;
  purchaseCount: string;
  reportCount: string;
  createdAtMs: string;
  updatedAtMs: string;
};

export type MarketListingVerifiedStats = {
  totalNodes: string;
  wikiNodes: string;
  sourceNodes: string;
  folderNodes: string;
  markdownChars: string;
  sourceChars: string;
  linkEdges: string;
  logicalSizeBytes: string;
  lastContentUpdatedAtMs: string | null;
};

export type MarketPreviewExcerpt = {
  path: string;
  etag: string;
  excerpt: string;
  contentChars: string;
};

export type MarketCategoryGraphNode = {
  category: string;
  nodeCount: string;
};

export type MarketCategoryGraphEdge = {
  sourceCategory: string;
  targetCategory: string;
  linkCount: string;
};

export type MarketCategoryGraph = {
  nodes: MarketCategoryGraphNode[];
  edges: MarketCategoryGraphEdge[];
};

export type MarketListingPreview = {
  topLevelPaths: string[];
  excerpts: MarketPreviewExcerpt[];
  categoryGraph: MarketCategoryGraph;
  graphLinks: LinkEdge[];
  previewStale: boolean;
};

export type MarketListingDetail = {
  listing: MarketListing;
  verifiedStats: MarketListingVerifiedStats;
  preview: MarketListingPreview;
};

export type MarketListingPage = {
  listings: MarketListing[];
  nextCursor: string | null;
};

export type MarketCreateListingRequest = {
  databaseId: string;
  payoutPrincipal: string;
  title: string;
  description: string;
  llmSummary: string | null;
  tagsJson: string;
  priceE8s: string;
};

export type MarketUpdateListingRequest = Omit<MarketCreateListingRequest, "databaseId"> & {
  listingId: string;
  expectedRevision: string;
};

export type MarketPurchasePreview = {
  listingId: string;
  databaseId: string;
  priceE8s: string;
  alreadyEntitled: boolean;
};

export type MarketOrder = {
  orderId: string;
  listingId: string;
  databaseId: string;
  buyerPrincipal: string;
  sellerPrincipal: string;
  payoutPrincipal: string;
  priceE8s: string;
  ledgerBlockIndex: string;
  createdAtMs: string;
};

export type MarketOrderPage = {
  orders: MarketOrder[];
  nextCursor: string | null;
};

export type MarketEntitlement = {
  databaseId: string;
  buyerPrincipal: string;
  listingId: string;
  orderId: string;
  purchasedAtMs: string;
  status: string;
};

export type MarketEntitlementPage = {
  entitlements: MarketEntitlement[];
  nextCursor: string | null;
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

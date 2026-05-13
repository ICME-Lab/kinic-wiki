import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { classifyApiError, invalidCanisterIdError } from "@/lib/api-errors";
import { sortChildNodes } from "@/lib/child-sort";
import { normalizeSearchHit, type RawSearchHit } from "@/lib/search-normalizer";
import { idlFactory } from "@/lib/vfs-idl";
import type {
  CanisterHealth,
  ChildNode,
  BillingTransferResult,
  DatabaseBillingEntry,
  DatabaseBillingEntryPage,
  DatabaseMember,
  DatabaseRole,
  DatabaseStatus,
  DatabaseSummary,
  LinkEdge,
  NodeContext,
  NodeEntryKind,
  NodeKind,
  PrincipalBillingEntry,
  PrincipalBillingEntryPage,
  PrincipalBillingSummary,
  RecentNode,
  SearchNodeHit,
  WikiNode,
  WriteNodeRequest,
  WriteNodeResult
} from "@/lib/types";
import { ApiError } from "@/lib/wiki-helpers";

type Variant = Record<string, null>;

type RawNode = {
  path: string;
  kind: Variant;
  content: string;
  created_at: bigint;
  updated_at: bigint;
  etag: string;
  metadata_json: string;
};

type RawCanisterHealth = {
  cycles_balance: bigint;
};

type RawDatabaseSummary = {
  status: Variant;
  role: Variant;
  logical_size_bytes: bigint;
  database_id: string;
  display_name: string;
  billing_balance_e8s: bigint;
  billing_suspended_at_ms: [] | [bigint];
  archived_at_ms: [] | [bigint];
  deleted_at_ms: [] | [bigint];
};

type RawDatabaseMember = {
  database_id: string;
  principal: string;
  role: Variant;
  created_at_ms: bigint;
};

type RawBillingTransferResult = {
  block_index: bigint;
  balance_e8s: bigint;
};

type RawPrincipalBillingSummary = {
  principal: string;
  balance_e8s: bigint;
};

type RawPrincipalBillingEntry = {
  entry_id: bigint;
  principal: string;
  kind: string;
  amount_e8s: bigint;
  balance_after_e8s: bigint;
  database_id: [] | [string];
  ledger_block_index: [] | [bigint];
  created_at_ms: bigint;
};

type RawPrincipalBillingEntryPage = {
  entries: RawPrincipalBillingEntry[];
  next_cursor: [] | [bigint];
};

type RawDatabaseBillingEntry = {
  entry_id: bigint;
  database_id: string;
  kind: string;
  amount_e8s: bigint;
  balance_after_e8s: bigint;
  caller: string;
  method: [] | [string];
  cycles_delta: [] | [bigint];
  rate_numerator_e8s: [] | [bigint];
  rate_denominator_cycles: [] | [bigint];
  fixed_update_fee_e8s: [] | [bigint];
  usage_event_id: [] | [bigint];
  created_at_ms: bigint;
};

type RawDatabaseBillingEntryPage = {
  entries: RawDatabaseBillingEntry[];
  next_cursor: [] | [bigint];
};

type RawChild = {
  path: string;
  name: string;
  kind: Variant;
  updated_at: [] | [bigint];
  etag: [] | [string];
  size_bytes: [] | [bigint];
  is_virtual: boolean;
  has_children: boolean;
};

type RawRecent = {
  path: string;
  kind: Variant;
  updated_at: bigint;
  etag: string;
};

type RawWriteNodeRequest = {
  database_id: string;
  path: string;
  kind: Variant;
  content: string;
  metadata_json: string;
  expected_etag: [] | [string];
};

type RawWriteNodeResult = {
  created: boolean;
  node: RawRecent;
};

type RawLinkEdge = {
  source_path: string;
  target_path: string;
  raw_href: string;
  link_text: string;
  link_kind: string;
  updated_at: bigint;
};

type RawNodeContext = {
  node: RawNode;
  incoming_links: RawLinkEdge[];
  outgoing_links: RawLinkEdge[];
};

type VfsActor = {
  canister_health: () => Promise<RawCanisterHealth>;
  create_database: (displayName: string, initialDepositE8s: bigint) => Promise<{ Ok: string } | { Err: string }>;
  rename_database: (databaseId: string, displayName: string) => Promise<{ Ok: null } | { Err: string }>;
  top_up_principal_balance: (amountE8s: bigint) => Promise<{ Ok: RawBillingTransferResult } | { Err: string }>;
  withdraw_principal_balance: (amountE8s: bigint, to: { owner: Principal; subaccount: [] }) => Promise<{ Ok: RawBillingTransferResult } | { Err: string }>;
  principal_billing_summary: () => Promise<{ Ok: RawPrincipalBillingSummary } | { Err: string }>;
  list_principal_billing_entries: (cursor: [] | [bigint], limit: number) => Promise<{ Ok: RawPrincipalBillingEntryPage } | { Err: string }>;
  top_up_database: (databaseId: string, amountE8s: bigint) => Promise<{ Ok: null } | { Err: string }>;
  withdraw_database_balance: (databaseId: string, amountE8s: bigint) => Promise<{ Ok: null } | { Err: string }>;
  list_database_billing_entries: (databaseId: string, cursor: [] | [bigint], limit: number) => Promise<{ Ok: RawDatabaseBillingEntryPage } | { Err: string }>;
  grant_database_access: (databaseId: string, principal: string, role: Variant) => Promise<{ Ok: null } | { Err: string }>;
  list_databases: () => Promise<{ Ok: RawDatabaseSummary[] } | { Err: string }>;
  list_database_members: (databaseId: string) => Promise<{ Ok: RawDatabaseMember[] } | { Err: string }>;
  revoke_database_access: (databaseId: string, principal: string) => Promise<{ Ok: null } | { Err: string }>;
  read_node: (databaseId: string, path: string) => Promise<{ Ok: [] | [RawNode] } | { Err: string }>;
  list_children: (request: { database_id: string; path: string }) => Promise<{ Ok: RawChild[] } | { Err: string }>;
  recent_nodes: (request: { database_id: string; path: [] | [string]; limit: number }) => Promise<
    { Ok: RawRecent[] } | { Err: string }
  >;
  incoming_links: (request: { database_id: string; path: string; limit: number }) => Promise<{ Ok: RawLinkEdge[] } | { Err: string }>;
  outgoing_links: (request: { database_id: string; path: string; limit: number }) => Promise<{ Ok: RawLinkEdge[] } | { Err: string }>;
  graph_links: (request: { database_id: string; prefix: string; limit: number }) => Promise<{ Ok: RawLinkEdge[] } | { Err: string }>;
  graph_neighborhood: (request: { database_id: string; center_path: string; depth: number; limit: number }) => Promise<{ Ok: RawLinkEdge[] } | { Err: string }>;
  read_node_context: (request: { database_id: string; path: string; link_limit: number }) => Promise<{ Ok: [] | [RawNodeContext] } | { Err: string }>;
  search_node_paths: (request: {
    database_id: string;
    query_text: string;
    prefix: [] | [string];
    top_k: number;
    preview_mode: [] | [Variant];
  }) => Promise<{ Ok: RawSearchHit[] } | { Err: string }>;
  search_nodes: (request: {
    database_id: string;
    query_text: string;
    prefix: [] | [string];
    top_k: number;
    preview_mode: [] | [Variant];
  }) => Promise<{ Ok: RawSearchHit[] } | { Err: string }>;
  write_node: (request: RawWriteNodeRequest) => Promise<{ Ok: RawWriteNodeResult } | { Err: string }>;
};

export function validateCanisterId(canisterId: string): Principal | string {
  try {
    return Principal.fromText(canisterId);
  } catch (error) {
    return error instanceof Error ? error.message : "invalid canister id";
  }
}

const actorCache = new Map<string, Promise<VfsActor>>();
const healthCache = new Map<string, Promise<CanisterHealth>>();
export async function createVfsActor(canisterId: string): Promise<VfsActor> {
  const principal = validateCanisterId(canisterId);
  if (typeof principal === "string") {
    const error = invalidCanisterIdError(principal);
    throw new ApiError(error.error, 400, error.hint, error.code);
  }
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const cacheKey = `${host}\n${canisterId}`;
  const cached = actorCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const actorPromise = createActor(principal, host);
  actorCache.set(cacheKey, actorPromise);
  return actorPromise;
}

async function createActor(principal: Principal, host: string): Promise<VfsActor> {
  const agent = HttpAgent.createSync({ host });
  if (isLocalHost(host)) {
    await agent.fetchRootKey();
  }
  return Actor.createActor<VfsActor>((idl) => idlFactory(idl), {
    agent,
    canisterId: principal
  });
}

async function createAuthenticatedActor(canisterId: string, identity: Identity): Promise<VfsActor> {
  const principal = validateCanisterId(canisterId);
  if (typeof principal === "string") {
    const error = invalidCanisterIdError(principal);
    throw new ApiError(error.error, 400, error.hint, error.code);
  }
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ host, identity });
  if (isLocalHost(host)) {
    await agent.fetchRootKey();
  }
  return Actor.createActor<VfsActor>((idl) => idlFactory(idl), {
    agent,
    canisterId: principal
  });
}

async function createReadActor(canisterId: string, identity?: Identity): Promise<VfsActor> {
  return identity ? createAuthenticatedActor(canisterId, identity) : createVfsActor(canisterId);
}

async function callVfs<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
    const publicError = classifyApiError(error, host);
    throw new ApiError(publicError.error, 502, publicError.hint, publicError.code);
  }
}

function throwCanisterError(message: string): never {
  throw new ApiError(message, 400);
}

export async function readNode(canisterId: string, databaseId: string, path: string, identity?: Identity): Promise<WikiNode | null> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.read_node(databaseId, path);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    const raw = result.Ok[0];
    return raw ? normalizeNode(raw) : null;
  });
}

export function canisterHealth(canisterId: string): Promise<CanisterHealth> {
  const cached = healthCache.get(canisterId);
  if (cached) {
    return cached;
  }
  const request = callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    return normalizeCanisterHealth(await actor.canister_health());
  }).catch((error) => {
    healthCache.delete(canisterId);
    throw error;
  });
  healthCache.set(canisterId, request);
  return request;
}

export async function listDatabasesAuthenticated(canisterId: string, identity: Identity): Promise<DatabaseSummary[]> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.list_databases();
    if ("Err" in result) {
      throw new Error(result.Err);
    }
    return result.Ok.map(normalizeDatabaseSummary);
  });
}

export async function listDatabasesPublic(canisterId: string): Promise<DatabaseSummary[]> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.list_databases();
    if ("Err" in result) {
      throw new Error(result.Err);
    }
    return result.Ok.map(normalizeDatabaseSummary);
  });
}

export async function createDatabaseAuthenticated(canisterId: string, identity: Identity, displayName: string, initialDepositE8s: bigint): Promise<string> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.create_database(displayName, initialDepositE8s);
    if ("Err" in result) {
      throw new Error(result.Err);
    }
    return result.Ok;
  });
}

export async function renameDatabaseAuthenticated(canisterId: string, identity: Identity, databaseId: string, displayName: string): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.rename_database(databaseId, displayName);
    if ("Err" in result) {
      throw new Error(result.Err);
    }
  });
}

export async function topUpPrincipalBalanceAuthenticated(canisterId: string, identity: Identity, amountE8s: bigint): Promise<BillingTransferResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.top_up_principal_balance(amountE8s);
    if ("Err" in result) {
      throw new Error(result.Err);
    }
    return normalizeBillingTransferResult(result.Ok);
  });
}

export async function withdrawPrincipalBalanceAuthenticated(canisterId: string, identity: Identity, amountE8s: bigint, toPrincipal: string): Promise<BillingTransferResult> {
  return callVfs(async () => {
    const owner = Principal.fromText(toPrincipal);
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.withdraw_principal_balance(amountE8s, { owner, subaccount: [] });
    if ("Err" in result) {
      throw new Error(result.Err);
    }
    return normalizeBillingTransferResult(result.Ok);
  });
}

export async function principalBillingSummaryAuthenticated(canisterId: string, identity: Identity): Promise<PrincipalBillingSummary> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.principal_billing_summary();
    if ("Err" in result) {
      throw new Error(result.Err);
    }
    return normalizePrincipalBillingSummary(result.Ok);
  });
}

export async function listPrincipalBillingEntriesAuthenticated(canisterId: string, identity: Identity, cursor: string | null, limit: number): Promise<PrincipalBillingEntryPage> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.list_principal_billing_entries(cursor ? [BigInt(cursor)] : [], limit);
    if ("Err" in result) {
      throw new Error(result.Err);
    }
    return normalizePrincipalBillingEntryPage(result.Ok);
  });
}

export async function topUpDatabaseAuthenticated(canisterId: string, identity: Identity, databaseId: string, amountE8s: bigint): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.top_up_database(databaseId, amountE8s);
    if ("Err" in result) {
      throw new Error(result.Err);
    }
  });
}

export async function withdrawDatabaseBalanceAuthenticated(canisterId: string, identity: Identity, databaseId: string, amountE8s: bigint): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.withdraw_database_balance(databaseId, amountE8s);
    if ("Err" in result) {
      throw new Error(result.Err);
    }
  });
}

export async function listDatabaseBillingEntriesAuthenticated(canisterId: string, identity: Identity, databaseId: string, cursor: string | null, limit: number): Promise<DatabaseBillingEntryPage> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.list_database_billing_entries(databaseId, cursor ? [BigInt(cursor)] : [], limit);
    if ("Err" in result) {
      throw new Error(result.Err);
    }
    return normalizeDatabaseBillingEntryPage(result.Ok);
  });
}

export async function writeNodeAuthenticated(canisterId: string, identity: Identity, request: WriteNodeRequest): Promise<WriteNodeResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.write_node({
      database_id: request.databaseId,
      path: request.path,
      kind: nodeKindVariant(request.kind),
      content: request.content,
      metadata_json: request.metadataJson,
      expected_etag: request.expectedEtag ? [request.expectedEtag] : []
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return {
      created: result.Ok.created,
      node: normalizeRecentNode(result.Ok.node)
    };
  });
}

export async function listDatabaseMembersAuthenticated(canisterId: string, identity: Identity, databaseId: string): Promise<DatabaseMember[]> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.list_database_members(databaseId);
    if ("Err" in result) {
      throw new Error(result.Err);
    }
    return result.Ok.map(normalizeDatabaseMember);
  });
}

export async function grantDatabaseAccessAuthenticated(
  canisterId: string,
  identity: Identity,
  databaseId: string,
  principal: string,
  role: DatabaseRole
): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.grant_database_access(databaseId, principal, databaseRoleVariant(role));
    if ("Err" in result) {
      throw new Error(result.Err);
    }
  });
}

export async function revokeDatabaseAccessAuthenticated(
  canisterId: string,
  identity: Identity,
  databaseId: string,
  principal: string
): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.revoke_database_access(databaseId, principal);
    if ("Err" in result) {
      throw new Error(result.Err);
    }
  });
}

export async function readNodeContext(canisterId: string, databaseId: string, path: string, linkLimit: number, identity?: Identity): Promise<NodeContext | null> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.read_node_context({ database_id: databaseId, path, link_limit: linkLimit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    const raw = result.Ok[0];
    return raw ? normalizeNodeContext(raw) : null;
  });
}

export async function listChildren(canisterId: string, databaseId: string, path: string, identity?: Identity): Promise<ChildNode[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.list_children({ database_id: databaseId, path });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return sortChildNodes(result.Ok.map(normalizeChild));
  });
}

export async function recentNodes(canisterId: string, databaseId: string, limit: number, identity?: Identity, path: string | null = null): Promise<RecentNode[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.recent_nodes({ database_id: databaseId, path: path ? [path] : [], limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map((node) => ({
      ...normalizeRecentNode(node)
    }));
  });
}

export async function incomingLinks(canisterId: string, databaseId: string, path: string, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.incoming_links({ database_id: databaseId, path, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function outgoingLinks(canisterId: string, databaseId: string, path: string, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.outgoing_links({ database_id: databaseId, path, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function graphLinks(canisterId: string, databaseId: string, prefix: string, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.graph_links({ database_id: databaseId, prefix, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function graphNeighborhood(canisterId: string, databaseId: string, centerPath: string, depth: number, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.graph_neighborhood({ database_id: databaseId, center_path: centerPath, depth, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function searchNodePaths(
  canisterId: string,
  databaseId: string,
  queryText: string,
  limit: number,
  prefix: string | null,
  identity?: Identity
): Promise<SearchNodeHit[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.search_node_paths({
      database_id: databaseId,
      query_text: queryText,
      prefix: prefix ? [prefix] : [],
      top_k: limit,
      preview_mode: [{ ContentStart: null }]
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeSearchHit);
  });
}

export async function searchNodes(
  canisterId: string,
  databaseId: string,
  queryText: string,
  limit: number,
  prefix: string | null,
  identity?: Identity
): Promise<SearchNodeHit[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.search_nodes({
      database_id: databaseId,
      query_text: queryText,
      prefix: prefix ? [prefix] : [],
      top_k: limit,
      preview_mode: [{ ContentStart: null }]
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeSearchHit);
  });
}

function normalizeNode(raw: RawNode): WikiNode {
  return {
    path: raw.path,
    kind: normalizeNodeKind(raw.kind),
    content: raw.content,
    createdAt: raw.created_at.toString(),
    updatedAt: raw.updated_at.toString(),
    etag: raw.etag,
    metadataJson: raw.metadata_json
  };
}

function normalizeCanisterHealth(raw: RawCanisterHealth): CanisterHealth {
  return {
    cyclesBalance: raw.cycles_balance
  };
}

function normalizeDatabaseSummary(raw: RawDatabaseSummary): DatabaseSummary {
  return {
    databaseId: raw.database_id,
    displayName: raw.display_name,
    role: normalizeDatabaseRole(raw.role),
    status: normalizeDatabaseStatus(raw.status),
    logicalSizeBytes: raw.logical_size_bytes.toString(),
    billingBalanceE8s: raw.billing_balance_e8s.toString(),
    billingSuspendedAtMs: raw.billing_suspended_at_ms[0]?.toString() ?? null,
    archivedAtMs: raw.archived_at_ms[0]?.toString() ?? null,
    deletedAtMs: raw.deleted_at_ms[0]?.toString() ?? null
  };
}

function normalizeDatabaseMember(raw: RawDatabaseMember): DatabaseMember {
  return {
    databaseId: raw.database_id,
    principal: raw.principal,
    role: normalizeDatabaseRole(raw.role),
    createdAtMs: raw.created_at_ms.toString()
  };
}

function normalizeBillingTransferResult(raw: RawBillingTransferResult): BillingTransferResult {
  return {
    blockIndex: raw.block_index.toString(),
    balanceE8s: raw.balance_e8s.toString()
  };
}

function normalizePrincipalBillingSummary(raw: RawPrincipalBillingSummary): PrincipalBillingSummary {
  return {
    principal: raw.principal,
    balanceE8s: raw.balance_e8s.toString()
  };
}

function normalizePrincipalBillingEntry(raw: RawPrincipalBillingEntry): PrincipalBillingEntry {
  return {
    entryId: raw.entry_id.toString(),
    principal: raw.principal,
    kind: raw.kind,
    amountE8s: raw.amount_e8s.toString(),
    balanceAfterE8s: raw.balance_after_e8s.toString(),
    databaseId: raw.database_id[0] ?? null,
    ledgerBlockIndex: raw.ledger_block_index[0]?.toString() ?? null,
    createdAtMs: raw.created_at_ms.toString()
  };
}

function normalizePrincipalBillingEntryPage(raw: RawPrincipalBillingEntryPage): PrincipalBillingEntryPage {
  return {
    entries: raw.entries.map(normalizePrincipalBillingEntry),
    nextCursor: raw.next_cursor[0]?.toString() ?? null
  };
}

function normalizeDatabaseBillingEntry(raw: RawDatabaseBillingEntry): DatabaseBillingEntry {
  return {
    entryId: raw.entry_id.toString(),
    databaseId: raw.database_id,
    kind: raw.kind,
    amountE8s: raw.amount_e8s.toString(),
    balanceAfterE8s: raw.balance_after_e8s.toString(),
    caller: raw.caller,
    method: raw.method[0] ?? null,
    cyclesDelta: raw.cycles_delta[0]?.toString() ?? null,
    rateNumeratorE8s: raw.rate_numerator_e8s[0]?.toString() ?? null,
    rateDenominatorCycles: raw.rate_denominator_cycles[0]?.toString() ?? null,
    fixedUpdateFeeE8s: raw.fixed_update_fee_e8s[0]?.toString() ?? null,
    usageEventId: raw.usage_event_id[0]?.toString() ?? null,
    createdAtMs: raw.created_at_ms.toString()
  };
}

function normalizeDatabaseBillingEntryPage(raw: RawDatabaseBillingEntryPage): DatabaseBillingEntryPage {
  return {
    entries: raw.entries.map(normalizeDatabaseBillingEntry),
    nextCursor: raw.next_cursor[0]?.toString() ?? null
  };
}

function normalizeRecentNode(raw: RawRecent): RecentNode {
  return {
    path: raw.path,
    kind: normalizeNodeKind(raw.kind),
    updatedAt: raw.updated_at.toString(),
    etag: raw.etag
  };
}

function normalizeChild(raw: RawChild): ChildNode {
  return {
    path: raw.path,
    name: raw.name,
    kind: normalizeEntryKind(raw.kind),
    updatedAt: raw.updated_at[0]?.toString() ?? null,
    etag: raw.etag[0] ?? null,
    sizeBytes: raw.size_bytes[0]?.toString() ?? null,
    isVirtual: raw.is_virtual,
    hasChildren: raw.has_children
  };
}

function normalizeLinkEdge(raw: RawLinkEdge): LinkEdge {
  return {
    sourcePath: raw.source_path,
    targetPath: raw.target_path,
    rawHref: raw.raw_href,
    linkText: raw.link_text,
    linkKind: raw.link_kind,
    updatedAt: raw.updated_at.toString()
  };
}

function normalizeNodeContext(raw: RawNodeContext): NodeContext {
  return {
    node: normalizeNode(raw.node),
    incomingLinks: raw.incoming_links.map(normalizeLinkEdge),
    outgoingLinks: raw.outgoing_links.map(normalizeLinkEdge)
  };
}

function normalizeNodeKind(kind: Variant): NodeKind {
  return "Source" in kind ? "source" : "file";
}

function normalizeEntryKind(kind: Variant): NodeEntryKind {
  if ("Directory" in kind) {
    return "directory";
  }
  return "Source" in kind ? "source" : "file";
}

function normalizeDatabaseRole(role: Variant): DatabaseRole {
  if ("Owner" in role) {
    return "owner";
  }
  if ("Writer" in role) {
    return "writer";
  }
  return "reader";
}

function databaseRoleVariant(role: DatabaseRole): Variant {
  if (role === "owner") {
    return { Owner: null };
  }
  if (role === "writer") {
    return { Writer: null };
  }
  return { Reader: null };
}

function nodeKindVariant(kind: NodeKind): Variant {
  if (kind === "source") return { Source: null };
  return { File: null };
}

function normalizeDatabaseStatus(status: Variant): DatabaseStatus {
  if ("Restoring" in status) {
    return "restoring";
  }
  if ("Archiving" in status) {
    return "archiving";
  }
  if ("Archived" in status) {
    return "archived";
  }
  if ("Deleted" in status) {
    return "deleted";
  }
  return "hot";
}

function isLocalHost(host: string): boolean {
  return host.includes("127.0.0.1") || host.includes("localhost");
}

// Where: extensions/wiki-clipper/src/vfs-actor.js
// What: Minimal write-capable VFS actor for raw source persistence.
// Why: The wiki browser client is read-only; capture needs source writes plus trigger session APIs.
export async function createVfsActor({ canisterId, host, identity }) {
  const [{ Actor, HttpAgent }, { Principal }] = await Promise.all([
    import("@icp-sdk/core/agent"),
    import("@icp-sdk/core/principal")
  ]);
  const principal = Principal.fromText(canisterId);
  const agent = await HttpAgent.create({ host, identity });
  if (isLocalHost(host)) {
    await agent.fetchRootKey();
  }
  return Actor.createActor(idlFactory, { agent, canisterId: principal });
}

function idlFactory({ IDL: idl }) {
  const DatabaseRole = idl.Variant({ Reader: idl.Null, Writer: idl.Null, Owner: idl.Null });
  const DatabaseStatus = idl.Variant({
    Hot: idl.Null,
    Restoring: idl.Null,
    Archiving: idl.Null,
    Archived: idl.Null,
    Deleted: idl.Null
  });
  const DatabaseSummary = idl.Record({
    status: DatabaseStatus,
    name: idl.Text,
    role: DatabaseRole,
    logical_size_bytes: idl.Nat64,
    database_id: idl.Text,
    billing_balance_e8s: idl.Opt(idl.Nat64),
    billing_suspended_at_ms: idl.Opt(idl.Int64),
    archived_at_ms: idl.Opt(idl.Int64),
    deleted_at_ms: idl.Opt(idl.Int64)
  });
  const BillingConfig = idl.Record({
    kinic_ledger_canister_id: idl.Text,
    sns_governance_id: idl.Text,
    rate_numerator_e8s: idl.Nat64,
    rate_denominator_cycles: idl.Nat64,
    fixed_update_fee_e8s: idl.Nat64,
    min_update_balance_e8s: idl.Nat64
  });
  const CreateDatabaseRequest = idl.Record({ name: idl.Text });
  const CreateDatabaseResult = idl.Record({ database_id: idl.Text, name: idl.Text });
  const NodeKind = idl.Variant({ File: idl.Null, Source: idl.Null, Folder: idl.Null });
  const Node = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    content: idl.Text,
    created_at: idl.Int64,
    updated_at: idl.Int64,
    etag: idl.Text,
    metadata_json: idl.Text
  });
  const WriteNodeRequest = idl.Record({
    database_id: idl.Text,
    path: idl.Text,
    kind: NodeKind,
    content: idl.Text,
    metadata_json: idl.Text,
    expected_etag: idl.Opt(idl.Text)
  });
  const WriteSourceForGenerationRequest = idl.Record({
    database_id: idl.Text,
    path: idl.Text,
    content: idl.Text,
    metadata_json: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    session_nonce: idl.Text
  });
  const MkdirNodeRequest = idl.Record({ database_id: idl.Text, path: idl.Text });
  const MkdirNodeResult = idl.Record({ path: idl.Text, created: idl.Bool });
  const UrlIngestTriggerSessionRequest = idl.Record({
    database_id: idl.Text,
    session_nonce: idl.Text
  });
  const RecentNodeHit = idl.Record({
    updated_at: idl.Int64,
    etag: idl.Text,
    kind: NodeKind,
    path: idl.Text
  });
  const WriteNodeResult = idl.Record({ created: idl.Bool, node: RecentNodeHit });
  const WriteSourceForGenerationResult = idl.Record({
    write: WriteNodeResult,
    session_nonce: idl.Text
  });
  return idl.Service({
    authorize_url_ingest_trigger_session: idl.Func([UrlIngestTriggerSessionRequest], [idl.Variant({ Ok: idl.Null, Err: idl.Text })], []),
    get_billing_config: idl.Func([], [idl.Variant({ Ok: BillingConfig, Err: idl.Text })], ["query"]),
    create_database: idl.Func([CreateDatabaseRequest], [idl.Variant({ Ok: CreateDatabaseResult, Err: idl.Text })], []),
    list_databases: idl.Func([], [idl.Variant({ Ok: idl.Vec(DatabaseSummary), Err: idl.Text })], ["query"]),
    mkdir_node: idl.Func([MkdirNodeRequest], [idl.Variant({ Ok: MkdirNodeResult, Err: idl.Text })], []),
    read_node: idl.Func([idl.Text, idl.Text], [idl.Variant({ Ok: idl.Opt(Node), Err: idl.Text })], ["query"]),
    write_node: idl.Func([WriteNodeRequest], [idl.Variant({ Ok: WriteNodeResult, Err: idl.Text })], []),
    write_source_for_generation: idl.Func([WriteSourceForGenerationRequest], [idl.Variant({ Ok: WriteSourceForGenerationResult, Err: idl.Text })], [])
  });
}

export async function createDatabase(config, name) {
  const actor = await createVfsActor(config);
  return createDatabaseWithActor(actor, name);
}

export async function createDatabaseWithActor(actor, name) {
  const result = await actor.create_database({ name });
  if ("Err" in result) {
    throw new Error(result.Err);
  }
  return normalizeCreateDatabaseResult(result.Ok);
}

export async function listWritableDatabases(config) {
  const actor = await createVfsActor(config);
  const [databaseResult, billingConfig] = await Promise.all([
    actor.list_databases(),
    getBillingConfigOrNull(actor)
  ]);
  if ("Err" in databaseResult) {
    throw new Error(databaseResult.Err);
  }
  return normalizeWritableDatabases(databaseResult.Ok, billingConfig);
}

export async function requireDatabaseBillable(actor, databaseId) {
  const [databaseResult, billingConfigResult] = await Promise.all([
    actor.list_databases(),
    actor.get_billing_config()
  ]);
  if ("Err" in databaseResult) throw new Error(databaseResult.Err);
  if ("Err" in billingConfigResult) throw new Error(`Billing config unavailable: ${billingConfigResult.Err}`);
  const config = normalizeBillingConfig(billingConfigResult.Ok);
  const databases = databaseResult.Ok.map(normalizeDatabaseSummary);
  const database = databases.find((entry) => entry.databaseId === databaseId);
  if (!database) throw new Error(`Database billing state unavailable: ${databaseId}`);
  const reason = databaseBillingDisabledReason(database, config);
  if (reason) throw new Error(reason);
}

export function normalizeWritableDatabases(rawDatabases, billingConfig = null) {
  return rawDatabases.map(normalizeDatabaseSummary).filter((database) => {
    return database.status === "Hot" && (database.role === "Owner" || database.role === "Writer");
  }).map((database) => {
    const reason = databaseBillingDisabledReason(database, billingConfig);
    return {
      ...database,
      billable: !reason,
      billingReason: reason
    };
  });
}

export function normalizeCreateDatabaseResult(raw) {
  return {
    databaseId: raw.database_id,
    name: String(raw.name || "")
  };
}

function normalizeDatabaseSummary(raw) {
  return {
    databaseId: raw.database_id,
    name: String(raw.name || ""),
    role: variantKey(raw.role),
    status: variantKey(raw.status),
    logicalSizeBytes: raw.logical_size_bytes?.toString?.() ?? String(raw.logical_size_bytes ?? "0"),
    billingBalanceE8s: raw.billing_balance_e8s?.[0]?.toString?.() ?? "0",
    billingSuspendedAtMs: raw.billing_suspended_at_ms?.[0]?.toString?.() ?? null
  };
}

export async function getBillingConfigOrNull(actor) {
  const result = await actor.get_billing_config();
  if ("Err" in result) return null;
  return normalizeBillingConfig(result.Ok);
}

function normalizeBillingConfig(raw) {
  return {
    minUpdateBalanceE8s: raw.min_update_balance_e8s?.toString?.() ?? String(raw.min_update_balance_e8s ?? "0")
  };
}

function databaseBillingDisabledReason(database, config) {
  const balance = parseE8s(database.billingBalanceE8s);
  const minimum = parseE8s(config?.minUpdateBalanceE8s);
  if (!config) return "Billing config unavailable.";
  if (database.billingSuspendedAtMs) return "Database billing is suspended.";
  if (balance < minimum) return "Database balance is below the minimum update balance.";
  return null;
}

function parseE8s(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : 0n;
}

function variantKey(value) {
  return Object.keys(value || {})[0] || "";
}

export function isLocalHost(host) {
  try {
    const { hostname } = new URL(host);
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

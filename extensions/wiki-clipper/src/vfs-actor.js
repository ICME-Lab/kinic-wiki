// Where: extensions/wiki-clipper/src/vfs-actor.js
// What: Minimal write-capable VFS actor for evidence source persistence.
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
    Active: idl.Null,
    Deleted: idl.Null,
    Pending: idl.Null
  });
  const DatabaseSummary = idl.Record({
    status: DatabaseStatus,
    name: idl.Text,
    role: DatabaseRole,
    logical_size_bytes: idl.Nat64,
    database_id: idl.Text,
    cycles_balance: idl.Opt(idl.Nat64),
    cycles_suspended_at_ms: idl.Opt(idl.Int64),
    deleted_at_ms: idl.Opt(idl.Int64)
  });
  const CyclesTopUpConfig = idl.Record({
    enabled: idl.Bool,
    launcher_principal: idl.Text,
    threshold_cycles: idl.Nat
  });
  const CyclesBillingConfig = idl.Record({
    kinic_ledger_canister_id: idl.Text,
    billing_authority_id: idl.Text,
    cycles_per_kinic: idl.Nat64,
    min_update_cycles: idl.Nat64,
    top_up: CyclesTopUpConfig
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
  const NodeMutationAck = idl.Record({
    updated_at: idl.Int64,
    etag: idl.Text,
    kind: NodeKind,
    path: idl.Text
  });
  const WriteNodeResult = idl.Record({ created: idl.Bool, node: NodeMutationAck });
  const WriteSourceForGenerationResult = idl.Record({
    write: WriteNodeResult,
    session_nonce: idl.Text
  });
  return idl.Service({
    get_cycles_billing_config: idl.Func([], [idl.Variant({ Ok: CyclesBillingConfig, Err: idl.Text })], ["query"]),
    create_database: idl.Func([CreateDatabaseRequest], [idl.Variant({ Ok: CreateDatabaseResult, Err: idl.Text })], []),
    list_databases: idl.Func([], [idl.Variant({ Ok: idl.Vec(DatabaseSummary), Err: idl.Text })], ["query"]),
    mkdir_node: idl.Func([MkdirNodeRequest], [idl.Variant({ Ok: MkdirNodeResult, Err: idl.Text })], []),
    read_node: idl.Func([idl.Text, idl.Text], [idl.Variant({ Ok: idl.Opt(Node), Err: idl.Text })], ["query"]),
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
  const [databaseResult, cyclesConfig] = await Promise.all([
    actor.list_databases(),
    getCyclesBillingConfigOrNull(actor)
  ]);
  if ("Err" in databaseResult) {
    throw new Error(databaseResult.Err);
  }
  return normalizeWritableDatabases(databaseResult.Ok, cyclesConfig);
}

export async function requireDatabaseWriteCyclesAvailable(actor, databaseId) {
  const [databaseResult, cyclesConfigResult] = await Promise.all([
    actor.list_databases(),
    actor.get_cycles_billing_config()
  ]);
  if ("Err" in databaseResult) throw new Error(databaseResult.Err);
  if ("Err" in cyclesConfigResult) throw new Error(`Cycles config unavailable: ${cyclesConfigResult.Err}`);
  const config = normalizeCyclesBillingConfig(cyclesConfigResult.Ok);
  const databases = databaseResult.Ok.map(normalizeDatabaseSummary);
  const database = databases.find((entry) => entry.databaseId === databaseId);
  if (!database) throw new Error(`Database cycles state unavailable: ${databaseId}`);
  const reason = databaseCyclesDisabledReason(database, config);
  if (reason) throw new Error(reason);
}

export function normalizeWritableDatabases(rawDatabases, cyclesConfig = null) {
  return rawDatabases.map(normalizeDatabaseSummary).filter((database) => {
    return database.status === "Active" && (database.role === "Owner" || database.role === "Writer");
  }).map((database) => {
    const reason = databaseCyclesDisabledReason(database, cyclesConfig);
    return {
      ...database,
      writeCyclesAvailable: !reason,
      cyclesReason: reason
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
    status: normalizeDatabaseStatus(raw.status),
    logicalSizeBytes: raw.logical_size_bytes?.toString?.() ?? String(raw.logical_size_bytes ?? "0"),
    cyclesBalance: raw.cycles_balance?.[0]?.toString?.() ?? "0",
    cyclesSuspendedAtMs: raw.cycles_suspended_at_ms?.[0]?.toString?.() ?? null,
    deletedAtMs: raw.deleted_at_ms?.[0]?.toString?.() ?? null
  };
}

function normalizeDatabaseStatus(status) {
  return variantKey(status);
}

export async function getCyclesBillingConfigOrNull(actor) {
  const result = await actor.get_cycles_billing_config();
  if ("Err" in result) return null;
  return normalizeCyclesBillingConfig(result.Ok);
}

function normalizeCyclesBillingConfig(raw) {
  return {
    minUpdateCycles: raw.min_update_cycles?.toString?.() ?? String(raw.min_update_cycles ?? "0")
  };
}

function databaseCyclesDisabledReason(database, config) {
  const balance = parseCycles(database.cyclesBalance);
  const minimum = parseCycles(config?.minUpdateCycles);
  if (!config) return "Cycles config unavailable.";
  if (database.status === "Pending") return "Database activation is pending until its first cycle purchase completes.";
  if (database.status !== "Active") return "Database is not writable in its current lifecycle state.";
  if (database.cyclesSuspendedAtMs) return "Database cycles are suspended.";
  if (balance < minimum) return "Database cycles balance is below the minimum update balance.";
  return null;
}

function parseCycles(value) {
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

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
    Pending: idl.Null,
    Active: idl.Null,
    Restoring: idl.Null,
    Archiving: idl.Null,
    Archived: idl.Null
  });
  const DatabaseSummary = idl.Record({
    status: DatabaseStatus,
    name: idl.Text,
    role: DatabaseRole,
    logical_size_bytes: idl.Nat64,
    database_id: idl.Text,
    credits_balance: idl.Opt(idl.Nat64),
    credits_suspended_at_ms: idl.Opt(idl.Int64),
    archived_at_ms: idl.Opt(idl.Int64)
  });
  const CreditsConfig = idl.Record({
    kinic_ledger_canister_id: idl.Text,
    sns_governance_id: idl.Text,
    credits_per_kinic: idl.Nat64,
    cycles_per_credit: idl.Nat64,
    min_update_credits: idl.Nat64
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
    authorize_url_ingest_trigger_session: idl.Func([UrlIngestTriggerSessionRequest], [idl.Variant({ Ok: idl.Null, Err: idl.Text })], []),
    get_credits_config: idl.Func([], [idl.Variant({ Ok: CreditsConfig, Err: idl.Text })], ["query"]),
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
  const [databaseResult, creditsConfig] = await Promise.all([
    actor.list_databases(),
    getCreditsConfigOrNull(actor)
  ]);
  if ("Err" in databaseResult) {
    throw new Error(databaseResult.Err);
  }
  return normalizeWritableDatabases(databaseResult.Ok, creditsConfig);
}

export async function requireDatabaseWriteCreditsAvailable(actor, databaseId) {
  const [databaseResult, creditsConfigResult] = await Promise.all([
    actor.list_databases(),
    actor.get_credits_config()
  ]);
  if ("Err" in databaseResult) throw new Error(databaseResult.Err);
  if ("Err" in creditsConfigResult) throw new Error(`Credits config unavailable: ${creditsConfigResult.Err}`);
  const config = normalizeCreditsConfig(creditsConfigResult.Ok);
  const databases = databaseResult.Ok.map(normalizeDatabaseSummary);
  const database = databases.find((entry) => entry.databaseId === databaseId);
  if (!database) throw new Error(`Database credits state unavailable: ${databaseId}`);
  const reason = databaseCreditsDisabledReason(database, config);
  if (reason) throw new Error(reason);
}

export function normalizeWritableDatabases(rawDatabases, creditsConfig = null) {
  return rawDatabases.map(normalizeDatabaseSummary).filter((database) => {
    return database.status === "Active" && (database.role === "Owner" || database.role === "Writer");
  }).map((database) => {
    const reason = databaseCreditsDisabledReason(database, creditsConfig);
    return {
      ...database,
      writeCreditsAvailable: !reason,
      creditsReason: reason
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
    creditsBalance: raw.credits_balance?.[0]?.toString?.() ?? "0",
    creditsSuspendedAtMs: raw.credits_suspended_at_ms?.[0]?.toString?.() ?? null
  };
}

function normalizeDatabaseStatus(status) {
  const key = variantKey(status);
  return key === "Hot" ? "Active" : key;
}

export async function getCreditsConfigOrNull(actor) {
  const result = await actor.get_credits_config();
  if ("Err" in result) return null;
  return normalizeCreditsConfig(result.Ok);
}

function normalizeCreditsConfig(raw) {
  return {
    minUpdateCredits: raw.min_update_credits?.toString?.() ?? String(raw.min_update_credits ?? "0")
  };
}

function databaseCreditsDisabledReason(database, config) {
  const balance = parseCredits(database.creditsBalance);
  const minimum = parseCredits(config?.minUpdateCredits);
  if (!config) return "Credits config unavailable.";
  if (database.status === "Pending") return "Database activation is pending until its first credit purchase completes.";
  if (database.creditsSuspendedAtMs) return "Database credits are suspended.";
  if (balance < minimum) return "Database credits balance is below the minimum update balance.";
  return null;
}

function parseCredits(value) {
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

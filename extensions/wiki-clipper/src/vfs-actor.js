// Where: extensions/wiki-clipper/src/vfs-actor.js
// What: Minimal write-capable VFS actor for raw source persistence.
// Why: The wiki browser client is read-only; capture needs read_node plus write_node.
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
  const MkdirNodeRequest = idl.Record({ database_id: idl.Text, path: idl.Text });
  const MkdirNodeResult = idl.Record({ path: idl.Text, created: idl.Bool });
  const OpsAnswerSessionRequest = idl.Record({
    database_id: idl.Text,
    session_nonce: idl.Text
  });
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
  return idl.Service({
    authorize_url_ingest_trigger_session: idl.Func([UrlIngestTriggerSessionRequest], [idl.Variant({ Ok: idl.Null, Err: idl.Text })], []),
    list_databases: idl.Func([], [idl.Variant({ Ok: idl.Vec(DatabaseSummary), Err: idl.Text })], ["query"]),
    mkdir_node: idl.Func([MkdirNodeRequest], [idl.Variant({ Ok: MkdirNodeResult, Err: idl.Text })], []),
    read_node: idl.Func([idl.Text, idl.Text], [idl.Variant({ Ok: idl.Opt(Node), Err: idl.Text })], ["query"]),
    write_node: idl.Func([WriteNodeRequest], [idl.Variant({ Ok: WriteNodeResult, Err: idl.Text })], [])
  });
}

export async function listWritableDatabases(config) {
  const actor = await createVfsActor(config);
  const result = await actor.list_databases();
  if ("Err" in result) {
    throw new Error(result.Err);
  }
  return normalizeWritableDatabases(result.Ok);
}

export function normalizeWritableDatabases(rawDatabases) {
  return rawDatabases.map(normalizeDatabaseSummary).filter((database) => {
    return database.status === "Hot" && (database.role === "Owner" || database.role === "Writer");
  });
}

function normalizeDatabaseSummary(raw) {
  return {
    databaseId: raw.database_id,
    name: String(raw.name || ""),
    role: variantKey(raw.role),
    status: variantKey(raw.status),
    logicalSizeBytes: raw.logical_size_bytes?.toString?.() ?? String(raw.logical_size_bytes ?? "0")
  };
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

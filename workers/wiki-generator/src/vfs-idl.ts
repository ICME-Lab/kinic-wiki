// Where: workers/wiki-generator/src/vfs-idl.ts
// What: Minimal Candid IDL for the VFS calls used by the generator.
// Why: The generator Worker should not depend on the UI app package.
import { Actor } from "@icp-sdk/core/agent";

type ActorInterfaceFactory = Parameters<typeof Actor.createActor>[0];

export const idlFactory: ActorInterfaceFactory = ({ IDL: idl }) => {
  const DatabaseStatus = idl.Variant({ Active: idl.Null, Deleted: idl.Null, Pending: idl.Null });
  const DatabaseRole = idl.Variant({ Reader: idl.Null, Writer: idl.Null, Owner: idl.Null });
  const DatabaseMetadata = idl.Record({
    name: idl.Text,
    description: idl.Text,
    llm_summary: idl.Opt(idl.Text),
    tags_json: idl.Text
  });
  const DatabaseSummary = idl.Record({
    database_id: idl.Text,
    metadata: idl.Opt(DatabaseMetadata),
    name: idl.Text,
    role: DatabaseRole,
    status: DatabaseStatus,
    logical_size_bytes: idl.Nat64,
    cycles_balance: idl.Opt(idl.Nat64),
    cycles_suspended_at_ms: idl.Opt(idl.Int64),
    deleted_at_ms: idl.Opt(idl.Int64)
  });
  const NodeKind = idl.Variant({ File: idl.Null, Source: idl.Null, Folder: idl.Null });
  const Node = idl.Record({
    updated_at: idl.Int64,
    content: idl.Text,
    etag: idl.Text,
    kind: NodeKind,
    path: idl.Text,
    created_at: idl.Int64,
    metadata_json: idl.Text
  });
  const NodeMutationAck = idl.Record({
    updated_at: idl.Int64,
    etag: idl.Text,
    kind: NodeKind,
    path: idl.Text
  });
  const NodeMutationErrorCode = idl.Variant({
    EtagConflict: idl.Null,
    NotFound: idl.Null,
    Forbidden: idl.Null,
    WriteUnavailable: idl.Null,
    InvalidOperation: idl.Null
  });
  const NodeMutationError = idl.Record({
    code: NodeMutationErrorCode,
    message: idl.Text,
    failed_index: idl.Opt(idl.Nat32),
    conflict_path: idl.Opt(idl.Text)
  });
  const SearchPreviewField = idl.Variant({ Path: idl.Null, Content: idl.Null });
  const SearchPreviewMode = idl.Variant({ Light: idl.Null, ContentStart: idl.Null, None: idl.Null });
  const SearchPreview = idl.Record({
    field: SearchPreviewField,
    char_offset: idl.Nat32,
    match_reason: idl.Text,
    excerpt: idl.Opt(idl.Text)
  });
  const SearchNodeHit = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    snippet: idl.Opt(idl.Text),
    preview: idl.Opt(SearchPreview),
    score: idl.Float32,
    match_reasons: idl.Vec(idl.Text)
  });
  const WriteNodeRequest = idl.Record({
    content: idl.Text,
    kind: NodeKind,
    path: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    metadata_json: idl.Text,
    database_id: idl.Text
  });
  const MkdirNodeRequest = idl.Record({ path: idl.Text, database_id: idl.Text });
  const SearchNodesRequest = idl.Record({
    database_id: idl.Text,
    query_text: idl.Text,
    prefix: idl.Opt(idl.Text),
    top_k: idl.Nat32,
    preview_mode: idl.Opt(SearchPreviewMode)
  });
  const ExportSnapshotRequest = idl.Record({
    snapshot_revision: idl.Opt(idl.Text),
    cursor: idl.Opt(idl.Text),
    limit: idl.Nat32,
    database_id: idl.Text,
    prefix: idl.Opt(idl.Text),
    snapshot_session_id: idl.Opt(idl.Text)
  });
  const ExportSnapshotResponse = idl.Record({
    snapshot_revision: idl.Text,
    nodes: idl.Vec(Node),
    next_cursor: idl.Opt(idl.Text),
    snapshot_session_id: idl.Opt(idl.Text)
  });
  const FetchUpdatesRequest = idl.Record({
    known_snapshot_revision: idl.Text,
    cursor: idl.Opt(idl.Text),
    limit: idl.Nat32,
    database_id: idl.Text,
    prefix: idl.Opt(idl.Text),
    target_snapshot_revision: idl.Opt(idl.Text)
  });
  const FetchUpdatesResponse = idl.Record({
    removed_paths: idl.Vec(idl.Text),
    snapshot_revision: idl.Text,
    changed_nodes: idl.Vec(Node),
    next_cursor: idl.Opt(idl.Text)
  });
  const SourceCaptureTriggerSessionCheckRequest = idl.Record({
    database_id: idl.Text,
    request_path: idl.Text,
    session_nonce: idl.Text
  });
  const SourceRunSessionCheckRequest = idl.Record({
    source_path: idl.Text,
    source_etag: idl.Text,
    session_nonce: idl.Text,
    database_id: idl.Text
  });
  const WriteNodeResult = idl.Record({ created: idl.Bool, node: NodeMutationAck });
  const MkdirNodeResult = idl.Record({ created: idl.Bool, path: idl.Text });
  const ResultNode = idl.Variant({ Ok: idl.Opt(Node), Err: idl.Text });
  const ResultDatabases = idl.Variant({ Ok: idl.Vec(DatabaseSummary), Err: idl.Text });
  const ResultSearch = idl.Variant({ Ok: idl.Vec(SearchNodeHit), Err: idl.Text });
  const ResultWriteNode = idl.Variant({ Ok: WriteNodeResult, Err: NodeMutationError });
  const ResultMkdirNode = idl.Variant({ Ok: MkdirNodeResult, Err: NodeMutationError });
  const ResultExportSnapshot = idl.Variant({ Ok: ExportSnapshotResponse, Err: idl.Text });
  const ResultFetchUpdates = idl.Variant({ Ok: FetchUpdatesResponse, Err: idl.Text });
  const ResultUnit = idl.Variant({ Ok: idl.Null, Err: idl.Text });

  return idl.Service({
    list_databases: idl.Func([], [ResultDatabases], ["query"]),
    check_database_write_cycles: idl.Func([idl.Text], [ResultUnit], ["query"]),
    check_source_run_session: idl.Func([SourceRunSessionCheckRequest], [ResultUnit], ["query"]),
    check_source_capture_trigger_session: idl.Func([SourceCaptureTriggerSessionCheckRequest], [ResultUnit], ["query"]),
    read_node: idl.Func([idl.Text, idl.Text], [ResultNode], ["query"]),
    mkdir_node: idl.Func([MkdirNodeRequest], [ResultMkdirNode], []),
    write_node: idl.Func([WriteNodeRequest], [ResultWriteNode], []),
    search_nodes: idl.Func([SearchNodesRequest], [ResultSearch], ["query"]),
    export_snapshot: idl.Func([ExportSnapshotRequest], [ResultExportSnapshot], ["query"]),
    fetch_updates: idl.Func([FetchUpdatesRequest], [ResultFetchUpdates], ["query"])
  });
};

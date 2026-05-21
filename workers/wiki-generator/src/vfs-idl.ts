// Where: workers/wiki-generator/src/vfs-idl.ts
// What: Minimal Candid IDL for the VFS calls used by the generator.
// Why: The generator Worker should not depend on the UI app package.
import { Actor } from "@icp-sdk/core/agent";

type ActorInterfaceFactory = Parameters<typeof Actor.createActor>[0];

export const idlFactory: ActorInterfaceFactory = ({ IDL: idl }) => {
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
  const RecentNodeHit = idl.Record({
    updated_at: idl.Int64,
    etag: idl.Text,
    kind: NodeKind,
    path: idl.Text
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
  const WriteNodeResult = idl.Record({ created: idl.Bool, node: RecentNodeHit });
  const MkdirNodeResult = idl.Record({ created: idl.Bool, path: idl.Text });
  const ResultNode = idl.Variant({ Ok: idl.Opt(Node), Err: idl.Text });
  const ResultSearch = idl.Variant({ Ok: idl.Vec(SearchNodeHit), Err: idl.Text });
  const ResultWriteNode = idl.Variant({ Ok: WriteNodeResult, Err: idl.Text });
  const ResultMkdirNode = idl.Variant({ Ok: MkdirNodeResult, Err: idl.Text });
  const ResultExportSnapshot = idl.Variant({ Ok: ExportSnapshotResponse, Err: idl.Text });
  const ResultFetchUpdates = idl.Variant({ Ok: FetchUpdatesResponse, Err: idl.Text });

  return idl.Service({
    read_node: idl.Func([idl.Text, idl.Text], [ResultNode], ["query"]),
    mkdir_node: idl.Func([MkdirNodeRequest], [ResultMkdirNode], []),
    write_node: idl.Func([WriteNodeRequest], [ResultWriteNode], []),
    search_nodes: idl.Func([SearchNodesRequest], [ResultSearch], ["query"]),
    export_snapshot: idl.Func([ExportSnapshotRequest], [ResultExportSnapshot], ["query"]),
    fetch_updates: idl.Func([FetchUpdatesRequest], [ResultFetchUpdates], ["query"])
  });
};

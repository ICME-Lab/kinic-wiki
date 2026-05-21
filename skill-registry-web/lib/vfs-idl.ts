import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";

type ActorInterfaceFactory = Parameters<typeof Actor.createActor>[0];

export const idlFactory: ActorInterfaceFactory = ({ IDL: idl }) => {
  const CanisterHealth = idl.Record({ cycles_balance: idl.Nat });
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
    role: DatabaseRole,
    logical_size_bytes: idl.Nat64,
    database_id: idl.Text,
    name: idl.Text,
    archived_at_ms: idl.Opt(idl.Int64),
    deleted_at_ms: idl.Opt(idl.Int64)
  });
  const CreateDatabaseRequest = idl.Record({ name: idl.Text });
  const CreateDatabaseResult = idl.Record({ name: idl.Text, database_id: idl.Text });
  const RenameDatabaseRequest = idl.Record({ name: idl.Text, database_id: idl.Text });
  const DatabaseMember = idl.Record({
    principal: idl.Text,
    role: DatabaseRole,
    created_at_ms: idl.Int64,
    database_id: idl.Text
  });
  const NodeKind = idl.Variant({ File: idl.Null, Source: idl.Null, Folder: idl.Null });
  const NodeEntryKind = idl.Variant({
    File: idl.Null,
    Source: idl.Null,
    Directory: idl.Null,
    Folder: idl.Null
  });
  const Node = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    content: idl.Text,
    created_at: idl.Int64,
    updated_at: idl.Int64,
    etag: idl.Text,
    metadata_json: idl.Text
  });
  const ChildNode = idl.Record({
    path: idl.Text,
    name: idl.Text,
    kind: NodeEntryKind,
    updated_at: idl.Opt(idl.Int64),
    etag: idl.Opt(idl.Text),
    size_bytes: idl.Opt(idl.Nat64),
    has_children: idl.Bool,
    is_virtual: idl.Bool
  });
  const RecentNodeHit = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    updated_at: idl.Int64,
    etag: idl.Text
  });
  const NodeMutationAck = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    updated_at: idl.Int64,
    etag: idl.Text
  });
  const LinkEdge = idl.Record({
    source_path: idl.Text,
    target_path: idl.Text,
    raw_href: idl.Text,
    link_text: idl.Text,
    link_kind: idl.Text,
    updated_at: idl.Int64
  });
  const NodeContext = idl.Record({
    incoming_links: idl.Vec(LinkEdge),
    node: Node,
    outgoing_links: idl.Vec(LinkEdge)
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
  const MemoryCapability = idl.Record({ name: idl.Text, description: idl.Text });
  const MemoryRoot = idl.Record({ path: idl.Text, kind: idl.Text });
  const CanonicalRole = idl.Record({
    name: idl.Text,
    path_pattern: idl.Text,
    purpose: idl.Text
  });
  const MemoryManifest = idl.Record({
    api_version: idl.Text,
    purpose: idl.Text,
    roots: idl.Vec(MemoryRoot),
    capabilities: idl.Vec(MemoryCapability),
    canonical_roles: idl.Vec(CanonicalRole),
    write_policy: idl.Text,
    recommended_entrypoint: idl.Text,
    max_depth: idl.Nat32,
    max_query_limit: idl.Nat32,
    budget_unit: idl.Text
  });
  const SourceEvidenceRef = idl.Record({
    source_path: idl.Text,
    via_path: idl.Text,
    raw_href: idl.Text,
    link_text: idl.Text
  });
  const SourceEvidence = idl.Record({
    node_path: idl.Text,
    refs: idl.Vec(SourceEvidenceRef)
  });
  const QueryContext = idl.Record({
    namespace: idl.Text,
    task: idl.Text,
    search_hits: idl.Vec(SearchNodeHit),
    nodes: idl.Vec(NodeContext),
    graph_links: idl.Vec(LinkEdge),
    evidence: idl.Vec(SourceEvidence),
    truncated: idl.Bool
  });
  const ListChildrenRequest = idl.Record({ path: idl.Text, database_id: idl.Text });
  const RecentNodesRequest = idl.Record({ path: idl.Opt(idl.Text), limit: idl.Nat32, database_id: idl.Text });
  const IncomingLinksRequest = idl.Record({ path: idl.Text, limit: idl.Nat32, database_id: idl.Text });
  const OutgoingLinksRequest = idl.Record({ path: idl.Text, limit: idl.Nat32, database_id: idl.Text });
  const GraphLinksRequest = idl.Record({ prefix: idl.Text, limit: idl.Nat32, database_id: idl.Text });
  const GraphNeighborhoodRequest = idl.Record({ center_path: idl.Text, depth: idl.Nat32, limit: idl.Nat32, database_id: idl.Text });
  const NodeContextRequest = idl.Record({ path: idl.Text, link_limit: idl.Nat32, database_id: idl.Text });
  const WriteNodeRequest = idl.Record({
    content: idl.Text,
    kind: NodeKind,
    path: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    metadata_json: idl.Text,
    database_id: idl.Text
  });
  const DeleteNodeRequest = idl.Record({
    path: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    expected_folder_index_etag: idl.Opt(idl.Text),
    database_id: idl.Text
  });
  const MkdirNodeRequest = idl.Record({ path: idl.Text, database_id: idl.Text });
  const MoveNodeRequest = idl.Record({
    from_path: idl.Text,
    to_path: idl.Text,
    expected_etag: idl.Opt(idl.Text),
    overwrite: idl.Bool,
    database_id: idl.Text
  });
  const UrlIngestTriggerSessionRequest = idl.Record({
    database_id: idl.Text,
    session_nonce: idl.Text
  });
  const UrlIngestTriggerSessionCheckRequest = idl.Record({
    database_id: idl.Text,
    request_path: idl.Text,
    session_nonce: idl.Text
  });
  const OpsAnswerSessionRequest = idl.Record({
    database_id: idl.Text,
    session_nonce: idl.Text
  });
  const OpsAnswerSessionCheckRequest = idl.Record({
    database_id: idl.Text,
    session_nonce: idl.Text
  });
  const OpsAnswerSessionCheckResult = idl.Record({ principal: idl.Text });
  const SearchNodePathsRequest = idl.Record({
    database_id: idl.Text,
    query_text: idl.Text,
    prefix: idl.Opt(idl.Text),
    top_k: idl.Nat32,
    preview_mode: idl.Opt(SearchPreviewMode)
  });
  const SearchNodesRequest = idl.Record({
    database_id: idl.Text,
    query_text: idl.Text,
    prefix: idl.Opt(idl.Text),
    top_k: idl.Nat32,
    preview_mode: idl.Opt(SearchPreviewMode)
  });
  const QueryContextRequest = idl.Record({
    database_id: idl.Text,
    task: idl.Text,
    entities: idl.Vec(idl.Text),
    namespace: idl.Opt(idl.Text),
    budget_tokens: idl.Nat32,
    include_evidence: idl.Bool,
    depth: idl.Nat32
  });
  const SourceEvidenceRequest = idl.Record({ node_path: idl.Text, database_id: idl.Text });
  const ResultNode = idl.Variant({ Ok: idl.Opt(Node), Err: idl.Text });
  const ResultChildren = idl.Variant({ Ok: idl.Vec(ChildNode), Err: idl.Text });
  const ResultRecent = idl.Variant({ Ok: idl.Vec(RecentNodeHit), Err: idl.Text });
  const ResultLinks = idl.Variant({ Ok: idl.Vec(LinkEdge), Err: idl.Text });
  const ResultNodeContext = idl.Variant({ Ok: idl.Opt(NodeContext), Err: idl.Text });
  const ResultSearch = idl.Variant({ Ok: idl.Vec(SearchNodeHit), Err: idl.Text });
  const ResultQueryContext = idl.Variant({ Ok: QueryContext, Err: idl.Text });
  const ResultSourceEvidence = idl.Variant({ Ok: SourceEvidence, Err: idl.Text });
  const ResultCreateDatabase = idl.Variant({ Ok: CreateDatabaseResult, Err: idl.Text });
  const ResultDatabases = idl.Variant({ Ok: idl.Vec(DatabaseSummary), Err: idl.Text });
  const ResultMembers = idl.Variant({ Ok: idl.Vec(DatabaseMember), Err: idl.Text });
  const WriteNodeResult = idl.Record({ created: idl.Bool, node: RecentNodeHit });
  const ResultWriteNode = idl.Variant({ Ok: WriteNodeResult, Err: idl.Text });
  const DeleteNodeResult = idl.Record({ path: idl.Text });
  const ResultDeleteNode = idl.Variant({ Ok: DeleteNodeResult, Err: idl.Text });
  const MkdirNodeResult = idl.Record({ path: idl.Text, created: idl.Bool });
  const ResultMkdirNode = idl.Variant({ Ok: MkdirNodeResult, Err: idl.Text });
  const MoveNodeResult = idl.Record({ from_path: idl.Text, node: NodeMutationAck, overwrote: idl.Bool });
  const ResultMoveNode = idl.Variant({ Ok: MoveNodeResult, Err: idl.Text });
  const ResultUnit = idl.Variant({ Ok: idl.Null, Err: idl.Text });
  const ResultOpsAnswerSessionCheck = idl.Variant({ Ok: OpsAnswerSessionCheckResult, Err: idl.Text });

  return idl.Service({
    // The public canister ABI intentionally keeps the legacy ops_* names; browser code exposes Query Q&A wrappers.
    authorize_ops_answer_session: idl.Func([OpsAnswerSessionRequest], [ResultUnit], []),
    authorize_url_ingest_trigger_session: idl.Func([UrlIngestTriggerSessionRequest], [ResultUnit], []),
    canister_health: idl.Func([], [CanisterHealth], ["query"]),
    check_ops_answer_session: idl.Func([OpsAnswerSessionCheckRequest], [ResultOpsAnswerSessionCheck], ["query"]),
    check_url_ingest_trigger_session: idl.Func([UrlIngestTriggerSessionCheckRequest], [ResultUnit], ["query"]),
    create_database: idl.Func([CreateDatabaseRequest], [ResultCreateDatabase], []),
    delete_node: idl.Func([DeleteNodeRequest], [ResultDeleteNode], []),
    grant_database_access: idl.Func([idl.Text, idl.Text, DatabaseRole], [ResultUnit], []),
    graph_links: idl.Func([GraphLinksRequest], [ResultLinks], ["query"]),
    graph_neighborhood: idl.Func([GraphNeighborhoodRequest], [ResultLinks], ["query"]),
    incoming_links: idl.Func([IncomingLinksRequest], [ResultLinks], ["query"]),
    list_databases: idl.Func([], [ResultDatabases], ["query"]),
    list_database_members: idl.Func([idl.Text], [ResultMembers], ["query"]),
    memory_manifest: idl.Func([], [MemoryManifest], ["query"]),
    mkdir_node: idl.Func([MkdirNodeRequest], [ResultMkdirNode], []),
    move_node: idl.Func([MoveNodeRequest], [ResultMoveNode], []),
    query_context: idl.Func([QueryContextRequest], [ResultQueryContext], ["query"]),
    read_node: idl.Func([idl.Text, idl.Text], [ResultNode], ["query"]),
    read_node_context: idl.Func([NodeContextRequest], [ResultNodeContext], ["query"]),
    list_children: idl.Func([ListChildrenRequest], [ResultChildren], ["query"]),
    outgoing_links: idl.Func([OutgoingLinksRequest], [ResultLinks], ["query"]),
    recent_nodes: idl.Func([RecentNodesRequest], [ResultRecent], ["query"]),
    revoke_database_access: idl.Func([idl.Text, idl.Text], [ResultUnit], []),
    rename_database: idl.Func([RenameDatabaseRequest], [ResultUnit], []),
    search_node_paths: idl.Func([SearchNodePathsRequest], [ResultSearch], ["query"]),
    search_nodes: idl.Func([SearchNodesRequest], [ResultSearch], ["query"]),
    source_evidence: idl.Func([SourceEvidenceRequest], [ResultSourceEvidence], ["query"]),
    write_node: idl.Func([WriteNodeRequest], [ResultWriteNode], [])
  });
};

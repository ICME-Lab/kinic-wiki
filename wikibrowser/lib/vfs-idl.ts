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
    billing_balance_e8s: idl.Nat64,
    billing_suspended_at_ms: idl.Opt(idl.Int64),
    display_name: idl.Text,
    database_id: idl.Text,
    archived_at_ms: idl.Opt(idl.Int64),
    deleted_at_ms: idl.Opt(idl.Int64)
  });
  const DatabaseMember = idl.Record({
    principal: idl.Text,
    role: DatabaseRole,
    created_at_ms: idl.Int64,
    database_id: idl.Text
  });
  const BillingAccount = idl.Record({ owner: idl.Principal, subaccount: idl.Opt(idl.Vec(idl.Nat8)) });
  const PrincipalBillingSummary = idl.Record({ principal: idl.Text, balance_e8s: idl.Nat64 });
  const PrincipalBillingEntry = idl.Record({
    entry_id: idl.Nat64,
    principal: idl.Text,
    kind: idl.Text,
    amount_e8s: idl.Int64,
    balance_after_e8s: idl.Nat64,
    database_id: idl.Opt(idl.Text),
    ledger_block_index: idl.Opt(idl.Nat64),
    created_at_ms: idl.Int64
  });
  const PrincipalBillingEntryPage = idl.Record({
    entries: idl.Vec(PrincipalBillingEntry),
    next_cursor: idl.Opt(idl.Nat64)
  });
  const DatabaseBillingEntry = idl.Record({
    method: idl.Opt(idl.Text),
    fixed_update_fee_e8s: idl.Opt(idl.Nat64),
    kind: idl.Text,
    rate_denominator_cycles: idl.Opt(idl.Nat64),
    created_at_ms: idl.Int64,
    amount_e8s: idl.Int64,
    rate_numerator_e8s: idl.Opt(idl.Nat64),
    database_id: idl.Text,
    balance_after_e8s: idl.Nat64,
    caller: idl.Text,
    cycles_delta: idl.Opt(idl.Nat64),
    entry_id: idl.Nat64,
    usage_event_id: idl.Opt(idl.Nat64)
  });
  const DatabaseBillingEntryPage = idl.Record({
    entries: idl.Vec(DatabaseBillingEntry),
    next_cursor: idl.Opt(idl.Nat64)
  });
  const BillingConfig = idl.Record({
    min_update_balance_e8s: idl.Nat64,
    fixed_update_fee_e8s: idl.Nat64,
    rate_denominator_cycles: idl.Nat64,
    kinic_ledger_canister_id: idl.Text,
    rate_numerator_e8s: idl.Nat64,
    min_initial_deposit_e8s: idl.Nat64,
    sns_governance_id: idl.Text
  });
  const BillingTransferResult = idl.Record({ block_index: idl.Nat64, balance_e8s: idl.Nat64 });
  const NodeKind = idl.Variant({ File: idl.Null, Source: idl.Null });
  const NodeEntryKind = idl.Variant({
    File: idl.Null,
    Source: idl.Null,
    Directory: idl.Null
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
  const ResultCreateDatabase = idl.Variant({ Ok: idl.Text, Err: idl.Text });
  const ResultDatabases = idl.Variant({ Ok: idl.Vec(DatabaseSummary), Err: idl.Text });
  const ResultMembers = idl.Variant({ Ok: idl.Vec(DatabaseMember), Err: idl.Text });
  const WriteNodeResult = idl.Record({ created: idl.Bool, node: RecentNodeHit });
  const ResultWriteNode = idl.Variant({ Ok: WriteNodeResult, Err: idl.Text });
  const ResultUnit = idl.Variant({ Ok: idl.Null, Err: idl.Text });
  const ResultBillingConfig = idl.Variant({ Ok: BillingConfig, Err: idl.Text });
  const ResultBillingTransfer = idl.Variant({ Ok: BillingTransferResult, Err: idl.Text });
  const ResultPrincipalBillingSummary = idl.Variant({ Ok: PrincipalBillingSummary, Err: idl.Text });
  const ResultPrincipalBillingEntryPage = idl.Variant({ Ok: PrincipalBillingEntryPage, Err: idl.Text });
  const ResultDatabaseBillingEntryPage = idl.Variant({ Ok: DatabaseBillingEntryPage, Err: idl.Text });

  return idl.Service({
    canister_health: idl.Func([], [CanisterHealth], ["query"]),
    create_database: idl.Func([idl.Text, idl.Nat64], [ResultCreateDatabase], []),
    get_billing_config: idl.Func([], [ResultBillingConfig], ["query"]),
    rename_database: idl.Func([idl.Text, idl.Text], [ResultUnit], []),
    grant_database_access: idl.Func([idl.Text, idl.Text, DatabaseRole], [ResultUnit], []),
    graph_links: idl.Func([GraphLinksRequest], [ResultLinks], ["query"]),
    graph_neighborhood: idl.Func([GraphNeighborhoodRequest], [ResultLinks], ["query"]),
    incoming_links: idl.Func([IncomingLinksRequest], [ResultLinks], ["query"]),
    list_database_billing_entries: idl.Func([idl.Text, idl.Opt(idl.Nat64), idl.Nat32], [ResultDatabaseBillingEntryPage], ["query"]),
    list_databases: idl.Func([], [ResultDatabases], ["query"]),
    list_database_members: idl.Func([idl.Text], [ResultMembers], ["query"]),
    list_principal_billing_entries: idl.Func([idl.Opt(idl.Nat64), idl.Nat32], [ResultPrincipalBillingEntryPage], ["query"]),
    memory_manifest: idl.Func([], [MemoryManifest], ["query"]),
    query_context: idl.Func([QueryContextRequest], [ResultQueryContext], ["query"]),
    read_node: idl.Func([idl.Text, idl.Text], [ResultNode], ["query"]),
    read_node_context: idl.Func([NodeContextRequest], [ResultNodeContext], ["query"]),
    list_children: idl.Func([ListChildrenRequest], [ResultChildren], ["query"]),
    outgoing_links: idl.Func([OutgoingLinksRequest], [ResultLinks], ["query"]),
    principal_billing_summary: idl.Func([], [ResultPrincipalBillingSummary], ["query"]),
    recent_nodes: idl.Func([RecentNodesRequest], [ResultRecent], ["query"]),
    revoke_database_access: idl.Func([idl.Text, idl.Text], [ResultUnit], []),
    search_node_paths: idl.Func([SearchNodePathsRequest], [ResultSearch], ["query"]),
    search_nodes: idl.Func([SearchNodesRequest], [ResultSearch], ["query"]),
    source_evidence: idl.Func([SourceEvidenceRequest], [ResultSourceEvidence], ["query"]),
    top_up_database: idl.Func([idl.Text, idl.Nat64], [ResultUnit], []),
    top_up_principal_balance: idl.Func([idl.Nat64], [ResultBillingTransfer], []),
    update_billing_config: idl.Func([idl.Vec(idl.Nat8)], [ResultUnit], []),
    validate_update_billing_config: idl.Func([idl.Vec(idl.Nat8)], [ResultUnit], []),
    withdraw_database_balance: idl.Func([idl.Text, idl.Nat64], [ResultUnit], []),
    withdraw_principal_balance: idl.Func([idl.Nat64, BillingAccount], [ResultBillingTransfer], []),
    write_node: idl.Func([WriteNodeRequest], [ResultWriteNode], [])
  });
};

export const expectedTypes = {
  CanisterHealth: { kind: "record", fields: { cycles_balance: "nat" } },
  DatabaseRole: { kind: "variant", cases: { Reader: "null", Writer: "null", Owner: "null" } },
  DatabaseStatus: { kind: "variant", cases: { Hot: "null", Restoring: "null", Archiving: "null", Archived: "null", Deleted: "null" } },
  DatabaseSummary: {
    kind: "record",
    fields: {
      status: "DatabaseStatus",
      role: "DatabaseRole",
      logical_size_bytes: "nat64",
      display_name: "text",
      billing_suspended_at_ms: "opt int64",
      database_id: "text",
      archived_at_ms: "opt int64",
      billing_balance_e8s: "nat64",
      deleted_at_ms: "opt int64"
    }
  },
  BillingConfig: {
    kind: "record",
    fields: {
      min_update_balance_e8s: "nat64",
      fixed_update_fee_e8s: "nat64",
      rate_denominator_cycles: "nat64",
      kinic_ledger_canister_id: "text",
      rate_numerator_e8s: "nat64",
      min_initial_deposit_e8s: "nat64",
      sns_governance_id: "text"
    }
  },
  BillingTransferResult: { kind: "record", fields: { block_index: "nat64", balance_e8s: "nat64" } },
  BillingAccount: { kind: "record", fields: { owner: "principal", subaccount: "opt blob" } },
  PrincipalBillingSummary: { kind: "record", fields: { principal: "text", balance_e8s: "nat64" } },
  PrincipalBillingEntry: {
    kind: "record",
    fields: {
      entry_id: "nat64",
      principal: "text",
      kind: "text",
      amount_e8s: "int64",
      balance_after_e8s: "nat64",
      database_id: "opt text",
      ledger_block_index: "opt nat64",
      created_at_ms: "int64"
    }
  },
  PrincipalBillingEntryPage: { kind: "record", fields: { entries: "vec PrincipalBillingEntry", next_cursor: "opt nat64" } },
  DatabaseBillingEntry: {
    kind: "record",
    fields: {
      method: "opt text",
      fixed_update_fee_e8s: "opt nat64",
      kind: "text",
      rate_denominator_cycles: "opt nat64",
      created_at_ms: "int64",
      amount_e8s: "int64",
      rate_numerator_e8s: "opt nat64",
      database_id: "text",
      balance_after_e8s: "nat64",
      caller: "text",
      cycles_delta: "opt nat64",
      entry_id: "nat64",
      usage_event_id: "opt nat64"
    }
  },
  DatabaseBillingEntryPage: { kind: "record", fields: { entries: "vec DatabaseBillingEntry", next_cursor: "opt nat64" } },
  DatabaseMember: {
    kind: "record",
    fields: {
      principal: "text",
      role: "DatabaseRole",
      created_at_ms: "int64",
      database_id: "text"
    }
  },
  CanonicalRole: {
    kind: "record",
    fields: { name: "text", path_pattern: "text", purpose: "text" }
  },
  ChildNode: {
    kind: "record",
    fields: {
      updated_at: "opt int64",
      etag: "opt text",
      kind: "NodeEntryKind",
      name: "text",
      size_bytes: "opt nat64",
      path: "text",
      has_children: "bool",
      is_virtual: "bool"
    }
  },
  ListChildrenRequest: { kind: "record", fields: { path: "text", database_id: "text" } },
  Node: {
    kind: "record",
    fields: {
      updated_at: "int64",
      content: "text",
      etag: "text",
      kind: "NodeKind",
      path: "text",
      created_at: "int64",
      metadata_json: "text"
    }
  },
  NodeEntryKind: { kind: "variant", cases: { File: "null", Source: "null", Directory: "null" } },
  NodeKind: { kind: "variant", cases: { File: "null", Source: "null" } },
  WriteNodeRequest: {
    kind: "record",
    fields: {
      content: "text",
      kind: "NodeKind",
      path: "text",
      expected_etag: "opt text",
      metadata_json: "text",
      database_id: "text"
    }
  },
  WriteNodeResult: {
    kind: "record",
    fields: { created: "bool", node: "RecentNodeHit" }
  },
  MemoryCapability: { kind: "record", fields: { name: "text", description: "text" } },
  MemoryManifest: {
    kind: "record",
    fields: {
      api_version: "text",
      budget_unit: "text",
      capabilities: "vec MemoryCapability",
      max_depth: "nat32",
      max_query_limit: "nat32",
      recommended_entrypoint: "text",
      write_policy: "text",
      canonical_roles: "vec CanonicalRole",
      purpose: "text",
      roots: "vec MemoryRoot"
    }
  },
  MemoryRoot: { kind: "record", fields: { kind: "text", path: "text" } },
  QueryContext: {
    kind: "record",
    fields: {
      truncated: "bool",
      task: "text",
      evidence: "vec SourceEvidence",
      nodes: "vec NodeContext",
      graph_links: "vec LinkEdge",
      search_hits: "vec SearchNodeHit",
      namespace: "text"
    }
  },
  QueryContextRequest: {
    kind: "record",
    fields: {
      task: "text",
      include_evidence: "bool",
      entities: "vec text",
      budget_tokens: "nat32",
      database_id: "text",
      depth: "nat32",
      namespace: "opt text"
    }
  },
  RecentNodeHit: {
    kind: "record",
    fields: { updated_at: "int64", etag: "text", kind: "NodeKind", path: "text" }
  },
  RecentNodesRequest: { kind: "record", fields: { path: "opt text", limit: "nat32", database_id: "text" } },
  GraphLinksRequest: { kind: "record", fields: { limit: "nat32", database_id: "text", prefix: "text" } },
  GraphNeighborhoodRequest: { kind: "record", fields: { center_path: "text", limit: "nat32", database_id: "text", depth: "nat32" } },
  IncomingLinksRequest: { kind: "record", fields: { path: "text", limit: "nat32", database_id: "text" } },
  NodeContextRequest: { kind: "record", fields: { link_limit: "nat32", path: "text", database_id: "text" } },
  OutgoingLinksRequest: { kind: "record", fields: { path: "text", limit: "nat32", database_id: "text" } },
  LinkEdge: {
    kind: "record",
    fields: {
      updated_at: "int64",
      link_kind: "text",
      link_text: "text",
      source_path: "text",
      raw_href: "text",
      target_path: "text"
    }
  },
  NodeContext: {
    kind: "record",
    fields: { incoming_links: "vec LinkEdge", node: "Node", outgoing_links: "vec LinkEdge" }
  },
  ResultChildren: { kind: "variant", cases: { Ok: "vec ChildNode", Err: "text" } },
  ResultCreateDatabase: { kind: "variant", cases: { Ok: "text", Err: "text" } },
  ResultDatabases: { kind: "variant", cases: { Ok: "vec DatabaseSummary", Err: "text" } },
  ResultMembers: { kind: "variant", cases: { Ok: "vec DatabaseMember", Err: "text" } },
  ResultUnit: { kind: "variant", cases: { Ok: "null", Err: "text" } },
  ResultWriteNode: { kind: "variant", cases: { Ok: "WriteNodeResult", Err: "text" } },
  ResultLinks: { kind: "variant", cases: { Ok: "vec LinkEdge", Err: "text" } },
  ResultNode: { kind: "variant", cases: { Ok: "opt Node", Err: "text" } },
  ResultNodeContext: { kind: "variant", cases: { Ok: "opt NodeContext", Err: "text" } },
  ResultQueryContext: { kind: "variant", cases: { Ok: "QueryContext", Err: "text" } },
  ResultRecent: { kind: "variant", cases: { Ok: "vec RecentNodeHit", Err: "text" } },
  ResultSearch: { kind: "variant", cases: { Ok: "vec SearchNodeHit", Err: "text" } },
  ResultSourceEvidence: { kind: "variant", cases: { Ok: "SourceEvidence", Err: "text" } },
  ResultBillingConfig: { kind: "variant", cases: { Ok: "BillingConfig", Err: "text" } },
  ResultBillingTransfer: { kind: "variant", cases: { Ok: "BillingTransferResult", Err: "text" } },
  ResultPrincipalBillingSummary: { kind: "variant", cases: { Ok: "PrincipalBillingSummary", Err: "text" } },
  ResultPrincipalBillingEntryPage: { kind: "variant", cases: { Ok: "PrincipalBillingEntryPage", Err: "text" } },
  ResultDatabaseBillingEntryPage: { kind: "variant", cases: { Ok: "DatabaseBillingEntryPage", Err: "text" } },
  SearchNodeHit: {
    kind: "record",
    fields: {
      preview: "opt SearchPreview",
      kind: "NodeKind",
      path: "text",
      match_reasons: "vec text",
      snippet: "opt text",
      score: "float32"
    }
  },
  SearchNodePathsRequest: {
    kind: "record",
    fields: {
      top_k: "nat32",
      database_id: "text",
      preview_mode: "opt SearchPreviewMode",
      prefix: "opt text",
      query_text: "text"
    }
  },
  SearchNodesRequest: {
    kind: "record",
    fields: {
      top_k: "nat32",
      database_id: "text",
      preview_mode: "opt SearchPreviewMode",
      prefix: "opt text",
      query_text: "text"
    }
  },
  SearchPreview: {
    kind: "record",
    fields: {
      field: "SearchPreviewField",
      char_offset: "nat32",
      match_reason: "text",
      excerpt: "opt text"
    }
  },
  SearchPreviewField: { kind: "variant", cases: { Path: "null", Content: "null" } },
  SearchPreviewMode: { kind: "variant", cases: { Light: "null", ContentStart: "null", None: "null" } },
  SourceEvidence: {
    kind: "record",
    fields: { node_path: "text", refs: "vec SourceEvidenceRef" }
  },
  SourceEvidenceRef: {
    kind: "record",
    fields: {
      link_text: "text",
      via_path: "text",
      source_path: "text",
      raw_href: "text"
    }
  },
  SourceEvidenceRequest: { kind: "record", fields: { node_path: "text", database_id: "text" } }
};

export const didTypeAliases = {
  ResultChildren: "Result_11",
  ResultCreateDatabase: "Result_3",
  ResultDatabases: "Result_14",
  ResultMembers: "Result_13",
  ResultUnit: "Result_2",
  ResultWriteNode: "Result",
  ResultLinks: "Result_10",
  ResultNode: "Result_22",
  ResultNodeContext: "Result_23",
  ResultQueryContext: "Result_20",
  ResultRecent: "Result_24",
  ResultSearch: "Result_25",
  ResultSourceEvidence: "Result_26",
  ResultBillingConfig: "Result_8",
  ResultBillingTransfer: "Result_27",
  ResultDatabaseBillingEntryPage: "Result_12",
  ResultPrincipalBillingEntryPage: "Result_16",
  ResultPrincipalBillingSummary: "Result_19"
};

export const expectedMethods = {
  canister_health: { input: [], output: "CanisterHealth", mode: "query" },
  create_database: { input: ["text", "nat64"], output: "ResultCreateDatabase", mode: "update" },
  get_billing_config: { input: [], output: "ResultBillingConfig", mode: "query" },
  grant_database_access: { input: ["text", "text", "DatabaseRole"], output: "ResultUnit", mode: "update" },
  graph_links: { input: ["GraphLinksRequest"], output: "ResultLinks", mode: "query" },
  graph_neighborhood: { input: ["GraphNeighborhoodRequest"], output: "ResultLinks", mode: "query" },
  incoming_links: { input: ["IncomingLinksRequest"], output: "ResultLinks", mode: "query" },
  list_children: { input: ["ListChildrenRequest"], output: "ResultChildren", mode: "query" },
  list_database_billing_entries: { input: ["text", "opt nat64", "nat32"], output: "ResultDatabaseBillingEntryPage", mode: "query" },
  list_databases: { input: [], output: "ResultDatabases", mode: "query" },
  list_database_members: { input: ["text"], output: "ResultMembers", mode: "query" },
  list_principal_billing_entries: { input: ["opt nat64", "nat32"], output: "ResultPrincipalBillingEntryPage", mode: "query" },
  memory_manifest: { input: [], output: "MemoryManifest", mode: "query" },
  outgoing_links: { input: ["OutgoingLinksRequest"], output: "ResultLinks", mode: "query" },
  principal_billing_summary: { input: [], output: "ResultPrincipalBillingSummary", mode: "query" },
  query_context: { input: ["QueryContextRequest"], output: "ResultQueryContext", mode: "query" },
  read_node: { input: ["text", "text"], output: "ResultNode", mode: "query" },
  read_node_context: { input: ["NodeContextRequest"], output: "ResultNodeContext", mode: "query" },
  recent_nodes: { input: ["RecentNodesRequest"], output: "ResultRecent", mode: "query" },
  rename_database: { input: ["text", "text"], output: "ResultUnit", mode: "update" },
  revoke_database_access: { input: ["text", "text"], output: "ResultUnit", mode: "update" },
  search_node_paths: { input: ["SearchNodePathsRequest"], output: "ResultSearch", mode: "query" },
  search_nodes: { input: ["SearchNodesRequest"], output: "ResultSearch", mode: "query" },
  source_evidence: { input: ["SourceEvidenceRequest"], output: "ResultSourceEvidence", mode: "query" },
  top_up_database: { input: ["text", "nat64"], output: "ResultUnit", mode: "update" },
  top_up_principal_balance: { input: ["nat64"], output: "ResultBillingTransfer", mode: "update" },
  update_billing_config: { input: ["blob"], output: "ResultUnit", mode: "update" },
  validate_update_billing_config: { input: ["blob"], output: "ResultUnit", mode: "update" },
  withdraw_database_balance: { input: ["text", "nat64"], output: "ResultUnit", mode: "update" },
  withdraw_principal_balance: { input: ["nat64", "BillingAccount"], output: "ResultBillingTransfer", mode: "update" },
  write_node: { input: ["WriteNodeRequest"], output: "ResultWriteNode", mode: "update" }
};

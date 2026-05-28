export const expectedTypes = {
  CanisterHealth: { kind: "record", fields: { cycles_balance: "nat" } },
  DatabaseRole: { kind: "variant", cases: { Reader: "null", Writer: "null", Owner: "null" } },
  DatabaseStatus: { kind: "variant", cases: { Pending: "null", Active: "null", Restoring: "null", Archiving: "null", Archived: "null" } },
  DatabaseSummary: {
    kind: "record",
    fields: {
      status: "DatabaseStatus",
      role: "DatabaseRole",
      logical_size_bytes: "nat64",
      database_id: "text",
      name: "text",
      credits_balance: "opt nat64",
      credits_suspended_at_ms: "opt int64",
      archived_at_ms: "opt int64"
    }
  },
  CreditsConfig: {
    kind: "record",
    fields: {
      credits_per_kinic: "nat64",
      min_update_credits: "nat64",
      cycles_per_credit: "nat64",
      kinic_ledger_canister_id: "text",
      sns_governance_id: "text"
    }
  },
  CreditsPurchaseResult: {
    kind: "record",
    fields: { block_index: "nat64", balance_credits: "nat64" }
  },
  CreateDatabaseRequest: { kind: "record", fields: { name: "text" } },
  CreateDatabaseResult: { kind: "record", fields: { name: "text", database_id: "text" } },
  RenameDatabaseRequest: { kind: "record", fields: { name: "text", database_id: "text" } },
  DeleteDatabaseRequest: { kind: "record", fields: { database_id: "text" } },
  DatabaseMember: {
    kind: "record",
    fields: {
      principal: "text",
      role: "DatabaseRole",
      created_at_ms: "int64",
      database_id: "text"
    }
  },
  DatabaseCreditEntry: {
    kind: "record",
    fields: {
      method: "opt text",
      credits_per_kinic: "opt nat64",
      payment_amount_e8s: "opt nat64",
      kind: "text",
      cycles_per_credit: "opt nat64",
      created_at_ms: "int64",
      amount_credits: "int64",
      ledger_block_index: "opt nat64",
      database_id: "text",
      balance_after_credits: "nat64",
      caller: "text",
      cycles_delta: "opt nat64",
      entry_id: "nat64",
      usage_event_id: "opt nat64"
    }
  },
  DatabaseCreditEntryPage: {
    kind: "record",
    fields: { entries: "vec DatabaseCreditEntry", next_cursor: "opt nat64" }
  },
  DatabaseCreditPendingOperation: {
    kind: "record",
    fields: {
      credits: "int64",
      payment_amount_e8s: "int64",
      to_owner: "opt text",
      to_subaccount: "opt blob",
      from_owner: "opt text",
      kind: "text",
      operation_id: "nat64",
      from_subaccount: "opt blob",
      created_at_ms: "int64",
      ledger_fee_e8s: "opt int64",
      ledger_created_at_time_ns: "opt int64",
      database_id: "text",
      caller: "text"
    }
  },
  DatabaseCreditPendingOperationPage: {
    kind: "record",
    fields: {
      entries: "vec DatabaseCreditPendingOperation",
      next_cursor: "opt nat64"
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
  NodeEntryKind: { kind: "variant", cases: { File: "null", Source: "null", Directory: "null", Folder: "null" } },
  NodeKind: { kind: "variant", cases: { File: "null", Source: "null", Folder: "null" } },
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
    fields: { created: "bool", node: "NodeMutationAck" }
  },
  WriteSourceForGenerationRequest: {
    kind: "record",
    fields: {
      content: "text",
      path: "text",
      session_nonce: "text",
      expected_etag: "opt text",
      metadata_json: "text",
      database_id: "text"
    }
  },
  WriteSourceForGenerationResult: {
    kind: "record",
    fields: { session_nonce: "text", write: "WriteNodeResult" }
  },
  DeleteNodeRequest: {
    kind: "record",
    fields: {
      path: "text",
      expected_etag: "opt text",
      expected_folder_index_etag: "opt text",
      database_id: "text"
    }
  },
  DeleteNodeResult: {
    kind: "record",
    fields: { path: "text" }
  },
  MkdirNodeRequest: { kind: "record", fields: { path: "text", database_id: "text" } },
  MkdirNodeResult: { kind: "record", fields: { path: "text", created: "bool" } },
  MoveNodeRequest: {
    kind: "record",
    fields: {
      from_path: "text",
      to_path: "text",
      expected_etag: "opt text",
      overwrite: "bool",
      database_id: "text"
    }
  },
  MoveNodeResult: {
    kind: "record",
    fields: { from_path: "text", node: "NodeMutationAck", overwrote: "bool" }
  },
  NodeMutationAck: {
    kind: "record",
    fields: { updated_at: "int64", etag: "text", kind: "NodeKind", path: "text" }
  },
  UrlIngestTriggerSessionRequest: {
    kind: "record",
    fields: { database_id: "text", session_nonce: "text" }
  },
  UrlIngestTriggerSessionCheckRequest: {
    kind: "record",
    fields: { database_id: "text", request_path: "text", session_nonce: "text" }
  },
  OpsAnswerSessionRequest: {
    kind: "record",
    fields: { database_id: "text", session_nonce: "text" }
  },
  OpsAnswerSessionCheckRequest: {
    kind: "record",
    fields: { database_id: "text", session_nonce: "text" }
  },
  OpsAnswerSessionCheckResult: {
    kind: "record",
    fields: { principal: "text" }
  },
  SourceRunSessionCheckRequest: {
    kind: "record",
    fields: {
      source_path: "text",
      source_etag: "text",
      session_nonce: "text",
      database_id: "text"
    }
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
  ResultCreditsConfig: { kind: "variant", cases: { Ok: "CreditsConfig", Err: "text" } },
  ResultCreditsPurchase: { kind: "variant", cases: { Ok: "CreditsPurchaseResult", Err: "text" } },
  ResultCreditsEntries: { kind: "variant", cases: { Ok: "DatabaseCreditEntryPage", Err: "text" } },
  ResultCreditsPending: { kind: "variant", cases: { Ok: "DatabaseCreditPendingOperationPage", Err: "text" } },
    ResultCreateDatabase: { kind: "variant", cases: { Ok: "CreateDatabaseResult", Err: "text" } },
  ResultDatabases: { kind: "variant", cases: { Ok: "vec DatabaseSummary", Err: "text" } },
  ResultMembers: { kind: "variant", cases: { Ok: "vec DatabaseMember", Err: "text" } },
  ResultUnit: { kind: "variant", cases: { Ok: "null", Err: "text" } },
  ResultWriteNode: { kind: "variant", cases: { Ok: "WriteNodeResult", Err: "text" } },
  ResultDeleteNode: { kind: "variant", cases: { Ok: "DeleteNodeResult", Err: "text" } },
  ResultMkdirNode: { kind: "variant", cases: { Ok: "MkdirNodeResult", Err: "text" } },
  ResultMoveNode: { kind: "variant", cases: { Ok: "MoveNodeResult", Err: "text" } },
  ResultLinks: { kind: "variant", cases: { Ok: "vec LinkEdge", Err: "text" } },
  ResultNode: { kind: "variant", cases: { Ok: "opt Node", Err: "text" } },
  ResultNodeContext: { kind: "variant", cases: { Ok: "opt NodeContext", Err: "text" } },
  ResultQueryContext: { kind: "variant", cases: { Ok: "QueryContext", Err: "text" } },
  ResultSearch: { kind: "variant", cases: { Ok: "vec SearchNodeHit", Err: "text" } },
  ResultSourceEvidence: { kind: "variant", cases: { Ok: "SourceEvidence", Err: "text" } },
  ResultOpsAnswerSessionCheck: {
    kind: "variant",
    cases: { Ok: "OpsAnswerSessionCheckResult", Err: "text" }
  },
  ResultWriteSourceForGeneration: {
    kind: "variant",
    cases: { Ok: "WriteSourceForGenerationResult", Err: "text" }
  },
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
  OpsAnswerSessionCheckRequest: "OpsAnswerSessionRequest",
  RenameDatabaseRequest: "CreateDatabaseResult",
  UrlIngestTriggerSessionRequest: "OpsAnswerSessionRequest",
  ResultChildren: "Result_12",
  ResultCreditsConfig: "Result_9",
  ResultCreditsPurchase: "Result_20",
  ResultCreditsEntries: "Result_13",
  ResultCreditsPending: "Result_14",
  ResultCreateDatabase: "Result_4",
  ResultDatabases: "Result_16",
  ResultDeleteNode: "Result_5",
  ResultMkdirNode: "Result_18",
  ResultMoveNode: "Result_19",
  ResultMembers: "Result_15",
  ResultUnit: "Result_1",
  ResultWriteNode: "Result",
  ResultLinks: "Result_11",
  ResultNode: "Result_24",
  ResultNodeContext: "Result_25",
  ResultQueryContext: "Result_21",
  ResultSearch: "Result_26",
  ResultSourceEvidence: "Result_27",
  ResultOpsAnswerSessionCheck: "Result_3",
  ResultWriteSourceForGeneration: "Result_29"
};

export const expectedMethods = {
  authorize_ops_answer_session: { input: ["OpsAnswerSessionRequest"], output: "ResultUnit", mode: "update" },
  authorize_url_ingest_trigger_session: { input: ["UrlIngestTriggerSessionRequest"], output: "ResultUnit", mode: "update" },
  canister_health: { input: [], output: "CanisterHealth", mode: "query" },
  check_database_write_credits: { input: ["text"], output: "ResultUnit", mode: "query" },
  check_ops_answer_session: { input: ["OpsAnswerSessionCheckRequest"], output: "ResultOpsAnswerSessionCheck", mode: "query" },
  check_source_run_session: { input: ["SourceRunSessionCheckRequest"], output: "ResultUnit", mode: "query" },
  check_url_ingest_trigger_session: { input: ["UrlIngestTriggerSessionCheckRequest"], output: "ResultUnit", mode: "query" },
  create_database: { input: ["CreateDatabaseRequest"], output: "ResultCreateDatabase", mode: "update" },
  delete_database: { input: ["DeleteDatabaseRequest"], output: "ResultUnit", mode: "update" },
  delete_node: { input: ["DeleteNodeRequest"], output: "ResultDeleteNode", mode: "update" },
  get_credits_config: { input: [], output: "ResultCreditsConfig", mode: "query" },
  grant_database_access: { input: ["text", "text", "DatabaseRole"], output: "ResultUnit", mode: "update" },
  rename_database: { input: ["RenameDatabaseRequest"], output: "ResultUnit", mode: "update" },
  graph_links: { input: ["GraphLinksRequest"], output: "ResultLinks", mode: "query" },
  graph_neighborhood: { input: ["GraphNeighborhoodRequest"], output: "ResultLinks", mode: "query" },
  incoming_links: { input: ["IncomingLinksRequest"], output: "ResultLinks", mode: "query" },
  list_children: { input: ["ListChildrenRequest"], output: "ResultChildren", mode: "query" },
  list_database_credit_entries: { input: ["text", "opt nat64", "nat32"], output: "ResultCreditsEntries", mode: "query" },
  list_database_credit_pending_operations: { input: ["text", "opt nat64", "nat32"], output: "ResultCreditsPending", mode: "query" },
  list_databases: { input: [], output: "ResultDatabases", mode: "query" },
  list_database_members: { input: ["text"], output: "ResultMembers", mode: "query" },
  memory_manifest: { input: [], output: "MemoryManifest", mode: "query" },
  mkdir_node: { input: ["MkdirNodeRequest"], output: "ResultMkdirNode", mode: "update" },
  move_node: { input: ["MoveNodeRequest"], output: "ResultMoveNode", mode: "update" },
  outgoing_links: { input: ["OutgoingLinksRequest"], output: "ResultLinks", mode: "query" },
  preview_database_credit_purchase: { input: ["text", "nat64"], output: "ResultUnit", mode: "query" },
  query_context: { input: ["QueryContextRequest"], output: "ResultQueryContext", mode: "query" },
  read_node: { input: ["text", "text"], output: "ResultNode", mode: "query" },
  read_node_context: { input: ["NodeContextRequest"], output: "ResultNodeContext", mode: "query" },
  repair_database_credit_purchase_cancel: { input: ["text", "nat64"], output: "ResultUnit", mode: "update" },
  repair_database_credit_purchase_complete: { input: ["text", "nat64", "nat64"], output: "ResultCreditsPurchase", mode: "update" },
  repair_database_credit_purchase_retry: { input: ["text", "nat64"], output: "ResultCreditsPurchase", mode: "update" },
  revoke_database_access: { input: ["text", "text"], output: "ResultUnit", mode: "update" },
  search_node_paths: { input: ["SearchNodePathsRequest"], output: "ResultSearch", mode: "query" },
  search_nodes: { input: ["SearchNodesRequest"], output: "ResultSearch", mode: "query" },
  source_evidence: { input: ["SourceEvidenceRequest"], output: "ResultSourceEvidence", mode: "query" },
  purchase_database_credits: { input: ["text", "nat64"], output: "ResultCreditsPurchase", mode: "update" },
  write_node: { input: ["WriteNodeRequest"], output: "ResultWriteNode", mode: "update" },
  write_source_for_generation: { input: ["WriteSourceForGenerationRequest"], output: "ResultWriteSourceForGeneration", mode: "update" }
};

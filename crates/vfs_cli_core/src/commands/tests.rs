use super::{command_requires_write_cycles_available, run_vfs_command};
use crate::cli::{CyclesCommand, NodeKindArg, VfsCommand};
use crate::connection::ResolvedConnection;
use anyhow::{Result, anyhow};
use async_trait::async_trait;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tempfile::tempdir;
use vfs_client::VfsApi;
use vfs_types::*;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn test_cycles_top_up_config() -> CyclesTopUpConfig {
    CyclesTopUpConfig {
        enabled: true,
        launcher_principal: "xfug4-5qaaa-aaaak-afowa-cai".to_string(),
        threshold_cycles: 2_000_000_000_000,
    }
}

#[derive(Default)]
struct MockClient {
    nodes: Vec<Node>,
    entries: Vec<NodeEntry>,
    created: Mutex<u32>,
    database_lists: Mutex<u32>,
    database_cycle_purchases: Mutex<Vec<DatabaseCyclesPurchaseRequest>>,
    database_cycles_history: Mutex<Vec<String>>,
    database_cycles_pending: Mutex<Vec<String>>,
    market_entitlements: Mutex<Vec<(Option<String>, u32)>>,
    database_summaries: Mutex<Vec<DatabaseSummary>>,
    metadata_updates: Mutex<Vec<UpdateDatabaseMetadataRequest>>,
    sql_queries: Mutex<Vec<(String, String, u32)>>,
    cycles_configs: Mutex<u32>,
    fail_cycles_config: Mutex<bool>,
    write_cycle_checks: Mutex<Vec<String>>,
    write_cycle_check_error: Mutex<Option<String>>,
    writes: Mutex<Vec<WriteNodeRequest>>,
    write_batches: Mutex<Vec<WriteNodesRequest>>,
    published_nodes: Mutex<Vec<PublishNodeRequest>>,
    publication_queries: Mutex<Vec<PublishNodeRequest>>,
    unpublished_nodes: Mutex<Vec<PublishNodeRequest>>,
    public_node_reads: Mutex<Vec<String>>,
    node_publication: Mutex<Option<NodePublication>>,
    public_node: Mutex<Option<PublicNode>>,
    deletes: Mutex<Vec<DeleteNodeRequest>>,
    node_lists: Mutex<Vec<ListNodesRequest>>,
    child_lists: Mutex<Vec<ListChildrenRequest>>,
    contexts: Mutex<Vec<NodeContextRequest>>,
    memory_manifests: Mutex<Vec<String>>,
    query_contexts: Mutex<Vec<QueryContextRequest>>,
    source_evidence_requests: Mutex<Vec<SourceEvidenceRequest>>,
    export_snapshots: Mutex<Vec<ExportSnapshotRequest>>,
    fetch_updates_requests: Mutex<Vec<FetchUpdatesRequest>>,
    neighborhoods: Mutex<Vec<GraphNeighborhoodRequest>>,
}

fn test_connection() -> ResolvedConnection {
    ResolvedConnection {
        replica_host: "http://127.0.0.1:8000".to_string(),
        canister_id: "aaaaa-aa".to_string(),
        database_id: Some("alpha".to_string()),
        replica_host_source: "test".to_string(),
        canister_id_source: "test".to_string(),
        database_id_source: Some("test".to_string()),
    }
}

fn node(path: &str, kind: NodeKind, etag: &str) -> Node {
    Node {
        path: path.to_string(),
        kind,
        content: String::new(),
        created_at: 1,
        updated_at: 2,
        etag: etag.to_string(),
        metadata_json: "{}".to_string(),
    }
}

fn entry(path: &str, kind: NodeEntryKind, etag: &str) -> NodeEntry {
    let has_children = kind == NodeEntryKind::Folder;
    NodeEntry {
        path: path.to_string(),
        kind,
        updated_at: 2,
        etag: etag.to_string(),
        has_children,
    }
}

#[async_trait]
impl VfsApi for MockClient {
    async fn status(&self, _database_id: &str) -> Result<Status> {
        unreachable!()
    }
    async fn create_database(&self, name: &str) -> Result<CreateDatabaseResult> {
        let mut created = self.created.lock().unwrap();
        *created += 1;
        Ok(CreateDatabaseResult {
            database_id: "db_testgenerated".to_string(),
            name: name.to_string(),
            status: vfs_types::DatabaseStatus::Active,
            initial_free_grant_applied: true,
        })
    }
    async fn purchase_database_cycles(
        &self,
        request: DatabaseCyclesPurchaseRequest,
    ) -> Result<CyclesPurchaseResult> {
        self.database_cycle_purchases.lock().unwrap().push(request);
        Ok(CyclesPurchaseResult {
            block_index: 7,
            amount_cycles: 1_250,
            balance_cycles: 1_250,
        })
    }
    async fn list_database_cycle_entries(
        &self,
        database_id: &str,
        _cursor: Option<u64>,
        _limit: u32,
    ) -> Result<DatabaseCycleEntryPage> {
        self.database_cycles_history
            .lock()
            .unwrap()
            .push(database_id.to_string());
        Ok(DatabaseCycleEntryPage {
            entries: vec![DatabaseCycleEntry {
                entry_id: 1,
                database_id: database_id.to_string(),
                kind: "cycles_purchase".to_string(),
                amount_cycles: 500_000,
                balance_after_cycles: 500_000,
                payment_amount_e8s: Some(50_000_000_000),
                caller: "caller".to_string(),
                method: Some("purchase_database_cycles".to_string()),
                cycles_delta: None,
                cycles_per_kinic: None,
                ledger_block_index: Some(7),
                created_at_ms: 1,
            }],
            next_cursor: None,
        })
    }
    async fn list_database_cycles_pending_purchases(
        &self,
        database_id: &str,
    ) -> Result<Vec<DatabaseCyclesPendingPurchase>> {
        self.database_cycles_pending
            .lock()
            .unwrap()
            .push(database_id.to_string());
        Ok(vec![DatabaseCyclesPendingPurchase {
            operation_id: 9,
            database_id: database_id.to_string(),
            status: "ambiguous".to_string(),
            amount_cycles: 1_250,
            payment_amount_e8s: 125_000_000,
            ledger_block_index: None,
            created_at_ms: 3,
            required_action: "billing_authority_review".to_string(),
        }])
    }
    async fn market_list_entitlements(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<MarketEntitlementPage> {
        self.market_entitlements
            .lock()
            .unwrap()
            .push((cursor, limit));
        Ok(MarketEntitlementPage {
            entitlements: vec![MarketEntitlement {
                database_id: "db_market".to_string(),
                buyer_principal: "buyer".to_string(),
                listing_id: "listing-1".to_string(),
                order_id: "order-1".to_string(),
                purchased_at_ms: 123,
                status: "active".to_string(),
            }],
            next_cursor: Some("next".to_string()),
        })
    }
    async fn get_cycles_billing_config(&self) -> Result<CyclesBillingConfig> {
        let mut configs = self.cycles_configs.lock().unwrap();
        *configs += 1;
        if *self.fail_cycles_config.lock().unwrap() {
            return Err(anyhow!("cycles config unavailable"));
        }
        Ok(CyclesBillingConfig {
            kinic_ledger_canister_id: "ryjl3-tyaaa-aaaaa-aaaba-cai".to_string(),
            billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai".to_string(),
            cycles_per_kinic: 1_000,
            min_update_cycles: 1,
            top_up: test_cycles_top_up_config(),
        })
    }
    async fn check_database_write_cycles(&self, database_id: &str) -> Result<()> {
        self.write_cycle_checks
            .lock()
            .unwrap()
            .push(database_id.to_string());
        if let Some(error) = self.write_cycle_check_error.lock().unwrap().take() {
            return Err(anyhow!(error));
        }
        Ok(())
    }
    async fn update_database_metadata(
        &self,
        request: UpdateDatabaseMetadataRequest,
    ) -> Result<vfs_types::DatabaseMetadata> {
        self.metadata_updates.lock().unwrap().push(request.clone());
        Ok(vfs_types::DatabaseMetadata {
            name: request.name,
            description: request.description,
            llm_summary: request.llm_summary,
            tags_json: request.tags_json,
        })
    }
    async fn list_databases(&self) -> Result<Vec<DatabaseSummary>> {
        let mut lists = self.database_lists.lock().unwrap();
        *lists += 1;
        let summaries = self.database_summaries.lock().unwrap();
        if !summaries.is_empty() {
            return Ok(summaries.clone());
        }
        Ok(vec![DatabaseSummary {
            database_id: "alpha".to_string(),
            name: "Alpha".to_string(),
            metadata: Some(vfs_types::DatabaseMetadata {
                name: "Alpha".to_string(),
                description: String::new(),
                llm_summary: None,
                tags_json: "[]".to_string(),
            }),
            status: DatabaseStatus::Active,
            role: DatabaseRole::Owner,
            logical_size_bytes: 42,
            cycles_balance: Some(1_000_000),
            cycles_suspended_at_ms: None,
            deleted_at_ms: None,
        }])
    }
    async fn read_node(&self, _database_id: &str, path: &str) -> Result<Option<Node>> {
        Ok(self.nodes.iter().find(|node| node.path == path).cloned())
    }
    async fn publish_node(&self, request: PublishNodeRequest) -> Result<NodePublication> {
        self.published_nodes.lock().unwrap().push(request.clone());
        Ok(NodePublication {
            public_id: "0123456789abcdef0123456789abcdef".to_string(),
            database_id: request.database_id,
            path: request.path,
            published_at_ms: 10,
        })
    }
    async fn get_node_publication(
        &self,
        request: PublishNodeRequest,
    ) -> Result<Option<NodePublication>> {
        self.publication_queries.lock().unwrap().push(request);
        Ok(self.node_publication.lock().unwrap().clone())
    }
    async fn unpublish_node(&self, request: PublishNodeRequest) -> Result<()> {
        self.unpublished_nodes.lock().unwrap().push(request);
        Ok(())
    }
    async fn read_public_node(&self, public_id: &str) -> Result<Option<PublicNode>> {
        self.public_node_reads
            .lock()
            .unwrap()
            .push(public_id.to_string());
        Ok(self.public_node.lock().unwrap().clone())
    }
    async fn query_database_sql_json(
        &self,
        database_id: &str,
        sql: &str,
        limit: u32,
    ) -> Result<IndexSqlJsonQueryResult> {
        self.sql_queries
            .lock()
            .unwrap()
            .push((database_id.to_string(), sql.to_string(), limit));
        Ok(IndexSqlJsonQueryResult {
            rows: vec![r#"{"ok":1}"#.to_string()],
            row_count: 1,
            limit,
        })
    }
    async fn read_node_context(&self, request: NodeContextRequest) -> Result<Option<NodeContext>> {
        self.contexts.lock().unwrap().push(request.clone());
        Ok(Some(NodeContext {
            node: Node {
                path: request.path,
                kind: NodeKind::File,
                content: "body".to_string(),
                created_at: 1,
                updated_at: 2,
                etag: "etag".to_string(),
                metadata_json: "{}".to_string(),
            },
            incoming_links: Vec::new(),
            outgoing_links: Vec::new(),
        }))
    }
    async fn memory_manifest(&self, database_id: &str) -> Result<MemoryManifest> {
        self.memory_manifests
            .lock()
            .unwrap()
            .push(database_id.to_string());
        Ok(MemoryManifest {
            api_version: "kinic-stores-v1".to_string(),
            purpose: "test".to_string(),
            enabled_stores: vec!["knowledge".to_string()],
            roots: vec![MemoryRoot {
                path: "/Knowledge".to_string(),
                kind: "knowledge".to_string(),
            }],
            entry_roots: Vec::new(),
            capabilities: Vec::new(),
            canonical_roles: Vec::new(),
            write_policy: "stores_read_only".to_string(),
            recommended_entrypoint: "query_context".to_string(),
            max_depth: 2,
            max_query_limit: 100,
            budget_unit: "approx_chars_from_tokens".to_string(),
        })
    }
    async fn query_context(&self, request: QueryContextRequest) -> Result<QueryContext> {
        self.query_contexts.lock().unwrap().push(request.clone());
        Ok(QueryContext {
            namespace: request.namespace.unwrap_or_else(|| "/Memory".to_string()),
            task: request.task,
            search_hits: Vec::new(),
            nodes: Vec::new(),
            graph_links: Vec::new(),
            evidence: Vec::new(),
            truncated: false,
        })
    }
    async fn source_evidence(&self, request: SourceEvidenceRequest) -> Result<SourceEvidence> {
        self.source_evidence_requests
            .lock()
            .unwrap()
            .push(request.clone());
        Ok(SourceEvidence {
            node_path: request.node_path,
            refs: vec![SourceEvidenceRef {
                source_path: "/Sources/web/a.md".to_string(),
                via_path: "/Knowledge/a.md".to_string(),
                raw_href: "https://example.com".to_string(),
                link_text: "Source".to_string(),
                source_etag: Some("source-etag".to_string()),
                source_updated_at: Some(2),
                source_content_hash: Some("sha256:test".to_string()),
            }],
        })
    }
    async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        self.node_lists.lock().unwrap().push(request);
        Ok(self.entries.clone())
    }
    async fn list_children(&self, request: ListChildrenRequest) -> Result<Vec<ChildNode>> {
        self.child_lists.lock().unwrap().push(request);
        Ok(vec![ChildNode {
            path: "/Knowledge/alpha.md".to_string(),
            name: "alpha.md".to_string(),
            kind: NodeEntryKind::File,
            updated_at: Some(10),
            etag: Some("etag".to_string()),
            size_bytes: Some(5),
            is_virtual: false,
            has_children: false,
            is_published: false,
        }])
    }
    async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
        self.writes.lock().unwrap().push(request.clone());
        Ok(WriteNodeResult {
            node: NodeMutationAck {
                path: request.path,
                kind: request.kind,
                updated_at: 0,
                etag: "etag".to_string(),
            },
            created: true,
        })
    }
    async fn write_nodes(&self, request: WriteNodesRequest) -> Result<Vec<WriteNodeResult>> {
        self.write_batches.lock().unwrap().push(request.clone());
        Ok(request
            .nodes
            .into_iter()
            .map(|node| WriteNodeResult {
                node: NodeMutationAck {
                    path: node.path,
                    kind: node.kind,
                    updated_at: 0,
                    etag: "etag".to_string(),
                },
                created: true,
            })
            .collect())
    }
    async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
        unreachable!()
    }
    async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
        unreachable!()
    }
    async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
        self.deletes.lock().unwrap().push(request.clone());
        Ok(DeleteNodeResult { path: request.path })
    }
    async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
        unreachable!()
    }
    async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
        unreachable!()
    }
    async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
        unreachable!()
    }
    async fn graph_neighborhood(&self, request: GraphNeighborhoodRequest) -> Result<Vec<LinkEdge>> {
        self.neighborhoods.lock().unwrap().push(request);
        Ok(Vec::new())
    }
    async fn multi_edit_node(&self, _request: MultiEditNodeRequest) -> Result<MultiEditNodeResult> {
        unreachable!()
    }
    async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        unreachable!()
    }
    async fn search_node_paths(
        &self,
        _request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>> {
        unreachable!()
    }
    async fn export_snapshot(
        &self,
        request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse> {
        self.export_snapshots.lock().unwrap().push(request);
        Ok(ExportSnapshotResponse {
            snapshot_revision: "rev-2".to_string(),
            snapshot_session_id: None,
            nodes: vec![node("/Knowledge/a.md", NodeKind::File, "etag")],
            next_cursor: Some("cursor-2".to_string()),
        })
    }
    async fn fetch_updates(&self, request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse> {
        self.fetch_updates_requests.lock().unwrap().push(request);
        Ok(FetchUpdatesResponse {
            snapshot_revision: "rev-3".to_string(),
            changed_nodes: vec![node("/Knowledge/b.md", NodeKind::File, "etag")],
            removed_paths: vec!["/Knowledge/old.md".to_string()],
            next_cursor: None,
        })
    }
}

#[tokio::test]
async fn write_node_supports_source_kind() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("source.md");
    std::fs::write(&input, "# Source").expect("input should write");
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::WriteNode {
            path: "/Sources/source/source.md".to_string(),
            kind: NodeKindArg::Source,
            input,
            metadata_json: "{}".to_string(),
            expected_etag: None,
            json: false,
        },
    )
    .await
    .expect("write should succeed");
    assert_eq!(client.writes.lock().unwrap()[0].kind, NodeKind::Source);
}

#[tokio::test]
async fn write_node_supports_folder_kind() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("folder.txt");
    std::fs::write(&input, "").expect("input should write");
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::WriteNode {
            path: "/Knowledge/folder".to_string(),
            kind: NodeKindArg::Folder,
            input,
            metadata_json: "{}".to_string(),
            expected_etag: None,
            json: false,
        },
    )
    .await
    .expect("write should succeed");
    assert_eq!(client.writes.lock().unwrap()[0].kind, NodeKind::Folder);
}

#[tokio::test]
async fn mutating_command_checks_write_cycles_before_write() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("source.md");
    std::fs::write(&input, "# Source").expect("input should write");
    let client = MockClient::default();

    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::WriteNode {
            path: "/Sources/source/source.md".to_string(),
            kind: NodeKindArg::Source,
            input,
            metadata_json: "{}".to_string(),
            expected_etag: None,
            json: true,
        },
    )
    .await
    .expect("write should pass after cycles check");

    assert_eq!(
        *client.write_cycle_checks.lock().unwrap(),
        vec!["alpha".to_string()]
    );
    assert_eq!(client.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn mutating_command_rejects_canister_write_cycles_error_before_write() {
    let client = MockClient {
        write_cycle_check_error: Mutex::new(Some("database cycles are suspended".to_string())),
        ..MockClient::default()
    };

    let error = run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::MkdirNode {
            path: "/Knowledge/new".to_string(),
            json: false,
        },
    )
    .await
    .expect_err("canister cycles check should reject");

    assert!(error.to_string().contains("cycles are suspended"));
    assert_eq!(
        *client.write_cycle_checks.lock().unwrap(),
        vec!["alpha".to_string()]
    );
    assert!(client.writes.lock().unwrap().is_empty());
}

#[test]
fn cycles_gate_covers_content_mutation_commands_only() {
    assert!(command_requires_write_cycles_available(
        &VfsCommand::WriteNode {
            path: "/Knowledge/a.md".to_string(),
            kind: NodeKindArg::File,
            input: PathBuf::from("a.md"),
            metadata_json: "{}".to_string(),
            expected_etag: None,
            json: false,
        }
    ));
    assert!(command_requires_write_cycles_available(
        &VfsCommand::AppendNode {
            path: "/Knowledge/a.md".to_string(),
            input: PathBuf::from("a.md"),
            kind: None,
            metadata_json: None,
            expected_etag: None,
            separator: None,
            json: false,
        }
    ));
    assert!(command_requires_write_cycles_available(
        &VfsCommand::EditNode {
            path: "/Knowledge/a.md".to_string(),
            old_text: "a".to_string(),
            new_text: "b".to_string(),
            expected_etag: None,
            replace_all: false,
            json: false,
        }
    ));
    assert!(command_requires_write_cycles_available(
        &VfsCommand::DeleteNode {
            path: "/Knowledge/a.md".to_string(),
            expected_etag: None,
            expected_folder_index_etag: None,
            json: false,
        }
    ));
    assert!(command_requires_write_cycles_available(
        &VfsCommand::DeleteTree {
            path: "/Knowledge/a".to_string(),
            json: false,
        }
    ));
    assert!(command_requires_write_cycles_available(
        &VfsCommand::MkdirNode {
            path: "/Knowledge/a".to_string(),
            json: false,
        }
    ));
    assert!(command_requires_write_cycles_available(
        &VfsCommand::MoveNode {
            from_path: "/Knowledge/a.md".to_string(),
            to_path: "/Knowledge/b.md".to_string(),
            expected_etag: None,
            expected_target_etag: None,
            overwrite: false,
            json: false,
        }
    ));
    assert!(command_requires_write_cycles_available(
        &VfsCommand::MultiEditNode {
            path: "/Knowledge/a.md".to_string(),
            edits_file: PathBuf::from("edits.json"),
            expected_etag: None,
            json: false,
        }
    ));
    assert!(!command_requires_write_cycles_available(
        &VfsCommand::ReadNode {
            path: "/Knowledge/a.md".to_string(),
            metadata_only: false,
            fields: None,
            json: false,
        }
    ));
    assert!(!command_requires_write_cycles_available(
        &VfsCommand::PublishNode {
            path: "/Knowledge/a.md".to_string(),
            json: false,
        }
    ));
    assert!(!command_requires_write_cycles_available(
        &VfsCommand::UnpublishNode {
            path: "/Knowledge/a.md".to_string(),
            json: false,
        }
    ));
    assert!(!command_requires_write_cycles_available(
        &VfsCommand::Database {
            command: super::DatabaseCommand::PurchaseCycles {
                database_id: "alpha".to_string(),
                kinic: "1".to_string(),
            },
        }
    ));
}

#[tokio::test]
async fn node_publication_commands_dispatch_without_cycles_preflight() {
    let publication = NodePublication {
        public_id: "0123456789abcdef0123456789abcdef".to_string(),
        database_id: "alpha".to_string(),
        path: "/Knowledge/a.md".to_string(),
        published_at_ms: 10,
    };
    let client = MockClient {
        node_publication: Mutex::new(Some(publication)),
        ..MockClient::default()
    };

    for json in [false, true] {
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::PublishNode {
                path: "/Knowledge/a.md".to_string(),
                json,
            },
        )
        .await
        .expect("publish-node should succeed");
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::GetNodePublication {
                path: "/Knowledge/a.md".to_string(),
                json,
            },
        )
        .await
        .expect("get-node-publication should succeed");
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::UnpublishNode {
                path: "/Knowledge/a.md".to_string(),
                json,
            },
        )
        .await
        .expect("unpublish-node should succeed");
    }

    for requests in [
        &client.published_nodes,
        &client.publication_queries,
        &client.unpublished_nodes,
    ] {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].database_id, "alpha");
        assert_eq!(requests[0].path, "/Knowledge/a.md");
    }
    assert!(client.write_cycle_checks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn get_node_publication_reports_unpublished_as_success() {
    let client = MockClient::default();

    for json in [false, true] {
        run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::GetNodePublication {
                path: "/Knowledge/unpublished.md".to_string(),
                json,
            },
        )
        .await
        .expect("an unpublished node should be a successful empty result");
    }
}

#[tokio::test]
async fn read_public_node_does_not_require_database_selection() {
    let client = MockClient {
        public_node: Mutex::new(Some(PublicNode {
            content: "# Published".to_string(),
            updated_at: 20,
            published_at_ms: 10,
        })),
        ..MockClient::default()
    };
    let mut connection = test_connection();
    connection.database_id = None;
    connection.database_id_source = None;

    for json in [false, true] {
        run_vfs_command(
            &client,
            &connection,
            VfsCommand::ReadPublicNode {
                public_id: "0123456789abcdef0123456789abcdef".to_string(),
                json,
            },
        )
        .await
        .expect("read-public-node should not require a database");
    }

    assert_eq!(
        *client.public_node_reads.lock().unwrap(),
        vec![
            "0123456789abcdef0123456789abcdef".to_string(),
            "0123456789abcdef0123456789abcdef".to_string()
        ]
    );
}

#[tokio::test]
async fn read_public_node_errors_when_public_id_is_missing() {
    let client = MockClient::default();
    let error = run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::ReadPublicNode {
            public_id: "ffffffffffffffffffffffffffffffff".to_string(),
            json: false,
        },
    )
    .await
    .expect_err("missing public id should fail");

    assert!(
        error
            .to_string()
            .contains("public node not found: ffffffffffffffffffffffffffffffff")
    );
}

#[tokio::test]
async fn write_nodes_dispatches_one_batch() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("nodes.json");
    std::fs::write(
        &input,
        r#"[
  {"path": "/Knowledge/a.md", "kind": "file", "content": "alpha"},
  {"path": "/Sources/source/source.md", "kind": "source", "content": "source", "metadata_json": "{\"url\":\"https://example.com\"}", "expected_etag": "etag-source"}
]"#,
    )
    .expect("input should write");
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::WriteNodes { input, json: true },
    )
    .await
    .expect("batch write should succeed");

    let batches = client.write_batches.lock().unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].database_id, "alpha");
    assert_eq!(batches[0].nodes.len(), 2);
    assert_eq!(batches[0].nodes[0].metadata_json, "{}");
    assert_eq!(batches[0].nodes[1].kind, NodeKind::Source);
    assert_eq!(
        batches[0].nodes[1].expected_etag.as_deref(),
        Some("etag-source")
    );
}

#[tokio::test]
async fn write_nodes_allows_source_kind_without_path_schema() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("nodes.json");
    std::fs::write(
        &input,
        r#"[{"path": "/Knowledge/source.md", "kind": "source", "content": "source"}]"#,
    )
    .expect("input should write");
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::WriteNodes { input, json: true },
    )
    .await
    .expect("source kind should not be schema-gated by CLI");

    let batches = client.write_batches.lock().unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].nodes[0].path, "/Knowledge/source.md");
    assert_eq!(batches[0].nodes[0].kind, NodeKind::Source);
}

#[tokio::test]
async fn write_nodes_rejects_empty_input() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("nodes.json");
    std::fs::write(&input, "[]").expect("input should write");
    let client = MockClient::default();
    let error = run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::WriteNodes { input, json: true },
    )
    .await
    .expect_err("empty input should fail");

    assert!(error.to_string().contains("at least one node"));
    assert!(client.write_batches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn write_nodes_rejects_invalid_json() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("nodes.json");
    std::fs::write(&input, "{").expect("input should write");
    let client = MockClient::default();
    let error = run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::WriteNodes { input, json: true },
    )
    .await
    .expect_err("invalid json should fail");

    assert!(!error.to_string().is_empty());
    assert!(client.write_batches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn write_nodes_rejects_unknown_fields() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("nodes.json");
    std::fs::write(
        &input,
        r#"[{"path": "/Knowledge/a.md", "kind": "file", "content": "alpha", "expected_etga": "etag"}]"#,
    )
    .expect("input should write");
    let client = MockClient::default();
    let error = run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::WriteNodes { input, json: true },
    )
    .await
    .expect_err("unknown field should fail");

    assert!(error.to_string().contains("unknown field"));
    assert!(client.write_batches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn write_nodes_allows_folder_kind() {
    let dir = tempdir().expect("temp dir should exist");
    let input = PathBuf::from(dir.path()).join("nodes.json");
    std::fs::write(
        &input,
        r#"[{"path": "/Knowledge/folder", "kind": "folder", "content": ""}]"#,
    )
    .expect("input should write");
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::WriteNodes { input, json: true },
    )
    .await
    .expect("folder kind should dispatch");

    let batches = client.write_batches.lock().unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].nodes[0].kind, NodeKind::Folder);
}

#[tokio::test]
async fn list_children_sends_path_request() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::ListChildren {
            path: "/Knowledge".to_string(),
            json: true,
        },
    )
    .await
    .expect("list children should succeed");
    assert_eq!(client.child_lists.lock().unwrap()[0].path, "/Knowledge");
}

#[tokio::test]
async fn delete_node_autofills_folder_index_etag() {
    let client = MockClient {
        nodes: vec![
            node("/Knowledge/topic", NodeKind::Folder, "etag-folder"),
            node("/Knowledge/topic/index.md", NodeKind::File, "etag-index"),
        ],
        ..MockClient::default()
    };
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::DeleteNode {
            path: "/Knowledge/topic".to_string(),
            expected_etag: Some("etag-folder".to_string()),
            expected_folder_index_etag: None,
            json: true,
        },
    )
    .await
    .expect("folder delete should succeed");

    let deletes = client.deletes.lock().unwrap();
    assert_eq!(deletes[0].path, "/Knowledge/topic");
    assert_eq!(deletes[0].expected_etag.as_deref(), Some("etag-folder"));
    assert_eq!(
        deletes[0].expected_folder_index_etag.as_deref(),
        Some("etag-index")
    );
}

#[tokio::test]
async fn delete_node_keeps_explicit_folder_index_etag() {
    let client = MockClient {
        nodes: vec![
            node("/Knowledge/topic", NodeKind::Folder, "etag-folder"),
            node("/Knowledge/topic/index.md", NodeKind::File, "etag-index"),
        ],
        ..MockClient::default()
    };
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::DeleteNode {
            path: "/Knowledge/topic".to_string(),
            expected_etag: Some("etag-folder".to_string()),
            expected_folder_index_etag: Some("stale".to_string()),
            json: true,
        },
    )
    .await
    .expect("folder delete should dispatch");

    let deletes = client.deletes.lock().unwrap();
    assert_eq!(
        deletes[0].expected_folder_index_etag.as_deref(),
        Some("stale")
    );
}

#[tokio::test]
async fn delete_tree_autofills_folder_index_etag_for_folder_entries() {
    let client = MockClient {
        nodes: vec![node(
            "/Knowledge/topic/index.md",
            NodeKind::File,
            "etag-index",
        )],
        entries: vec![
            entry(
                "/Knowledge/topic/index.md",
                NodeEntryKind::File,
                "etag-index",
            ),
            entry("/Knowledge/topic", NodeEntryKind::Folder, "etag-folder"),
        ],
        ..MockClient::default()
    };
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::DeleteTree {
            path: "/Knowledge/topic".to_string(),
            json: true,
        },
    )
    .await
    .expect("tree delete should succeed");

    let deletes = client.deletes.lock().unwrap();
    let index_delete = deletes
        .iter()
        .find(|request| request.path == "/Knowledge/topic/index.md")
        .expect("index delete should dispatch");
    assert!(index_delete.expected_folder_index_etag.is_none());
    let folder_delete = deletes
        .iter()
        .find(|request| request.path == "/Knowledge/topic")
        .expect("folder delete should dispatch");
    assert_eq!(
        folder_delete.expected_folder_index_etag.as_deref(),
        Some("etag-index")
    );
}

#[tokio::test]
async fn delete_tree_rejects_limit_sized_listing_before_deleting() {
    let entries = (0..super::DELETE_TREE_LIST_LIMIT)
        .map(|index| {
            entry(
                &format!("/Knowledge/topic/{index:03}.md"),
                NodeEntryKind::File,
                &format!("etag-{index}"),
            )
        })
        .collect::<Vec<_>>();
    let client = MockClient {
        entries,
        ..MockClient::default()
    };

    let error = run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::DeleteTree {
            path: "/Knowledge/topic".to_string(),
            json: true,
        },
    )
    .await
    .expect_err("limit-sized tree listing should reject before delete");

    assert!(error.to_string().contains("delete-tree target exceeds"));
    assert!(client.deletes.lock().unwrap().is_empty());
    let lists = client.node_lists.lock().unwrap();
    assert_eq!(lists.len(), 1);
    assert_eq!(lists[0].limit, super::DELETE_TREE_LIST_LIMIT);
}

#[tokio::test]
async fn database_create_uses_name_and_prints_generated_id() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::Database {
            command: super::DatabaseCommand::Create {
                name: "Team skills".to_string(),
            },
        },
    )
    .await
    .expect("database create should succeed");
    assert_eq!(*client.created.lock().unwrap(), 1);
}

#[tokio::test]
async fn database_cycles_purchase_calls_client() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::Database {
            command: super::DatabaseCommand::PurchaseCycles {
                database_id: "db_alpha".to_string(),
                kinic: "1.25".to_string(),
            },
        },
    )
    .await
    .expect("database cycle purchase should succeed");
    assert_eq!(
        *client.database_cycle_purchases.lock().unwrap(),
        vec![DatabaseCyclesPurchaseRequest {
            database_id: "db_alpha".to_string(),
            payment_amount_e8s: 125_000_000,
            min_expected_cycles: 1_250,
        }]
    );
}

#[tokio::test]
async fn database_cycles_purchase_requires_cycles_quote() {
    let client = MockClient {
        fail_cycles_config: Mutex::new(true),
        ..MockClient::default()
    };
    let error = run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::Database {
            command: super::DatabaseCommand::PurchaseCycles {
                database_id: "db_alpha".to_string(),
                kinic: "1.25".to_string(),
            },
        },
    )
    .await
    .expect_err("database cycle purchase should require quote config");
    assert!(error.to_string().contains("cycles config unavailable"));
    assert!(client.database_cycle_purchases.lock().unwrap().is_empty());
}

#[tokio::test]
async fn database_cycles_purchase_rejects_invalid_kinic_amounts() {
    for kinic in ["0", "0.000000001", "abc", "184467440737.09551616"] {
        let client = MockClient::default();
        let error = run_vfs_command(
            &client,
            &test_connection(),
            VfsCommand::Database {
                command: super::DatabaseCommand::PurchaseCycles {
                    database_id: "db_alpha".to_string(),
                    kinic: kinic.to_string(),
                },
            },
        )
        .await
        .expect_err("invalid KINIC amount should reject");
        assert!(error.to_string().contains("KINIC amount"));
        assert!(client.database_cycle_purchases.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn database_cycles_history_calls_client() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::Database {
            command: super::DatabaseCommand::CyclesHistory {
                database_id: "db_alpha".to_string(),
                json: false,
            },
        },
    )
    .await
    .expect("database cycles-history should succeed");
    assert_eq!(
        *client.database_cycles_history.lock().unwrap(),
        vec!["db_alpha".to_string()]
    );
}

#[tokio::test]
async fn database_cycles_pending_calls_client() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::Database {
            command: super::DatabaseCommand::CyclesPending {
                database_id: "db_alpha".to_string(),
                json: false,
            },
        },
    )
    .await
    .expect("database cycles-pending should succeed");
    assert_eq!(
        *client.database_cycles_pending.lock().unwrap(),
        vec!["db_alpha".to_string()]
    );
}

#[tokio::test]
async fn market_entitlements_calls_client_without_database_id() {
    let client = MockClient::default();
    let mut connection = test_connection();
    connection.database_id = None;

    run_vfs_command(
        &client,
        &connection,
        VfsCommand::Market {
            command: super::MarketCommand::Entitlements {
                cursor: Some("cursor-1".to_string()),
                limit: 50,
                json: false,
            },
        },
    )
    .await
    .expect("market entitlements should not require selected database");

    assert_eq!(
        *client.market_entitlements.lock().unwrap(),
        vec![(Some("cursor-1".to_string()), 50)]
    );
}

#[test]
fn database_cycles_url_uses_browser_origin() {
    let url = super::database_cycles_url(Some("http://127.0.0.1:3000/"), "db_alpha")
        .expect("url should build");

    assert_eq!(url, "http://127.0.0.1:3000/cycles?database_id=db_alpha");
}

#[test]
fn database_cycles_url_rejects_unsupported_database_id() {
    for database_id in ["db alpha", "bad/path", ""] {
        let error = super::database_cycles_url(Some("http://127.0.0.1:3000/"), database_id)
            .expect_err("unsupported database id should fail");
        assert!(
            error
                .to_string()
                .contains("database_id contains unsupported characters")
        );
    }
}

#[test]
fn database_cycles_url_rejects_empty_browser_origin() {
    let error =
        super::database_cycles_url(Some(""), "db_alpha").expect_err("empty origin should fail");
    assert!(error.to_string().contains("browser origin"));
}

#[test]
fn database_cycles_open_warning_keeps_url_actionable() {
    let error = anyhow!("xdg-open missing");
    let warning = super::browser_open_warning(&error);

    assert!(warning.contains("warning: could not open browser automatically"));
    assert!(warning.contains("open the URL manually"));
    assert!(warning.contains("xdg-open missing"));
}

#[tokio::test]
async fn cycles_config_json_calls_client() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::Cycles {
            command: CyclesCommand::Config { json: true },
        },
    )
    .await
    .expect("cycles config should succeed");
    assert_eq!(*client.cycles_configs.lock().unwrap(), 1);
}

#[test]
fn cycles_config_text_includes_billing_authority_principal() {
    let lines = super::cycles_config_lines(
        &CyclesBillingConfig {
            kinic_ledger_canister_id: "ryjl3-tyaaa-aaaaa-aaaba-cai".to_string(),
            billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai".to_string(),
            cycles_per_kinic: 1_000,
            min_update_cycles: 1,
            top_up: test_cycles_top_up_config(),
        },
        KINIC_LEDGER_FEE_E8S,
    );

    assert!(lines.contains(&"billing_authority_id\trrkah-fqaaa-aaaaa-aaaaq-cai".to_string()));
    assert!(lines.contains(&"ledger_fee_e8s\t100000".to_string()));
}

#[tokio::test]
async fn database_metadata_reads_input_and_calls_client() {
    let client = MockClient::default();
    let dir = tempdir().expect("tempdir should be created");
    let input = dir.path().join("metadata.json");
    fs::write(
        &input,
        r#"{
          "name": " Alpha metadata ",
          "description": " Public wiki retrieval metadata. ",
          "llm_summary": " Search terms and retrieval scope. ",
          "tags_json": "[\"kinic-wiki\",\"clipper\"]"
        }"#,
    )
    .expect("metadata fixture should be written");
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::Database {
            command: super::DatabaseCommand::Metadata {
                database_id: "db_alpha".to_string(),
                input,
                json: false,
            },
        },
    )
    .await
    .expect("database metadata update should succeed");
    let updates = client.metadata_updates.lock().unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].database_id, "db_alpha");
    assert_eq!(updates[0].name, "Alpha metadata");
    assert_eq!(updates[0].description, "Public wiki retrieval metadata.");
    assert_eq!(
        updates[0].llm_summary.as_deref(),
        Some("Search terms and retrieval scope.")
    );
    assert_eq!(updates[0].tags_json, r#"["kinic-wiki","clipper"]"#);
}

#[tokio::test]
async fn database_metadata_rejects_invalid_tags_json() {
    let client = MockClient::default();
    let dir = tempdir().expect("tempdir should be created");
    let input = dir.path().join("metadata.json");
    fs::write(
        &input,
        r#"{
          "name": "Alpha",
          "description": "Description",
          "llm_summary": "Summary",
          "tags_json": "{\"tag\":\"not-array\"}"
        }"#,
    )
    .expect("metadata fixture should be written");
    let error = run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::Database {
            command: super::DatabaseCommand::Metadata {
                database_id: "db_alpha".to_string(),
                input,
                json: false,
            },
        },
    )
    .await
    .expect_err("invalid tags_json should reject");

    assert!(
        error
            .to_string()
            .contains("database metadata tags_json must be a JSON string array")
    );
    assert!(client.metadata_updates.lock().unwrap().is_empty());
}

#[tokio::test]
async fn database_metadata_rejects_empty_name() {
    let client = MockClient::default();
    let dir = tempdir().expect("tempdir should be created");
    let input = dir.path().join("metadata.json");
    fs::write(
        &input,
        r#"{
          "name": " ",
          "description": "Description",
          "llm_summary": "Summary",
          "tags_json": "[\"alpha\"]"
        }"#,
    )
    .expect("metadata fixture should be written");
    let error = run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::Database {
            command: super::DatabaseCommand::Metadata {
                database_id: "db_alpha".to_string(),
                input,
                json: false,
            },
        },
    )
    .await
    .expect_err("empty name should reject");

    assert!(
        error
            .to_string()
            .contains("database metadata name must not be empty")
    );
    assert!(client.metadata_updates.lock().unwrap().is_empty());
}

#[tokio::test]
async fn database_list_uses_list_databases_command() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::Database {
            command: super::DatabaseCommand::List { json: false },
        },
    )
    .await
    .expect("database list should succeed");
    assert_eq!(*client.database_lists.lock().unwrap(), 1);
}

#[tokio::test]
async fn query_sql_sends_database_sql_request() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::QuerySql {
            sql: "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1".to_string(),
            limit: 10,
            json: true,
        },
    )
    .await
    .expect("query-sql should succeed");

    assert_eq!(
        client.sql_queries.lock().unwrap().as_slice(),
        &[(
            "alpha".to_string(),
            "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1".to_string(),
            10
        )]
    );
    assert!(client.write_cycle_checks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn memory_manifest_sends_database_request() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::MemoryManifest { json: true },
    )
    .await
    .expect("memory-manifest should succeed");

    assert_eq!(
        client.memory_manifests.lock().unwrap().as_slice(),
        &["alpha".to_string()]
    );
    assert!(client.write_cycle_checks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn query_context_sends_store_request() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::QueryContext {
            task: "answer auth question".to_string(),
            entities: vec!["auth".to_string(), "ii".to_string()],
            namespace: Some("/Knowledge/auth".to_string()),
            budget_tokens: 12_000,
            depth: 2,
            no_evidence: true,
            json: true,
        },
    )
    .await
    .expect("query-context should succeed");

    let requests = client.query_contexts.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].database_id, "alpha");
    assert_eq!(requests[0].task, "answer auth question");
    assert_eq!(requests[0].entities, vec!["auth", "ii"]);
    assert_eq!(requests[0].namespace.as_deref(), Some("/Knowledge/auth"));
    assert_eq!(requests[0].budget_tokens, 12_000);
    assert_eq!(requests[0].depth, 2);
    assert!(!requests[0].include_evidence);
    assert!(client.write_cycle_checks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn source_evidence_sends_node_path_request() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::SourceEvidence {
            node_path: "/Knowledge/a.md".to_string(),
            json: true,
        },
    )
    .await
    .expect("source-evidence should succeed");

    let requests = client.source_evidence_requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].database_id, "alpha");
    assert_eq!(requests[0].node_path, "/Knowledge/a.md");
    assert!(client.write_cycle_checks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn export_snapshot_sends_scope_request() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::ExportSnapshot {
            prefix: Some("/Knowledge".to_string()),
            limit: 25,
            cursor: Some("cursor-1".to_string()),
            snapshot_revision: Some("rev-1".to_string()),
            json: true,
        },
    )
    .await
    .expect("export-snapshot should succeed");

    let requests = client.export_snapshots.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].database_id, "alpha");
    assert_eq!(requests[0].prefix.as_deref(), Some("/Knowledge"));
    assert_eq!(requests[0].limit, 25);
    assert_eq!(requests[0].cursor.as_deref(), Some("cursor-1"));
    assert_eq!(requests[0].snapshot_revision.as_deref(), Some("rev-1"));
    assert_eq!(requests[0].snapshot_session_id, None);
    assert!(client.write_cycle_checks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn fetch_updates_sends_delta_request() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::FetchUpdates {
            known_snapshot_revision: "rev-1".to_string(),
            prefix: Some("/Knowledge".to_string()),
            limit: 25,
            cursor: Some("cursor-1".to_string()),
            target_snapshot_revision: Some("rev-2".to_string()),
            json: true,
        },
    )
    .await
    .expect("fetch-updates should succeed");

    let requests = client.fetch_updates_requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].database_id, "alpha");
    assert_eq!(requests[0].known_snapshot_revision, "rev-1");
    assert_eq!(requests[0].prefix.as_deref(), Some("/Knowledge"));
    assert_eq!(requests[0].limit, 25);
    assert_eq!(requests[0].cursor.as_deref(), Some("cursor-1"));
    assert_eq!(
        requests[0].target_snapshot_revision.as_deref(),
        Some("rev-2")
    );
    assert!(client.write_cycle_checks.lock().unwrap().is_empty());
}

#[test]
fn sql_json_query_output_formats_rows_and_envelope() {
    let result = IndexSqlJsonQueryResult {
        rows: vec![r#"{"path":"/Knowledge/a.md"}"#.to_string()],
        row_count: 1,
        limit: 20,
    };

    assert_eq!(
        super::sql_json_query_output_lines(&result, false).expect("text output"),
        vec![r#"{"path":"/Knowledge/a.md"}"#.to_string()]
    );
    let json = super::sql_json_query_output_lines(&result, true).expect("json output");
    assert_eq!(json.len(), 1);
    assert!(json[0].contains("\"row_count\": 1"));
    assert!(json[0].contains("\"limit\": 20"));
}

#[test]
fn database_id_falls_back_to_env() {
    with_vfs_database_id("env-db", || {
        let database_id = super::database_id_or_env(None).expect("env database id should load");
        assert_eq!(database_id.as_ref(), "env-db");
    });
}

#[test]
fn explicit_database_id_overrides_env() {
    with_vfs_database_id("env-db", || {
        let database_id =
            super::database_id_or_env(Some("flag-db")).expect("flag database id should load");
        assert_eq!(database_id.as_ref(), "flag-db");
    });
}

#[test]
fn node_field_view_can_omit_content() {
    let node = vfs_types::Node {
        path: "/Knowledge/index.md".to_string(),
        kind: vfs_types::NodeKind::File,
        content: "large body".to_string(),
        created_at: 1,
        updated_at: 2,
        etag: "etag".to_string(),
        metadata_json: "{}".to_string(),
    };
    let metadata = super::node_field_view(&node, true, None).expect("metadata view");
    assert!(metadata.get("content").is_none());
    assert_eq!(metadata["path"], "/Knowledge/index.md");

    let fields = super::node_field_view(&node, false, Some("path,kind,etag")).expect("field view");
    assert!(fields.get("content").is_none());
    assert_eq!(
        fields.as_object().expect("fields should be object").len(),
        3
    );
}

fn with_vfs_database_id(value: &str, assert_fn: impl FnOnce()) {
    let _guard = ENV_LOCK.lock().expect("env lock should not be poisoned");
    let previous = std::env::var("VFS_DATABASE_ID").ok();
    unsafe {
        std::env::set_var("VFS_DATABASE_ID", value);
    }
    assert_fn();
    unsafe {
        match previous {
            Some(previous) => std::env::set_var("VFS_DATABASE_ID", previous),
            None => std::env::remove_var("VFS_DATABASE_ID"),
        }
    }
}

#[tokio::test]
async fn read_node_context_sends_link_limit_request() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::ReadNodeContext {
            path: "/Knowledge/a.md".to_string(),
            link_limit: 7,
            json: true,
        },
    )
    .await
    .expect("read context should succeed");
    let contexts = client.contexts.lock().unwrap();
    assert_eq!(contexts[0].path, "/Knowledge/a.md");
    assert_eq!(contexts[0].link_limit, 7);
}

#[tokio::test]
async fn graph_neighborhood_sends_depth_request() {
    let client = MockClient::default();
    run_vfs_command(
        &client,
        &test_connection(),
        VfsCommand::GraphNeighborhood {
            center_path: "/Knowledge/a.md".to_string(),
            depth: 2,
            limit: 9,
            json: true,
        },
    )
    .await
    .expect("graph neighborhood should succeed");
    let neighborhoods = client.neighborhoods.lock().unwrap();
    assert_eq!(neighborhoods[0].center_path, "/Knowledge/a.md");
    assert_eq!(neighborhoods[0].depth, 2);
    assert_eq!(neighborhoods[0].limit, 9);
}

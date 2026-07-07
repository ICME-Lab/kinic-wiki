use super::*;
use anyhow::Result;
use async_trait::async_trait;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tempfile::tempdir;
use vfs_types::{
    AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodesRequest, ListChildrenRequest, MoveNodeRequest, MoveNodeResult,
    MultiEditNodeRequest, MultiEditNodeResult, NodeContext, QueryContext, QueryContextRequest,
    SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest, SourceEvidence,
    SourceEvidenceRef, WriteNodeRequest, WriteNodeResult,
};

struct MockClient {
    context: QueryContext,
    recall_requests: Mutex<Vec<QueryContextRequest>>,
    readable_nodes: BTreeMap<String, Node>,
    read_node_calls: AtomicUsize,
    list_nodes_calls: AtomicUsize,
}

impl Default for MockClient {
    fn default() -> Self {
        Self {
            context: QueryContext {
                namespace: WIKI_ROOT_PATH.to_string(),
                task: String::new(),
                search_hits: Vec::new(),
                nodes: Vec::new(),
                graph_links: Vec::new(),
                evidence: Vec::new(),
                truncated: false,
            },
            recall_requests: Mutex::new(Vec::new()),
            readable_nodes: BTreeMap::new(),
            read_node_calls: AtomicUsize::new(0),
            list_nodes_calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl VfsApi for MockClient {
    async fn status(&self, _database_id: &str) -> Result<vfs_types::Status> {
        unreachable!()
    }

    async fn read_node(&self, _database_id: &str, path: &str) -> Result<Option<Node>> {
        self.read_node_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(node) = self.readable_nodes.get(path) {
            return Ok(Some(node.clone()));
        }
        bail!("unexpected read_node during context-pack export: {path}")
    }

    async fn list_nodes(
        &self,
        _request: vfs_types::ListNodesRequest,
    ) -> Result<Vec<vfs_types::NodeEntry>> {
        self.list_nodes_calls.fetch_add(1, Ordering::SeqCst);
        bail!("list_nodes must not be called during context-pack export")
    }

    async fn list_children(
        &self,
        _request: ListChildrenRequest,
    ) -> Result<Vec<vfs_types::ChildNode>> {
        unreachable!()
    }

    async fn write_node(&self, _request: WriteNodeRequest) -> Result<WriteNodeResult> {
        unreachable!()
    }

    async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
        unreachable!()
    }

    async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
        unreachable!()
    }

    async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
        unreachable!()
    }

    async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
        unreachable!()
    }

    async fn mkdir_node(
        &self,
        _request: vfs_types::MkdirNodeRequest,
    ) -> Result<vfs_types::MkdirNodeResult> {
        unreachable!()
    }

    async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
        unreachable!()
    }

    async fn multi_edit_node(
        &self,
        _request: MultiEditNodeRequest,
    ) -> Result<MultiEditNodeResult> {
        unreachable!()
    }

    async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        unreachable!()
    }

    async fn query_context(&self, request: QueryContextRequest) -> Result<QueryContext> {
        assert!(request.include_evidence);
        self.recall_requests
            .lock()
            .expect("recall request lock")
            .push(request.clone());
        Ok(QueryContext {
            namespace: request
                .namespace
                .unwrap_or_else(|| MEMORY_ROOT_PATH.to_string()),
            task: request.task,
            ..self.context.clone()
        })
    }

    async fn search_node_paths(
        &self,
        _request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>> {
        unreachable!()
    }

    async fn export_snapshot(
        &self,
        _request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse> {
        unreachable!()
    }

    async fn fetch_updates(
        &self,
        _request: FetchUpdatesRequest,
    ) -> Result<FetchUpdatesResponse> {
        unreachable!()
    }
}

fn test_node(path: &str, kind: NodeKind, content: &str, etag: &str) -> Node {
    Node {
        path: path.to_string(),
        kind,
        content: content.to_string(),
        created_at: 1,
        updated_at: 2,
        etag: etag.to_string(),
        metadata_json: "{}".to_string(),
    }
}

fn test_node_context(path: &str, content: &str, etag: &str) -> NodeContext {
    NodeContext {
        node: test_node(path, NodeKind::File, content, etag),
        incoming_links: Vec::new(),
        outgoing_links: Vec::new(),
    }
}

fn test_source_evidence(
    node_path: &str,
    source_path: &str,
    source_content_hash: &str,
) -> SourceEvidence {
    SourceEvidence {
        node_path: node_path.to_string(),
        refs: vec![SourceEvidenceRef {
            source_path: source_path.to_string(),
            via_path: node_path.to_string(),
            raw_href: source_path.to_string(),
            link_text: "Raw".to_string(),
            source_etag: Some("source-etag".to_string()),
            source_updated_at: Some(3),
            source_content_hash: Some(source_content_hash.to_string()),
        }],
    }
}

async fn export_reference_bundle(out: &Path, truncated: bool) {
    let mut client = MockClient::default();
    client.context.nodes = vec![test_node_context(
        "/Knowledge/projects/acme/facts.md",
        "Fact from /Sources/web/source.md\n",
        "wiki-etag",
    )];
    client.context.evidence = vec![test_source_evidence(
        "/Knowledge/projects/acme/facts.md",
        "/Sources/web/source.md",
        "sha256:sourcehash",
    )];
    client.context.truncated = truncated;
    export_okf_bundle(
        &client,
        "alpha",
        ContextPackExportOptions {
            task: "acme facts".to_string(),
            namespace: "/Knowledge/projects/acme".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            entities: vec!["acme".to_string()],
            out: out.to_path_buf(),
            expires_at: "2999-01-01T00:00:00Z".to_string(),
            trust_level: "team-approved".to_string(),
            approved_by: vec!["principal:aaaaa-aa".to_string()],
            overwrite: false,
            json: true,
        },
    )
    .await
    .expect("export");
}

#[test]
fn namespace_normalization_accepts_database_roots() {
    assert_eq!(normalize_wiki_namespace("/").expect("root"), "/");
    assert_eq!(
        normalize_wiki_namespace("/Knowledge/projects/acme/").expect("knowledge"),
        "/Knowledge/projects/acme"
    );
    assert_eq!(
        normalize_wiki_namespace("/Memory/session").expect("memory"),
        "/Memory/session"
    );
    assert_eq!(
        normalize_wiki_namespace("/Skills/tool").expect("skills"),
        "/Skills/tool"
    );
    assert_eq!(
        normalize_wiki_namespace("/Sessions/chat").expect("sessions"),
        "/Sessions/chat"
    );
    assert_eq!(
        normalize_wiki_namespace("/Sources/raw/a.md").expect("sources"),
        "/Sources/raw/a.md"
    );
    assert!(normalize_wiki_namespace("/Private/a.md").is_err());
}

fn write_reserved_files(dir: &Path) {
    fs::write(dir.join(INDEX_FILE), "# Index\n").expect("index");
    fs::write(dir.join(LOG_FILE), "# Log\n").expect("log");
    fs::write(
        dir.join(OKF_MANIFEST_FILE),
        serde_yaml::to_string(&OkfBundleManifest {
            okf_version: OKF_VERSION.to_string(),
            generated_at: "2999-01-01T00:00:00Z".to_string(),
            task: "test".to_string(),
            namespace: "/Knowledge/projects/acme".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            truncated: false,
            concept_count: 0,
            reference_count: 0,
            selected_nodes: Vec::new(),
        })
        .expect("manifest yaml"),
    )
    .expect("manifest");
}

fn write_kinic_fact(dir: &Path, content_hash: Option<String>, body: &str) -> PathBuf {
    fs::create_dir_all(dir.join("facts")).expect("facts");
    let hash_yaml = content_hash
        .map(|hash| format!("  content_hash: {hash}\n"))
        .unwrap_or_default();
    let path = dir.join("facts/fact.md");
    fs::write(
        &path,
        format!(
            "---\ntype: Fact\nresource: kinic://alpha/Knowledge/projects/acme/facts.md\nkinic:\n  database_id: alpha\n  root: /Knowledge/projects/acme\n{hash_yaml}---\n\n{body}\n"
        ),
    )
    .expect("fact");
    path
}

#[tokio::test]
async fn export_writes_okf_concepts_without_raw_source_text() {
    let out = tempdir().expect("tempdir");
    let mut client = MockClient::default();
    client.context.nodes = vec![test_node_context(
        "/Knowledge/projects/acme/facts.md",
        "Fact from /Sources/web/source.md\n",
        "wiki-etag",
    )];
    client.context.evidence = vec![test_source_evidence(
        "/Knowledge/projects/acme/facts.md",
        "/Sources/web/source.md",
        "sha256:sourcehash",
    )];
    client.context.truncated = true;

    let result = export_okf_bundle(
        &client,
        "alpha",
        ContextPackExportOptions {
            task: "acme facts".to_string(),
            namespace: "/Knowledge/projects/acme".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            entities: vec!["acme".to_string()],
            out: out.path().to_path_buf(),
            expires_at: "2999-01-01T00:00:00Z".to_string(),
            trust_level: "team-approved".to_string(),
            approved_by: vec!["principal:aaaaa-aa".to_string()],
            overwrite: false,
            json: true,
        },
    )
    .await
    .expect("export");

    assert_eq!(client.read_node_calls.load(Ordering::SeqCst), 0);
    assert_eq!(client.list_nodes_calls.load(Ordering::SeqCst), 0);
    assert_eq!(result.concept_count, 2);
    assert_eq!(result.reference_count, 1);
    assert!(result.truncated);
    let fact = fs::read_to_string(out.path().join("facts/knowledge-projects-acme-facts.md"))
        .expect("fact");
    assert!(fact.starts_with("---\n"));
    assert!(fact.contains("type: Fact"));
    assert!(fact.contains("Fact from /Sources/web/source.md"));
    let reference = fs::read_to_string(out.path().join("references/sources-web-source.md"))
        .expect("reference");
    assert!(reference.contains("type: Reference"));
    assert!(reference.contains("store: source_evidence"));
    assert!(reference.contains("store_path: /Sources/web/source.md"));
    assert!(reference.contains("source-etag"));
    assert!(reference.contains("sha256:sourcehash"));
    assert!(!reference.contains("raw secret transcript"));
    let index = fs::read_to_string(out.path().join(INDEX_FILE)).expect("index");
    assert!(!index.starts_with("---\n"));
    assert!(index.contains("task: `acme facts`"));
    assert!(index.contains("truncated: `true`"));
    let log = fs::read_to_string(out.path().join(LOG_FILE)).expect("log");
    assert!(log.contains("truncated: true"));
    assert!(
        verify_okf_bundle_dir(out.path(), false)
            .expect("verify")
            .valid
    );
    let manifest = read_okf_manifest(out.path()).expect("manifest");
    assert_eq!(manifest.okf_version, OKF_VERSION);
    assert_eq!(manifest.task, "acme facts");
    assert_eq!(manifest.namespace, "/Knowledge/projects/acme");
    assert_eq!(manifest.budget_tokens, 8_000);
    assert_eq!(manifest.depth, 1);
    assert!(manifest.truncated);
    assert_eq!(manifest.concept_count, 2);
    assert_eq!(manifest.reference_count, 1);
    assert!(manifest.selected_nodes.iter().any(|node| {
        node.path == "/Knowledge/projects/acme/facts.md"
            && node.concept_type == "Fact"
            && node.etag == "wiki-etag"
            && node.output_path == "facts/knowledge-projects-acme-facts.md"
    }));
    assert!(manifest.selected_nodes.iter().any(|node| {
        node.path == "/Sources/web/source.md"
            && node.concept_type == "Reference"
            && node.etag == "source-etag"
            && node.content_hash == "sha256:sourcehash"
            && node.output_path == "references/sources-web-source.md"
    }));
    let truncated_verify = verify_okf_bundle_dir(out.path(), true).expect("truncated verify");
    assert!(!truncated_verify.valid);
    assert!(
        truncated_verify
            .errors
            .iter()
            .any(|error| error.contains("truncated context"))
    );

    let fact_path = out.path().join("facts/knowledge-projects-acme-facts.md");
    let mut tampered = fs::read_to_string(&fact_path).expect("fact read");
    tampered.push_str("\nTampered line\n");
    fs::write(&fact_path, tampered).expect("tamper fact");
    let tampered_verify = verify_okf_bundle_dir(out.path(), false).expect("tampered verify");
    assert!(!tampered_verify.valid);
    assert!(
        tampered_verify
            .errors
            .iter()
            .any(|error| error.contains("kinic.content_hash mismatch"))
    );
}

#[tokio::test]
async fn export_root_context_does_not_copy_source_nodes_as_concepts() {
    let out = tempdir().expect("tempdir");
    let mut client = MockClient::default();
    client.context.nodes = vec![
        test_node_context(
            "/Knowledge/projects/acme/facts.md",
            "Fact from /Sources/web/source.md\n",
            "wiki-etag",
        ),
        NodeContext {
            node: test_node(
                "/Sources/web/source.md",
                NodeKind::Source,
                "raw secret transcript",
                "raw-etag",
            ),
            incoming_links: Vec::new(),
            outgoing_links: Vec::new(),
        },
    ];
    client.context.evidence = vec![test_source_evidence(
        "/Knowledge/projects/acme/facts.md",
        "/Sources/web/source.md",
        "sha256:sourcehash",
    )];

    let result = export_okf_bundle(
        &client,
        "alpha",
        ContextPackExportOptions {
            task: "root export".to_string(),
            namespace: "/".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            entities: Vec::new(),
            out: out.path().to_path_buf(),
            expires_at: "2999-01-01T00:00:00Z".to_string(),
            trust_level: "team-approved".to_string(),
            approved_by: Vec::new(),
            overwrite: false,
            json: true,
        },
    )
    .await
    .expect("export");

    assert_eq!(result.concept_count, 2);
    assert_eq!(result.reference_count, 1);
    assert!(!out.path().join("notes/sources-web-source.md").exists());
    assert!(!out.path().join("facts/sources-web-source.md").exists());
    let fact = fs::read_to_string(out.path().join("facts/knowledge-projects-acme-facts.md"))
        .expect("fact");
    assert!(!fact.contains("raw secret transcript"));
    let reference = fs::read_to_string(out.path().join("references/sources-web-source.md"))
        .expect("reference");
    assert!(reference.contains("Referenced store content is not copied"));
    assert!(!reference.contains("raw secret transcript"));
    assert!(
        verify_okf_bundle_dir(out.path(), false)
            .expect("verify")
            .valid
    );
}

#[tokio::test]
async fn export_sources_namespace_does_not_copy_source_bodies() {
    let out = tempdir().expect("tempdir");
    let mut client = MockClient::default();
    client.context.nodes = vec![NodeContext {
        node: test_node(
            "/Sources/web/source.md",
            NodeKind::Source,
            "raw secret transcript",
            "raw-etag",
        ),
        incoming_links: Vec::new(),
        outgoing_links: Vec::new(),
    }];

    let result = export_okf_bundle(
        &client,
        "alpha",
        ContextPackExportOptions {
            task: "source export".to_string(),
            namespace: "/Sources".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            entities: Vec::new(),
            out: out.path().to_path_buf(),
            expires_at: "2999-01-01T00:00:00Z".to_string(),
            trust_level: "team-approved".to_string(),
            approved_by: Vec::new(),
            overwrite: false,
            json: true,
        },
    )
    .await
    .expect("export");

    assert_eq!(result.concept_count, 0);
    assert_eq!(result.reference_count, 0);
    let manifest = read_okf_manifest(out.path()).expect("manifest");
    assert_eq!(manifest.namespace, "/Sources");
    assert!(manifest.selected_nodes.is_empty());
    let index = fs::read_to_string(out.path().join(INDEX_FILE)).expect("index");
    assert!(!index.contains("raw secret transcript"));
    assert!(
        verify_okf_bundle_dir(out.path(), false)
            .expect("verify")
            .valid
    );
}

#[tokio::test]
async fn export_writes_unclassified_wiki_nodes_as_notes() {
    let out = tempdir().expect("tempdir");
    let mut client = MockClient::default();
    client.context.nodes = vec![test_node_context(
        "/Knowledge/projects/acme/summary.md",
        "Project summary",
        "summary-etag",
    )];

    let result = export_okf_bundle(
        &client,
        "alpha",
        ContextPackExportOptions {
            task: "summary".to_string(),
            namespace: "/Knowledge/projects/acme".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            entities: Vec::new(),
            out: out.path().to_path_buf(),
            expires_at: "2999-01-01T00:00:00Z".to_string(),
            trust_level: "draft".to_string(),
            approved_by: Vec::new(),
            overwrite: false,
            json: true,
        },
    )
    .await
    .expect("export");

    assert_eq!(result.concept_count, 1);
    assert_eq!(result.reference_count, 0);
    let note = fs::read_to_string(out.path().join("notes/knowledge-projects-acme-summary.md"))
        .expect("note");
    assert!(note.contains("type: Note"));
    assert!(note.contains("Project summary"));

    let verify = verify_okf_bundle_dir(out.path(), false).expect("verify");
    assert!(verify.valid);
    assert_eq!(verify.reference_count, 0);
}

#[tokio::test]
async fn export_writes_session_links_as_metadata_only_references() {
    let out = tempdir().expect("tempdir");
    let mut client = MockClient::default();
    let session_path = "/Sessions/codex/session.md";
    client.context.nodes = vec![NodeContext {
        node: test_node(
            "/Knowledge/projects/acme/provenance.md",
            NodeKind::File,
            "Session [audit](/Sessions/codex/session.md)",
            "wiki-etag",
        ),
        incoming_links: Vec::new(),
        outgoing_links: vec![LinkEdge {
            source_path: "/Knowledge/projects/acme/provenance.md".to_string(),
            target_path: session_path.to_string(),
            raw_href: session_path.to_string(),
            link_text: "audit".to_string(),
            link_kind: "markdown".to_string(),
            updated_at: 4,
        }],
    }];
    client.readable_nodes.insert(
        session_path.to_string(),
        test_node(
            session_path,
            NodeKind::File,
            "raw session transcript",
            "session-etag",
        ),
    );

    let result = export_okf_bundle(
        &client,
        "alpha",
        ContextPackExportOptions {
            task: "session audit".to_string(),
            namespace: "/Knowledge/projects/acme".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            entities: Vec::new(),
            out: out.path().to_path_buf(),
            expires_at: "2999-01-01T00:00:00Z".to_string(),
            trust_level: "team-approved".to_string(),
            approved_by: Vec::new(),
            overwrite: false,
            json: true,
        },
    )
    .await
    .expect("export");

    assert_eq!(result.reference_count, 1);
    assert_eq!(client.read_node_calls.load(Ordering::SeqCst), 1);
    let reference = fs::read_to_string(out.path().join("references/sessions-codex-session.md"))
        .expect("reference");
    assert!(reference.contains("store: session"));
    assert!(reference.contains("store_path: /Sessions/codex/session.md"));
    assert!(reference.contains("session-etag"));
    assert!(!reference.contains("raw session transcript"));
    let verify = verify_okf_bundle_dir(out.path(), false).expect("verify");
    assert!(verify.valid, "{:?}", verify.errors);
}

#[test]
fn verify_rejects_missing_okf_manifest() {
    let dir = tempdir().expect("tempdir");
    fs::write(dir.path().join(INDEX_FILE), "# Index\n").expect("index");
    fs::write(dir.path().join(LOG_FILE), "# Log\n").expect("log");

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(result.errors.iter().any(|error| error.contains("okf.yaml")));
}

#[tokio::test]
async fn verify_rejects_manifest_count_mismatch() {
    let out = tempdir().expect("tempdir");
    export_reference_bundle(out.path(), false).await;
    let mut manifest = read_okf_manifest(out.path()).expect("manifest");
    manifest.concept_count = 99;
    fs::write(
        out.path().join(OKF_MANIFEST_FILE),
        serde_yaml::to_string(&manifest).expect("manifest yaml"),
    )
    .expect("manifest write");

    let result = verify_okf_bundle_dir(out.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(
        result
            .errors
            .iter()
            .any(|error| error.contains("concept_count mismatch"))
    );
}

#[tokio::test]
async fn verify_rejects_selected_node_hash_mismatch() {
    let out = tempdir().expect("tempdir");
    export_reference_bundle(out.path(), false).await;
    let mut manifest = read_okf_manifest(out.path()).expect("manifest");
    manifest.selected_nodes[0].content_hash = "sha256:wrong".to_string();
    fs::write(
        out.path().join(OKF_MANIFEST_FILE),
        serde_yaml::to_string(&manifest).expect("manifest yaml"),
    )
    .expect("manifest write");

    let result = verify_okf_bundle_dir(out.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(
        result
            .errors
            .iter()
            .any(|error| error.contains("selected_nodes mismatch"))
    );
}

#[tokio::test]
async fn verify_rejects_reference_missing_etag_or_content_hash() {
    let out = tempdir().expect("tempdir");
    export_reference_bundle(out.path(), false).await;
    let reference_path = out.path().join("references/sources-web-source.md");
    let without_etag = fs::read_to_string(&reference_path)
        .expect("reference read")
        .replace("  etag: source-etag\n", "");
    fs::write(&reference_path, without_etag).expect("reference write");
    let missing_etag = verify_okf_bundle_dir(out.path(), false).expect("verify result");
    assert!(!missing_etag.valid);
    assert!(
        missing_etag
            .errors
            .iter()
            .any(|error| error.contains("kinic.etag"))
    );

    let out = tempdir().expect("tempdir");
    export_reference_bundle(out.path(), false).await;
    let reference_path = out.path().join("references/sources-web-source.md");
    let without_hash = fs::read_to_string(&reference_path)
        .expect("reference read")
        .replace("  content_hash: sha256:sourcehash\n", "");
    fs::write(&reference_path, without_hash).expect("reference write");
    let missing_hash = verify_okf_bundle_dir(out.path(), false).expect("verify result");
    assert!(!missing_hash.valid);
    assert!(
        missing_hash
            .errors
            .iter()
            .any(|error| error.contains("kinic.content_hash"))
    );
}

#[tokio::test]
async fn verify_rejects_reference_body_extra_text() {
    let out = tempdir().expect("tempdir");
    export_reference_bundle(out.path(), false).await;
    let reference_path = out.path().join("references/sources-web-source.md");
    let mut reference = fs::read_to_string(&reference_path).expect("reference read");
    reference.push_str("\nraw source transcript should not appear\n");
    fs::write(&reference_path, reference).expect("reference write");

    let result = verify_okf_bundle_dir(out.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(
        result
            .errors
            .iter()
            .any(|error| error.contains("fixed metadata-only shape"))
    );
}

#[test]
fn verify_rejects_missing_type() {
    let dir = tempdir().expect("tempdir");
    fs::write(
        dir.path().join("broken.md"),
        "---\ntitle: Broken\n---\n\n# Broken\n",
    )
    .expect("write");
    write_reserved_files(dir.path());

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(result.errors.iter().any(|error| error.contains("type")));
}

#[test]
fn verify_rejects_missing_content_hash_for_kinic_concept() {
    let dir = tempdir().expect("tempdir");
    write_reserved_files(dir.path());
    write_kinic_fact(dir.path(), None, "# Fact\n\nOriginal");

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(result.errors.iter().any(|error| {
        error.contains("facts/fact.md") && error.contains("kinic.content_hash is required")
    }));
}

#[test]
fn verify_rejects_tampered_body_after_hash_removed() {
    let dir = tempdir().expect("tempdir");
    write_reserved_files(dir.path());
    let fact = write_kinic_fact(
        dir.path(),
        Some(sha256_hex("# Fact\n\nOriginal".as_bytes())),
        "# Fact\n\nOriginal",
    );
    let mut tampered = fs::read_to_string(&fact)
        .expect("fact read")
        .lines()
        .filter(|line| !line.trim_start().starts_with("content_hash:"))
        .collect::<Vec<_>>()
        .join("\n");
    tampered.push_str("\nTampered line\n");
    fs::write(&fact, tampered).expect("tamper");

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(result.errors.iter().any(|error| {
        error.contains("facts/fact.md") && error.contains("kinic.content_hash is required")
    }));
}

#[test]
fn verify_rejects_empty_dir() {
    let dir = tempdir().expect("tempdir");

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(result.errors.iter().any(|error| error.contains("index.md")));
}

#[test]
fn verify_rejects_missing_index_or_log() {
    let dir = tempdir().expect("tempdir");
    fs::write(dir.path().join(INDEX_FILE), "# Index\n").expect("index");
    write_kinic_fact(
        dir.path(),
        Some(sha256_hex("# Fact\n\nOriginal".as_bytes())),
        "# Fact\n\nOriginal",
    );

    let missing_log = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!missing_log.valid);
    assert!(
        missing_log
            .errors
            .iter()
            .any(|error| error.contains("log.md"))
    );

    fs::remove_file(dir.path().join(INDEX_FILE)).expect("remove index");
    fs::write(dir.path().join(LOG_FILE), "# Log\n").expect("log");
    let missing_index = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!missing_index.valid);
    assert!(
        missing_index
            .errors
            .iter()
            .any(|error| error.contains("index.md"))
    );
}

#[test]
fn verify_rejects_only_reserved_files() {
    let dir = tempdir().expect("tempdir");
    write_reserved_files(dir.path());

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(result.valid);
    assert_eq!(result.concept_count, 0);
}

#[test]
fn verify_rejects_expired_kinic_context() {
    let dir = tempdir().expect("tempdir");
    write_reserved_files(dir.path());
    fs::write(
        dir.path().join("expired.md"),
        "---\ntype: Fact\nkinic:\n  expires_at: 2000-01-01T00:00:00Z\n---\n\n# Expired\n",
    )
    .expect("write");

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(
        result
            .errors
            .iter()
            .any(|error| error.contains("kinic.expires_at"))
    );
}

#[test]
fn verify_rejects_reference_without_kinic_store_metadata() {
    let dir = tempdir().expect("tempdir");
    write_reserved_files(dir.path());
    fs::create_dir_all(dir.path().join("references")).expect("refs");
    fs::write(
        dir.path().join("references/missing-kinic.md"),
        "---\ntype: Reference\n---\n\n# Reference\n",
    )
    .expect("write missing kinic");
    fs::write(
        dir.path().join("reference-no-source-path.md"),
        "---\ntype: Reference\nkinic:\n  database_id: alpha\n---\n\n# Reference\n",
    )
    .expect("write missing source path");

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!result.valid);
    assert_eq!(result.reference_count, 2);
    assert!(
        result
            .errors
            .iter()
            .any(|error| error.contains("missing-kinic.md") && error.contains("kinic.store"))
    );
    assert!(
        result
            .errors
            .iter()
            .any(|error| error.contains("reference-no-source-path.md")
                && error.contains("kinic.store"))
    );
}

#[test]
fn verify_rejects_non_reference_type_under_references() {
    let dir = tempdir().expect("tempdir");
    write_reserved_files(dir.path());
    fs::create_dir_all(dir.path().join("references")).expect("refs");
    fs::write(
        dir.path().join("references/source.md"),
        "---\ntype: Fact\nkinic:\n  database_id: alpha\n  root: /Knowledge/projects/acme\n  store: source_evidence\n  store_path: /Sources/web/source.md\n---\n\n# Source\n",
    )
    .expect("write");

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(result.errors.iter().any(|error| {
        error.contains("references/source.md") && error.contains("type: Reference")
    }));
}

#[test]
fn verify_rejects_reference_type_outside_references() {
    let dir = tempdir().expect("tempdir");
    write_reserved_files(dir.path());
    fs::write(
        dir.path().join("source.md"),
        "---\ntype: Reference\nkinic:\n  store: source_evidence\n  store_path: /Sources/web/source.md\n---\n\n# Source\n",
    )
    .expect("write");

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(result.errors.iter().any(|error| {
        error.contains("source.md") && error.contains("must be under references/")
    }));
}

#[test]
fn verify_rejects_reference_store_path_outside_store_roots() {
    let dir = tempdir().expect("tempdir");
    write_reserved_files(dir.path());
    fs::create_dir_all(dir.path().join("references")).expect("refs");
    fs::write(
        dir.path().join("references/bad.md"),
        "---\ntype: Reference\nkinic:\n  database_id: alpha\n  root: /Knowledge/projects/acme\n  store: knowledge\n  store_path: /Bad/root.md\n  etag: bad-etag\n  content_hash: sha256:bad\n  expires_at: 2999-01-01T00:00:00Z\n---\n\n# Reference\n\n- store: `knowledge`\n- store_path: `/Bad/root.md`\n- via_path: `/Knowledge/projects/acme/facts.md`\n- target_href: `/Bad/root.md`\n- link_text: `Bad`\n- etag: `bad-etag`\n- updated_at: `3`\n- content_hash: `sha256:bad`\n\nReferenced store content is not copied into this OKF bundle.\n",
    )
    .expect("write");

    let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
    assert!(!result.valid);
    assert!(result.errors.iter().any(|error| {
        error.contains("references/bad.md") && error.contains("outside supported store roots")
    }));
}

#[test]
fn reference_store_mapping_covers_four_store_roots_and_evidence_roots() {
    assert_eq!(reference_store_for_path("/Memory/facts.md"), Some("memory"));
    assert_eq!(
        reference_store_for_path("/Knowledge/page.md"),
        Some("knowledge")
    );
    assert_eq!(
        reference_store_for_path("/Skills/review/SKILL.md"),
        Some("skill")
    );
    assert_eq!(
        reference_store_for_path("/Sessions/codex/session.md"),
        Some("session")
    );
    assert_eq!(
        reference_store_for_path("/Sources/web/source.md"),
        Some("source_evidence")
    );
    assert_eq!(
        reference_store_for_path("/Sources/sessions/claudecode/session-1.md"),
        Some("session_evidence")
    );
    assert_eq!(
        reference_store_for_path("/Sources/sessions/claudecode/bad.txt"),
        Some("session_evidence")
    );
    assert_eq!(
        reference_store_for_path("/Sources/skill-runs/review/run-1.md"),
        Some("skill_run_evidence")
    );
    assert_eq!(
        reference_store_for_path("/Sources/skill-runs/review"),
        Some("skill_run_evidence")
    );
    assert_eq!(reference_store_for_path("/Bad/root.md"), None);
}

#[tokio::test]
async fn overwrite_removes_owned_bundle_subdirs() {
    let out = tempdir().expect("tempdir");
    for dir_name in OKF_OWNED_DIRS {
        fs::create_dir_all(out.path().join(dir_name).join("nested")).expect("owned dir");
        fs::write(
            out.path().join(dir_name).join("nested/stale.txt"),
            "stale owned artifact",
        )
        .expect("stale owned");
    }
    fs::write(out.path().join(INDEX_FILE), "# Old\n").expect("old index");
    fs::write(out.path().join(LOG_FILE), "# Old\n").expect("old log");
    fs::write(out.path().join("manifest.json"), "{}").expect("manifest");
    fs::write(out.path().join("unrelated.txt"), "keep").expect("unrelated");

    let mut client = MockClient::default();
    client.context.nodes = vec![test_node_context(
        "/Knowledge/projects/acme/facts.md",
        "Fact",
        "wiki-etag",
    )];

    export_okf_bundle(
        &client,
        "alpha",
        ContextPackExportOptions {
            task: "facts".to_string(),
            namespace: "/Knowledge/projects/acme".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            entities: Vec::new(),
            out: out.path().to_path_buf(),
            expires_at: "2999-01-01T00:00:00Z".to_string(),
            trust_level: "team-approved".to_string(),
            approved_by: Vec::new(),
            overwrite: true,
            json: true,
        },
    )
    .await
    .expect("export");

    assert!(out.path().join("unrelated.txt").is_file());
    assert!(!out.path().join("manifest.json").exists());
    assert!(!out.path().join("facts/nested/stale.txt").exists());
    assert!(
        out.path()
            .join("facts/knowledge-projects-acme-facts.md")
            .is_file()
    );
    assert!(
        verify_okf_bundle_dir(out.path(), false)
            .expect("verify")
            .valid
    );
}

#[test]
fn inspect_reports_counts_and_kinic_summary() {
    let dir = tempdir().expect("tempdir");
    fs::write(
        dir.path().join(OKF_MANIFEST_FILE),
        serde_yaml::to_string(&OkfBundleManifest {
            okf_version: OKF_VERSION.to_string(),
            generated_at: "2999-01-01T00:00:00Z".to_string(),
            task: "inspect".to_string(),
            namespace: "/Knowledge/projects/acme".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            truncated: true,
            concept_count: 1,
            reference_count: 1,
            selected_nodes: vec![OkfSelectedNode {
                path: "/Sources/web/source.md".to_string(),
                concept_type: "Reference".to_string(),
                etag: "source-etag".to_string(),
                content_hash: "sha256:sourcehash".to_string(),
                output_path: "references/source.md".to_string(),
            }],
        })
        .expect("manifest yaml"),
    )
    .expect("manifest");
    fs::create_dir_all(dir.path().join("references")).expect("refs");
    fs::write(
        dir.path().join("references/source.md"),
        "---\ntype: Reference\nkinic:\n  database_id: alpha\n  root: /Knowledge/projects/acme\n  store: source_evidence\n  store_path: /Sources/web/source.md\n  etag: source-etag\n  content_hash: sha256:sourcehash\n  expires_at: 2999-01-01T00:00:00Z\n---\n\n# Reference\n\n- store: `source_evidence`\n- store_path: `/Sources/web/source.md`\n- via_path: `/Knowledge/projects/acme/facts.md`\n- target_href: `/Sources/web/source.md`\n- link_text: `Raw`\n- etag: `source-etag`\n- updated_at: `3`\n- content_hash: `sha256:sourcehash`\n\nReferenced store content is not copied into this OKF bundle.\n",
    )
    .expect("write");

    let result = inspect_okf_bundle_dir(dir.path()).expect("inspect");
    assert_eq!(result.concept_count, 1);
    assert_eq!(result.reference_count, 1);
    assert_eq!(result.task, "inspect");
    assert_eq!(result.namespace, "/Knowledge/projects/acme");
    assert_eq!(result.budget_tokens, 8_000);
    assert_eq!(result.depth, 1);
    assert!(result.truncated);
    assert_eq!(result.types.get("Reference"), Some(&1));
    assert_eq!(result.kinic.database_ids, vec!["alpha"]);
    assert_eq!(result.kinic.roots, vec!["/Knowledge/projects/acme"]);
}

#[tokio::test]
async fn export_allows_empty_query_context() {
    let out = tempdir().expect("tempdir");
    let client = MockClient::default();

    let result = export_okf_bundle(
        &client,
        "alpha",
        ContextPackExportOptions {
            task: "missing".to_string(),
            namespace: "/Knowledge/projects/acme".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            entities: Vec::new(),
            out: out.path().to_path_buf(),
            expires_at: "2999-01-01T00:00:00Z".to_string(),
            trust_level: "draft".to_string(),
            approved_by: Vec::new(),
            overwrite: false,
            json: true,
        },
    )
    .await
    .expect("export");

    assert_eq!(result.concept_count, 0);
    assert_eq!(result.reference_count, 0);
    let index = fs::read_to_string(out.path().join(INDEX_FILE)).expect("index");
    assert!(index.contains("No context nodes matched this task."));
    assert!(
        verify_okf_bundle_dir(out.path(), false)
            .expect("verify")
            .valid
    );
}

#[tokio::test]
async fn export_uses_database_root_namespace_explicitly() {
    let out = tempdir().expect("tempdir");
    let client = MockClient::default();

    export_okf_bundle(
        &client,
        "alpha",
        ContextPackExportOptions {
            task: "root search".to_string(),
            namespace: "/".to_string(),
            budget_tokens: 8_000,
            depth: 1,
            entities: Vec::new(),
            out: out.path().to_path_buf(),
            expires_at: "2999-01-01T00:00:00Z".to_string(),
            trust_level: "draft".to_string(),
            approved_by: Vec::new(),
            overwrite: false,
            json: true,
        },
    )
    .await
    .expect("export");

    let requests = client.recall_requests.lock().expect("recall request lock");
    assert_eq!(requests[0].namespace.as_deref(), Some("/"));
    let manifest: OkfBundleManifest = serde_yaml::from_str(
        &fs::read_to_string(out.path().join(OKF_MANIFEST_FILE)).expect("manifest file"),
    )
    .expect("manifest");
    assert_eq!(manifest.namespace, "/");
}

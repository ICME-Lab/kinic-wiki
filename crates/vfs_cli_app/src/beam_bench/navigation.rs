// Where: crates/vfs_cli_app/src/beam_bench/navigation.rs
// What: Canonical BEAM wiki paths plus index maintenance for benchmark imports.
// Why: BEAM notes should live on the normal wiki path and remain discoverable from `/Wiki/index.md`.
use anyhow::Result;
use vfs_client::VfsApi;
use vfs_types::{ListNodesRequest, NodeEntryKind, NodeKind, WriteNodeRequest};
use wiki_domain::{WIKI_BEAM_SECTION_TITLE, WIKI_INDEX_PATH, WIKI_ROOT_PATH};

const SOURCES_ROOT_PREFIX: &str = "/Sources/raw";

pub fn conversation_base_path(namespace: &str, conversation_id: &str) -> String {
    format!(
        "{}/{}",
        namespace_base_path(namespace),
        sanitize_segment(conversation_id)
    )
}

pub fn conversation_index_path(namespace: &str, conversation_id: &str) -> String {
    format!(
        "{}/index.md",
        conversation_base_path(namespace, conversation_id)
    )
}

pub fn namespace_base_path(namespace: &str) -> String {
    format!("{}/{}", WIKI_ROOT_PATH, sanitize_segment(namespace))
}

pub fn namespace_index_path(namespace: &str) -> String {
    format!("{}/index.md", namespace_base_path(namespace))
}

pub fn manifest_path(namespace: &str) -> String {
    format!(
        "{}/_beam_prepare_manifest.json",
        namespace_base_path(namespace)
    )
}

pub fn raw_source_id(namespace: &str, conversation_id: &str) -> String {
    format!(
        "{}-{}",
        sanitize_segment(namespace),
        sanitize_segment(conversation_id)
    )
}

pub fn raw_source_path(namespace: &str, conversation_id: &str) -> String {
    let source_id = raw_source_id(namespace, conversation_id);
    format!("{SOURCES_ROOT_PREFIX}/{source_id}/{source_id}.md")
}

pub async fn sync_beam_indexes(client: &impl VfsApi, namespace: &str) -> Result<()> {
    let namespace_prefix = namespace_base_path(namespace);
    let index_path = namespace_index_path(namespace);
    let entries = client
        .list_nodes(ListNodesRequest {
            prefix: namespace_prefix.clone(),
            recursive: true,
        })
        .await?;
    let mut conversation_indexes = entries
        .into_iter()
        .filter(|entry| entry.kind == NodeEntryKind::File)
        .map(|entry| entry.path)
        .filter(|path| {
            path == &namespace_prefix || path.starts_with(&format!("{namespace_prefix}/"))
        })
        .filter(|path| path != &index_path)
        .filter(|path| path.ends_with("/index.md"))
        .collect::<Vec<_>>();
    conversation_indexes.sort();

    let mut rows = Vec::with_capacity(conversation_indexes.len());
    for path in &conversation_indexes {
        let summary = client
            .read_node(path)
            .await?
            .map(|node| extract_identifier_summary(&node.content))
            .unwrap_or_default();
        rows.push(BeamIndexRow {
            path: path.clone(),
            summary,
        });
    }
    let beam_index = render_beam_index(&rows);
    upsert_node(client, &index_path, &beam_index).await?;

    let current_root = client
        .read_node(WIKI_INDEX_PATH)
        .await?
        .map(|node| node.content)
        .unwrap_or_else(default_root_index);
    let beam_entry = format!(
        "- [{}]({index_path}) - benchmark conversations",
        sanitize_segment(namespace)
    );
    let root_index = upsert_list_entry(
        &current_root,
        WIKI_BEAM_SECTION_TITLE,
        &beam_entry,
        &index_path,
    );
    upsert_node(client, WIKI_INDEX_PATH, &root_index).await?;
    Ok(())
}

async fn upsert_node(client: &impl VfsApi, path: &str, content: &str) -> Result<()> {
    let expected_etag = client.read_node(path).await?.map(|node| node.etag);
    client
        .write_node(WriteNodeRequest {
            path: path.to_string(),
            kind: NodeKind::File,
            content: content.to_string(),
            metadata_json: "{}".to_string(),
            expected_etag,
        })
        .await?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BeamIndexRow {
    path: String,
    summary: String,
}

fn render_beam_index(rows: &[BeamIndexRow]) -> String {
    let mut out = String::from("# Benchmark Conversations\n\n");
    out.push_str(
        "Imported BEAM conversation notes on the normal wiki path. Start here, then open each conversation index.\n\n",
    );
    if rows.is_empty() {
        out.push_str("- none\n");
        return out;
    }
    for row in rows {
        let conversation_id = row
            .path
            .trim_end_matches("/index.md")
            .rsplit('/')
            .next()
            .unwrap_or(&row.path);
        if row.summary.is_empty() {
            out.push_str(&format!("- [{conversation_id}]({})\n", row.path));
            continue;
        }
        out.push_str(&format!(
            "- [{conversation_id}]({}) - {}\n",
            row.path, row.summary
        ));
    }
    out
}

fn extract_identifier_summary(content: &str) -> String {
    let mut in_identifiers = false;
    let mut parts = Vec::new();
    for line in content.lines() {
        if line == "## Identifiers" {
            in_identifiers = true;
            continue;
        }
        if in_identifiers && line.starts_with("## ") {
            break;
        }
        if !in_identifiers {
            continue;
        }
        let bullet = line.trim().strip_prefix("- ").unwrap_or("").trim();
        if bullet.is_empty() || bullet.starts_with("conversation_id:") {
            continue;
        }
        parts.push(bullet.to_string());
        if parts.len() == 3 {
            break;
        }
    }
    parts.join("; ")
}

fn upsert_section(content: &str, title: &str, body: &str) -> String {
    let heading = format!("## {title}\n\n");
    if let Some(start) = content.find(&heading) {
        let section_start = start + heading.len();
        let rest = &content[section_start..];
        let section_end = rest
            .find("\n## ")
            .map(|offset| section_start + offset)
            .unwrap_or(content.len());
        let mut out = String::new();
        out.push_str(&content[..section_start]);
        out.push_str(body);
        out.push_str("\n\n");
        out.push_str(content[section_end..].trim_start_matches('\n'));
        if !out.ends_with('\n') {
            out.push('\n');
        }
        return out;
    }
    let trimmed = content.trim_end();
    if trimmed.is_empty() {
        return format!("# Index\n\n## {title}\n\n{body}\n");
    }
    format!("{trimmed}\n\n## {title}\n\n{body}\n")
}

fn upsert_list_entry(content: &str, title: &str, entry: &str, entry_link: &str) -> String {
    let heading = format!("## {title}\n\n");
    if let Some(start) = content.find(&heading) {
        let section_start = start + heading.len();
        let rest = &content[section_start..];
        let section_end = rest
            .find("\n## ")
            .map(|offset| section_start + offset)
            .unwrap_or(content.len());
        let mut lines = content[section_start..section_end]
            .lines()
            .filter(|line| !line.contains(entry_link))
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        lines.retain(|line| line.trim() != "- none");
        lines.push(entry.to_string());
        lines.sort();
        let body = lines.join("\n");
        let mut out = String::new();
        out.push_str(&content[..section_start]);
        out.push_str(&body);
        out.push_str("\n\n");
        out.push_str(content[section_end..].trim_start_matches('\n'));
        if !out.ends_with('\n') {
            out.push('\n');
        }
        return out;
    }
    upsert_section(content, title, entry)
}

fn default_root_index() -> String {
    "# Index\n\n## Sources\n\n- none\n\n## Entities\n\n- none\n\n## Concepts\n\n- none\n"
        .to_string()
}

fn sanitize_segment(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "unknown".to_string();
    }
    trimmed
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use anyhow::Result;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use vfs_client::VfsApi;
    use vfs_types::{
        AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
        ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
        GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
        MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node,
        NodeEntry, NodeEntryKind, NodeKind, RecentNodeHit, RecentNodesRequest,
        SearchNodePathsRequest, SearchNodesRequest, WriteNodeRequest, WriteNodeResult,
    };

    use super::{
        BeamIndexRow, conversation_base_path, conversation_index_path, extract_identifier_summary,
        manifest_path, namespace_base_path, namespace_index_path, render_beam_index,
        sync_beam_indexes, upsert_list_entry, upsert_section,
    };

    #[test]
    fn conversation_paths_use_canonical_root() {
        assert_eq!(
            conversation_base_path("Run A", "Beam Sample 1"),
            "/Wiki/run-a/beam-sample-1"
        );
        assert_eq!(namespace_base_path("Run A"), "/Wiki/run-a");
        assert_eq!(namespace_index_path("Run A"), "/Wiki/run-a/index.md");
        assert_eq!(
            manifest_path("Run A"),
            "/Wiki/run-a/_beam_prepare_manifest.json"
        );
        assert_eq!(
            conversation_index_path("Run A", "Beam Sample 1"),
            "/Wiki/run-a/beam-sample-1/index.md"
        );
        assert_ne!(
            conversation_base_path("run-a", "same-conv"),
            conversation_base_path("run-b", "same-conv")
        );
    }

    #[test]
    fn beam_index_lists_conversation_indexes() {
        let body = render_beam_index(&[
            BeamIndexRow {
                path: "/Wiki/run-a/conv-1/index.md".to_string(),
                summary: "title: Calendar planning".to_string(),
            },
            BeamIndexRow {
                path: "/Wiki/run-a/conv-2/index.md".to_string(),
                summary: "title: Travel check-in".to_string(),
            },
        ]);
        assert!(body.contains("[conv-1](/Wiki/run-a/conv-1/index.md)"));
        assert!(body.contains("[conv-2](/Wiki/run-a/conv-2/index.md)"));
        assert!(body.contains("title: Travel check-in"));
    }

    #[test]
    fn summary_uses_identifier_section() {
        let content = "# Conversation Index\n\n## Identifiers\n\n- conversation_id: beam-dev-2\n- title: Travel check-in\n- category: Personal\n- plan: Confirm the hotel and arrival date for the trip.\n\n## Note Roles\n";
        let summary = extract_identifier_summary(content);
        assert_eq!(
            summary,
            "title: Travel check-in; category: Personal; plan: Confirm the hotel and arrival date for the trip."
        );
    }

    #[test]
    fn root_index_section_is_replaced_in_place() {
        let content = "# Index\n\n## Sources\n\n- none\n\n## Benchmarks\n\n- old\n\n";
        let updated = upsert_section(
            content,
            "Benchmarks",
            "- [run-a](/Wiki/run-a/index.md) - benchmark conversations",
        );
        assert!(updated.contains("## Sources"));
        assert!(updated.contains("- [run-a](/Wiki/run-a/index.md)"));
        assert!(!updated.contains("- old"));
    }

    #[test]
    fn root_index_list_preserves_other_namespaces() {
        let content = "# Index\n\n## Benchmarks\n\n- [run-b](/Wiki/run-b/index.md) - benchmark conversations\n- [run-a](/Wiki/run-a/index.md) - old\n\n";
        let updated = upsert_list_entry(
            content,
            "Benchmarks",
            "- [run-a](/Wiki/run-a/index.md) - benchmark conversations",
            "/Wiki/run-a/index.md",
        );
        assert!(updated.contains("- [run-a](/Wiki/run-a/index.md) - benchmark conversations"));
        assert!(updated.contains("- [run-b](/Wiki/run-b/index.md) - benchmark conversations"));
        assert!(!updated.contains("- old"));
    }

    struct MockClient {
        list_requests: Mutex<Vec<ListNodesRequest>>,
        writes: Mutex<Vec<WriteNodeRequest>>,
    }

    #[async_trait]
    impl VfsApi for MockClient {
        async fn status(&self) -> Result<vfs_types::Status> {
            unreachable!()
        }
        async fn read_node(&self, path: &str) -> Result<Option<Node>> {
            if path.ends_with("/conv-1/index.md") {
                return Ok(Some(Node {
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: "# Conversation Index\n\n## Identifiers\n\n- title: Example\n"
                        .to_string(),
                    created_at: 0,
                    updated_at: 0,
                    etag: "etag".to_string(),
                    metadata_json: "{}".to_string(),
                }));
            }
            Ok(None)
        }
        async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            self.list_requests
                .lock()
                .expect("list requests should lock")
                .push(request);
            Ok(vec![
                NodeEntry {
                    path: "/Wiki/run-a/conv-1/index.md".to_string(),
                    kind: NodeEntryKind::File,
                    updated_at: 0,
                    etag: "etag".to_string(),
                    has_children: false,
                },
                NodeEntry {
                    path: "/Wiki/run-b/conv-2/index.md".to_string(),
                    kind: NodeEntryKind::File,
                    updated_at: 0,
                    etag: "etag".to_string(),
                    has_children: false,
                },
                NodeEntry {
                    path: "/Wiki/run-a/index.md".to_string(),
                    kind: NodeEntryKind::File,
                    updated_at: 0,
                    etag: "etag".to_string(),
                    has_children: false,
                },
            ])
        }
        async fn list_children(
            &self,
            _request: vfs_types::ListChildrenRequest,
        ) -> Result<Vec<vfs_types::ChildNode>> {
            unreachable!()
        }
        async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
            self.writes
                .lock()
                .expect("writes should lock")
                .push(request.clone());
            Ok(WriteNodeResult {
                node: vfs_types::NodeMutationAck {
                    path: request.path,
                    kind: request.kind,
                    updated_at: 0,
                    etag: "etag".to_string(),
                },
                created: true,
            })
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
        async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
            unreachable!()
        }
        async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            unreachable!()
        }
        async fn recent_nodes(&self, _request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
            unreachable!()
        }
        async fn multi_edit_node(
            &self,
            _request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            unreachable!()
        }
        async fn search_nodes(
            &self,
            _request: SearchNodesRequest,
        ) -> Result<Vec<vfs_types::SearchNodeHit>> {
            unreachable!()
        }
        async fn search_node_paths(
            &self,
            _request: SearchNodePathsRequest,
        ) -> Result<Vec<vfs_types::SearchNodeHit>> {
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

    #[tokio::test]
    async fn beam_index_sync_scopes_listing_to_namespace() {
        let client = MockClient {
            list_requests: Mutex::new(Vec::new()),
            writes: Mutex::new(Vec::new()),
        };

        sync_beam_indexes(&client, "Run A")
            .await
            .expect("index sync should succeed");

        let list_requests = client
            .list_requests
            .lock()
            .expect("list requests should lock");
        assert_eq!(list_requests[0].prefix, "/Wiki/run-a");
        assert!(list_requests[0].recursive);
        let writes = client.writes.lock().expect("writes should lock");
        let beam_index = writes
            .iter()
            .find(|request| request.path == "/Wiki/run-a/index.md")
            .expect("namespace index should be written");
        assert!(beam_index.content.contains("/Wiki/run-a/conv-1/index.md"));
        assert!(!beam_index.content.contains("/Wiki/run-b/conv-2/index.md"));
        assert!(!beam_index.content.contains("[run-a](/Wiki/run-a/index.md)"));
        let old_beam_index = format!("{}/beam/index.md", "/Wiki");
        assert!(writes.iter().all(|request| request.path != old_beam_index));
    }
}

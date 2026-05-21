// Where: crates/vfs_cli_app/src/purge_url_ingest.rs
// What: Accident-response cleanup for URL ingest artifacts.
// Why: Operators need one dry-run-first command that finds request/source/wiki nodes before deleting them.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use vfs_client::VfsApi;
use vfs_types::{DeleteNodeRequest, ListNodesRequest, Node, NodeKind};
use wiki_domain::validate_canonical_source_path;

const REQUEST_PREFIX: &str = "/Sources/ingest-requests";
const GENERATED_TARGET_PREFIX: &str = "/Wiki/conversations";
const WIDE_DELETE_PATH_COUNT: usize = 1;

#[derive(Debug, Default, Deserialize)]
struct Frontmatter {
    kind: Option<String>,
    status: Option<String>,
    url: Option<String>,
    source_path: Option<String>,
    target_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct MatchedRequest {
    path: String,
    url: String,
    source_path: Option<String>,
    target_path: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Serialize)]
struct PurgeReport {
    ok: bool,
    dry_run: bool,
    matched_requests: Vec<MatchedRequest>,
    delete_plan: Vec<String>,
    deleted_paths: Vec<String>,
    skipped_paths: Vec<String>,
    errors: Vec<String>,
}

struct DeletePlan {
    paths: Vec<String>,
    target_groups: Vec<TargetDeleteGroup>,
}

struct TargetDeleteGroup {
    target_path: String,
    paths: Vec<String>,
}

enum SourceLookup {
    Matched(Vec<MatchedRequest>),
    Skipped(String),
}

pub async fn purge_url_ingest(
    client: &impl VfsApi,
    database_id: &str,
    url: Option<&str>,
    source_path: Option<&str>,
    yes: bool,
    force_target_prefix: Option<&str>,
    json: bool,
) -> Result<()> {
    let normalized_url = url.map(normalize_url).transpose()?;
    let normalized_source_path = source_path.map(normalize_source_path).transpose()?;
    let mut matched = BTreeMap::new();
    let mut skipped_paths = Vec::new();
    for request in find_matching_requests(client, database_id, normalized_url.as_deref()).await? {
        matched.insert(request.path.clone(), request);
    }
    if let Some(source_path) = normalized_source_path.as_deref() {
        match request_for_source(client, database_id, source_path).await? {
            SourceLookup::Matched(requests) => {
                for request in requests {
                    matched.insert(request.path.clone(), request);
                }
            }
            SourceLookup::Skipped(reason) => skipped_paths.push(reason),
        }
    }
    let matched_requests = matched.into_values().collect::<Vec<_>>();
    let delete_plan = build_delete_plan(client, database_id, &matched_requests).await?;
    let mut report = PurgeReport {
        ok: true,
        dry_run: !yes,
        matched_requests,
        delete_plan: delete_plan.paths,
        deleted_paths: Vec::new(),
        skipped_paths,
        errors: Vec::new(),
    };
    if yes {
        validate_target_force(force_target_prefix, &delete_plan.target_groups)?;
        execute_delete_plan(client, database_id, &mut report).await?;
    }
    report.ok = report.errors.is_empty();
    print_report(&report, json)?;
    if yes && !report.ok {
        return Err(anyhow!(
            "purge_url_ingest failed to delete one or more paths"
        ));
    }
    Ok(())
}

async fn find_matching_requests(
    client: &impl VfsApi,
    database_id: &str,
    url: Option<&str>,
) -> Result<Vec<MatchedRequest>> {
    let Some(url) = url else {
        return Ok(Vec::new());
    };
    let entries = client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: REQUEST_PREFIX.to_string(),
            recursive: true,
        })
        .await?;
    let mut matched = Vec::new();
    for entry in entries {
        if !is_same_or_descendant(&entry.path, REQUEST_PREFIX) {
            return Err(anyhow!(
                "list_nodes returned path outside ingest request prefix: {}",
                entry.path
            ));
        }
        let Some(node) = client.read_node(database_id, &entry.path).await? else {
            continue;
        };
        let Some(request) = parse_request_node(&node)? else {
            continue;
        };
        if request.url == url {
            matched.push(request);
        }
    }
    Ok(matched)
}

async fn request_for_source(
    client: &impl VfsApi,
    database_id: &str,
    source_path: &str,
) -> Result<SourceLookup> {
    let Some(source) = client.read_node(database_id, source_path).await? else {
        return Ok(SourceLookup::Skipped(format!(
            "{source_path}: source not found"
        )));
    };
    if source.kind != NodeKind::Source {
        return Ok(SourceLookup::Skipped(format!(
            "{source_path}: node is not a source"
        )));
    };
    let Some(frontmatter) = parse_frontmatter(&source.content)? else {
        return Ok(SourceLookup::Skipped(format!(
            "{source_path}: missing raw web source frontmatter"
        )));
    };
    if frontmatter.kind.as_deref() != Some("kinic.raw_web_source") {
        return Ok(SourceLookup::Skipped(format!(
            "{source_path}: not kinic.raw_web_source"
        )));
    }
    let entries = client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: REQUEST_PREFIX.to_string(),
            recursive: true,
        })
        .await?;
    let mut matched = Vec::new();
    for entry in entries {
        if !is_same_or_descendant(&entry.path, REQUEST_PREFIX) {
            return Err(anyhow!(
                "list_nodes returned path outside ingest request prefix: {}",
                entry.path
            ));
        }
        let Some(node) = client.read_node(database_id, &entry.path).await? else {
            continue;
        };
        let Some(request) = parse_request_node(&node)? else {
            continue;
        };
        if request.source_path.as_deref() == Some(source_path) {
            matched.push(request);
        }
    }
    if !matched.is_empty() {
        return Ok(SourceLookup::Matched(matched));
    }
    Ok(SourceLookup::Skipped(format!(
        "{source_path}: matching ingest request not found"
    )))
}

async fn build_delete_plan(
    client: &impl VfsApi,
    database_id: &str,
    requests: &[MatchedRequest],
) -> Result<DeletePlan> {
    let mut paths = BTreeSet::new();
    let mut target_groups = Vec::new();
    for request in requests {
        paths.insert(request.path.clone());
        if let Some(source_path) = &request.source_path {
            paths.insert(normalize_source_path(source_path)?);
        }
        if let Some(target_path) = &request.target_path {
            let target_path = normalize_target_path(target_path)?;
            let target_paths = list_tree_paths(client, database_id, &target_path).await?;
            for path in &target_paths {
                paths.insert(path.clone());
            }
            target_groups.push(TargetDeleteGroup {
                target_path,
                paths: target_paths,
            });
        }
    }
    remove_folder_indexes_with_planned_parent(&mut paths);
    let mut ordered = paths.into_iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    Ok(DeletePlan {
        paths: ordered,
        target_groups,
    })
}

fn remove_folder_indexes_with_planned_parent(paths: &mut BTreeSet<String>) {
    let nested_indexes = paths
        .iter()
        .filter(|path| folder_index_parent(path).is_some_and(|parent| paths.contains(&parent)))
        .cloned()
        .collect::<Vec<_>>();
    for path in nested_indexes {
        paths.remove(&path);
    }
}

async fn list_tree_paths(
    client: &impl VfsApi,
    database_id: &str,
    path: &str,
) -> Result<Vec<String>> {
    let entries = client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: path.to_string(),
            recursive: true,
        })
        .await?;
    let mut paths = Vec::new();
    for entry in entries {
        if !is_same_or_descendant(&entry.path, path) {
            return Err(anyhow!(
                "list_nodes returned path outside target prefix: {}",
                entry.path
            ));
        }
        paths.push(entry.path);
    }
    Ok(paths)
}

async fn execute_delete_plan(
    client: &impl VfsApi,
    database_id: &str,
    report: &mut PurgeReport,
) -> Result<()> {
    for path in report.delete_plan.clone() {
        let Some(node) = client.read_node(database_id, &path).await? else {
            report.skipped_paths.push(path);
            continue;
        };
        let expected_folder_index_etag =
            expected_folder_index_etag(client, database_id, &node).await?;
        match client
            .delete_node(DeleteNodeRequest {
                database_id: database_id.to_string(),
                path: path.clone(),
                expected_etag: Some(node.etag),
                expected_folder_index_etag,
            })
            .await
        {
            Ok(result) => report.deleted_paths.push(result.path),
            Err(error) => report.errors.push(error.to_string()),
        }
    }
    Ok(())
}

async fn expected_folder_index_etag(
    client: &impl VfsApi,
    database_id: &str,
    node: &Node,
) -> Result<Option<String>> {
    if node.kind != NodeKind::Folder {
        return Ok(None);
    }
    let index_path = folder_index_path(&node.path);
    Ok(client
        .read_node(database_id, &index_path)
        .await?
        .and_then(|index| (index.kind == NodeKind::File).then_some(index.etag)))
}

fn folder_index_path(folder_path: &str) -> String {
    format!("{}/index.md", folder_path.trim_end_matches('/'))
}

fn folder_index_parent(path: &str) -> Option<String> {
    path.strip_suffix("/index.md")
        .filter(|parent| !parent.is_empty())
        .map(ToString::to_string)
}

fn parse_request_node(node: &Node) -> Result<Option<MatchedRequest>> {
    let path = normalize_request_path(&node.path)?;
    if node.kind != NodeKind::File {
        return Ok(None);
    }
    let Some(frontmatter) = parse_frontmatter(&node.content)? else {
        return Ok(None);
    };
    if frontmatter.kind.as_deref() != Some("kinic.url_ingest_request") {
        return Ok(None);
    }
    let Some(url) = frontmatter.url else {
        return Ok(None);
    };
    Ok(Some(MatchedRequest {
        path,
        url,
        source_path: frontmatter.source_path,
        target_path: frontmatter.target_path,
        status: frontmatter.status,
    }))
}

fn parse_frontmatter(content: &str) -> Result<Option<Frontmatter>> {
    let Some(rest) = content.strip_prefix("---\n") else {
        return Ok(None);
    };
    let Some((frontmatter, _body)) = rest.split_once("\n---") else {
        return Ok(None);
    };
    Ok(Some(serde_yaml::from_str(frontmatter)?))
}

fn normalize_url(value: &str) -> Result<String> {
    let mut parsed = reqwest::Url::parse(value).map_err(|error| anyhow!("invalid URL: {error}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(anyhow!("URL must use http or https"));
    }
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

fn validate_target_force(
    force_target_prefix: Option<&str>,
    target_groups: &[TargetDeleteGroup],
) -> Result<()> {
    let wide_groups = target_groups
        .iter()
        .filter(|group| group.paths.len() > WIDE_DELETE_PATH_COUNT)
        .collect::<Vec<_>>();
    if wide_groups.is_empty() {
        return Ok(());
    }
    let Some(force_target_prefix) = force_target_prefix else {
        let targets = wide_groups
            .iter()
            .map(|group| format!("{} ({} paths)", group.target_path, group.paths.len()))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(anyhow!(
            "wide target delete requires --force-target-prefix: {targets}"
        ));
    };
    let force_target_prefix = normalize_target_path(force_target_prefix)?;
    for group in wide_groups {
        if group.target_path != force_target_prefix {
            return Err(anyhow!(
                "--force-target-prefix must match target_path exactly: {}",
                group.target_path
            ));
        }
    }
    Ok(())
}

fn normalize_request_path(path: &str) -> Result<String> {
    let path = normalize_absolute_path(path, "request_path")?;
    if !is_same_or_descendant(&path, REQUEST_PREFIX) || path == REQUEST_PREFIX {
        return Err(anyhow!(
            "request_path outside ingest request prefix: {path}"
        ));
    }
    Ok(path)
}

fn normalize_source_path(path: &str) -> Result<String> {
    let path = normalize_absolute_path(path, "source_path")?;
    validate_canonical_source_path(&path).map_err(anyhow::Error::msg)?;
    Ok(path)
}

fn normalize_target_path(path: &str) -> Result<String> {
    let path = normalize_absolute_path(path, "target_path")?;
    if path == "/" || path == "/Wiki" || path == "/Sources" || path == GENERATED_TARGET_PREFIX {
        return Err(anyhow!("refusing protected target_path: {path}"));
    }
    if !is_same_or_descendant(&path, GENERATED_TARGET_PREFIX) {
        return Err(anyhow!(
            "target_path must be under {GENERATED_TARGET_PREFIX}: {path}"
        ));
    }
    Ok(path)
}

fn normalize_absolute_path(path: &str, field: &str) -> Result<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{field} is empty"));
    }
    if !trimmed.starts_with('/') {
        return Err(anyhow!("{field} must be absolute: {path}"));
    }
    let mut segments = Vec::new();
    for segment in trimmed.split('/').filter(|segment| !segment.is_empty()) {
        if segment == "." || segment == ".." {
            return Err(anyhow!("{field} contains invalid segment: {path}"));
        }
        segments.push(segment);
    }
    if segments.is_empty() {
        return Ok("/".to_string());
    }
    Ok(format!("/{}", segments.join("/")))
}

fn is_same_or_descendant(path: &str, prefix: &str) -> bool {
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

fn print_report(report: &PurgeReport, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(report)?);
        return Ok(());
    }
    println!("dry_run: {}", report.dry_run);
    for path in &report.delete_plan {
        println!("delete\t{path}");
    }
    for path in &report.deleted_paths {
        println!("deleted\t{path}");
    }
    for path in &report.skipped_paths {
        println!("skipped\t{path}");
    }
    for error in &report.errors {
        println!("error\t{error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use async_trait::async_trait;
    use vfs_types::*;

    #[derive(Default)]
    struct PlanClient {
        entries: Vec<NodeEntry>,
    }

    #[async_trait]
    impl VfsApi for PlanClient {
        async fn status(&self, _database_id: &str) -> Result<Status> {
            unimplemented!()
        }

        async fn read_node(&self, _database_id: &str, _path: &str) -> Result<Option<Node>> {
            unimplemented!()
        }

        async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            Ok(self
                .entries
                .iter()
                .filter(|entry| entry.path.starts_with(&request.prefix))
                .cloned()
                .collect())
        }

        async fn list_children(&self, _request: ListChildrenRequest) -> Result<Vec<ChildNode>> {
            unimplemented!()
        }

        async fn write_node(&self, _request: WriteNodeRequest) -> Result<WriteNodeResult> {
            unimplemented!()
        }

        async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
            unimplemented!()
        }

        async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
            unimplemented!()
        }

        async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            unimplemented!()
        }

        async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
            unimplemented!()
        }

        async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
            unimplemented!()
        }

        async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            unimplemented!()
        }

        async fn recent_nodes(&self, _request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
            unimplemented!()
        }

        async fn multi_edit_node(
            &self,
            _request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            unimplemented!()
        }

        async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
            unimplemented!()
        }

        async fn search_node_paths(
            &self,
            _request: SearchNodePathsRequest,
        ) -> Result<Vec<SearchNodeHit>> {
            unimplemented!()
        }

        async fn export_snapshot(
            &self,
            _request: ExportSnapshotRequest,
        ) -> Result<ExportSnapshotResponse> {
            unimplemented!()
        }

        async fn fetch_updates(
            &self,
            _request: FetchUpdatesRequest,
        ) -> Result<FetchUpdatesResponse> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn build_delete_plan_omits_folder_index_when_folder_is_planned() -> Result<()> {
        let client = PlanClient {
            entries: vec![
                node_entry("/Wiki/conversations/web-1", NodeEntryKind::Folder),
                node_entry("/Wiki/conversations/web-1/index.md", NodeEntryKind::File),
                node_entry("/Wiki/conversations/web-1/facts.md", NodeEntryKind::File),
            ],
        };
        let request = matched_request(Some("/Wiki/conversations/web-1"));

        let plan = build_delete_plan(&client, "default", &[request]).await?;

        assert!(
            plan.paths
                .contains(&"/Sources/ingest-requests/r1.md".to_string())
        );
        assert!(
            plan.paths
                .contains(&"/Sources/raw/web-1/web-1.md".to_string())
        );
        assert!(
            plan.paths
                .contains(&"/Wiki/conversations/web-1".to_string())
        );
        assert!(
            plan.paths
                .contains(&"/Wiki/conversations/web-1/facts.md".to_string())
        );
        assert!(
            !plan
                .paths
                .contains(&"/Wiki/conversations/web-1/index.md".to_string())
        );
        assert!(
            plan.target_groups[0]
                .paths
                .contains(&"/Wiki/conversations/web-1/index.md".to_string())
        );
        Ok(())
    }

    #[tokio::test]
    async fn build_delete_plan_keeps_standalone_folder_index() -> Result<()> {
        let client = PlanClient {
            entries: vec![node_entry(
                "/Wiki/conversations/web-1/index.md",
                NodeEntryKind::File,
            )],
        };
        let request = matched_request(Some("/Wiki/conversations/web-1/index.md"));

        let plan = build_delete_plan(&client, "default", &[request]).await?;

        assert!(
            plan.paths
                .contains(&"/Wiki/conversations/web-1/index.md".to_string())
        );
        Ok(())
    }

    fn matched_request(target_path: Option<&str>) -> MatchedRequest {
        MatchedRequest {
            path: "/Sources/ingest-requests/r1.md".to_string(),
            url: "https://example.com/page".to_string(),
            source_path: Some("/Sources/raw/web-1/web-1.md".to_string()),
            target_path: target_path.map(ToString::to_string),
            status: Some("completed".to_string()),
        }
    }

    fn node_entry(path: &str, kind: NodeEntryKind) -> NodeEntry {
        NodeEntry {
            path: path.to_string(),
            kind,
            updated_at: 1,
            etag: format!("etag:{path}"),
            has_children: false,
        }
    }
}

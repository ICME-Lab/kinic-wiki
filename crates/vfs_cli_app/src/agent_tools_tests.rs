use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use vfs_client::VfsApi;
use vfs_types::{
    AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodeType, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest,
    MkdirNodeResult, MoveNodeRequest, MoveNodeResult, MultiEdit, MultiEditNodeRequest,
    MultiEditNodeResult, Node, NodeEntry, NodeEntryKind, NodeKind, NodeMutationAck, RecentNodeHit,
    RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest, Status,
    WriteNodeRequest, WriteNodeResult,
};

use crate::agent_tools::{
    create_anthropic_tools, create_openai_tools, handle_anthropic_tool_call,
    handle_openai_tool_call,
};
#[derive(Default)]
struct ToolMockClient {
    append_requests: std::sync::Mutex<Vec<AppendNodeRequest>>,
    edit_requests: std::sync::Mutex<Vec<EditNodeRequest>>,
    mkdir_requests: std::sync::Mutex<Vec<MkdirNodeRequest>>,
    move_requests: std::sync::Mutex<Vec<MoveNodeRequest>>,
    list_requests: std::sync::Mutex<Vec<ListNodesRequest>>,
    glob_requests: std::sync::Mutex<Vec<GlobNodesRequest>>,
    recent_requests: std::sync::Mutex<Vec<RecentNodesRequest>>,
    search_requests: std::sync::Mutex<Vec<SearchNodesRequest>>,
    search_path_requests: std::sync::Mutex<Vec<SearchNodePathsRequest>>,
    multi_edit_requests: std::sync::Mutex<Vec<MultiEditNodeRequest>>,
}

#[async_trait]
impl VfsApi for ToolMockClient {
    async fn status(&self) -> Result<Status> {
        Ok(Status {
            file_count: 0,
            source_count: 0,
        })
    }

    async fn read_node(&self, path: &str) -> Result<Option<Node>> {
        Ok(Some(sample_node(path, "body", "etag-1")))
    }

    async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        self.list_requests
            .lock()
            .expect("list lock should succeed")
            .push(request);
        Ok(Vec::new())
    }

    async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
        Ok(WriteNodeResult {
            created: false,
            node: sample_ack(&request.path, NodeKind::File, "etag-write"),
        })
    }

    async fn append_node(&self, request: AppendNodeRequest) -> Result<WriteNodeResult> {
        self.append_requests
            .lock()
            .expect("append lock should succeed")
            .push(request.clone());
        Ok(WriteNodeResult {
            created: false,
            node: sample_ack(
                &request.path,
                request.kind.unwrap_or(NodeKind::File),
                "etag-append",
            ),
        })
    }

    async fn edit_node(&self, request: EditNodeRequest) -> Result<EditNodeResult> {
        self.edit_requests
            .lock()
            .expect("edit lock should succeed")
            .push(request.clone());
        if request.old_text == "missing" {
            return Err(anyhow::anyhow!("old_text not found"));
        }
        Ok(EditNodeResult {
            node: sample_ack(&request.path, NodeKind::File, "etag-edit"),
            replacement_count: 1,
        })
    }

    async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
        Ok(DeleteNodeResult { path: request.path })
    }

    async fn move_node(&self, request: MoveNodeRequest) -> Result<MoveNodeResult> {
        self.move_requests
            .lock()
            .expect("move lock should succeed")
            .push(request.clone());
        Ok(MoveNodeResult {
            node: sample_ack(&request.to_path, NodeKind::File, "etag-move"),
            from_path: request.from_path,
            overwrote: request.overwrite,
        })
    }

    async fn mkdir_node(&self, request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
        self.mkdir_requests
            .lock()
            .expect("mkdir lock should succeed")
            .push(request.clone());
        Ok(MkdirNodeResult {
            path: request.path,
            created: true,
        })
    }

    async fn glob_nodes(&self, request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
        self.glob_requests
            .lock()
            .expect("glob lock should succeed")
            .push(request);
        Ok(vec![GlobNodeHit {
            path: "/Wiki/nested".to_string(),
            kind: NodeEntryKind::Directory,
            has_children: true,
        }])
    }

    async fn recent_nodes(&self, request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
        self.recent_requests
            .lock()
            .expect("recent lock should succeed")
            .push(request);
        Ok(vec![RecentNodeHit {
            path: "/Wiki/a.md".to_string(),
            kind: NodeKind::File,
            updated_at: 2,
            etag: "etag-a".to_string(),
        }])
    }

    async fn multi_edit_node(&self, request: MultiEditNodeRequest) -> Result<MultiEditNodeResult> {
        self.multi_edit_requests
            .lock()
            .expect("multi edit lock should succeed")
            .push(request.clone());
        if request.edits.iter().any(|edit| edit.old_text == "missing") {
            return Err(anyhow::anyhow!("multi_edit rollback"));
        }
        Ok(MultiEditNodeResult {
            node: sample_ack(&request.path, NodeKind::File, "etag-multi-edit"),
            replacement_count: 2,
        })
    }

    async fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        self.search_requests
            .lock()
            .expect("search lock should succeed")
            .push(request);
        Ok(Vec::new())
    }

    async fn search_node_paths(
        &self,
        request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>> {
        self.search_path_requests
            .lock()
            .expect("search path lock should succeed")
            .push(request);
        Ok(vec![SearchNodeHit {
            path: "/Wiki/nested/beta.md".to_string(),
            kind: NodeKind::File,
            snippet: Some("/Wiki/nested/beta.md".to_string()),
            preview: None,
            score: 15.0,
            match_reasons: vec!["path_substring".to_string()],
        }])
    }

    async fn export_snapshot(
        &self,
        _request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse> {
        Ok(ExportSnapshotResponse {
            snapshot_revision: "snap".to_string(),
            snapshot_session_id: None,
            nodes: Vec::new(),
            next_cursor: None,
        })
    }

    async fn fetch_updates(&self, _request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse> {
        Ok(FetchUpdatesResponse {
            snapshot_revision: "snap".to_string(),
            changed_nodes: Vec::new(),
            removed_paths: Vec::new(),
            next_cursor: None,
        })
    }
}

#[tokio::test]
async fn wiki_agent_tools_default_read_scopes_to_wiki_root() {
    let client = ToolMockClient::default();
    for (name, input) in [
        ("ls", serde_json::json!({})),
        ("glob", serde_json::json!({ "pattern": "**/*.md" })),
        ("recent", serde_json::json!({ "limit": 5 })),
        ("search", serde_json::json!({ "query_text": "nested" })),
        (
            "search_paths",
            serde_json::json!({ "query_text": "nested" }),
        ),
    ] {
        let result = handle_anthropic_tool_call(&client, name, input)
            .await
            .expect("tool should succeed");
        assert!(!result.is_error);
    }

    assert_eq!(
        client
            .list_requests
            .lock()
            .expect("list lock should succeed")[0]
            .prefix,
        "/Wiki"
    );
    assert_eq!(
        client
            .glob_requests
            .lock()
            .expect("glob lock should succeed")[0]
            .path,
        Some("/Wiki".to_string())
    );
    assert_eq!(
        client
            .recent_requests
            .lock()
            .expect("recent lock should succeed")[0]
            .path,
        Some("/Wiki".to_string())
    );
    assert_eq!(
        client
            .search_requests
            .lock()
            .expect("search lock should succeed")[0]
            .prefix,
        Some("/Wiki".to_string())
    );
    assert_eq!(
        client
            .search_path_requests
            .lock()
            .expect("search path lock should succeed")[0]
            .prefix,
        Some("/Wiki".to_string())
    );
}

#[test]
fn tool_schemas_include_minimal_vfs_tools() {
    let openai = create_openai_tools();
    let anthropic = create_anthropic_tools();
    assert_eq!(openai.len(), 13);
    assert_eq!(anthropic.len(), 13);

    let openai_names = tool_names(&openai, "function");
    let anthropic_names = tool_names(&anthropic, "name");

    for name in [
        "read",
        "write",
        "append",
        "edit",
        "ls",
        "mkdir",
        "mv",
        "glob",
        "recent",
        "multi_edit",
        "rm",
        "search",
        "search_paths",
    ] {
        assert!(openai_names.contains(&name.to_string()));
        assert!(anthropic_names.contains(&name.to_string()));
    }
}

#[test]
fn tool_schemas_cap_query_result_limits() {
    let openai = create_openai_tools();
    let recent = openai_tool_parameters(&openai, "recent");
    assert_eq!(recent["properties"]["limit"]["maximum"], 100);

    let search = openai_tool_parameters(&openai, "search");
    assert_eq!(search["properties"]["top_k"]["maximum"], 100);

    let search_paths = openai_tool_parameters(&openai, "search_paths");
    assert_eq!(search_paths["properties"]["top_k"]["maximum"], 100);
}

fn openai_tool_parameters<'a>(tools: &'a [Value], name: &str) -> &'a Value {
    &tools
        .iter()
        .find(|tool| tool["function"]["name"] == name)
        .expect("tool should exist")["function"]["parameters"]
}

#[tokio::test]
async fn openai_dispatch_routes_append_and_edit() {
    let client = ToolMockClient::default();

    let append = handle_openai_tool_call(
        &client,
        "append",
        r#"{"path":"/Wiki/a.md","content":"tail","expected_etag":"etag-1","separator":"\n"}"#,
    )
    .await
    .expect("append dispatch should succeed");
    assert!(!append.is_error);

    let edit = handle_openai_tool_call(
        &client,
        "edit",
        r#"{"path":"/Wiki/a.md","old_text":"before","new_text":"after","replace_all":false}"#,
    )
    .await
    .expect("edit dispatch should succeed");
    assert!(!edit.is_error);

    let append_requests = client
        .append_requests
        .lock()
        .expect("append lock should succeed");
    assert_eq!(append_requests.len(), 1);
    assert_eq!(append_requests[0].path, "/Wiki/a.md");
    drop(append_requests);

    let edit_requests = client
        .edit_requests
        .lock()
        .expect("edit lock should succeed");
    assert_eq!(edit_requests.len(), 1);
    assert_eq!(edit_requests[0].old_text, "before");
}

#[tokio::test]
async fn anthropic_dispatch_returns_tool_error_for_edit_failures() {
    let client = ToolMockClient::default();
    let result = handle_anthropic_tool_call(
        &client,
        "edit",
        serde_json::json!({
            "path": "/Wiki/a.md",
            "old_text": "missing",
            "new_text": "after",
            "replace_all": false
        }),
    )
    .await
    .expect("tool dispatch should return tool result");

    assert!(result.is_error);
    assert!(result.text.contains("old_text not found"));
}

#[tokio::test]
async fn anthropic_dispatch_routes_mkdir() {
    let client = ToolMockClient::default();
    let result = handle_anthropic_tool_call(
        &client,
        "mkdir",
        serde_json::json!({ "path": "/Wiki/new-dir" }),
    )
    .await
    .expect("mkdir tool should succeed");
    assert!(!result.is_error);
    let mkdirs = client
        .mkdir_requests
        .lock()
        .expect("mkdir lock should succeed");
    assert_eq!(mkdirs.len(), 1);
    assert_eq!(mkdirs[0].path, "/Wiki/new-dir");
}

#[tokio::test]
async fn anthropic_dispatch_routes_move_glob_recent_and_multi_edit() {
    let client = ToolMockClient::default();

    let moved = handle_anthropic_tool_call(
        &client,
        "mv",
        serde_json::json!({
            "from_path": "/Wiki/a.md",
            "to_path": "/Wiki/b.md",
            "expected_etag": "etag-1",
            "overwrite": true
        }),
    )
    .await
    .expect("move tool should succeed");
    assert!(!moved.is_error);

    let globbed = handle_anthropic_tool_call(
        &client,
        "glob",
        serde_json::json!({
            "pattern": "**/*.md",
            "path": "/Wiki",
            "node_type": "directory"
        }),
    )
    .await
    .expect("glob tool should succeed");
    assert!(!globbed.is_error);

    let recent = handle_anthropic_tool_call(
        &client,
        "recent",
        serde_json::json!({
            "limit": 5,
            "path": "/Wiki"
        }),
    )
    .await
    .expect("recent tool should succeed");
    assert!(!recent.is_error);

    let multi_edit = handle_anthropic_tool_call(
        &client,
        "multi_edit",
        serde_json::json!({
            "path": "/Wiki/a.md",
            "expected_etag": "etag-1",
            "edits": [
                { "old_text": "before", "new_text": "after" },
                { "old_text": "alpha", "new_text": "beta" }
            ]
        }),
    )
    .await
    .expect("multi edit tool should succeed");
    assert!(!multi_edit.is_error);

    assert_eq!(
        client
            .move_requests
            .lock()
            .expect("move lock should succeed")
            .len(),
        1
    );
    assert_eq!(
        client
            .glob_requests
            .lock()
            .expect("glob lock should succeed")[0]
            .node_type,
        Some(GlobNodeType::Directory)
    );
    assert_eq!(
        client
            .recent_requests
            .lock()
            .expect("recent lock should succeed")[0]
            .limit,
        5
    );
    assert_eq!(
        client
            .multi_edit_requests
            .lock()
            .expect("multi edit lock should succeed")[0]
            .edits,
        vec![
            MultiEdit {
                old_text: "before".to_string(),
                new_text: "after".to_string(),
            },
            MultiEdit {
                old_text: "alpha".to_string(),
                new_text: "beta".to_string(),
            },
        ]
    );
}

#[tokio::test]
async fn anthropic_dispatch_routes_search_paths() {
    let client = ToolMockClient::default();
    let result = handle_anthropic_tool_call(
        &client,
        "search_paths",
        serde_json::json!({
            "query_text": "nested",
            "prefix": "/Wiki",
            "top_k": 5
        }),
    )
    .await
    .expect("search paths tool should succeed");
    assert!(!result.is_error);
    assert!(result.text.contains("/Wiki/nested/beta.md"));
    assert!(result.text.contains("path_substring"));
}

fn sample_node(path: &str, content: &str, etag: &str) -> Node {
    Node {
        path: path.to_string(),
        kind: NodeKind::File,
        content: content.to_string(),
        created_at: 1,
        updated_at: 2,
        etag: etag.to_string(),
        metadata_json: "{}".to_string(),
    }
}

fn sample_ack(path: &str, kind: NodeKind, etag: &str) -> NodeMutationAck {
    NodeMutationAck {
        path: path.to_string(),
        kind,
        updated_at: 2,
        etag: etag.to_string(),
    }
}

fn tool_names(values: &[Value], key: &str) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| match key {
            "function" => value
                .get("function")
                .and_then(|entry| entry.get("name"))
                .and_then(Value::as_str),
            "name" => value.get("name").and_then(Value::as_str),
            _ => None,
        })
        .map(str::to_string)
        .collect()
}

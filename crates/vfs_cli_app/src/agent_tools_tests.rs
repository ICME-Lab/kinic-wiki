use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use vfs_client::VfsApi;
use vfs_types::{
    AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodeType, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest,
    MkdirNodeResult, MoveNodeRequest, MoveNodeResult, MultiEdit, MultiEditNodeRequest,
    MultiEditNodeResult, Node, NodeEntry, NodeEntryKind, NodeKind, NodeMutationAck, SearchNodeHit,
    SearchNodePathsRequest, SearchNodesRequest, SearchPreviewMode, Status, WriteNodeRequest,
    WriteNodeResult,
};

use vfs_cli::agent_tools::{
    create_anthropic_tools, create_openai_read_only_tools, create_openai_tools,
    handle_anthropic_tool_call, handle_openai_read_only_tool_call, handle_openai_tool_call,
};
#[derive(Default)]
struct ToolMockClient {
    nodes: std::sync::Mutex<std::collections::BTreeMap<String, Node>>,
    append_requests: std::sync::Mutex<Vec<AppendNodeRequest>>,
    edit_requests: std::sync::Mutex<Vec<EditNodeRequest>>,
    delete_requests: std::sync::Mutex<Vec<DeleteNodeRequest>>,
    mkdir_requests: std::sync::Mutex<Vec<MkdirNodeRequest>>,
    move_requests: std::sync::Mutex<Vec<MoveNodeRequest>>,
    list_requests: std::sync::Mutex<Vec<ListNodesRequest>>,
    glob_requests: std::sync::Mutex<Vec<GlobNodesRequest>>,
    context_requests: std::sync::Mutex<Vec<vfs_types::NodeContextRequest>>,
    graph_requests: std::sync::Mutex<Vec<vfs_types::GraphNeighborhoodRequest>>,
    graph_link_requests: std::sync::Mutex<Vec<vfs_types::GraphLinksRequest>>,
    incoming_requests: std::sync::Mutex<Vec<vfs_types::IncomingLinksRequest>>,
    outgoing_requests: std::sync::Mutex<Vec<vfs_types::OutgoingLinksRequest>>,
    multi_edit_requests: std::sync::Mutex<Vec<MultiEditNodeRequest>>,
    search_requests: std::sync::Mutex<Vec<SearchNodesRequest>>,
    path_search_requests: std::sync::Mutex<Vec<SearchNodePathsRequest>>,
    search_hits: std::sync::Mutex<Vec<SearchNodeHit>>,
    path_search_hits: std::sync::Mutex<Vec<SearchNodeHit>>,
}

#[async_trait]
impl VfsApi for ToolMockClient {
    async fn status(&self, _database_id: &str) -> Result<Status> {
        Ok(Status {
            file_count: 0,
            source_count: 0,
        })
    }

    async fn read_node(&self, _database_id: &str, path: &str) -> Result<Option<Node>> {
        if let Some(node) = self
            .nodes
            .lock()
            .expect("nodes lock should succeed")
            .get(path)
            .cloned()
        {
            return Ok(Some(node));
        }
        Ok(Some(sample_node(path, "body", "etag-1")))
    }

    async fn read_node_context(
        &self,
        request: vfs_types::NodeContextRequest,
    ) -> Result<Option<vfs_types::NodeContext>> {
        self.context_requests
            .lock()
            .expect("context lock should succeed")
            .push(request.clone());
        Ok(Some(vfs_types::NodeContext {
            node: sample_node(&request.path, "body", "etag-1"),
            incoming_links: vec![sample_link("/Knowledge/source.md", &request.path)],
            outgoing_links: vec![sample_link(&request.path, "/Knowledge/target.md")],
        }))
    }

    async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        self.list_requests
            .lock()
            .expect("list lock should succeed")
            .push(request.clone());
        let nodes = self.nodes.lock().expect("nodes lock should succeed");
        if !nodes.is_empty() {
            return Ok(nodes
                .values()
                .filter(|node| node.path.starts_with(&request.prefix))
                .map(|node| NodeEntry {
                    path: node.path.clone(),
                    kind: match node.kind {
                        NodeKind::File => NodeEntryKind::File,
                        NodeKind::Source => NodeEntryKind::Source,
                        NodeKind::Folder => NodeEntryKind::Folder,
                    },
                    updated_at: node.updated_at,
                    etag: node.etag.clone(),
                    has_children: false,
                })
                .collect());
        }
        Ok(Vec::new())
    }

    async fn list_children(
        &self,
        _request: vfs_types::ListChildrenRequest,
    ) -> Result<Vec<vfs_types::ChildNode>> {
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
        self.delete_requests
            .lock()
            .expect("delete lock should succeed")
            .push(request.clone());
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
            path: "/Knowledge/nested".to_string(),
            kind: NodeEntryKind::Directory,
            has_children: true,
        }])
    }

    async fn graph_links(
        &self,
        request: vfs_types::GraphLinksRequest,
    ) -> Result<Vec<vfs_types::LinkEdge>> {
        self.graph_link_requests
            .lock()
            .expect("graph links lock should succeed")
            .push(request);
        Ok(vec![sample_link("/Knowledge/a.md", "/Knowledge/b.md")])
    }

    async fn graph_neighborhood(
        &self,
        request: vfs_types::GraphNeighborhoodRequest,
    ) -> Result<Vec<vfs_types::LinkEdge>> {
        self.graph_requests
            .lock()
            .expect("graph lock should succeed")
            .push(request);
        Ok(vec![sample_link("/Knowledge/a.md", "/Knowledge/b.md")])
    }

    async fn incoming_links(
        &self,
        request: vfs_types::IncomingLinksRequest,
    ) -> Result<Vec<vfs_types::LinkEdge>> {
        self.incoming_requests
            .lock()
            .expect("incoming lock should succeed")
            .push(request);
        Ok(vec![sample_link("/Knowledge/source.md", "/Knowledge/a.md")])
    }

    async fn outgoing_links(
        &self,
        request: vfs_types::OutgoingLinksRequest,
    ) -> Result<Vec<vfs_types::LinkEdge>> {
        self.outgoing_requests
            .lock()
            .expect("outgoing lock should succeed")
            .push(request);
        Ok(vec![sample_link("/Knowledge/a.md", "/Knowledge/target.md")])
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
            .push(request.clone());
        let search_hits = self
            .search_hits
            .lock()
            .expect("search hits lock should succeed");
        if !search_hits.is_empty() {
            return Ok(search_hits.clone());
        }
        drop(search_hits);
        let nodes = self.nodes.lock().expect("nodes lock should succeed");
        if !nodes.is_empty() {
            return Ok(nodes
                .values()
                .filter(|node| {
                    node.path
                        .starts_with(request.prefix.as_deref().unwrap_or_default())
                        && node.content.contains(&request.query_text)
                })
                .map(|node| SearchNodeHit {
                    path: node.path.clone(),
                    kind: node.kind.clone(),
                    snippet: Some(node.path.clone()),
                    preview: None,
                    score: -1.0,
                    match_reasons: vec!["content_fts".to_string()],
                })
                .collect());
        }
        Ok(Vec::new())
    }

    async fn search_node_paths(
        &self,
        request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>> {
        self.path_search_requests
            .lock()
            .expect("path search lock should succeed")
            .push(request.clone());
        let path_search_hits = self
            .path_search_hits
            .lock()
            .expect("path search hits lock should succeed");
        if !path_search_hits.is_empty() {
            return Ok(path_search_hits.clone());
        }
        drop(path_search_hits);
        let nodes = self.nodes.lock().expect("nodes lock should succeed");
        if !nodes.is_empty() {
            return Ok(nodes
                .values()
                .filter(|node| {
                    node.path
                        .starts_with(request.prefix.as_deref().unwrap_or_default())
                        && node.path.contains(&request.query_text)
                })
                .map(|node| SearchNodeHit {
                    path: node.path.clone(),
                    kind: node.kind.clone(),
                    snippet: Some(node.path.clone()),
                    preview: None,
                    score: -1.0,
                    match_reasons: vec!["path_substring".to_string()],
                })
                .collect());
        }
        Ok(vec![SearchNodeHit {
            path: "/Knowledge/nested/beta.md".to_string(),
            kind: NodeKind::File,
            snippet: Some("/Knowledge/nested/beta.md".to_string()),
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
async fn agent_tools_default_read_scopes_to_vfs_root() {
    let client = ToolMockClient::default();
    for (name, input) in [
        ("ls", serde_json::json!({ "database_id": "default" })),
        (
            "glob",
            serde_json::json!({ "database_id": "default", "pattern": "**/*.md" }),
        ),
        (
            "search",
            serde_json::json!({ "database_id": "default", "query_text": "nested" }),
        ),
        (
            "search_paths",
            serde_json::json!({ "database_id": "default", "query_text": "nested" }),
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
        "/"
    );
    assert_eq!(
        client
            .glob_requests
            .lock()
            .expect("glob lock should succeed")[0]
            .path,
        Some("/".to_string())
    );
    assert_eq!(
        client
            .search_requests
            .lock()
            .expect("search lock should succeed")[0]
            .prefix,
        Some("/".to_string())
    );
    assert_eq!(
        client
            .path_search_requests
            .lock()
            .expect("path search lock should succeed")[0]
            .prefix,
        Some("/".to_string())
    );
}

#[tokio::test]
async fn agent_search_ranks_sources_last_when_prefix_is_omitted() {
    let client = ToolMockClient::default();
    *client
        .search_hits
        .lock()
        .expect("search hits lock should succeed") = vec![
        sample_hit("/Sources/evidence/chat.md"),
        sample_hit("/Knowledge/answer.md"),
        sample_hit("/Memory/context.md"),
        sample_hit("/Sources/web/page.md"),
    ];
    *client
        .path_search_hits
        .lock()
        .expect("path search hits lock should succeed") = vec![
        sample_hit("/Sources/evidence/chat.md"),
        sample_hit("/Knowledge/answer.md"),
        sample_hit("/Memory/context.md"),
        sample_hit("/Sources/web/page.md"),
    ];

    let search = handle_anthropic_tool_call(
        &client,
        "search",
        serde_json::json!({ "database_id": "default", "query_text": "answer" }),
    )
    .await
    .expect("search tool should succeed");
    assert_eq!(
        hit_paths(&search),
        vec![
            "/Knowledge/answer.md",
            "/Memory/context.md",
            "/Sources/evidence/chat.md",
            "/Sources/web/page.md"
        ]
    );

    let path_search = handle_anthropic_tool_call(
        &client,
        "search_paths",
        serde_json::json!({ "database_id": "default", "query_text": "answer" }),
    )
    .await
    .expect("path search tool should succeed");
    assert_eq!(
        hit_paths(&path_search),
        vec![
            "/Knowledge/answer.md",
            "/Memory/context.md",
            "/Sources/evidence/chat.md",
            "/Sources/web/page.md"
        ]
    );
}

#[tokio::test]
async fn agent_search_preserves_order_when_prefix_is_explicit() {
    let client = ToolMockClient::default();
    *client
        .search_hits
        .lock()
        .expect("search hits lock should succeed") = vec![
        sample_hit("/Sources/evidence/chat.md"),
        sample_hit("/Knowledge/answer.md"),
    ];

    let search = handle_anthropic_tool_call(
        &client,
        "search",
        serde_json::json!({ "database_id": "default", "query_text": "answer", "prefix": "/" }),
    )
    .await
    .expect("search tool should succeed");
    assert_eq!(
        hit_paths(&search),
        vec!["/Sources/evidence/chat.md", "/Knowledge/answer.md"]
    );
}

#[test]
fn tool_schemas_include_minimal_vfs_tools() {
    let openai = create_openai_tools();
    let anthropic = create_anthropic_tools();
    assert_eq!(openai.len(), 21);
    assert_eq!(anthropic.len(), 21);

    let openai_names = tool_names(&openai, "function");
    let anthropic_names = tool_names(&anthropic, "name");

    for name in [
        "read",
        "read_context",
        "write",
        "append",
        "edit",
        "ls",
        "mkdir",
        "mv",
        "glob",
        "graph_neighborhood",
        "graph_links",
        "incoming_links",
        "outgoing_links",
        "multi_edit",
        "rm",
        "search",
        "search_paths",
        "skill_find",
        "skill_inspect",
        "skill_read",
        "skill_record_run",
    ] {
        assert!(openai_names.contains(&name.to_string()));
        assert!(anthropic_names.contains(&name.to_string()));
    }
}

#[test]
fn read_only_tool_schemas_exclude_skill_record_run() {
    let tools = create_openai_read_only_tools();
    let names = tool_names(&tools, "name");
    assert!(names.contains(&"skill_find".to_string()));
    assert!(names.contains(&"skill_read".to_string()));
    assert!(!names.contains(&"skill_record_run".to_string()));
}

#[tokio::test]
async fn read_only_dispatch_rejects_write_tools() {
    let client = ToolMockClient::default();
    let result = handle_openai_read_only_tool_call(
        &client,
        "write",
        r#"{"database_id":"default","path":"/Knowledge/a.md","content":"body"}"#,
    )
    .await
    .expect("read-only dispatch should return a tool result");
    assert!(result.is_error);
    assert!(result.text.contains("read-only tool set rejects"));
}

#[test]
fn tool_schemas_cap_query_result_limits() {
    let openai = create_openai_tools();
    let search = openai_tool_parameters(&openai, "search");
    assert_eq!(search["properties"]["top_k"]["maximum"], 100);
    assert_eq!(
        search["properties"]["preview_mode"]["enum"],
        serde_json::json!(["none", "light", "content_start"])
    );

    let search_paths = openai_tool_parameters(&openai, "search_paths");
    assert_eq!(search_paths["properties"]["top_k"]["maximum"], 100);

    let skill_find = openai_tool_parameters(&openai, "skill_find");
    assert_eq!(skill_find["properties"]["top_k"]["maximum"], 20);

    let read_context = openai_tool_parameters(&openai, "read_context");
    assert_eq!(read_context["properties"]["link_limit"]["maximum"], 100);

    let graph = openai_tool_parameters(&openai, "graph_neighborhood");
    assert_eq!(graph["properties"]["depth"]["maximum"], 2);
    assert_eq!(graph["properties"]["limit"]["maximum"], 100);

    let rm = openai_tool_parameters(&openai, "rm");
    assert!(rm["properties"].get("expected_folder_index_etag").is_some());
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
        r#"{"database_id":"default","path":"/Knowledge/a.md","content":"tail","expected_etag":"etag-1","separator":"\n"}"#,
    )
    .await
    .expect("append dispatch should succeed");
    assert!(!append.is_error);

    let edit = handle_openai_tool_call(
        &client,
        "edit",
        r#"{"database_id":"default","path":"/Knowledge/a.md","old_text":"before","new_text":"after","replace_all":false}"#,
    )
    .await
    .expect("edit dispatch should succeed");
    assert!(!edit.is_error);

    let append_requests = client
        .append_requests
        .lock()
        .expect("append lock should succeed");
    assert_eq!(append_requests.len(), 1);
    assert_eq!(append_requests[0].path, "/Knowledge/a.md");
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
            "database_id": "default",
            "path": "/Knowledge/a.md",
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
        serde_json::json!({ "database_id": "default", "path": "/Knowledge/new-dir" }),
    )
    .await
    .expect("mkdir tool should succeed");
    assert!(!result.is_error);
    let mkdirs = client
        .mkdir_requests
        .lock()
        .expect("mkdir lock should succeed");
    assert_eq!(mkdirs.len(), 1);
    assert_eq!(mkdirs[0].path, "/Knowledge/new-dir");
}

#[tokio::test]
async fn anthropic_dispatch_rm_autofills_folder_index_etag() {
    let client = ToolMockClient::default();
    {
        let mut nodes = client.nodes.lock().expect("nodes lock should succeed");
        nodes.insert(
            "/Knowledge/topic".to_string(),
            Node {
                kind: NodeKind::Folder,
                etag: "etag-folder".to_string(),
                ..sample_node("/Knowledge/topic", "", "etag-folder")
            },
        );
        nodes.insert(
            "/Knowledge/topic/index.md".to_string(),
            sample_node("/Knowledge/topic/index.md", "", "etag-index"),
        );
    }

    let result = handle_anthropic_tool_call(
        &client,
        "rm",
        serde_json::json!({
            "database_id": "default",
            "path": "/Knowledge/topic",
            "expected_etag": "etag-folder"
        }),
    )
    .await
    .expect("rm tool should dispatch");

    assert!(!result.is_error);
    let deletes = client
        .delete_requests
        .lock()
        .expect("delete lock should succeed");
    assert_eq!(deletes[0].path, "/Knowledge/topic");
    assert_eq!(deletes[0].expected_etag.as_deref(), Some("etag-folder"));
    assert_eq!(
        deletes[0].expected_folder_index_etag.as_deref(),
        Some("etag-index")
    );
}

#[tokio::test]
async fn anthropic_dispatch_rm_keeps_explicit_folder_index_etag() {
    let client = ToolMockClient::default();
    {
        let mut nodes = client.nodes.lock().expect("nodes lock should succeed");
        nodes.insert(
            "/Knowledge/topic".to_string(),
            Node {
                kind: NodeKind::Folder,
                etag: "etag-folder".to_string(),
                ..sample_node("/Knowledge/topic", "", "etag-folder")
            },
        );
        nodes.insert(
            "/Knowledge/topic/index.md".to_string(),
            sample_node("/Knowledge/topic/index.md", "", "etag-index"),
        );
    }

    let result = handle_anthropic_tool_call(
        &client,
        "rm",
        serde_json::json!({
            "database_id": "default",
            "path": "/Knowledge/topic",
            "expected_etag": "etag-folder",
            "expected_folder_index_etag": "stale"
        }),
    )
    .await
    .expect("rm tool should dispatch");

    assert!(!result.is_error);
    let deletes = client
        .delete_requests
        .lock()
        .expect("delete lock should succeed");
    assert_eq!(
        deletes[0].expected_folder_index_etag.as_deref(),
        Some("stale")
    );
}

#[tokio::test]
async fn anthropic_dispatch_routes_move_glob_and_multi_edit() {
    let client = ToolMockClient::default();

    let moved = handle_anthropic_tool_call(
        &client,
        "mv",
        serde_json::json!({
            "database_id": "default",
            "from_path": "/Knowledge/a.md",
            "to_path": "/Knowledge/b.md",
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
            "database_id": "default",
            "pattern": "**/*.md",
            "path": "/Knowledge",
            "node_type": "directory"
        }),
    )
    .await
    .expect("glob tool should succeed");
    assert!(!globbed.is_error);

    let multi_edit = handle_anthropic_tool_call(
        &client,
        "multi_edit",
        serde_json::json!({
            "database_id": "default",
            "path": "/Knowledge/a.md",
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
            "database_id": "default",
            "query_text": "nested",
            "prefix": "/Knowledge",
            "top_k": 5,
            "preview_mode": "content_start"
        }),
    )
    .await
    .expect("search paths tool should succeed");
    assert!(!result.is_error);
    assert!(result.text.contains("/Knowledge/nested/beta.md"));
    assert!(result.text.contains("path_substring"));
    assert_eq!(
        client
            .path_search_requests
            .lock()
            .expect("path search lock should succeed")[0]
            .preview_mode,
        Some(SearchPreviewMode::ContentStart)
    );
}

#[tokio::test]
async fn anthropic_dispatch_routes_search_preview_mode() {
    let client = ToolMockClient::default();
    let result = handle_anthropic_tool_call(
        &client,
        "search",
        serde_json::json!({
            "database_id": "default",
            "query_text": "body",
            "prefix": "/Knowledge",
            "top_k": 5,
            "preview_mode": "content_start"
        }),
    )
    .await
    .expect("search tool should succeed");

    assert!(!result.is_error);
    assert_eq!(
        client
            .search_requests
            .lock()
            .expect("search lock should succeed")[0]
            .preview_mode,
        Some(SearchPreviewMode::ContentStart)
    );
}

#[tokio::test]
async fn anthropic_dispatch_routes_skill_tools() {
    let client = ToolMockClient::default();
    seed_skill_nodes(&client);

    let found = handle_anthropic_tool_call(
        &client,
        "skill_find",
        serde_json::json!({
            "database_id": "default",
            "query_text": "contract",
            "top_k": 5
        }),
    )
    .await
    .expect("skill find should dispatch");
    assert!(!found.is_error);
    assert!(found.text.contains("\"id\": \"legal-review\""));
    assert!(!found.text.contains("\"id\": \"old-skill\""));

    let deprecated = handle_anthropic_tool_call(
        &client,
        "skill_find",
        serde_json::json!({
            "database_id": "default",
            "query_text": "contract",
            "include_deprecated": true
        }),
    )
    .await
    .expect("skill find should include deprecated");
    assert!(deprecated.text.contains("\"id\": \"old-skill\""));

    let inspected = handle_anthropic_tool_call(
        &client,
        "skill_inspect",
        serde_json::json!({
            "database_id": "default",
            "id": "legal-review"
        }),
    )
    .await
    .expect("skill inspect should dispatch");
    assert!(!inspected.is_error);
    assert!(inspected.text.contains("\"ingest.md\": true"));

    let read = handle_anthropic_tool_call(
        &client,
        "skill_read",
        serde_json::json!({
            "database_id": "default",
            "id": "legal-review",
            "file": "ingest.md"
        }),
    )
    .await
    .expect("skill read should dispatch");
    assert!(!read.is_error);
    assert!(read.text.contains("contract ingest"));

    let recorded = handle_anthropic_tool_call(
        &client,
        "skill_record_run",
        serde_json::json!({
            "database_id": "default",
            "id": "legal-review",
            "task": "review contract",
            "outcome": "success",
            "notes": "helped find missing approval",
            "agent": "codex"
        }),
    )
    .await
    .expect("skill record run should dispatch");
    assert!(!recorded.is_error);
    assert!(recorded.text.contains("/Sources/skill-runs/legal-review/"));
}

#[tokio::test]
async fn skill_read_rejects_non_package_paths_and_requires_database() {
    let client = ToolMockClient::default();

    for file in [
        "../secret.md",
        "/Skills/legal-review/SKILL.md",
        "https://example.com/a.md",
    ] {
        let result = handle_anthropic_tool_call(
            &client,
            "skill_read",
            serde_json::json!({
                "database_id": "default",
                "id": "legal-review",
                "file": file
            }),
        )
        .await
        .expect("skill read should return tool error");
        assert!(result.is_error);
    }

    let missing_database = handle_anthropic_tool_call(
        &client,
        "skill_find",
        serde_json::json!({ "query_text": "contract" }),
    )
    .await
    .expect("skill find should return tool error");
    assert!(missing_database.is_error);
    assert!(missing_database.text.contains("database_id is required"));
}

#[tokio::test]
async fn anthropic_dispatch_routes_link_tools() {
    let client = ToolMockClient::default();

    for (name, input) in [
        (
            "read_context",
            serde_json::json!({ "database_id": "default", "path": "/Knowledge/a.md", "link_limit": 7 }),
        ),
        (
            "graph_neighborhood",
            serde_json::json!({ "database_id": "default", "center_path": "/Knowledge/a.md", "depth": 2, "limit": 9 }),
        ),
        (
            "graph_links",
            serde_json::json!({ "database_id": "default", "prefix": "/Knowledge", "limit": 11 }),
        ),
        (
            "incoming_links",
            serde_json::json!({ "database_id": "default", "path": "/Knowledge/a.md", "limit": 13 }),
        ),
        (
            "outgoing_links",
            serde_json::json!({ "database_id": "default", "path": "/Knowledge/a.md", "limit": 15 }),
        ),
    ] {
        let result = handle_anthropic_tool_call(&client, name, input)
            .await
            .expect("link tool should dispatch");
        assert!(!result.is_error);
    }

    assert_eq!(
        client
            .context_requests
            .lock()
            .expect("context lock should succeed")[0]
            .link_limit,
        7
    );
    assert_eq!(
        client
            .graph_requests
            .lock()
            .expect("graph lock should succeed")[0]
            .depth,
        2
    );
    assert_eq!(
        client
            .graph_link_requests
            .lock()
            .expect("graph links lock should succeed")[0]
            .limit,
        11
    );
    assert_eq!(
        client
            .incoming_requests
            .lock()
            .expect("incoming lock should succeed")[0]
            .limit,
        13
    );
    assert_eq!(
        client
            .outgoing_requests
            .lock()
            .expect("outgoing lock should succeed")[0]
            .limit,
        15
    );
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

fn sample_hit(path: &str) -> SearchNodeHit {
    SearchNodeHit {
        path: path.to_string(),
        kind: NodeKind::File,
        snippet: Some(path.to_string()),
        preview: None,
        score: -1.0,
        match_reasons: vec!["content_fts".to_string()],
    }
}

fn hit_paths(result: &vfs_cli::agent_tools::ToolResult) -> Vec<String> {
    let value: Value = serde_json::from_str(&result.text).expect("tool result should be JSON");
    value["hits"]
        .as_array()
        .expect("hits should be an array")
        .iter()
        .map(|hit| {
            hit["path"]
                .as_str()
                .expect("hit path should be a string")
                .to_string()
        })
        .collect()
}

fn sample_ack(path: &str, kind: NodeKind, etag: &str) -> NodeMutationAck {
    NodeMutationAck {
        path: path.to_string(),
        kind,
        updated_at: 2,
        etag: etag.to_string(),
    }
}

fn sample_link(source_path: &str, target_path: &str) -> vfs_types::LinkEdge {
    vfs_types::LinkEdge {
        source_path: source_path.to_string(),
        target_path: target_path.to_string(),
        raw_href: target_path.to_string(),
        link_text: "target".to_string(),
        link_kind: "wiki".to_string(),
        updated_at: 2,
    }
}

fn seed_skill_nodes(client: &ToolMockClient) {
    let mut nodes = client.nodes.lock().expect("nodes lock should succeed");
    for (path, content) in [
        (
            "/Skills/legal-review/manifest.md",
            concat!(
                "---\n",
                "kind: kinic.skill\n",
                "schema_version: 1\n",
                "id: legal-review\n",
                "version: 0.1.0\n",
                "entry: SKILL.md\n",
                "summary: Contract review workflow\n",
                "tags:\n",
                "- legal\n",
                "use_cases:\n",
                "- Review contract redlines\n",
                "status: promoted\n",
                "---\n"
            ),
        ),
        (
            "/Skills/legal-review/SKILL.md",
            "# Legal Review\n\ncontract review",
        ),
        (
            "/Skills/legal-review/ingest.md",
            "# Ingest\n\ncontract ingest",
        ),
        (
            "/Skills/old-skill/manifest.md",
            concat!(
                "---\n",
                "kind: kinic.skill\n",
                "schema_version: 1\n",
                "id: old-skill\n",
                "version: 0.1.0\n",
                "entry: SKILL.md\n",
                "summary: Old contract workflow\n",
                "status: deprecated\n",
                "---\n"
            ),
        ),
        ("/Skills/old-skill/SKILL.md", "# Old\n\ncontract review"),
    ] {
        nodes.insert(path.to_string(), sample_node(path, content, "etag-skill"));
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

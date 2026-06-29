// Where: crates/vfs_cli_app/src/mcp.rs
// What: Local stdio MCP adapter for read-only Store/Recall tools.
// Why: AI clients should recall Kinic store context without shelling out per operation.
use anyhow::{Result, anyhow};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use vfs_cli::skill_kb;
use vfs_client::VfsApi;
use vfs_types::{QueryContextRequest, SourceEvidenceRequest};

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MCP_SERVER_NAME: &str = "kinic-store-recall";
const MCP_SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

pub async fn run_mcp_stdio_server(client: &impl VfsApi, database_id: &str) -> Result<()> {
    let scope = McpDatabaseScope::new(database_id)?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_json_rpc_message(client, &scope, &line).await {
            stdout.write_all(response.as_bytes())?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

pub async fn run_mcp_server<R, W>(
    client: &impl VfsApi,
    database_id: &str,
    reader: R,
    mut writer: W,
) -> Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let scope = McpDatabaseScope::new(database_id)?;
    let mut lines = reader.lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_json_rpc_message(client, &scope, &line).await {
            writer.write_all(response.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
        }
    }
    Ok(())
}

pub async fn handle_json_rpc_message(
    client: &impl VfsApi,
    scope: &McpDatabaseScope,
    line: &str,
) -> Option<String> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return Some(serialize_error(
                None,
                -32700,
                format!("parse error: {error}"),
            ));
        }
    };
    let Some(object) = value.as_object() else {
        return Some(serialize_error(None, -32600, "invalid request"));
    };
    let id = object.get("id").cloned();
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Some(serialize_error(id, -32600, "missing method"));
    };
    let id = id?;
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "initialize" => Ok(initialize_result()),
        "notifications/initialized" => return None,
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_specs() })),
        "tools/call" => call_tool(client, scope, params).await,
        _ => {
            return Some(serialize_error(
                Some(id),
                -32601,
                format!("method not found: {method}"),
            ));
        }
    };
    Some(match result {
        Ok(result) => serialize_response(id, result),
        Err(error) => serialize_error(Some(id), -32600, error.to_string()),
    })
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": MCP_SERVER_NAME,
            "version": MCP_SERVER_VERSION
        }
    })
}

async fn call_tool(client: &impl VfsApi, scope: &McpDatabaseScope, params: Value) -> Result<Value> {
    let request: ToolCallRequest = serde_json::from_value(params)?;
    let arguments = request.arguments.unwrap_or_else(|| json!({}));
    let result = match dispatch_tool(client, scope, &request.name, arguments).await {
        Ok(value) => tool_result(value, false),
        Err(error) => tool_result(json!({ "error": error.to_string() }), true),
    };
    Ok(result)
}

async fn dispatch_tool(
    client: &impl VfsApi,
    scope: &McpDatabaseScope,
    name: &str,
    arguments: Value,
) -> Result<Value> {
    match name {
        "kinic.memory_manifest" => {
            let args: MemoryManifestArgs = serde_json::from_value(arguments)?;
            Ok(json!(
                client
                    .memory_manifest(&scope.database_id(args.database_id)?)
                    .await?
            ))
        }
        "kinic.query_context" => {
            let args: QueryContextArgs = serde_json::from_value(arguments)?;
            Ok(json!(
                client
                    .query_context(QueryContextRequest {
                        database_id: scope.database_id(args.database_id)?,
                        task: args.task,
                        entities: args.entities.unwrap_or_default(),
                        namespace: args.namespace,
                        budget_tokens: args.budget_tokens.unwrap_or(0),
                        include_evidence: args.include_evidence.unwrap_or(true),
                        depth: args.depth.unwrap_or(1),
                    })
                    .await?
            ))
        }
        "kinic.source_evidence" => {
            let args: SourceEvidenceArgs = serde_json::from_value(arguments)?;
            Ok(json!(
                client
                    .source_evidence(SourceEvidenceRequest {
                        database_id: scope.database_id(args.database_id)?,
                        node_path: args.node_path,
                    })
                    .await?
            ))
        }
        "kinic.skill_find" => {
            let args: SkillFindArgs = serde_json::from_value(arguments)?;
            skill_kb::find_skills(
                client,
                &scope.database_id(args.database_id)?,
                &args.query_text,
                args.include_deprecated.unwrap_or(false),
                args.top_k.unwrap_or(5),
            )
            .await
        }
        _ => Err(anyhow!("unknown tool: {name}")),
    }
}

fn tool_result(value: Value, is_error: bool) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": serde_json::to_string_pretty(&value).expect("tool result should serialize")
            }
        ],
        "isError": is_error
    })
}

fn tool_specs() -> Vec<Value> {
    vec![
        json!({
            "name": "kinic.memory_manifest",
            "description": "Return Store API version, roots, limits, and capability summary for one Kinic database.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "database_id": { "type": "string" }
                },
                "required": ["database_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "kinic.query_context",
            "description": "Return task-scoped memory context, selected nodes, graph links, and optional evidence.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "database_id": { "type": "string" },
                    "task": { "type": "string" },
                    "entities": { "type": "array", "items": { "type": "string" } },
                    "namespace": { "type": "string" },
                    "budget_tokens": { "type": "integer", "minimum": 0 },
                    "include_evidence": { "type": "boolean" },
                    "depth": { "type": "integer", "minimum": 0, "maximum": 2 }
                },
                "required": ["database_id", "task"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "kinic.source_evidence",
            "description": "Return source references and freshness metadata for one known wiki node path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "database_id": { "type": "string" },
                    "node_path": { "type": "string" }
                },
                "required": ["database_id", "node_path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "kinic.skill_find",
            "description": "Find Skill KB packages for a task query.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "database_id": { "type": "string" },
                    "query_text": { "type": "string" },
                    "top_k": { "type": "integer", "minimum": 1, "maximum": 20 },
                    "include_deprecated": { "type": "boolean" }
                },
                "required": ["database_id", "query_text"],
                "additionalProperties": false
            }
        }),
    ]
}

pub struct McpDatabaseScope {
    database_id: String,
}

impl McpDatabaseScope {
    fn new(database_id: &str) -> Result<Self> {
        if database_id.is_empty() {
            return Err(anyhow!("database_id is required"));
        }
        Ok(Self {
            database_id: database_id.to_string(),
        })
    }

    fn database_id(&self, value: Option<String>) -> Result<String> {
        let value = value
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("database_id is required"))?;
        if value != self.database_id {
            return Err(anyhow!(
                "database_id does not match MCP server scope: expected {}",
                self.database_id
            ));
        }
        Ok(value)
    }
}

fn serialize_response(id: Value, result: Value) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
    .expect("JSON-RPC response should serialize")
}

fn serialize_error(id: Option<Value>, code: i64, message: impl Into<String>) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": code,
            "message": message.into(),
        },
    }))
    .expect("JSON-RPC error should serialize")
}

#[derive(Deserialize)]
struct ToolCallRequest {
    name: String,
    arguments: Option<Value>,
}

#[derive(Deserialize)]
struct MemoryManifestArgs {
    database_id: Option<String>,
}

#[derive(Deserialize)]
struct QueryContextArgs {
    database_id: Option<String>,
    task: String,
    entities: Option<Vec<String>>,
    namespace: Option<String>,
    budget_tokens: Option<u32>,
    include_evidence: Option<bool>,
    depth: Option<u32>,
}

#[derive(Deserialize)]
struct SourceEvidenceArgs {
    database_id: Option<String>,
    node_path: String,
}

#[derive(Deserialize)]
struct SkillFindArgs {
    database_id: Option<String>,
    query_text: String,
    top_k: Option<u32>,
    include_deprecated: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, BufReader};
    use vfs_types::{
        AppendNodeRequest, ChildNode, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest,
        EditNodeResult, ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest,
        FetchUpdatesResponse, GlobNodeHit, GlobNodesRequest, ListChildrenRequest, ListNodesRequest,
        MemoryCapability, MemoryManifest, MemoryRoot, MkdirNodeRequest, MkdirNodeResult,
        MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node,
        NodeEntry, QueryContext, SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest,
        SearchPreviewMode, SourceEvidence, SourceEvidenceRef, Status, WriteNodeRequest,
        WriteNodeResult,
    };

    #[derive(Default)]
    struct McpMockClient {
        memory_manifest_requests: Mutex<Vec<String>>,
        query_context_requests: Mutex<Vec<QueryContextRequest>>,
        source_evidence_requests: Mutex<Vec<SourceEvidenceRequest>>,
        search_requests: Mutex<Vec<SearchNodesRequest>>,
    }

    #[async_trait]
    impl VfsApi for McpMockClient {
        async fn status(&self, _database_id: &str) -> Result<Status> {
            Ok(Status {
                file_count: 0,
                source_count: 0,
            })
        }

        async fn memory_manifest(&self, database_id: &str) -> Result<MemoryManifest> {
            self.memory_manifest_requests
                .lock()
                .expect("memory manifest lock should succeed")
                .push(database_id.to_string());
            Ok(MemoryManifest {
                api_version: "kinic-stores-v1".to_string(),
                purpose: "memory".to_string(),
                enabled_stores: vec!["memory".to_string()],
                roots: vec![MemoryRoot {
                    path: "/Memory".to_string(),
                    kind: "memory".to_string(),
                }],
                entry_roots: vec![MemoryRoot {
                    path: "/Memory".to_string(),
                    kind: "query_context".to_string(),
                }],
                capabilities: vec![MemoryCapability {
                    name: "query_context".to_string(),
                    description: "recall".to_string(),
                }],
                canonical_roles: Vec::new(),
                write_policy: "store_recall_read_only".to_string(),
                recommended_entrypoint: "query_context".to_string(),
                max_depth: 2,
                max_query_limit: 100,
                budget_unit: "approx_chars_from_tokens".to_string(),
            })
        }

        async fn query_context(&self, request: QueryContextRequest) -> Result<QueryContext> {
            self.query_context_requests
                .lock()
                .expect("query context lock should succeed")
                .push(request.clone());
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
                .expect("source evidence lock should succeed")
                .push(request.clone());
            Ok(SourceEvidence {
                node_path: request.node_path,
                refs: vec![SourceEvidenceRef {
                    source_path: "/Sources/web/source.md".to_string(),
                    via_path: "/Knowledge/topic.md".to_string(),
                    raw_href: "https://example.com".to_string(),
                    link_text: "source".to_string(),
                    source_etag: Some("etag-1".to_string()),
                    source_updated_at: Some(1),
                    source_content_hash: Some("sha256:abc".to_string()),
                }],
            })
        }

        async fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
            self.search_requests
                .lock()
                .expect("search lock should succeed")
                .push(request);
            Ok(Vec::new())
        }

        async fn read_node(&self, _database_id: &str, _path: &str) -> Result<Option<Node>> {
            Err(anyhow!("read_node is not used by MCP tests"))
        }

        async fn list_nodes(&self, _request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            Err(anyhow!("list_nodes is not used by MCP tests"))
        }

        async fn list_children(&self, _request: ListChildrenRequest) -> Result<Vec<ChildNode>> {
            Err(anyhow!("list_children is not used by MCP tests"))
        }

        async fn write_node(&self, _request: WriteNodeRequest) -> Result<WriteNodeResult> {
            Err(anyhow!("write_node is not used by MCP tests"))
        }

        async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
            Err(anyhow!("append_node is not used by MCP tests"))
        }

        async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
            Err(anyhow!("edit_node is not used by MCP tests"))
        }

        async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            Err(anyhow!("delete_node is not used by MCP tests"))
        }

        async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
            Err(anyhow!("move_node is not used by MCP tests"))
        }

        async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
            Err(anyhow!("mkdir_node is not used by MCP tests"))
        }

        async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            Err(anyhow!("glob_nodes is not used by MCP tests"))
        }

        async fn multi_edit_node(
            &self,
            _request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            Err(anyhow!("multi_edit_node is not used by MCP tests"))
        }

        async fn search_node_paths(
            &self,
            _request: SearchNodePathsRequest,
        ) -> Result<Vec<SearchNodeHit>> {
            Err(anyhow!("search_node_paths is not used by MCP tests"))
        }

        async fn export_snapshot(
            &self,
            _request: ExportSnapshotRequest,
        ) -> Result<ExportSnapshotResponse> {
            Err(anyhow!("export_snapshot is not used by MCP tests"))
        }

        async fn fetch_updates(
            &self,
            _request: FetchUpdatesRequest,
        ) -> Result<FetchUpdatesResponse> {
            Err(anyhow!("fetch_updates is not used by MCP tests"))
        }
    }

    #[tokio::test]
    async fn initialize_returns_tools_capability() {
        let client = McpMockClient::default();
        let response = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        )
        .await
        .expect("initialize should respond");
        let value: Value = serde_json::from_str(&response).expect("response should parse");
        assert_eq!(
            value["result"]["protocolVersion"],
            Value::String(MCP_PROTOCOL_VERSION.to_string())
        );
        assert!(value["result"]["capabilities"]["tools"].is_object());
    }

    #[tokio::test]
    async fn initialized_notification_has_no_response() {
        let client = McpMockClient::default();
        let response = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#,
        )
        .await;
        assert!(response.is_none());
    }

    #[tokio::test]
    async fn tools_list_returns_v0_tools_only() {
        let client = McpMockClient::default();
        let response = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        )
        .await
        .expect("tools/list should respond");
        let value: Value = serde_json::from_str(&response).expect("response should parse");
        let names = value["result"]["tools"]
            .as_array()
            .expect("tools should be array")
            .iter()
            .map(|tool| tool["name"].as_str().expect("tool name should be string"))
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "kinic.memory_manifest",
                "kinic.query_context",
                "kinic.source_evidence",
                "kinic.skill_find"
            ]
        );
    }

    #[tokio::test]
    async fn memory_manifest_tool_calls_client() {
        let client = McpMockClient::default();
        let response = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kinic.memory_manifest","arguments":{"database_id":"db_alpha"}}}"#,
        )
        .await
        .expect("tools/call should respond");
        assert_tool_ok(&response);
        assert_eq!(
            *client
                .memory_manifest_requests
                .lock()
                .expect("memory manifest lock should succeed"),
            vec!["db_alpha".to_string()]
        );
    }

    #[tokio::test]
    async fn query_context_tool_builds_request() {
        let client = McpMockClient::default();
        let response = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"kinic.query_context","arguments":{"database_id":"db_alpha","task":"summarize decisions","entities":["project"],"namespace":"/Memory","budget_tokens":1200,"include_evidence":false,"depth":2}}}"#,
        )
        .await
        .expect("tools/call should respond");
        assert_tool_ok(&response);
        let requests = client
            .query_context_requests
            .lock()
            .expect("query context lock should succeed");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].database_id, "db_alpha");
        assert_eq!(requests[0].task, "summarize decisions");
        assert_eq!(requests[0].entities, vec!["project".to_string()]);
        assert_eq!(requests[0].namespace, Some("/Memory".to_string()));
        assert_eq!(requests[0].budget_tokens, 1200);
        assert!(!requests[0].include_evidence);
        assert_eq!(requests[0].depth, 2);
    }

    #[tokio::test]
    async fn source_evidence_tool_builds_request() {
        let client = McpMockClient::default();
        let response = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"kinic.source_evidence","arguments":{"database_id":"db_alpha","node_path":"/Knowledge/topic.md"}}}"#,
        )
        .await
        .expect("tools/call should respond");
        assert_tool_ok(&response);
        let requests = client
            .source_evidence_requests
            .lock()
            .expect("source evidence lock should succeed");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].database_id, "db_alpha");
        assert_eq!(requests[0].node_path, "/Knowledge/topic.md");
    }

    #[tokio::test]
    async fn skill_find_tool_uses_read_only_skill_search() {
        let client = McpMockClient::default();
        let response = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"kinic.skill_find","arguments":{"database_id":"db_alpha","query_text":"legal review","top_k":3}}}"#,
        )
        .await
        .expect("tools/call should respond");
        assert_tool_ok(&response);
        let requests = client
            .search_requests
            .lock()
            .expect("search lock should succeed");
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].database_id, "db_alpha");
        assert_eq!(requests[0].query_text, "legal review");
        assert_eq!(requests[0].top_k, 3);
        assert_eq!(requests[0].preview_mode, Some(SearchPreviewMode::Light));
    }

    #[tokio::test]
    async fn tool_errors_are_mcp_tool_results() {
        let client = McpMockClient::default();
        let response = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"kinic.memory_manifest","arguments":{}}}"#,
        )
        .await
        .expect("tools/call should respond");
        assert_tool_error(&response, "database_id is required");

        let response = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"kinic.unknown","arguments":{"database_id":"db_alpha"}}}"#,
        )
        .await
        .expect("tools/call should respond");
        assert_tool_error(&response, "unknown tool");
    }

    #[tokio::test]
    async fn tool_rejects_database_id_outside_server_scope() {
        let client = McpMockClient::default();
        let response = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"kinic.memory_manifest","arguments":{"database_id":"db_beta"}}}"#,
        )
        .await
        .expect("tools/call should respond");
        assert_tool_error(&response, "database_id does not match MCP server scope");
        assert!(
            client
                .memory_manifest_requests
                .lock()
                .expect("memory manifest lock should succeed")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn protocol_errors_use_json_rpc_errors() {
        let client = McpMockClient::default();
        let parse_error = handle_json_rpc_message(&client, &scope(), "{not json")
            .await
            .expect("parse error should respond");
        assert_json_rpc_error(&parse_error, -32700);

        let unknown = handle_json_rpc_message(
            &client,
            &scope(),
            r#"{"jsonrpc":"2.0","id":9,"method":"resources/list"}"#,
        )
        .await
        .expect("unknown method should respond");
        assert_json_rpc_error(&unknown, -32601);
    }

    #[tokio::test]
    async fn stdio_loop_writes_only_json_rpc_lines() {
        let client = McpMockClient::default();
        let input = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"ping"}
"#;
        let mut output = Vec::new();
        run_mcp_server(&client, "db_alpha", BufReader::new(&input[..]), &mut output)
            .await
            .expect("server loop should succeed");
        let mut text = String::new();
        (&output[..])
            .read_to_string(&mut text)
            .await
            .expect("output should be UTF-8");
        let lines = text.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        for line in lines {
            let value: Value = serde_json::from_str(line).expect("line should be JSON");
            assert_eq!(value["jsonrpc"], "2.0");
        }
    }

    fn assert_tool_ok(response: &str) {
        let value: Value = serde_json::from_str(response).expect("response should parse");
        assert_eq!(value["result"]["isError"], false);
        assert_eq!(value["result"]["content"][0]["type"], "text");
    }

    fn assert_tool_error(response: &str, expected: &str) {
        let value: Value = serde_json::from_str(response).expect("response should parse");
        assert_eq!(value["result"]["isError"], true);
        let text = value["result"]["content"][0]["text"]
            .as_str()
            .expect("text content should be string");
        assert!(text.contains(expected), "missing {expected:?} in {text:?}");
    }

    fn assert_json_rpc_error(response: &str, code: i64) {
        let value: Value = serde_json::from_str(response).expect("response should parse");
        assert_eq!(value["error"]["code"], code);
    }

    fn scope() -> McpDatabaseScope {
        McpDatabaseScope::new("db_alpha").expect("scope should build")
    }
}

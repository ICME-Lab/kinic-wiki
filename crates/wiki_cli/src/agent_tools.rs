// Where: crates/wiki_cli/src/agent_tools.rs
// What: Ready-made OpenAI/Anthropic tool schemas and dispatchers for the FS-first canister API.
// Why: Agents should be able to use familiar VFS operations without rebuilding tool definitions in each app.
use anyhow::Result;
use serde::Deserialize;
use serde_json::{Value, json};
use wiki_types::{
    AppendNodeRequest, DeleteNodeRequest, EditNodeRequest, GlobNodeType, GlobNodesRequest,
    ListNodesRequest, MkdirNodeRequest, MoveNodeRequest, MultiEdit, MultiEditNodeRequest, NodeKind,
    RecentNodesRequest, SearchNodePathsRequest, SearchNodesRequest, WriteNodeRequest,
};

use crate::client::WikiApi;

pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

pub const READ_ONLY_TOOL_NAMES: [&str; 5] = ["read", "ls", "search", "search_paths", "recent"];

pub fn create_openai_tools() -> Vec<Value> {
    create_openai_tools_for_names(tool_names_slice())
}

pub fn create_openai_tools_for_names(names: &[&str]) -> Vec<Value> {
    tool_specs()
        .into_iter()
        .filter(|spec| names.contains(&spec.name))
        .map(|spec| {
            json!({
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": spec.parameters
                }
            })
        })
        .collect()
}

pub fn create_anthropic_tools() -> Vec<Value> {
    create_anthropic_tools_for_names(tool_names_slice())
}

pub fn create_anthropic_tools_for_names(names: &[&str]) -> Vec<Value> {
    tool_specs()
        .into_iter()
        .filter(|spec| names.contains(&spec.name))
        .map(|spec| {
            json!({
                "name": spec.name,
                "description": spec.description,
                "input_schema": spec.parameters
            })
        })
        .collect()
}

pub fn create_openai_read_only_tools() -> Vec<Value> {
    create_openai_responses_tools_for_names(&READ_ONLY_TOOL_NAMES)
}

pub fn create_openai_responses_tools_for_names(names: &[&str]) -> Vec<Value> {
    tool_specs()
        .into_iter()
        .filter(|spec| names.contains(&spec.name))
        .map(|spec| {
            json!({
                "type": "function",
                "name": spec.name,
                "description": spec.description,
                "parameters": spec.parameters,
                "strict": false
            })
        })
        .collect()
}

fn tool_names_slice() -> &'static [&'static str] {
    &[
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
    ]
}

pub async fn handle_openai_tool_call(
    client: &impl WikiApi,
    name: &str,
    arguments_json: &str,
) -> Result<ToolResult> {
    let input = match serde_json::from_str(arguments_json) {
        Ok(value) => value,
        Err(error) => return Ok(tool_error(format!("invalid tool args: {error}"))),
    };
    dispatch_tool_call(client, name, input).await
}

pub async fn handle_anthropic_tool_call(
    client: &impl WikiApi,
    name: &str,
    input: Value,
) -> Result<ToolResult> {
    dispatch_tool_call(client, name, input).await
}

async fn dispatch_tool_call(client: &impl WikiApi, name: &str, input: Value) -> Result<ToolResult> {
    match dispatch_tool_call_impl(client, name, input).await {
        Ok(result) => Ok(result),
        Err(error) => Ok(tool_error(error.to_string())),
    }
}

async fn dispatch_tool_call_impl(
    client: &impl WikiApi,
    name: &str,
    input: Value,
) -> Result<ToolResult> {
    let result = match name {
        "read" => {
            let args: ReadArgs = serde_json::from_value(input)?;
            let node = client.read_node(&args.path).await?;
            tool_ok(json!({ "node": node }))
        }
        "write" => {
            let args: WriteArgs = serde_json::from_value(input)?;
            let result = client
                .write_node(WriteNodeRequest {
                    path: args.path,
                    kind: args.kind.unwrap_or(NodeKind::File),
                    content: args.content,
                    metadata_json: args.metadata_json.unwrap_or_else(|| "{}".to_string()),
                    expected_etag: args.expected_etag,
                })
                .await?;
            tool_ok(json!(result))
        }
        "append" => {
            let args: AppendArgs = serde_json::from_value(input)?;
            let result = client
                .append_node(AppendNodeRequest {
                    path: args.path,
                    content: args.content,
                    expected_etag: args.expected_etag,
                    separator: args.separator,
                    metadata_json: args.metadata_json,
                    kind: args.kind,
                })
                .await?;
            tool_ok(json!(result))
        }
        "edit" => {
            let args: EditArgs = serde_json::from_value(input)?;
            let result = client
                .edit_node(EditNodeRequest {
                    path: args.path,
                    old_text: args.old_text,
                    new_text: args.new_text,
                    expected_etag: args.expected_etag,
                    replace_all: args.replace_all.unwrap_or(false),
                })
                .await?;
            tool_ok(json!(result))
        }
        "ls" => {
            let args: ListArgs = serde_json::from_value(input)?;
            let result = client
                .list_nodes(ListNodesRequest {
                    prefix: args.prefix.unwrap_or_else(|| "/Wiki".to_string()),
                    recursive: args.recursive.unwrap_or(false),
                })
                .await?;
            tool_ok(json!({ "entries": result }))
        }
        "mkdir" => {
            let args: MkdirArgs = serde_json::from_value(input)?;
            let result = client
                .mkdir_node(MkdirNodeRequest { path: args.path })
                .await?;
            tool_ok(json!(result))
        }
        "mv" => {
            let args: MoveArgs = serde_json::from_value(input)?;
            let result = client
                .move_node(MoveNodeRequest {
                    from_path: args.from_path,
                    to_path: args.to_path,
                    expected_etag: args.expected_etag,
                    overwrite: args.overwrite.unwrap_or(false),
                })
                .await?;
            tool_ok(json!(result))
        }
        "glob" => {
            let args: GlobArgs = serde_json::from_value(input)?;
            let result = client
                .glob_nodes(GlobNodesRequest {
                    pattern: args.pattern,
                    path: args.path,
                    node_type: args.node_type,
                })
                .await?;
            tool_ok(json!({ "hits": result }))
        }
        "recent" => {
            let args: RecentArgs = serde_json::from_value(input)?;
            let result = client
                .recent_nodes(RecentNodesRequest {
                    limit: args.limit.unwrap_or(10),
                    path: args.path,
                })
                .await?;
            tool_ok(json!({ "hits": result }))
        }
        "multi_edit" => {
            let args: MultiEditArgs = serde_json::from_value(input)?;
            let result = client
                .multi_edit_node(MultiEditNodeRequest {
                    path: args.path,
                    edits: args.edits,
                    expected_etag: args.expected_etag,
                })
                .await?;
            tool_ok(json!(result))
        }
        "rm" => {
            let args: DeleteArgs = serde_json::from_value(input)?;
            let result = client
                .delete_node(DeleteNodeRequest {
                    path: args.path,
                    expected_etag: args.expected_etag,
                })
                .await?;
            tool_ok(json!(result))
        }
        "search" => {
            let args: SearchArgs = serde_json::from_value(input)?;
            let result = client
                .search_nodes(SearchNodesRequest {
                    query_text: args.query_text,
                    prefix: args.prefix,
                    top_k: args.top_k.unwrap_or(10),
                })
                .await?;
            tool_ok(json!({ "hits": result }))
        }
        "search_paths" => {
            let args: SearchArgs = serde_json::from_value(input)?;
            let result = client
                .search_node_paths(SearchNodePathsRequest {
                    query_text: args.query_text,
                    prefix: args.prefix,
                    top_k: args.top_k.unwrap_or(10),
                })
                .await?;
            tool_ok(json!({ "hits": result }))
        }
        other => return Ok(tool_error(format!("unknown tool: {other}"))),
    };
    Ok(result)
}

fn tool_ok(value: Value) -> ToolResult {
    ToolResult {
        text: serde_json::to_string_pretty(&value).expect("tool result should serialize"),
        is_error: false,
    }
}

fn tool_error(message: String) -> ToolResult {
    ToolResult {
        text: serde_json::to_string_pretty(&json!({ "error": message }))
            .expect("tool error should serialize"),
        is_error: true,
    }
}

fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec::new("read", "Read a node by path.", read_schema()),
        ToolSpec::new("write", "Write a node by path.", write_schema()),
        ToolSpec::new("append", "Append text to a node.", append_schema()),
        ToolSpec::new(
            "edit",
            "Find and replace plain text inside a node.",
            edit_schema(),
        ),
        ToolSpec::new("ls", "List nodes under a prefix.", list_schema()),
        ToolSpec::new("mkdir", "Validate a directory-like path.", mkdir_schema()),
        ToolSpec::new("mv", "Rename one node path.", move_schema()),
        ToolSpec::new(
            "glob",
            "Match node paths with shell-style glob patterns.",
            glob_schema(),
        ),
        ToolSpec::new("recent", "List recently updated nodes.", recent_schema()),
        ToolSpec::new(
            "multi_edit",
            "Apply multiple atomic plain-text replacements to a node.",
            multi_edit_schema(),
        ),
        ToolSpec::new("rm", "Delete a node by path.", delete_schema()),
        ToolSpec::new("search", "Search current node contents.", search_schema()),
        ToolSpec::new(
            "search_paths",
            "Search node paths and filenames by case-insensitive substring.",
            search_schema(),
        ),
    ]
}

fn read_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"],
        "additionalProperties": false
    })
}

fn write_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "content": { "type": "string" },
            "kind": { "type": "string", "enum": ["file", "source"] },
            "metadata_json": { "type": "string" },
            "expected_etag": { "type": "string" }
        },
        "required": ["path", "content"],
        "additionalProperties": false
    })
}

fn append_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "content": { "type": "string" },
            "expected_etag": { "type": "string" },
            "separator": { "type": "string" },
            "metadata_json": { "type": "string" },
            "kind": { "type": "string", "enum": ["file", "source"] }
        },
        "required": ["path", "content"],
        "additionalProperties": false
    })
}

fn edit_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "old_text": { "type": "string" },
            "new_text": { "type": "string" },
            "expected_etag": { "type": "string" },
            "replace_all": { "type": "boolean" }
        },
        "required": ["path", "old_text", "new_text"],
        "additionalProperties": false
    })
}

fn list_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "prefix": { "type": "string" },
            "recursive": { "type": "boolean" }
        },
        "additionalProperties": false
    })
}

fn mkdir_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"],
        "additionalProperties": false
    })
}

fn move_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "from_path": { "type": "string" },
            "to_path": { "type": "string" },
            "expected_etag": { "type": "string" },
            "overwrite": { "type": "boolean" }
        },
        "required": ["from_path", "to_path"],
        "additionalProperties": false
    })
}

fn glob_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "pattern": { "type": "string" },
            "path": { "type": "string" },
            "node_type": { "type": "string", "enum": ["file", "directory", "any"] }
        },
        "required": ["pattern"],
        "additionalProperties": false
    })
}

fn recent_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
            "path": { "type": "string" }
        },
        "additionalProperties": false
    })
}

fn multi_edit_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "expected_etag": { "type": "string" },
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "old_text": { "type": "string" },
                        "new_text": { "type": "string" }
                    },
                    "required": ["old_text", "new_text"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["path", "edits"],
        "additionalProperties": false
    })
}

fn delete_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "expected_etag": { "type": "string" }
        },
        "required": ["path"],
        "additionalProperties": false
    })
}

fn search_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query_text": { "type": "string" },
            "prefix": { "type": "string" },
            "top_k": { "type": "integer", "minimum": 1, "maximum": 100 }
        },
        "required": ["query_text"],
        "additionalProperties": false
    })
}

#[derive(Deserialize)]
struct ReadArgs {
    path: String,
}

#[derive(Deserialize)]
struct WriteArgs {
    path: String,
    content: String,
    expected_etag: Option<String>,
    metadata_json: Option<String>,
    kind: Option<NodeKind>,
}

#[derive(Deserialize)]
struct AppendArgs {
    path: String,
    content: String,
    expected_etag: Option<String>,
    separator: Option<String>,
    metadata_json: Option<String>,
    kind: Option<NodeKind>,
}

#[derive(Deserialize)]
struct EditArgs {
    path: String,
    old_text: String,
    new_text: String,
    expected_etag: Option<String>,
    replace_all: Option<bool>,
}

#[derive(Deserialize)]
struct ListArgs {
    prefix: Option<String>,
    recursive: Option<bool>,
}

#[derive(Deserialize)]
struct MkdirArgs {
    path: String,
}

#[derive(Deserialize)]
struct MoveArgs {
    from_path: String,
    to_path: String,
    expected_etag: Option<String>,
    overwrite: Option<bool>,
}

#[derive(Deserialize)]
struct GlobArgs {
    pattern: String,
    path: Option<String>,
    node_type: Option<GlobNodeType>,
}

#[derive(Deserialize)]
struct RecentArgs {
    limit: Option<u32>,
    path: Option<String>,
}

#[derive(Deserialize)]
struct MultiEditArgs {
    path: String,
    edits: Vec<MultiEdit>,
    expected_etag: Option<String>,
}

#[derive(Deserialize)]
struct DeleteArgs {
    path: String,
    expected_etag: Option<String>,
}

#[derive(Deserialize)]
struct SearchArgs {
    query_text: String,
    prefix: Option<String>,
    top_k: Option<u32>,
}

struct ToolSpec {
    name: &'static str,
    description: &'static str,
    parameters: Value,
}

impl ToolSpec {
    fn new(name: &'static str, description: &'static str, parameters: Value) -> Self {
        Self {
            name,
            description,
            parameters,
        }
    }
}

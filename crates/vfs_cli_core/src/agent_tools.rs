// Where: crates/vfs_cli_core/src/agent_tools.rs
// What: Shared agent tool schema and dispatch for VFS operations.
// Why: Generic tool wiring should sit with the reusable VFS CLI crate rather than wiki workflow code.
use anyhow::Result;
use serde::Deserialize;
use serde_json::{Value, json};
use vfs_client::VfsApi;
use vfs_types::{
    AppendNodeRequest, EditNodeRequest, GlobNodeType, GlobNodesRequest, GraphLinksRequest,
    GraphNeighborhoodRequest, IncomingLinksRequest, ListNodesRequest, MkdirNodeRequest,
    MoveNodeRequest, MultiEdit, MultiEditNodeRequest, NodeContextRequest, NodeKind,
    OutgoingLinksRequest, SearchNodePathsRequest, SearchNodesRequest, SearchPreviewMode,
    WriteNodeRequest,
};

use crate::cli::DEFAULT_VFS_ROOT_PATH;
use crate::commands::delete_node_with_folder_index;
use crate::skill_kb;

pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

pub const READ_ONLY_TOOL_NAMES: [&str; 12] = [
    "read",
    "read_context",
    "ls",
    "search",
    "search_paths",
    "skill_find",
    "skill_inspect",
    "skill_read",
    "graph_neighborhood",
    "graph_links",
    "incoming_links",
    "outgoing_links",
];

pub fn create_openai_tools() -> Vec<Value> {
    create_openai_tools_for_names(tool_names_slice())
}
pub fn create_anthropic_tools() -> Vec<Value> {
    create_anthropic_tools_for_names(tool_names_slice())
}
pub fn create_openai_read_only_tools() -> Vec<Value> {
    create_openai_responses_tools_for_names(&READ_ONLY_TOOL_NAMES)
}

pub fn create_openai_tools_for_names(names: &[&str]) -> Vec<Value> {
    tool_specs().into_iter().filter(|spec| names.contains(&spec.name)).map(|spec| json!({"type":"function","function":{"name":spec.name,"description":spec.description,"parameters":spec.parameters}})).collect()
}

pub fn create_anthropic_tools_for_names(names: &[&str]) -> Vec<Value> {
    tool_specs().into_iter().filter(|spec| names.contains(&spec.name)).map(|spec| json!({"name":spec.name,"description":spec.description,"input_schema":spec.parameters})).collect()
}

pub fn create_openai_responses_tools_for_names(names: &[&str]) -> Vec<Value> {
    tool_specs().into_iter().filter(|spec| names.contains(&spec.name)).map(|spec| json!({"type":"function","name":spec.name,"description":spec.description,"parameters":spec.parameters,"strict":false})).collect()
}

pub async fn handle_openai_tool_call(
    client: &impl VfsApi,
    name: &str,
    arguments_json: &str,
) -> Result<ToolResult> {
    let input = match serde_json::from_str(arguments_json) {
        Ok(value) => value,
        Err(error) => return Ok(tool_error(format!("invalid tool args: {error}"))),
    };
    dispatch_tool_call(client, name, input).await
}

pub async fn handle_openai_read_only_tool_call(
    client: &impl VfsApi,
    name: &str,
    arguments_json: &str,
) -> Result<ToolResult> {
    if !READ_ONLY_TOOL_NAMES.contains(&name) {
        return Ok(tool_error(format!("read-only tool set rejects: {name}")));
    }
    handle_openai_tool_call(client, name, arguments_json).await
}

pub async fn handle_anthropic_tool_call(
    client: &impl VfsApi,
    name: &str,
    input: Value,
) -> Result<ToolResult> {
    dispatch_tool_call(client, name, input).await
}

pub async fn handle_anthropic_read_only_tool_call(
    client: &impl VfsApi,
    name: &str,
    input: Value,
) -> Result<ToolResult> {
    if !READ_ONLY_TOOL_NAMES.contains(&name) {
        return Ok(tool_error(format!("read-only tool set rejects: {name}")));
    }
    handle_anthropic_tool_call(client, name, input).await
}

async fn dispatch_tool_call(client: &impl VfsApi, name: &str, input: Value) -> Result<ToolResult> {
    match dispatch_tool_call_impl(client, name, input).await {
        Ok(result) => Ok(result),
        Err(error) => Ok(tool_error(error.to_string())),
    }
}

async fn dispatch_tool_call_impl(
    client: &impl VfsApi,
    name: &str,
    input: Value,
) -> Result<ToolResult> {
    let result = match name {
        "read" => {
            let args: ReadArgs = serde_json::from_value(input)?;
            let database_id = database_id(args.database_id)?;
            tool_ok(json!({ "node": client.read_node(&database_id, &args.path).await? }))
        }
        "read_context" => {
            let args: ReadContextArgs = serde_json::from_value(input)?;
            tool_ok(
                json!({ "context": client.read_node_context(NodeContextRequest { database_id: database_id(args.database_id)?, path: args.path, link_limit: args.link_limit.unwrap_or(20) }).await? }),
            )
        }
        "write" => {
            let args: WriteArgs = serde_json::from_value(input)?;
            tool_ok(json!(
                client
                    .write_node(WriteNodeRequest {
                        database_id: database_id(args.database_id)?,
                        path: args.path,
                        kind: args.kind.unwrap_or(NodeKind::File),
                        content: args.content,
                        metadata_json: args.metadata_json.unwrap_or_else(|| "{}".to_string()),
                        expected_etag: args.expected_etag
                    })
                    .await?
            ))
        }
        "append" => {
            let args: AppendArgs = serde_json::from_value(input)?;
            tool_ok(json!(
                client
                    .append_node(AppendNodeRequest {
                        database_id: database_id(args.database_id)?,
                        path: args.path,
                        content: args.content,
                        expected_etag: args.expected_etag,
                        separator: args.separator,
                        metadata_json: args.metadata_json,
                        kind: args.kind
                    })
                    .await?
            ))
        }
        "edit" => {
            let args: EditArgs = serde_json::from_value(input)?;
            tool_ok(json!(
                client
                    .edit_node(EditNodeRequest {
                        database_id: database_id(args.database_id)?,
                        path: args.path,
                        old_text: args.old_text,
                        new_text: args.new_text,
                        expected_etag: args.expected_etag,
                        replace_all: args.replace_all.unwrap_or(false)
                    })
                    .await?
            ))
        }
        "ls" => {
            let args: ListArgs = serde_json::from_value(input)?;
            tool_ok(
                json!({ "entries": client.list_nodes(ListNodesRequest { database_id: database_id(args.database_id)?, prefix: args.prefix.unwrap_or_else(|| DEFAULT_VFS_ROOT_PATH.to_string()), recursive: args.recursive.unwrap_or(false) }).await? }),
            )
        }
        "mkdir" => {
            let args: MkdirArgs = serde_json::from_value(input)?;
            tool_ok(json!(
                client
                    .mkdir_node(MkdirNodeRequest {
                        database_id: database_id(args.database_id)?,
                        path: args.path
                    })
                    .await?
            ))
        }
        "mv" => {
            let args: MoveArgs = serde_json::from_value(input)?;
            tool_ok(json!(
                client
                    .move_node(MoveNodeRequest {
                        database_id: database_id(args.database_id)?,
                        from_path: args.from_path,
                        to_path: args.to_path,
                        expected_etag: args.expected_etag,
                        overwrite: args.overwrite.unwrap_or(false)
                    })
                    .await?
            ))
        }
        "glob" => {
            let args: GlobArgs = serde_json::from_value(input)?;
            tool_ok(
                json!({ "hits": client.glob_nodes(GlobNodesRequest { database_id: database_id(args.database_id)?, pattern: args.pattern, path: Some(args.path.unwrap_or_else(|| DEFAULT_VFS_ROOT_PATH.to_string())), node_type: args.node_type }).await? }),
            )
        }
        "graph_neighborhood" => {
            let args: GraphNeighborhoodArgs = serde_json::from_value(input)?;
            tool_ok(
                json!({ "links": client.graph_neighborhood(GraphNeighborhoodRequest { database_id: database_id(args.database_id)?, center_path: args.center_path, depth: args.depth.unwrap_or(1), limit: args.limit.unwrap_or(100) }).await? }),
            )
        }
        "graph_links" => {
            let args: GraphLinksArgs = serde_json::from_value(input)?;
            tool_ok(
                json!({ "links": client.graph_links(GraphLinksRequest { database_id: database_id(args.database_id)?, prefix: args.prefix.unwrap_or_else(|| DEFAULT_VFS_ROOT_PATH.to_string()), limit: args.limit.unwrap_or(100) }).await? }),
            )
        }
        "incoming_links" => {
            let args: LinkArgs = serde_json::from_value(input)?;
            tool_ok(
                json!({ "links": client.incoming_links(IncomingLinksRequest { database_id: database_id(args.database_id)?, path: args.path, limit: args.limit.unwrap_or(20) }).await? }),
            )
        }
        "outgoing_links" => {
            let args: LinkArgs = serde_json::from_value(input)?;
            tool_ok(
                json!({ "links": client.outgoing_links(OutgoingLinksRequest { database_id: database_id(args.database_id)?, path: args.path, limit: args.limit.unwrap_or(20) }).await? }),
            )
        }
        "multi_edit" => {
            let args: MultiEditArgs = serde_json::from_value(input)?;
            tool_ok(json!(
                client
                    .multi_edit_node(MultiEditNodeRequest {
                        database_id: database_id(args.database_id)?,
                        path: args.path,
                        edits: args.edits,
                        expected_etag: args.expected_etag
                    })
                    .await?
            ))
        }
        "rm" => {
            let args: DeleteArgs = serde_json::from_value(input)?;
            let database_id = database_id(args.database_id)?;
            tool_ok(json!(
                delete_node_with_folder_index(
                    client,
                    database_id.as_ref(),
                    args.path,
                    args.expected_etag,
                    args.expected_folder_index_etag,
                    None
                )
                .await?
            ))
        }
        "search" => {
            let args: SearchArgs = serde_json::from_value(input)?;
            let rank_sources_last = args.prefix.is_none();
            let hits = client
                .search_nodes(SearchNodesRequest {
                    database_id: database_id(args.database_id)?,
                    query_text: args.query_text,
                    prefix: Some(
                        args.prefix
                            .unwrap_or_else(|| DEFAULT_VFS_ROOT_PATH.to_string()),
                    ),
                    top_k: args.top_k.unwrap_or(10),
                    preview_mode: args.preview_mode,
                })
                .await?;
            tool_ok(json!({ "hits": rank_search_hits_for_agent(hits, rank_sources_last) }))
        }
        "search_paths" => {
            let args: SearchArgs = serde_json::from_value(input)?;
            let rank_sources_last = args.prefix.is_none();
            let hits = client
                .search_node_paths(SearchNodePathsRequest {
                    database_id: database_id(args.database_id)?,
                    query_text: args.query_text,
                    prefix: Some(
                        args.prefix
                            .unwrap_or_else(|| DEFAULT_VFS_ROOT_PATH.to_string()),
                    ),
                    top_k: args.top_k.unwrap_or(10),
                    preview_mode: args.preview_mode,
                })
                .await?;
            tool_ok(json!({ "hits": rank_search_hits_for_agent(hits, rank_sources_last) }))
        }
        "skill_find" => {
            let args: SkillFindArgs = serde_json::from_value(input)?;
            tool_ok(
                skill_kb::find_skills(
                    client,
                    &database_id(args.database_id)?,
                    &args.query_text,
                    args.include_deprecated.unwrap_or(false),
                    args.top_k.unwrap_or(5),
                )
                .await?,
            )
        }
        "skill_inspect" => {
            let args: SkillInspectArgs = serde_json::from_value(input)?;
            tool_ok(
                skill_kb::inspect_skill(client, &database_id(args.database_id)?, &args.id).await?,
            )
        }
        "skill_read" => {
            let args: SkillReadArgs = serde_json::from_value(input)?;
            tool_ok(
                skill_kb::read_skill_file(
                    client,
                    &database_id(args.database_id)?,
                    &args.id,
                    &args.file,
                )
                .await?,
            )
        }
        "skill_record_run" => {
            let args: SkillRecordRunArgs = serde_json::from_value(input)?;
            let database_id = database_id(args.database_id)?;
            tool_ok(
                skill_kb::record_skill_run(
                    client,
                    skill_kb::SkillRunRecord {
                        database_id: &database_id,
                        id: &args.id,
                        task: &args.task,
                        outcome: skill_run_outcome(&args.outcome)?,
                        notes: &args.notes,
                        agent: &args.agent,
                    },
                )
                .await?,
            )
        }
        other => return Ok(tool_error(format!("unknown tool: {other}"))),
    };
    Ok(result)
}

fn tool_names_slice() -> &'static [&'static str] {
    &[
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
    ]
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

fn rank_search_hits_for_agent(
    hits: Vec<vfs_types::SearchNodeHit>,
    rank_sources_last: bool,
) -> Vec<vfs_types::SearchNodeHit> {
    if !rank_sources_last {
        return hits;
    }
    let mut primary = Vec::new();
    let mut sources = Vec::new();
    for hit in hits {
        if is_raw_source_path(&hit.path) {
            sources.push(hit);
        } else {
            primary.push(hit);
        }
    }
    primary.extend(sources);
    primary
}

fn is_raw_source_path(path: &str) -> bool {
    path == "/Sources" || path.starts_with("/Sources/")
}

fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec::new("read", "Read a node by path.", read_schema()),
        ToolSpec::new(
            "read_context",
            "Read a node with incoming and outgoing links.",
            read_context_schema(),
        ),
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
        ToolSpec::new(
            "graph_neighborhood",
            "Read local link graph edges around a center path.",
            graph_neighborhood_schema(),
        ),
        ToolSpec::new(
            "graph_links",
            "Read link graph edges under a prefix.",
            graph_links_schema(),
        ),
        ToolSpec::new(
            "incoming_links",
            "Read links pointing to a node path.",
            link_schema(),
        ),
        ToolSpec::new(
            "outgoing_links",
            "Read links from a node path.",
            link_schema(),
        ),
        ToolSpec::new(
            "multi_edit",
            "Apply multiple atomic plain-text replacements to a node.",
            multi_edit_schema(),
        ),
        ToolSpec::new("rm", "Delete a node by path.", delete_schema()),
        ToolSpec::new(
            "search",
            "Search database node contents with FTS recall. Prefix omitted searches the database and ranks /Sources last. Unspecified preview mode defaults to light.",
            search_schema(),
        ),
        ToolSpec::new(
            "search_paths",
            "Search node paths and basenames by case-insensitive substring recall. Prefix omitted searches the database and ranks /Sources last.",
            search_schema(),
        ),
        ToolSpec::new(
            "skill_find",
            "Find Skill KB packages for a task query. Deprecated skills are hidden unless requested.",
            skill_find_schema(),
        ),
        ToolSpec::new(
            "skill_inspect",
            "Inspect one Skill KB package manifest, files, and recent run evidence.",
            skill_id_schema(),
        ),
        ToolSpec::new(
            "skill_read",
            "Read a package-local file from a Skill KB package.",
            skill_read_schema(),
        ),
        ToolSpec::new(
            "skill_record_run",
            "Record Skill KB run evidence after an agent uses a skill.",
            skill_record_run_schema(),
        ),
    ]
}

fn read_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"path":{"type":"string"}},"required":["database_id","path"],"additionalProperties":false})
}
fn read_context_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"path":{"type":"string"},"link_limit":{"type":"integer","minimum":1,"maximum":100}},"required":["database_id","path"],"additionalProperties":false})
}
fn write_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"path":{"type":"string"},"content":{"type":"string"},"kind":{"type":"string","enum":["file","source"]},"metadata_json":{"type":"string"},"expected_etag":{"type":"string"}},"required":["database_id","path","content"],"additionalProperties":false})
}
fn append_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"path":{"type":"string"},"content":{"type":"string"},"expected_etag":{"type":"string"},"separator":{"type":"string"},"metadata_json":{"type":"string"},"kind":{"type":"string","enum":["file","source"]}},"required":["database_id","path","content"],"additionalProperties":false})
}
fn edit_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"path":{"type":"string"},"old_text":{"type":"string"},"new_text":{"type":"string"},"expected_etag":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["database_id","path","old_text","new_text"],"additionalProperties":false})
}
fn list_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"prefix":{"type":"string"},"recursive":{"type":"boolean"}},"required":["database_id"],"additionalProperties":false})
}
fn mkdir_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"path":{"type":"string"}},"required":["database_id","path"],"additionalProperties":false})
}
fn move_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"from_path":{"type":"string"},"to_path":{"type":"string"},"expected_etag":{"type":"string"},"overwrite":{"type":"boolean"}},"required":["database_id","from_path","to_path"],"additionalProperties":false})
}
fn glob_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"pattern":{"type":"string"},"path":{"type":"string"},"node_type":{"type":"string","enum":["file","directory","any"]}},"required":["database_id","pattern"],"additionalProperties":false})
}
fn graph_neighborhood_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"center_path":{"type":"string"},"depth":{"type":"integer","minimum":1,"maximum":2},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["database_id","center_path"],"additionalProperties":false})
}
fn graph_links_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"prefix":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["database_id"],"additionalProperties":false})
}
fn link_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"path":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["database_id","path"],"additionalProperties":false})
}
fn multi_edit_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"path":{"type":"string"},"expected_etag":{"type":"string"},"edits":{"type":"array","items":{"type":"object","properties":{"old_text":{"type":"string"},"new_text":{"type":"string"}},"required":["old_text","new_text"],"additionalProperties":false}}},"required":["database_id","path","edits"],"additionalProperties":false})
}
fn delete_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"path":{"type":"string"},"expected_etag":{"type":"string"},"expected_folder_index_etag":{"type":"string"}},"required":["database_id","path"],"additionalProperties":false})
}
fn search_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"query_text":{"type":"string"},"prefix":{"type":"string"},"top_k":{"type":"integer","minimum":1,"maximum":100},"preview_mode":{"type":"string","enum":["none","light","content_start"]}},"required":["database_id","query_text"],"additionalProperties":false})
}
fn skill_find_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"query_text":{"type":"string"},"top_k":{"type":"integer","minimum":1,"maximum":20},"include_deprecated":{"type":"boolean"}},"required":["database_id","query_text"],"additionalProperties":false})
}
fn skill_id_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"id":{"type":"string"}},"required":["database_id","id"],"additionalProperties":false})
}
fn skill_read_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"id":{"type":"string"},"file":{"type":"string"}},"required":["database_id","id","file"],"additionalProperties":false})
}
fn skill_record_run_schema() -> Value {
    json!({"type":"object","properties":{"database_id":{"type":"string"},"id":{"type":"string"},"task":{"type":"string"},"outcome":{"type":"string","enum":["success","partial","fail"]},"notes":{"type":"string"},"agent":{"type":"string"}},"required":["database_id","id","task","outcome","notes","agent"],"additionalProperties":false})
}

fn database_id(value: Option<String>) -> Result<String> {
    value
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("database_id is required"))
}

#[derive(Deserialize)]
struct ReadArgs {
    database_id: Option<String>,
    path: String,
}
#[derive(Deserialize)]
struct ReadContextArgs {
    database_id: Option<String>,
    path: String,
    link_limit: Option<u32>,
}
#[derive(Deserialize)]
struct WriteArgs {
    database_id: Option<String>,
    path: String,
    content: String,
    expected_etag: Option<String>,
    metadata_json: Option<String>,
    kind: Option<NodeKind>,
}
#[derive(Deserialize)]
struct AppendArgs {
    database_id: Option<String>,
    path: String,
    content: String,
    expected_etag: Option<String>,
    separator: Option<String>,
    metadata_json: Option<String>,
    kind: Option<NodeKind>,
}
#[derive(Deserialize)]
struct EditArgs {
    database_id: Option<String>,
    path: String,
    old_text: String,
    new_text: String,
    expected_etag: Option<String>,
    replace_all: Option<bool>,
}
#[derive(Deserialize)]
struct ListArgs {
    database_id: Option<String>,
    prefix: Option<String>,
    recursive: Option<bool>,
}
#[derive(Deserialize)]
struct MkdirArgs {
    database_id: Option<String>,
    path: String,
}
#[derive(Deserialize)]
struct MoveArgs {
    database_id: Option<String>,
    from_path: String,
    to_path: String,
    expected_etag: Option<String>,
    overwrite: Option<bool>,
}
#[derive(Deserialize)]
struct GlobArgs {
    database_id: Option<String>,
    pattern: String,
    path: Option<String>,
    node_type: Option<GlobNodeType>,
}
#[derive(Deserialize)]
struct GraphNeighborhoodArgs {
    database_id: Option<String>,
    center_path: String,
    depth: Option<u32>,
    limit: Option<u32>,
}
#[derive(Deserialize)]
struct GraphLinksArgs {
    database_id: Option<String>,
    prefix: Option<String>,
    limit: Option<u32>,
}
#[derive(Deserialize)]
struct LinkArgs {
    database_id: Option<String>,
    path: String,
    limit: Option<u32>,
}
#[derive(Deserialize)]
struct MultiEditArgs {
    database_id: Option<String>,
    path: String,
    edits: Vec<MultiEdit>,
    expected_etag: Option<String>,
}
#[derive(Deserialize)]
struct DeleteArgs {
    database_id: Option<String>,
    path: String,
    expected_etag: Option<String>,
    expected_folder_index_etag: Option<String>,
}
#[derive(Deserialize)]
struct SearchArgs {
    database_id: Option<String>,
    query_text: String,
    prefix: Option<String>,
    top_k: Option<u32>,
    preview_mode: Option<SearchPreviewMode>,
}
#[derive(Deserialize)]
struct SkillFindArgs {
    database_id: Option<String>,
    query_text: String,
    top_k: Option<u32>,
    include_deprecated: Option<bool>,
}
#[derive(Deserialize)]
struct SkillInspectArgs {
    database_id: Option<String>,
    id: String,
}
#[derive(Deserialize)]
struct SkillReadArgs {
    database_id: Option<String>,
    id: String,
    file: String,
}
#[derive(Deserialize)]
struct SkillRecordRunArgs {
    database_id: Option<String>,
    id: String,
    task: String,
    outcome: String,
    notes: String,
    agent: String,
}

fn skill_run_outcome(value: &str) -> Result<skill_kb::SkillRunOutcome> {
    match value {
        "success" => Ok(skill_kb::SkillRunOutcome::Success),
        "partial" => Ok(skill_kb::SkillRunOutcome::Partial),
        "fail" => Ok(skill_kb::SkillRunOutcome::Fail),
        _ => anyhow::bail!("invalid skill run outcome: {value}"),
    }
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

#[cfg(test)]
mod tests {
    use super::{READ_ONLY_TOOL_NAMES, create_openai_read_only_tools};

    #[test]
    fn read_only_tools_keep_expected_names() {
        assert_eq!(
            create_openai_read_only_tools().len(),
            READ_ONLY_TOOL_NAMES.len()
        );
    }
}

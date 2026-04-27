// Where: crates/vfs_cli_app/src/agent_tools.rs
// What: Wiki-facing agent tool adapter over generic VFS tool plumbing.
// Why: Shared VFS tools stay domain-neutral while Kinic wiki agents keep `/Wiki` defaults.
pub use vfs_cli::agent_tools::{
    READ_ONLY_TOOL_NAMES, ToolResult, create_anthropic_tools, create_anthropic_tools_for_names,
    create_openai_read_only_tools, create_openai_responses_tools_for_names, create_openai_tools,
    create_openai_tools_for_names,
};

use anyhow::Result;
use serde_json::Value;
use vfs_cli::agent_tools::{
    AgentToolConfig, handle_anthropic_tool_call_with_config, handle_openai_tool_call_with_config,
};
use vfs_client::VfsApi;
use wiki_domain::WIKI_ROOT_PATH;

const WIKI_AGENT_TOOL_CONFIG: AgentToolConfig = AgentToolConfig {
    default_prefix: WIKI_ROOT_PATH,
};

pub async fn handle_openai_tool_call(
    client: &impl VfsApi,
    name: &str,
    arguments_json: &str,
) -> Result<ToolResult> {
    handle_openai_tool_call_with_config(client, name, arguments_json, WIKI_AGENT_TOOL_CONFIG).await
}

pub async fn handle_anthropic_tool_call(
    client: &impl VfsApi,
    name: &str,
    input: Value,
) -> Result<ToolResult> {
    handle_anthropic_tool_call_with_config(client, name, input, WIKI_AGENT_TOOL_CONFIG).await
}

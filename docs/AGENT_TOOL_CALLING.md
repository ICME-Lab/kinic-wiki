# Agent Tool Calling

Use the shared Rust library when embedding Kinic Wiki VFS tool calling into an OpenAI-compatible client.
This is not shelling out to `kinic-vfs-cli`; it uses the same canister-backed VFS through the shared client and tool dispatcher.
For direct read-only canister queries without tool schemas, use the Agent Memory API described in [`AGENT_MEMORY_API.md`](AGENT_MEMORY_API.md).

## Library Tool Calling

```rust
use anyhow::Result;
use vfs_cli::agent_tools::{create_openai_tools, handle_openai_tool_call};
use vfs_client::CanisterVfsClient;

async fn run() -> Result<()> {
    let client = CanisterVfsClient::new(
        "http://127.0.0.1:8000",
        "aaaaa-aa",
    )
    .await?;

    let tools = create_openai_tools();

    // Pass `tools` into your OpenAI-compatible SDK request.
    // When the model returns a tool call:
    let result = handle_openai_tool_call(
        &client,
        "append",
        r#"{"database_id":"<database-id>","path":"/Wiki/memory.md","content":"remember this"}"#,
    )
    .await?;

    println!("{}", result.text);
    Ok(())
}
```

The dispatcher also exposes Anthropic-format schemas through `create_anthropic_tools` and `handle_anthropic_tool_call`.
Use `create_openai_read_only_tools` when an agent should only inspect wiki and skill content.

## Tool Names

Current tool names:

- `read`
- `read_context`
- `write`
- `append`
- `edit`
- `ls`
- `mkdir`
- `mv`
- `glob`
- `recent`
- `graph_neighborhood`
- `graph_links`
- `incoming_links`
- `outgoing_links`
- `multi_edit`
- `rm`
- `search`
- `search_paths`
- `skill_find`
- `skill_inspect`
- `skill_read`
- `skill_record_run`

Read-only tools are:

- `read`
- `read_context`
- `ls`
- `search`
- `search_paths`
- `skill_find`
- `skill_inspect`
- `skill_read`
- `recent`
- `graph_neighborhood`
- `graph_links`
- `incoming_links`
- `outgoing_links`

Skill discovery and read tools are read-only runtime helpers.
Agents should call `skill_find` at task start, inspect promising candidates, read `SKILL.md` and package-local helper files with `skill_read`, then apply those instructions to the current task.
`skill_record_run` is a write tool for agent-side evidence capture and is excluded from read-only tool sets.

Use the CLI for operational writes such as `skill upsert`, `database link`, imports, and improvement proposal approval.

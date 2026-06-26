// Where: crates/vfs_cli_app/src/commands.rs
// What: Command handlers for FS-first remote reads and writes.
// Why: The CLI should keep canister operations explicit and path-oriented.
use crate::claude::run_claude_command;
use crate::cli::{Cli, Command, ContextPackCommand, IdentityCommand};
use crate::codex::run_codex_command;
use crate::context_pack::{
    ContextPackExportOptions, ContextPackInspectOptions, ContextPackVerifyOptions,
    run_context_pack_export, run_context_pack_inspect, run_context_pack_verify,
};
use crate::conversation_wiki::generate_conversation_wiki;
use crate::github_ingest::run_github_command;
use crate::hermes::run_hermes_command;
use crate::maintenance::{rebuild_index, rebuild_scope_index};
use crate::purge_url_ingest::purge_url_ingest;
use crate::skill_registry::run_skill_command;
use anyhow::{Result, anyhow};
use vfs_cli::commands::{database_id_or_env, run_vfs_command};
use vfs_cli::connection::ResolvedConnection;
use vfs_client::VfsApi;

pub async fn run_command(
    client: &impl VfsApi,
    cli: Cli,
    connection: &ResolvedConnection,
) -> Result<()> {
    let Cli {
        command,
        connection: _,
    } = cli;
    let database_id = connection.database_id.as_deref();
    if let Some(vfs_command) = command.as_vfs_command() {
        return run_vfs_command(client, connection, vfs_command).await;
    }
    match command {
        Command::Identity { command } => match command {
            IdentityCommand::Show { json } => {
                let principal = client
                    .caller_principal()
                    .ok_or_else(|| anyhow!("current identity principal is not available"))?;
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "principal": principal
                        }))?
                    );
                } else {
                    println!("{principal}");
                }
            }
        },
        Command::Skill { command } => {
            run_skill_command(client, require_database_id(database_id)?, command).await?;
        }
        Command::Github { command } => {
            run_github_command(client, require_database_id(database_id)?, command).await?;
        }
        Command::ContextPack { command } => match command {
            ContextPackCommand::Export(args) => {
                run_context_pack_export(
                    client,
                    require_database_id(database_id)?,
                    ContextPackExportOptions {
                        root: args.root,
                        out: args.out,
                        expires_at: args.expires_at,
                        trust_level: args.trust_level,
                        approved_by: args.approved_by,
                        overwrite: args.overwrite,
                        json: args.json,
                    },
                )
                .await?;
            }
            ContextPackCommand::Verify(args) => {
                run_context_pack_verify(ContextPackVerifyOptions {
                    path: args.path,
                    json: args.json,
                })?;
            }
            ContextPackCommand::Inspect(args) => {
                run_context_pack_inspect(ContextPackInspectOptions {
                    path: args.path,
                    json: args.json,
                })?;
            }
        },
        Command::Hermes { command } => {
            run_hermes_command(client, database_id, command).await?;
        }
        Command::Codex { command } => {
            run_codex_command(command)?;
        }
        Command::Claude { command } => {
            run_claude_command(command)?;
        }
        Command::RebuildIndex => {
            rebuild_index(client, database_id_or_env(database_id)?.as_ref()).await?;
            println!("index rebuilt");
        }
        Command::RebuildScopeIndex { scope } => {
            rebuild_scope_index(client, database_id_or_env(database_id)?.as_ref(), &scope).await?;
            println!("scope index rebuilt: {scope}");
        }
        Command::GenerateConversationWiki { source_path, json } => {
            let result =
                generate_conversation_wiki(client, require_database_id(database_id)?, &source_path)
                    .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!(
                    "conversation wiki generated: {} ({} pages)",
                    result.base_path,
                    result.written_paths.len()
                );
            }
        }
        Command::PurgeUrlIngest {
            url,
            source_path,
            yes,
            force_target_prefix,
            json,
        } => {
            purge_url_ingest(
                client,
                require_database_id(database_id)?,
                url.as_deref(),
                source_path.as_deref(),
                yes,
                force_target_prefix.as_deref(),
                json,
            )
            .await?;
        }
        Command::Status { json } => {
            let database_id = database_id_or_env(database_id)?;
            let remote = client.status(database_id.as_ref()).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&remote)?);
            } else {
                println!(
                    "remote: files={} sources={}",
                    remote.file_count, remote.source_count
                );
            }
        }
        _ => unreachable!("vfs commands should be delegated before wiki workflow dispatch"),
    }
    Ok(())
}

fn require_database_id(database_id: Option<&str>) -> Result<&str> {
    database_id
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("database id is required; set --database-id, VFS_DATABASE_ID, or run database link <database-id>"))
}

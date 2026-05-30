// Where: crates/vfs_cli_app/src/commands.rs
// What: Command handlers for FS-first remote reads and writes.
// Why: The CLI should keep canister operations explicit and path-oriented.
use crate::claude::run_claude_command;
use crate::cli::{Cli, Command, DocsCommand, IdentityCommand};
use crate::codex::run_codex_command;
use crate::conversation_wiki::generate_conversation_wiki;
use crate::docs_context::{run_docs_cite, run_docs_command};
use crate::github_ingest::run_github_command;
use crate::hermes::run_hermes_command;
use crate::maintenance::{rebuild_index, rebuild_scope_index};
use crate::purge_url_ingest::purge_url_ingest;
use crate::skill_registry::run_skill_command;
use anyhow::{Result, anyhow};
use vfs_cli::commands::{database_id_or_env, run_vfs_command};
use vfs_cli::connection::ResolvedConnection;
use vfs_client::VfsApi;

pub fn run_local_docs_command(command: &Command) -> Result<bool> {
    let Command::Docs { command } = command else {
        return Ok(false);
    };
    match command {
        DocsCommand::Cite { input, json } => {
            run_docs_cite(input, *json)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

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
        Command::Docs { command } => match command {
            DocsCommand::Cite { input, json } => run_docs_cite(&input, json)?,
            command => run_docs_command(client, require_database_id(database_id)?, command).await?,
        },
        Command::Github { command } => {
            run_github_command(client, require_database_id(database_id)?, command).await?;
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands_fs_tests::MockClient;
    use clap::Parser;
    use std::fs;
    use vfs_cli::connection::ResolvedConnection;

    #[test]
    fn local_docs_cite_runs_without_remote_database() {
        let temp_dir = tempfile::tempdir().expect("tempdir should create");
        let input = temp_dir.path().join("pack.json");
        fs::write(
            &input,
            r#"{"query":"q","max_tokens":1000,"estimated_tokens":1,"sources":[],"evidence":[{"path":"/Wiki/sources/vercel__next_js/16/a.md","score":1.0,"snippet":"s","content":"c","source_id":"/vercel/next.js","title":"Next.js","citation":"https://nextjs.org/docs","version":"16","chunk_id":"a","trust":"official"}],"citations":[],"truncated":false}"#,
        )
        .expect("pack should write");
        let command = Command::Docs {
            command: crate::cli::DocsCommand::Cite { input, json: true },
        };

        assert!(run_local_docs_command(&command).expect("local docs command should run"));
    }

    #[test]
    fn local_docs_command_ignores_remote_docs_commands() {
        let command = Command::Docs {
            command: crate::cli::DocsCommand::Source {
                command: crate::cli::DocsSourceCommand::List { json: true },
            },
        };

        assert!(!run_local_docs_command(&command).expect("remote docs command should not run"));
    }

    #[tokio::test]
    async fn run_command_docs_cite_skips_database_id() {
        let temp_dir = tempfile::tempdir().expect("tempdir should create");
        let input = temp_dir.path().join("pack.json");
        fs::write(
            &input,
            r#"{"query":"q","max_tokens":1000,"estimated_tokens":1,"sources":[],"evidence":[{"path":"/Wiki/sources/vercel__next_js/16/a.md","score":1.0,"snippet":"s","content":"c","source_id":"/vercel/next.js","title":"Next.js","citation":"https://nextjs.org/docs","version":"16","chunk_id":"a","trust":"official"}],"citations":[],"truncated":false}"#,
        )
        .expect("pack should write");
        let input_arg = input.to_string_lossy().into_owned();
        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "docs",
            "cite",
            "--input",
            &input_arg,
            "--json",
        ]);
        let connection = ResolvedConnection {
            replica_host: "http://127.0.0.1:8000".to_string(),
            canister_id: "aaaaa-aa".to_string(),
            database_id: None,
            replica_host_source: "test".to_string(),
            canister_id_source: "test".to_string(),
            database_id_source: None,
        };

        run_command(&MockClient::default(), cli, &connection)
            .await
            .expect("docs cite should not require database id");
    }
}

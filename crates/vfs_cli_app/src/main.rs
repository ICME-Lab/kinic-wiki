// Where: crates/vfs_cli_app/src/main.rs
// What: Binary entrypoint for the single published kinic-vfs-cli executable.
// Why: Wiki operations and Skill Registry operations share connection, identity, and DB selection.
use anyhow::Result;
use clap::Parser;
use vfs_cli::commands::{open_database_cycles_page, print_database_current, run_database_unlink};
use vfs_cli::connection::{
    ResolvedConnection, resolve_connection, resolve_connection_optional_canister,
};
use vfs_cli_app::claude::run_claude_command;
use vfs_cli_app::cli::{Cli, Command, ContextPackCommand, DatabaseCommand, IdentityModeArg};
use vfs_cli_app::codex::run_codex_command;
use vfs_cli_app::commands::run_command;
use vfs_cli_app::context_pack::{
    ContextPackInspectOptions, ContextPackVerifyOptions, run_context_pack_inspect,
    run_context_pack_verify,
};
use vfs_cli_app::identity::load_default_identity;
use vfs_cli_app::identity_mode::{
    ClientIdentityMode, anonymous_can_read_database, identity_is_database_member,
    resolve_client_identity_mode,
};
use vfs_client::{CanisterVfsClient, VfsApi};

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let doctor_json = match &cli.command {
        Command::Agent {
            command: vfs_cli_app::learning::cli::AgentCommand::Doctor(args),
        } => Some(args.json),
        _ => None,
    };
    match execute_cli(cli).await {
        Err(_) if doctor_json.is_some() => {
            if doctor_json == Some(true) {
                println!(
                    "{}",
                    serde_json::json!({"schema_version":1,"checked_at":chrono::Utc::now().to_rfc3339(),"checks":[{"id":"diagnostic","status":"error","code":"diagnostic_failed","evidence":"Doctor could not start or produce its report.","remedy":"Check cwd and local environment, then retry."}]})
                );
            } else {
                eprintln!("Doctor could not start; check cwd and local environment.");
            }
            std::process::exit(2);
        }
        result => result,
    }
}

async fn execute_cli(mut cli: Cli) -> Result<()> {
    if let Command::Agent { command } = &mut cli.command {
        command.anchor_paths(&std::env::current_dir()?);
    }
    // Hook input must select the project before connection/identity resolution.
    if let Command::Agent {
        command: vfs_cli_app::learning::cli::AgentCommand::Hook { cwd, request, .. },
    } = &mut cli.command
    {
        let mut input: serde_json::Value =
            vfs_cli_app::learning::workflow::read_json(std::path::Path::new("-"))?;
        if let Some(event_cwd) = input.get("cwd").and_then(serde_json::Value::as_str) {
            let event_cwd = std::path::PathBuf::from(event_cwd).canonicalize()?;
            if let Some(explicit) = cwd.as_ref() {
                anyhow::ensure!(
                    explicit.canonicalize()? == event_cwd,
                    "hook cwd conflicts with --cwd"
                );
            }
            *cwd = Some(event_cwd.clone());
            input["cwd"] = serde_json::to_value(event_cwd)?;
        }
        *request = Some(input);
    }
    if let Command::Agent { command } = &mut cli.command {
        if let Some(cwd) = command.resolve_cwd(&std::env::current_dir()?)? {
            std::env::set_current_dir(cwd)?;
        }
    }
    if let Command::Agent { command } = &cli.command {
        match command {
            vfs_cli_app::learning::cli::AgentCommand::Setup(args) => {
                return vfs_cli_app::agent_setup::run(args);
            }
            vfs_cli_app::learning::cli::AgentCommand::Status(args) => {
                return vfs_cli_app::agent_status::run(args, &cli.connection);
            }
            vfs_cli_app::learning::cli::AgentCommand::Doctor(args) => {
                let code = vfs_cli_app::agent_doctor::run(args, &cli.connection).await?;
                std::process::exit(code);
            }
            _ => {}
        }
    }
    if let Command::Agent { command } = &mut cli.command {
        command.capture_recall_stdin()?;
    }
    if let Command::Agent {
        command: vfs_cli_app::learning::cli::AgentCommand::Hook { recall_config, .. },
    } = &cli.command
    {
        if recall_config.is_none()
            && vfs_cli_app::agent_config::AgentConfig::current()?
                .hook_path()?
                .is_none()
        {
            println!(
                "{}",
                serde_json::json!({"skipped":true,"reason":"project learning is not configured","additionalContext":""})
            );
            return Ok(());
        }
    }
    let mut hook_input = if let Command::Agent {
        command: vfs_cli_app::learning::cli::AgentCommand::Hook { request, .. },
    } = &cli.command
    {
        request.clone()
    } else {
        None
    };
    if let Some(path) =
        vfs_cli_app::learning::project::config_for_command(&cli.command, &std::env::current_dir()?)?
    {
        let value: serde_json::Value = vfs_cli_app::learning::workflow::read_json(&path)?;
        if value["version"] == 2 {
            let project = vfs_cli_app::learning::project::load_project(&path)?;
            if !cli.connection.local && cli.connection.replica_host.is_none() {
                cli.connection.replica_host = Some(project.replica_host);
            }
            if cli.connection.canister_id.is_none() && std::env::var_os("VFS_CANISTER_ID").is_none()
            {
                cli.connection.canister_id = Some(project.canister_id);
            }
            if cli.connection.database_id.is_none() && std::env::var_os("VFS_DATABASE_ID").is_none()
            {
                cli.connection.database_id = Some(project.database_id);
            }
        }
    }
    if let Command::Eval { command } = cli.command.clone() {
        return vfs_cli_app::learning::workflow::run_eval(command).await;
    }
    if let Command::Dsh { command } = cli.command.clone() {
        return vfs_cli_app::learning::workflow::run_dsh_setup(command);
    }
    let database_id_arg = cli.connection.database_id.clone();
    if let Command::Database { command } = &cli.command {
        match command {
            DatabaseCommand::Current { json } => {
                let connection = resolve_connection_optional_canister(
                    cli.connection.local,
                    cli.connection.replica_host.clone(),
                    cli.connection.canister_id.clone(),
                    database_id_arg.clone(),
                )?;
                print_database_current(&connection, *json)?;
                return Ok(());
            }
            DatabaseCommand::Unlink => {
                run_database_unlink()?;
                return Ok(());
            }
            DatabaseCommand::Cycles {
                database_id,
                browser_origin,
            } => {
                open_database_cycles_page(browser_origin.as_deref(), database_id)?;
                return Ok(());
            }
            _ => {}
        }
    }
    if let Command::Codex { command } = cli.command.clone() {
        run_codex_command(command)?;
        return Ok(());
    }
    if let Command::Claude { command } = cli.command.clone() {
        run_claude_command(command)?;
        return Ok(());
    }
    if let Command::ContextPack { command } = cli.command.clone() {
        match command {
            ContextPackCommand::Verify(args) => {
                run_context_pack_verify(ContextPackVerifyOptions {
                    path: args.path,
                    fail_on_truncated: args.fail_on_truncated,
                    json: args.json,
                })?;
                return Ok(());
            }
            ContextPackCommand::Inspect(args) => {
                run_context_pack_inspect(ContextPackInspectOptions {
                    path: args.path,
                    json: args.json,
                })?;
                return Ok(());
            }
            ContextPackCommand::Export(_) => {}
        }
    }
    if let Command::Hermes {
        command: vfs_cli_app::cli::HermesCommand::Status { json },
    } = &cli.command
    {
        let preview = resolve_connection_optional_canister(
            cli.connection.local,
            cli.connection.replica_host.clone(),
            cli.connection.canister_id.clone(),
            database_id_arg.clone(),
        )?;
        if preview.database_id.is_none() {
            vfs_cli_app::hermes::run_hermes_local_status(*json)?;
            return Ok(());
        }
    }
    let connection = resolve_connection(
        cli.connection.local,
        cli.connection.replica_host.clone(),
        cli.connection.canister_id.clone(),
        database_id_arg,
    )?;
    let mut hook_spool = if let (
        Some(request),
        Command::Agent {
            command:
                vfs_cli_app::learning::cli::AgentCommand::Hook {
                    state,
                    engine,
                    recall_config,
                    ..
                },
        },
    ) = (&hook_input, &cli.command)
    {
        if request["expected_routing_binding"].as_str().is_some() {
            // Older adapters own their queue; verify their pinned caller before any intake.
            None
        } else {
            Some(vfs_cli_app::learning::workflow::spool_hook(
                &connection,
                state,
                engine,
                recall_config.clone(),
                request,
            )?)
        }
    } else {
        None
    };
    if let Some(path) = &hook_spool {
        hook_input = Some(vfs_cli_app::learning::workflow::read_json(path)?);
    }
    let auto_probes_database = matches!(cli.connection.identity_mode, IdentityModeArg::Auto)
        && cli.command.probes_anonymous_database_read()
        && !cli.command.requires_identity();
    let anonymous_probe = if auto_probes_database {
        let database_id = connection.database_id.as_deref().ok_or_else(|| {
            anyhow::anyhow!(
                "database id is required for anonymous access check; pass --database-id or link a workspace database"
            )
        })?;
        let anonymous =
            CanisterVfsClient::new(&connection.replica_host, &connection.canister_id).await?;
        Some(anonymous_can_read_database(&anonymous, database_id).await?)
    } else {
        None
    };
    let mut identity_client = None;
    let identity_membership = if anonymous_probe == Some(true) {
        let database_id = connection.database_id.as_deref().ok_or_else(|| {
            anyhow::anyhow!(
                "database id is required for identity membership check; pass --database-id or link a workspace database"
            )
        })?;
        match new_identity_client(&connection, cli.connection.allow_non_ii_identity).await {
            Ok(client) => match identity_is_database_member(&client, database_id).await {
                Ok(is_member) => {
                    if is_member {
                        identity_client = Some(client);
                    }
                    Some(is_member)
                }
                Err(error) => {
                    eprintln!(
                        "warning: failed to check selected identity membership for public database; falling back to anonymous read: {error}"
                    );
                    None
                }
            },
            Err(error) => {
                eprintln!(
                    "warning: failed to load selected identity for public database membership check; falling back to anonymous read: {error}"
                );
                None
            }
        }
    } else {
        None
    };
    let client_mode = resolve_client_identity_mode(
        &cli.command,
        cli.connection.identity_mode,
        anonymous_probe,
        identity_membership,
    )?;
    let client = match client_mode {
        ClientIdentityMode::Anonymous => {
            CanisterVfsClient::new(&connection.replica_host, &connection.canister_id).await?
        }
        ClientIdentityMode::Identity => match identity_client {
            Some(client) => client,
            None => new_identity_client(&connection, cli.connection.allow_non_ii_identity).await?,
        },
    };
    if let Some(mut request) = hook_input {
        if let Command::Agent {
            command:
                vfs_cli_app::learning::cli::AgentCommand::Hook {
                    engine,
                    recall_config,
                    state,
                    ..
                },
        } = cli.command
        {
            if let Some(expected) = request["expected_routing_binding"].as_str() {
                let actual = vfs_cli_app::learning::workflow::routing_binding(
                    &connection,
                    &client
                        .caller_principal()
                        .ok_or_else(|| anyhow::anyhow!("authenticated identity required"))?,
                );
                if expected != actual {
                    println!(
                        "{}",
                        serde_json::json!({"routing_binding":actual,"recorded":false,"error_code":"routing_changed"})
                    );
                    return Ok(());
                }
                let path = vfs_cli_app::learning::workflow::spool_hook(
                    &connection,
                    &state,
                    &engine,
                    recall_config.clone(),
                    &request,
                )?;
                request = vfs_cli_app::learning::workflow::read_json(&path)?;
                hook_spool = Some(path);
            }
            if let Some(path) = &hook_spool {
                vfs_cli_app::learning::workflow::replay_hook_inbox(
                    &client,
                    &connection,
                    &engine,
                    recall_config.clone(),
                    &state,
                    path,
                )
                .await?;
            }
            vfs_cli_app::learning::workflow::run_hook_request(
                &client,
                &connection,
                &engine,
                recall_config,
                &state,
                request,
            )
            .await?;
            if let Some(path) = hook_spool {
                std::fs::remove_file(path)?;
            }
            return Ok(());
        }
    }
    run_command(&client, cli, &connection).await
}

async fn new_identity_client(
    connection: &ResolvedConnection,
    allow_non_ii_identity: bool,
) -> Result<CanisterVfsClient> {
    let identity = load_default_identity(&connection.canister_id, allow_non_ii_identity).await?;
    CanisterVfsClient::new_with_boxed_identity(
        &connection.replica_host,
        &connection.canister_id,
        identity,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use vfs_cli::commands::database_cycles_url;

    #[test]
    fn database_cycles_url_resolves_without_connection_or_client() {
        let command = DatabaseCommand::Cycles {
            database_id: "db_alpha".to_string(),
            browser_origin: Some("http://127.0.0.1:3000".to_string()),
        };
        let DatabaseCommand::Cycles {
            database_id,
            browser_origin,
        } = command
        else {
            panic!("expected cycles command");
        };

        let url = database_cycles_url(browser_origin.as_deref(), &database_id)
            .expect("cycles URL should build without canister client");

        assert_eq!(url, "http://127.0.0.1:3000/cycles?database_id=db_alpha");
    }
}

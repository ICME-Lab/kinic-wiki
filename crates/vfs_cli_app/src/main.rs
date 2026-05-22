// Where: crates/vfs_cli_app/src/main.rs
// What: Binary entrypoint for the single published kinic-vfs-cli executable.
// Why: Wiki operations and Skill Registry operations share connection, identity, and DB selection.
use anyhow::Result;
use clap::Parser;
use vfs_cli::commands::{print_database_current, run_database_unlink};
use vfs_cli::connection::{
    ResolvedConnection, resolve_connection, resolve_connection_optional_canister,
};
use vfs_cli_app::claude::run_claude_command;
use vfs_cli_app::cli::{Cli, Command, DatabaseCommand, IdentityModeArg};
use vfs_cli_app::codex::run_codex_command;
use vfs_cli_app::commands::run_command;
use vfs_cli_app::identity::load_default_identity;
use vfs_cli_app::identity_mode::{
    ClientIdentityMode, anonymous_can_read_database, identity_is_database_member,
    resolve_client_identity_mode,
};
use vfs_client::CanisterVfsClient;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Command::Database { command } = &cli.command {
        match command {
            DatabaseCommand::Current { json } => {
                let connection = resolve_connection_optional_canister(
                    cli.connection.local,
                    cli.connection.replica_host.clone(),
                    cli.connection.canister_id.clone(),
                    cli.connection.database_id.clone(),
                )?;
                print_database_current(&connection, *json)?;
                return Ok(());
            }
            DatabaseCommand::Unlink => {
                run_database_unlink()?;
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
    if let Command::Hermes {
        command: vfs_cli_app::cli::HermesCommand::Status { json },
    } = &cli.command
    {
        let preview = resolve_connection_optional_canister(
            cli.connection.local,
            cli.connection.replica_host.clone(),
            cli.connection.canister_id.clone(),
            cli.connection.database_id.clone(),
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
        cli.connection.database_id.clone(),
    )?;
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

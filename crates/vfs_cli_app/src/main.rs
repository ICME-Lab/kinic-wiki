// Where: crates/wiki_cli/src/main.rs
// What: Binary entrypoint for the agent-facing wiki CLI.
// Why: Agents need one executable that can read remote pages and sync the local mirror.
use anyhow::Result;
use clap::Parser;
use vfs_cli::connection::resolve_connection;
use vfs_cli_app::cli::Cli;
use vfs_cli_app::commands::run_command;
use vfs_client::CanisterVfsClient;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let connection = resolve_connection(cli.connection.local, cli.connection.canister_id.clone())?;
    let client = CanisterVfsClient::new(&connection.replica_host, &connection.canister_id).await?;
    run_command(&client, cli).await
}

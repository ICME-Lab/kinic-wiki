// Where: crates/wiki_cli/src/main.rs
// What: Binary entrypoint for the agent-facing wiki CLI.
// Why: Agents need one executable that can read remote pages and sync the local mirror.
use anyhow::Result;
use clap::Parser;
use wiki_cli::cli::Cli;
use wiki_cli::client::CanisterWikiClient;
use wiki_cli::commands::run_command;
use wiki_cli::connection::resolve_connection;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let connection = resolve_connection(cli.connection.local, cli.connection.canister_id.clone())?;
    let client = CanisterWikiClient::new(&connection.replica_host, &connection.canister_id).await?;
    run_command(&client, cli).await
}

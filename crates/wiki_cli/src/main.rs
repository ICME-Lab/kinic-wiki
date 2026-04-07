// Where: crates/wiki_cli/src/main.rs
// What: Binary entrypoint for the agent-facing wiki CLI.
// Why: Agents need one executable that can read remote pages and sync the local mirror.
use anyhow::Result;
use clap::Parser;
use wiki_cli::cli::Cli;
use wiki_cli::client::CanisterWikiClient;
use wiki_cli::commands::run_command;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let client =
        CanisterWikiClient::new(&cli.connection.replica_host, &cli.connection.canister_id).await?;
    run_command(&client, cli).await
}

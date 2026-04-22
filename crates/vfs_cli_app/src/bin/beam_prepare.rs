// Where: crates/wiki_cli/src/bin/beam_prepare.rs
// What: Dedicated BEAM namespace preparation binary that writes notes before eval.
// Why: Eval must stay read-only, so preparation needs its own explicit entrypoint.
use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;
use vfs_cli_app::beam_bench::{BeamPrepareArgs, run_beam_prepare};
use vfs_cli_app::cli::ConnectionArgs;
use vfs_cli_app::connection::resolve_connection;

#[derive(Parser, Debug)]
#[command(name = "beam-prepare")]
#[command(about = "Prepare a BEAM benchmark namespace before read-only eval")]
struct Cli {
    #[command(flatten)]
    connection: ConnectionArgs,

    #[arg(long)]
    dataset_path: PathBuf,
    #[arg(long, default_value = "100K")]
    split: String,
    #[arg(long, default_value_t = 1)]
    limit: usize,
    #[arg(long)]
    namespace: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let connection = resolve_connection(cli.connection.local, cli.connection.canister_id.clone())?;
    let summary = run_beam_prepare(
        connection,
        BeamPrepareArgs {
            dataset_path: cli.dataset_path,
            split: cli.split,
            limit: cli.limit,
            namespace: cli.namespace,
        },
    )
    .await?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Cli;
    use clap::CommandFactory;

    #[test]
    fn dedicated_bin_help_mentions_beam_prepare() {
        let mut command = Cli::command();
        let help = command.render_long_help().to_string();

        assert!(help.contains("beam-prepare"));
        assert!(help.contains("Prepare a BEAM benchmark namespace before read-only eval"));
    }
}

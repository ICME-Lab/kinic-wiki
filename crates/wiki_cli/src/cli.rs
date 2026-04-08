// Where: crates/wiki_cli/src/cli.rs
// What: clap definitions for the FS-first CLI surface.
// Why: Agents need direct node operations and path-based mirror sync commands.
use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;
use wiki_types::NodeKind;

#[derive(Parser, Debug)]
#[command(name = "wiki-cli")]
#[command(about = "Agent-facing CLI for the Kinic FS-first wiki")]
pub struct Cli {
    #[command(flatten)]
    pub connection: ConnectionArgs,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Args, Debug, Clone)]
pub struct ConnectionArgs {
    #[arg(long)]
    pub replica_host: String,

    #[arg(long)]
    pub canister_id: String,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    ReadNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        json: bool,
    },
    ListNodes {
        #[arg(long, default_value = "/Wiki")]
        prefix: String,
        #[arg(long)]
        recursive: bool,
        #[arg(long)]
        include_deleted: bool,
        #[arg(long)]
        json: bool,
    },
    WriteNode {
        #[arg(long)]
        path: String,
        #[arg(long, value_enum, default_value_t = NodeKindArg::File)]
        kind: NodeKindArg,
        #[arg(long)]
        input: PathBuf,
        #[arg(long, default_value = "{}")]
        metadata_json: String,
        #[arg(long)]
        expected_etag: Option<String>,
        #[arg(long)]
        json: bool,
    },
    DeleteNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        expected_etag: Option<String>,
        #[arg(long)]
        json: bool,
    },
    SearchRemote {
        query_text: String,
        #[arg(long, default_value = "/Wiki")]
        prefix: String,
        #[arg(long, default_value_t = 10)]
        top_k: u32,
        #[arg(long)]
        json: bool,
    },
    LintLocal {
        #[arg(long)]
        vault_path: PathBuf,
        #[arg(long, default_value = "Wiki")]
        mirror_root: String,
        #[arg(long)]
        json: bool,
    },
    Status {
        #[arg(long)]
        vault_path: Option<PathBuf>,
        #[arg(long, default_value = "Wiki")]
        mirror_root: String,
        #[arg(long)]
        json: bool,
    },
    Pull {
        #[arg(long)]
        vault_path: PathBuf,
        #[arg(long, default_value = "Wiki")]
        mirror_root: String,
    },
    Push {
        #[arg(long)]
        vault_path: PathBuf,
        #[arg(long, default_value = "Wiki")]
        mirror_root: String,
    },
}

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKindArg {
    File,
    Source,
}

impl NodeKindArg {
    pub fn to_node_kind(self) -> NodeKind {
        match self {
            Self::File => NodeKind::File,
            Self::Source => NodeKind::Source,
        }
    }
}

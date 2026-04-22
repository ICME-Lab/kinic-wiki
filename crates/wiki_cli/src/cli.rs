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
    #[arg(long, help = "Use the local replica host http://127.0.0.1:8000")]
    pub local: bool,

    #[arg(long, help = "Override WIKI_CANISTER_ID or user config")]
    pub canister_id: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    RebuildIndex,
    RebuildScopeIndex {
        #[arg(long)]
        scope: String,
    },
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
    AppendNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        input: PathBuf,
        #[arg(long, value_enum)]
        kind: Option<NodeKindArg>,
        #[arg(long)]
        metadata_json: Option<String>,
        #[arg(long)]
        expected_etag: Option<String>,
        #[arg(long)]
        separator: Option<String>,
        #[arg(long)]
        json: bool,
    },
    EditNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        old_text: String,
        #[arg(long)]
        new_text: String,
        #[arg(long)]
        expected_etag: Option<String>,
        #[arg(long)]
        replace_all: bool,
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
    DeleteTree {
        #[arg(long)]
        path: String,
        #[arg(long)]
        json: bool,
    },
    MkdirNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        json: bool,
    },
    MoveNode {
        #[arg(long)]
        from_path: String,
        #[arg(long)]
        to_path: String,
        #[arg(long)]
        expected_etag: Option<String>,
        #[arg(long)]
        overwrite: bool,
        #[arg(long)]
        json: bool,
    },
    GlobNodes {
        pattern: String,
        #[arg(long, default_value = "/Wiki")]
        path: String,
        #[arg(long, value_enum)]
        node_type: Option<GlobNodeTypeArg>,
        #[arg(long)]
        json: bool,
    },
    RecentNodes {
        #[arg(long, help = "Maximum 100; 0 is treated as 1 by the canister")]
        limit: u32,
        #[arg(long, default_value = "/Wiki")]
        path: String,
        #[arg(long)]
        json: bool,
    },
    MultiEditNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        edits_file: PathBuf,
        #[arg(long)]
        expected_etag: Option<String>,
        #[arg(long)]
        json: bool,
    },
    SearchRemote {
        query_text: String,
        #[arg(long, default_value = "/Wiki")]
        prefix: String,
        #[arg(
            long,
            default_value_t = 10,
            help = "Maximum 100; 0 is treated as 1 by the canister. Search preview defaults to light."
        )]
        top_k: u32,
        #[arg(long)]
        json: bool,
    },
    SearchPathRemote {
        query_text: String,
        #[arg(long, default_value = "/Wiki")]
        prefix: String,
        #[arg(
            long,
            default_value_t = 10,
            help = "Maximum 100; 0 is treated as 1 by the canister"
        )]
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
        #[arg(long)]
        resync: bool,
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

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlobNodeTypeArg {
    File,
    Directory,
    Any,
}

impl NodeKindArg {
    pub fn to_node_kind(self) -> NodeKind {
        match self {
            Self::File => NodeKind::File,
            Self::Source => NodeKind::Source,
        }
    }
}

impl GlobNodeTypeArg {
    pub fn to_glob_node_type(self) -> wiki_types::GlobNodeType {
        match self {
            Self::File => wiki_types::GlobNodeType::File,
            Self::Directory => wiki_types::GlobNodeType::Directory,
            Self::Any => wiki_types::GlobNodeType::Any,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Cli;
    use clap::CommandFactory;

    #[test]
    fn main_cli_help_does_not_list_beam_bench() {
        let mut command = Cli::command();
        let help = command.render_long_help().to_string();

        assert!(!help.contains("beam-bench"));
    }
}

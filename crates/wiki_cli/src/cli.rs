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
            help = "Maximum 100; 0 is treated as 1 by the canister"
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
    },
    Push {
        #[arg(long)]
        vault_path: PathBuf,
        #[arg(long, default_value = "Wiki")]
        mirror_root: String,
    },
    BeamBench {
        #[arg(long)]
        dataset_path: PathBuf,
        #[arg(long, default_value = "100K")]
        split: String,
        #[arg(long)]
        model: String,
        #[arg(long)]
        output_dir: PathBuf,
        #[arg(long, value_enum, default_value_t = BeamBenchProviderArg::Codex)]
        provider: BeamBenchProviderArg,
        #[arg(long, default_value_t = 1)]
        limit: usize,
        #[arg(long, default_value_t = 1)]
        parallelism: usize,
        #[arg(long, default_value = "https://api.openai.com/v1")]
        openai_base_url: String,
        #[arg(long, default_value = "OPENAI_API_KEY")]
        openai_api_key_env: String,
        #[arg(long, default_value_t = 8)]
        max_tool_roundtrips: usize,
        #[arg(long)]
        questions_per_conversation: Option<usize>,
        #[arg(long)]
        namespace: Option<String>,
        #[arg(long, default_value = "codex")]
        codex_bin: PathBuf,
        #[arg(long, default_value = "danger-full-access")]
        codex_sandbox: String,
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

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeamBenchProviderArg {
    Codex,
    Openai,
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

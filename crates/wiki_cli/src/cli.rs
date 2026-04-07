// Where: crates/wiki_cli/src/cli.rs
// What: clap definitions for the agent-facing wiki CLI.
// Why: The CLI needs stable subcommands and shared connection arguments.
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;
use wiki_types::WikiPageType;

#[derive(Parser, Debug)]
#[command(name = "wiki-cli")]
#[command(about = "Agent-facing CLI for the Kinic wiki")]
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
    SearchRemote {
        query_text: String,
        #[arg(long = "page-type", value_enum)]
        page_types: Vec<PageTypeArg>,
        #[arg(long, default_value_t = 10)]
        top_k: u32,
        #[arg(long)]
        json: bool,
    },
    GetPage {
        slug: String,
        #[arg(long)]
        json: bool,
    },
    GetSystemPage {
        slug: String,
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

#[derive(clap::ValueEnum, Debug, Clone)]
pub enum PageTypeArg {
    Entity,
    Concept,
    Overview,
    Comparison,
    QueryNote,
    SourceSummary,
}

impl PageTypeArg {
    pub fn to_wiki_page_type(&self) -> WikiPageType {
        match self {
            Self::Entity => WikiPageType::Entity,
            Self::Concept => WikiPageType::Concept,
            Self::Overview => WikiPageType::Overview,
            Self::Comparison => WikiPageType::Comparison,
            Self::QueryNote => WikiPageType::QueryNote,
            Self::SourceSummary => WikiPageType::SourceSummary,
        }
    }
}

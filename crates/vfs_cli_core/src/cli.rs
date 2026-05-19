// Where: crates/vfs_cli_core/src/cli.rs
// What: Generic clap-facing VFS CLI definitions.
// Why: The app-facing CLI package should reuse these shared command shapes without owning the VFS surface.
use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;
use vfs_types::{DatabaseRole, GlobNodeType, NodeKind, SearchPreviewMode};

pub const DEFAULT_VFS_ROOT_PATH: &str = "/";

#[derive(Parser, Debug)]
#[command(name = "kinic-vfs-cli")]
#[command(about = "Generic CLI for the Kinic VFS canister surface")]
pub struct VfsCli {
    #[command(flatten)]
    pub connection: ConnectionArgs,

    #[command(subcommand)]
    pub command: VfsCommand,
}

#[derive(Args, Debug, Clone)]
pub struct ConnectionArgs {
    #[arg(
        long,
        conflicts_with = "replica_host",
        help = "Use the local replica host http://127.0.0.1:8000"
    )]
    pub local: bool,

    #[arg(long, help = "Override replica host from config")]
    pub replica_host: Option<String>,

    #[arg(long, help = "Override VFS_CANISTER_ID or user config")]
    pub canister_id: Option<String>,

    #[arg(long, help = "Target database id for DB-backed VFS operations")]
    pub database_id: Option<String>,

    #[arg(
        long,
        value_enum,
        default_value_t = IdentityModeArg::Auto,
        help = "Canister identity mode: auto, anonymous, or identity"
    )]
    pub identity_mode: IdentityModeArg,

    #[arg(
        long,
        help = "Allow authenticated calls with a non-Internet Identity icp-cli identity"
    )]
    pub allow_non_ii_identity: bool,
}

#[derive(Subcommand, Debug, Clone)]
pub enum VfsCommand {
    Database {
        #[command(subcommand)]
        command: DatabaseCommand,
    },
    ReadNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        metadata_only: bool,
        #[arg(long)]
        fields: Option<String>,
        #[arg(long)]
        json: bool,
    },
    ListNodes {
        #[arg(long, default_value = DEFAULT_VFS_ROOT_PATH)]
        prefix: String,
        #[arg(long)]
        recursive: bool,
        #[arg(long)]
        json: bool,
    },
    ListChildren {
        #[arg(long, default_value = DEFAULT_VFS_ROOT_PATH)]
        path: String,
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
        expected_folder_index_etag: Option<String>,
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
        #[arg(long, default_value = DEFAULT_VFS_ROOT_PATH)]
        path: String,
        #[arg(long, value_enum)]
        node_type: Option<GlobNodeTypeArg>,
        #[arg(long)]
        json: bool,
    },
    RecentNodes {
        #[arg(long, help = "Maximum 100; 0 is treated as 1 by the canister")]
        limit: u32,
        #[arg(long, alias = "prefix", default_value = DEFAULT_VFS_ROOT_PATH)]
        path: String,
        #[arg(long)]
        json: bool,
    },
    ReadNodeContext {
        #[arg(long)]
        path: String,
        #[arg(long, default_value_t = 20)]
        link_limit: u32,
        #[arg(long)]
        json: bool,
    },
    GraphNeighborhood {
        #[arg(long)]
        center_path: String,
        #[arg(long, default_value_t = 1)]
        depth: u32,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    GraphLinks {
        #[arg(long, default_value = DEFAULT_VFS_ROOT_PATH)]
        prefix: String,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    IncomingLinks {
        #[arg(long)]
        path: String,
        #[arg(long, default_value_t = 20)]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    OutgoingLinks {
        #[arg(long)]
        path: String,
        #[arg(long, default_value_t = 20)]
        limit: u32,
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
    #[command(alias = "search-nodes")]
    SearchRemote {
        query_text: String,
        #[arg(long, default_value = DEFAULT_VFS_ROOT_PATH)]
        prefix: String,
        #[arg(long, default_value_t = 10)]
        top_k: u32,
        #[arg(long, value_enum)]
        preview_mode: Option<SearchPreviewModeArg>,
        #[arg(long)]
        json: bool,
    },
    SearchPathRemote {
        query_text: String,
        #[arg(long, default_value = DEFAULT_VFS_ROOT_PATH)]
        prefix: String,
        #[arg(long, default_value_t = 10)]
        top_k: u32,
        #[arg(long, value_enum)]
        preview_mode: Option<SearchPreviewModeArg>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum DatabaseCommand {
    Create {
        name: String,
    },
    Rename {
        database_id: String,
        name: String,
    },
    List {
        #[arg(long)]
        json: bool,
    },
    Link {
        database_id: String,
    },
    Current {
        #[arg(long)]
        json: bool,
    },
    Unlink,
    Grant {
        database_id: String,
        principal: String,
        #[arg(value_enum)]
        role: DatabaseRoleArg,
    },
    GrantCurrentIdentity {
        database_id: String,
        #[arg(value_enum)]
        role: DatabaseRoleArg,
    },
    Revoke {
        database_id: String,
        principal: String,
    },
    Members {
        database_id: String,
        #[arg(long)]
        json: bool,
    },
    ArchiveExport {
        database_id: String,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value_t = 1_048_576)]
        chunk_size: u32,
        #[arg(long)]
        json: bool,
    },
    ArchiveRestore {
        database_id: String,
        #[arg(long)]
        input: PathBuf,
        #[arg(long, default_value_t = 1_048_576)]
        chunk_size: u32,
        #[arg(long)]
        json: bool,
    },
    ArchiveCancel {
        database_id: String,
    },
    RestoreCancel {
        database_id: String,
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
pub enum SearchPreviewModeArg {
    None,
    Light,
    ContentStart,
}

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseRoleArg {
    Owner,
    Writer,
    Reader,
}

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityModeArg {
    Auto,
    Anonymous,
    Identity,
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
    pub fn to_glob_node_type(self) -> GlobNodeType {
        match self {
            Self::File => GlobNodeType::File,
            Self::Directory => GlobNodeType::Directory,
            Self::Any => GlobNodeType::Any,
        }
    }
}

impl SearchPreviewModeArg {
    pub fn to_search_preview_mode(self) -> SearchPreviewMode {
        match self {
            Self::None => SearchPreviewMode::None,
            Self::Light => SearchPreviewMode::Light,
            Self::ContentStart => SearchPreviewMode::ContentStart,
        }
    }
}

impl DatabaseRoleArg {
    pub fn to_database_role(self) -> DatabaseRole {
        match self {
            Self::Owner => DatabaseRole::Owner,
            Self::Writer => DatabaseRole::Writer,
            Self::Reader => DatabaseRole::Reader,
        }
    }
}

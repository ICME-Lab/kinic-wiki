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

    #[arg(
        long,
        help = "Target DB-backed operations; alternatively set VFS_DATABASE_ID or run database link <database-id>"
    )]
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
    Cycles {
        #[command(subcommand)]
        command: CyclesCommand,
    },
    Database {
        #[command(subcommand)]
        command: DatabaseCommand,
    },
    Market {
        #[command(subcommand)]
        command: MarketCommand,
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
    WriteNodes {
        #[arg(long)]
        input: PathBuf,
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
    #[command(
        about = "Run one restricted JSON SELECT against the selected database; auto identity uses anonymous for public DBs unless the selected identity is a member"
    )]
    QuerySql {
        sql: String,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum MarketCommand {
    #[command(about = "List marketplace database entitlements for the current identity")]
    Entitlements {
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum DatabaseCommand {
    #[command(about = "Create a database and print its generated database id")]
    Create { name: String },
    #[command(about = "Rename one database")]
    Rename { database_id: String, name: String },
    #[command(about = "List databases attached to the current identity")]
    List {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Purchase non-refundable database cycles with KINIC")]
    PurchaseCycles { database_id: String, kinic: String },
    #[command(about = "List cycles ledger entries for one database")]
    CyclesHistory {
        database_id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List pending cycles purchases for one database")]
    CyclesPending {
        database_id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Open the browser cycles purchase page for one database")]
    Cycles {
        database_id: String,
        #[arg(long)]
        browser_origin: Option<String>,
    },
    #[command(about = "Save a workspace database link so commands can omit --database-id")]
    Link { database_id: String },
    #[command(about = "Show the currently linked workspace database")]
    Current {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Remove the workspace database link")]
    Unlink,
    #[command(about = "Grant owner, writer, or reader access to a principal")]
    Grant {
        database_id: String,
        principal: String,
        #[arg(value_enum)]
        role: DatabaseRoleArg,
    },
    #[command(about = "Grant the current identity owner, writer, or reader access")]
    GrantCurrentIdentity {
        database_id: String,
        #[arg(value_enum)]
        role: DatabaseRoleArg,
    },
    #[command(about = "Revoke database access from a principal")]
    Revoke {
        database_id: String,
        principal: String,
    },
    #[command(about = "List database members and roles")]
    Members {
        database_id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Export one database archive snapshot")]
    ArchiveExport {
        database_id: String,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value_t = 1_048_576)]
        chunk_size: u32,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Restore one archived database from a snapshot")]
    ArchiveRestore {
        database_id: String,
        #[arg(long)]
        input: PathBuf,
        #[arg(long, default_value_t = 1_048_576)]
        chunk_size: u32,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Cancel an interrupted archive export")]
    ArchiveCancel { database_id: String },
    #[command(about = "Cancel an interrupted archive restore")]
    RestoreCancel { database_id: String },
}

#[derive(Subcommand, Debug, Clone)]
pub enum CyclesCommand {
    #[command(about = "Show canister cycles configuration")]
    Config {
        #[arg(long)]
        json: bool,
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

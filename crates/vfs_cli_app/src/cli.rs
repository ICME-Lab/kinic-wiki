// Where: crates/vfs_cli_app/src/cli.rs
// What: clap definitions for the single published kinic-vfs-cli surface.
// Why: Wiki/operator commands and Skill Registry commands share one canister connection.
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use vfs_cli::cli::VfsCommand;
pub use vfs_cli::cli::{
    ConnectionArgs, DatabaseCommand, GlobNodeTypeArg, IdentityModeArg, NodeKindArg,
    SearchPreviewModeArg,
};
use wiki_domain::WIKI_ROOT_PATH;

#[derive(Parser, Debug)]
#[command(name = "kinic-vfs-cli")]
#[command(version)]
#[command(about = "Agent-facing CLI for the Kinic FS-first wiki")]
pub struct Cli {
    #[command(flatten)]
    pub connection: ConnectionArgs,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug, Clone)]
pub enum Command {
    Database {
        #[command(subcommand)]
        command: DatabaseCommand,
    },
    Identity {
        #[command(subcommand)]
        command: IdentityCommand,
    },
    Skill {
        #[command(subcommand)]
        command: SkillCommand,
    },
    Github {
        #[command(subcommand)]
        command: GitHubCommand,
    },
    RebuildIndex,
    RebuildScopeIndex {
        #[arg(long)]
        scope: String,
    },
    GenerateConversationWiki {
        #[arg(long)]
        source_path: String,
        #[arg(long)]
        json: bool,
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
        #[arg(long, default_value = WIKI_ROOT_PATH)]
        prefix: String,
        #[arg(long)]
        recursive: bool,
        #[arg(long)]
        json: bool,
    },
    ListChildren {
        #[arg(long, default_value = WIKI_ROOT_PATH)]
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
    PurgeUrlIngest {
        #[arg(
            long,
            conflicts_with = "source_path",
            required_unless_present = "source_path"
        )]
        url: Option<String>,
        #[arg(long, conflicts_with = "url", required_unless_present = "url")]
        source_path: Option<String>,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        force_target_prefix: Option<String>,
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
        #[arg(long, default_value = WIKI_ROOT_PATH)]
        path: String,
        #[arg(long, value_enum)]
        node_type: Option<GlobNodeTypeArg>,
        #[arg(long)]
        json: bool,
    },
    RecentNodes {
        #[arg(long, help = "Maximum 100; 0 is treated as 1 by the canister")]
        limit: u32,
        #[arg(long, alias = "prefix", default_value = WIKI_ROOT_PATH)]
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
        #[arg(long, default_value = WIKI_ROOT_PATH)]
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
        #[arg(long, default_value = WIKI_ROOT_PATH)]
        prefix: String,
        #[arg(
            long,
            default_value_t = 10,
            help = "Maximum 100; 0 is treated as 1 by the canister. Search preview defaults to light."
        )]
        top_k: u32,
        #[arg(long, value_enum)]
        preview_mode: Option<SearchPreviewModeArg>,
        #[arg(long)]
        json: bool,
    },
    SearchPathRemote {
        query_text: String,
        #[arg(long, default_value = WIKI_ROOT_PATH)]
        prefix: String,
        #[arg(
            long,
            default_value_t = 10,
            help = "Maximum 100; 0 is treated as 1 by the canister"
        )]
        top_k: u32,
        #[arg(long, value_enum)]
        preview_mode: Option<SearchPreviewModeArg>,
        #[arg(long)]
        json: bool,
    },
    Status {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum SkillCommand {
    Upsert {
        #[arg(long)]
        source_dir: PathBuf,
        #[arg(long)]
        id: String,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        prune: bool,
        #[arg(long)]
        json: bool,
    },
    Find {
        query: String,
        #[arg(long)]
        include_deprecated: bool,
        #[arg(long, default_value_t = 10)]
        top_k: u32,
        #[arg(long)]
        json: bool,
    },
    Inspect {
        id: String,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        json: bool,
    },
    RecordRun {
        id: String,
        #[arg(long, conflicts_with_all = ["task", "outcome", "notes_file", "agent"])]
        evidence_json: Option<PathBuf>,
        #[arg(long)]
        task: Option<String>,
        #[arg(long, value_enum)]
        outcome: Option<SkillRunOutcomeArg>,
        #[arg(long)]
        notes_file: Option<PathBuf>,
        #[arg(long, default_value = "cli")]
        agent: String,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        json: bool,
    },
    SetStatus {
        id: String,
        #[arg(long, value_enum)]
        status: SkillStatusArg,
        #[arg(long)]
        reason: Option<String>,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        json: bool,
    },
    Import {
        #[command(subcommand)]
        source: SkillImportCommand,
    },
    ProposeImprovement {
        id: String,
        #[arg(long = "runs", required = true)]
        runs: Vec<String>,
        #[arg(long)]
        summary: String,
        #[arg(long)]
        diff_file: PathBuf,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        json: bool,
    },
    ApproveProposal {
        id: String,
        proposal_path: String,
        #[arg(long)]
        json: bool,
    },
    RecordCorrection {
        id: String,
        run_id: String,
        #[arg(long)]
        notes_file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    ApplyProposal {
        id: String,
        proposal_id: String,
        #[arg(long)]
        projection_dir: Option<PathBuf>,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        json: bool,
    },
    Export {
        id: String,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        json: bool,
    },
    EvolveJobs {
        #[command(subcommand)]
        command: SkillEvolveJobsCommand,
    },
    Install {
        id: String,
        #[arg(long)]
        lockfile: PathBuf,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum IdentityCommand {
    Show {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum SkillEvolveJobsCommand {
    CreateReady {
        #[arg(long, default_value_t = 5)]
        min_new_runs: u32,
        #[arg(long, default_value_t = 24)]
        cooldown_hours: u32,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum SkillImportCommand {
    Github {
        source: String,
        #[arg(long)]
        id: String,
        #[arg(long = "ref", default_value = "HEAD")]
        reference: String,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        prune: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(clap::ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillStatusArg {
    Draft,
    Reviewed,
    Promoted,
    Deprecated,
}

#[derive(clap::ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillRunOutcomeArg {
    Success,
    Partial,
    Fail,
}

#[derive(Subcommand, Debug, Clone)]
pub enum GitHubCommand {
    Ingest {
        #[command(subcommand)]
        command: GitHubIngestCommand,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum GitHubIngestCommand {
    Issue {
        target: String,
        #[arg(long)]
        json: bool,
    },
    Pr {
        target: String,
        #[arg(long)]
        json: bool,
    },
}

impl Command {
    pub fn requires_identity(&self) -> bool {
        match self {
            Self::Database { command } => matches!(
                command,
                DatabaseCommand::Create { .. }
                    | DatabaseCommand::Rename { .. }
                    | DatabaseCommand::Grant { .. }
                    | DatabaseCommand::GrantCurrentIdentity { .. }
                    | DatabaseCommand::Revoke { .. }
                    | DatabaseCommand::Members { .. }
                    | DatabaseCommand::ArchiveExport { .. }
                    | DatabaseCommand::ArchiveRestore { .. }
                    | DatabaseCommand::ArchiveCancel { .. }
                    | DatabaseCommand::RestoreCancel { .. }
            ),
            Self::Skill { command } => !matches!(
                command,
                SkillCommand::Find { .. }
                    | SkillCommand::Inspect { .. }
                    | SkillCommand::Install { public: true, .. }
            ),
            Self::Identity { .. } => true,
            Self::Github { .. }
            | Self::RebuildIndex
            | Self::RebuildScopeIndex { .. }
            | Self::GenerateConversationWiki { .. }
            | Self::WriteNode { .. }
            | Self::AppendNode { .. }
            | Self::EditNode { .. }
            | Self::DeleteNode { .. }
            | Self::DeleteTree { .. }
            | Self::PurgeUrlIngest { .. }
            | Self::MkdirNode { .. }
            | Self::MoveNode { .. }
            | Self::MultiEditNode { .. } => true,
            Self::ReadNode { .. }
            | Self::ListNodes { .. }
            | Self::ListChildren { .. }
            | Self::GlobNodes { .. }
            | Self::RecentNodes { .. }
            | Self::ReadNodeContext { .. }
            | Self::GraphNeighborhood { .. }
            | Self::GraphLinks { .. }
            | Self::IncomingLinks { .. }
            | Self::OutgoingLinks { .. }
            | Self::SearchRemote { .. }
            | Self::SearchPathRemote { .. }
            | Self::Status { .. } => false,
        }
    }

    pub fn probes_anonymous_database_read(&self) -> bool {
        match self {
            Self::Skill { command } => matches!(
                command,
                SkillCommand::Find { .. }
                    | SkillCommand::Inspect { .. }
                    | SkillCommand::Install { public: true, .. }
            ),
            Self::ReadNode { .. }
            | Self::ListNodes { .. }
            | Self::ListChildren { .. }
            | Self::GlobNodes { .. }
            | Self::RecentNodes { .. }
            | Self::ReadNodeContext { .. }
            | Self::GraphNeighborhood { .. }
            | Self::GraphLinks { .. }
            | Self::IncomingLinks { .. }
            | Self::OutgoingLinks { .. }
            | Self::SearchRemote { .. }
            | Self::SearchPathRemote { .. }
            | Self::Status { .. } => true,
            Self::Database { .. }
            | Self::Identity { .. }
            | Self::Github { .. }
            | Self::RebuildIndex
            | Self::RebuildScopeIndex { .. }
            | Self::GenerateConversationWiki { .. }
            | Self::WriteNode { .. }
            | Self::AppendNode { .. }
            | Self::EditNode { .. }
            | Self::DeleteNode { .. }
            | Self::DeleteTree { .. }
            | Self::PurgeUrlIngest { .. }
            | Self::MkdirNode { .. }
            | Self::MoveNode { .. }
            | Self::MultiEditNode { .. } => false,
        }
    }

    pub fn prefers_identity_in_auto(&self) -> bool {
        matches!(
            self,
            Self::Database {
                command: DatabaseCommand::List { .. }
            } | Self::Identity { .. }
        )
    }

    pub fn as_vfs_command(&self) -> Option<VfsCommand> {
        match self {
            Self::Database { command } => Some(VfsCommand::Database {
                command: command.clone(),
            }),
            Self::ReadNode {
                path,
                metadata_only,
                fields,
                json,
            } => Some(VfsCommand::ReadNode {
                path: path.clone(),
                metadata_only: *metadata_only,
                fields: fields.clone(),
                json: *json,
            }),
            Self::ListNodes {
                prefix,
                recursive,
                json,
            } => Some(VfsCommand::ListNodes {
                prefix: prefix.clone(),
                recursive: *recursive,
                json: *json,
            }),
            Self::ListChildren { path, json } => Some(VfsCommand::ListChildren {
                path: path.clone(),
                json: *json,
            }),
            Self::WriteNode {
                path,
                kind,
                input,
                metadata_json,
                expected_etag,
                json,
            } => Some(VfsCommand::WriteNode {
                path: path.clone(),
                kind: *kind,
                input: input.clone(),
                metadata_json: metadata_json.clone(),
                expected_etag: expected_etag.clone(),
                json: *json,
            }),
            Self::AppendNode {
                path,
                input,
                kind,
                metadata_json,
                expected_etag,
                separator,
                json,
            } => Some(VfsCommand::AppendNode {
                path: path.clone(),
                input: input.clone(),
                kind: *kind,
                metadata_json: metadata_json.clone(),
                expected_etag: expected_etag.clone(),
                separator: separator.clone(),
                json: *json,
            }),
            Self::EditNode {
                path,
                old_text,
                new_text,
                expected_etag,
                replace_all,
                json,
            } => Some(VfsCommand::EditNode {
                path: path.clone(),
                old_text: old_text.clone(),
                new_text: new_text.clone(),
                expected_etag: expected_etag.clone(),
                replace_all: *replace_all,
                json: *json,
            }),
            Self::DeleteNode {
                path,
                expected_etag,
                expected_folder_index_etag,
                json,
            } => Some(VfsCommand::DeleteNode {
                path: path.clone(),
                expected_etag: expected_etag.clone(),
                expected_folder_index_etag: expected_folder_index_etag.clone(),
                json: *json,
            }),
            Self::DeleteTree { path, json } => Some(VfsCommand::DeleteTree {
                path: path.clone(),
                json: *json,
            }),
            Self::PurgeUrlIngest { .. } => None,
            Self::MkdirNode { path, json } => Some(VfsCommand::MkdirNode {
                path: path.clone(),
                json: *json,
            }),
            Self::MoveNode {
                from_path,
                to_path,
                expected_etag,
                overwrite,
                json,
            } => Some(VfsCommand::MoveNode {
                from_path: from_path.clone(),
                to_path: to_path.clone(),
                expected_etag: expected_etag.clone(),
                overwrite: *overwrite,
                json: *json,
            }),
            Self::GlobNodes {
                pattern,
                path,
                node_type,
                json,
            } => Some(VfsCommand::GlobNodes {
                pattern: pattern.clone(),
                path: path.clone(),
                node_type: *node_type,
                json: *json,
            }),
            Self::RecentNodes { limit, path, json } => Some(VfsCommand::RecentNodes {
                limit: *limit,
                path: path.clone(),
                json: *json,
            }),
            Self::ReadNodeContext {
                path,
                link_limit,
                json,
            } => Some(VfsCommand::ReadNodeContext {
                path: path.clone(),
                link_limit: *link_limit,
                json: *json,
            }),
            Self::GraphNeighborhood {
                center_path,
                depth,
                limit,
                json,
            } => Some(VfsCommand::GraphNeighborhood {
                center_path: center_path.clone(),
                depth: *depth,
                limit: *limit,
                json: *json,
            }),
            Self::GraphLinks {
                prefix,
                limit,
                json,
            } => Some(VfsCommand::GraphLinks {
                prefix: prefix.clone(),
                limit: *limit,
                json: *json,
            }),
            Self::IncomingLinks { path, limit, json } => Some(VfsCommand::IncomingLinks {
                path: path.clone(),
                limit: *limit,
                json: *json,
            }),
            Self::OutgoingLinks { path, limit, json } => Some(VfsCommand::OutgoingLinks {
                path: path.clone(),
                limit: *limit,
                json: *json,
            }),
            Self::MultiEditNode {
                path,
                edits_file,
                expected_etag,
                json,
            } => Some(VfsCommand::MultiEditNode {
                path: path.clone(),
                edits_file: edits_file.clone(),
                expected_etag: expected_etag.clone(),
                json: *json,
            }),
            Self::SearchRemote {
                query_text,
                prefix,
                top_k,
                preview_mode,
                json,
            } => Some(VfsCommand::SearchRemote {
                query_text: query_text.clone(),
                prefix: prefix.clone(),
                top_k: *top_k,
                preview_mode: *preview_mode,
                json: *json,
            }),
            Self::SearchPathRemote {
                query_text,
                prefix,
                top_k,
                preview_mode,
                json,
            } => Some(VfsCommand::SearchPathRemote {
                query_text: query_text.clone(),
                prefix: prefix.clone(),
                top_k: *top_k,
                preview_mode: *preview_mode,
                json: *json,
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Cli, Command, DatabaseCommand, IdentityModeArg, NodeKindArg, SkillCommand,
        SkillImportCommand, SkillStatusArg,
    };
    use clap::{CommandFactory, Parser};

    #[test]
    fn main_cli_help_does_not_list_beam_bench() {
        let mut command = Cli::command();
        let help = command.render_long_help().to_string();

        assert!(!help.contains("beam-bench"));
    }

    #[test]
    fn main_cli_exposes_package_version() {
        let command = Cli::command();
        let version = command.render_version().to_string();

        assert_eq!(
            version.trim(),
            concat!("kinic-vfs-cli ", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn main_cli_parses_link_commands() {
        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "read-node-context",
            "--path",
            "/Wiki/a.md",
            "--link-limit",
            "7",
            "--json",
        ]);
        let Command::ReadNodeContext {
            path,
            link_limit,
            json,
        } = cli.command
        else {
            panic!("expected read-node-context command");
        };
        assert_eq!(path, "/Wiki/a.md");
        assert_eq!(link_limit, 7);
        assert!(json);

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "graph-neighborhood",
            "--center-path",
            "/Wiki/a.md",
            "--depth",
            "2",
            "--limit",
            "9",
        ]);
        let Command::GraphNeighborhood {
            center_path,
            depth,
            limit,
            json,
        } = cli.command
        else {
            panic!("expected graph-neighborhood command");
        };
        assert_eq!(center_path, "/Wiki/a.md");
        assert_eq!(depth, 2);
        assert_eq!(limit, 9);
        assert!(!json);
    }

    #[test]
    fn main_cli_parses_database_link_commands() {
        let cli = Cli::parse_from(["kinic-vfs-cli", "database", "create", "team-db"]);
        let Command::Database {
            command: DatabaseCommand::Create { name },
        } = cli.command
        else {
            panic!("expected database create command");
        };
        assert_eq!(name, "team-db");
        assert!(Cli::try_parse_from(["kinic-vfs-cli", "database", "create"]).is_err());

        let cli = Cli::parse_from(["kinic-vfs-cli", "database", "rename", "db_alpha", "Alpha"]);
        let Command::Database {
            command: DatabaseCommand::Rename { database_id, name },
        } = cli.command
        else {
            panic!("expected database rename command");
        };
        assert_eq!(database_id, "db_alpha");
        assert_eq!(name, "Alpha");

        let cli = Cli::parse_from(["kinic-vfs-cli", "database", "link", "team-db"]);
        let Command::Database {
            command: DatabaseCommand::Link { database_id },
        } = cli.command
        else {
            panic!("expected database link command");
        };
        assert_eq!(database_id, "team-db");

        let cli = Cli::parse_from(["kinic-vfs-cli", "database", "current", "--json"]);
        let Command::Database {
            command: DatabaseCommand::Current { json },
        } = cli.command
        else {
            panic!("expected database current command");
        };
        assert!(json);

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "database",
            "archive-export",
            "team-db",
            "--output",
            "team-db.sqlite",
            "--chunk-size",
            "512",
            "--json",
        ]);
        let Command::Database {
            command:
                DatabaseCommand::ArchiveExport {
                    database_id,
                    output,
                    chunk_size,
                    json,
                },
        } = cli.command
        else {
            panic!("expected archive-export command");
        };
        assert_eq!(database_id, "team-db");
        assert_eq!(output.to_string_lossy(), "team-db.sqlite");
        assert_eq!(chunk_size, 512);
        assert!(json);
    }

    #[test]
    fn command_identity_requirement_keeps_reads_anonymous() {
        let read = Cli::parse_from(["kinic-vfs-cli", "read-node", "--path", "/Wiki/index.md"]);
        assert!(!read.command.requires_identity());
        assert!(read.command.probes_anonymous_database_read());

        let status = Cli::parse_from(["kinic-vfs-cli", "status"]);
        assert!(!status.command.requires_identity());
        assert!(status.command.probes_anonymous_database_read());

        let private_install = Cli::parse_from([
            "kinic-vfs-cli",
            "skill",
            "install",
            "legal-review",
            "--lockfile",
            "skill.lock.json",
        ]);
        assert!(private_install.command.requires_identity());
        assert!(!private_install.command.probes_anonymous_database_read());

        let public_install = Cli::parse_from([
            "kinic-vfs-cli",
            "skill",
            "install",
            "legal-review",
            "--lockfile",
            "skill.lock.json",
            "--public",
        ]);
        assert!(!public_install.command.requires_identity());
        assert!(public_install.command.probes_anonymous_database_read());

        let write = Cli::parse_from([
            "kinic-vfs-cli",
            "write-node",
            "--path",
            "/Wiki/index.md",
            "--input",
            "index.md",
        ]);
        assert!(write.command.requires_identity());
        assert!(!write.command.probes_anonymous_database_read());

        let list = Cli::parse_from(["kinic-vfs-cli", "database", "list"]);
        assert!(!list.command.requires_identity());
        assert!(list.command.prefers_identity_in_auto());
    }

    #[test]
    fn main_cli_parses_identity_mode() {
        let default_cli =
            Cli::parse_from(["kinic-vfs-cli", "read-node", "--path", "/Wiki/index.md"]);
        assert_eq!(default_cli.connection.identity_mode, IdentityModeArg::Auto);
        assert!(!default_cli.connection.allow_non_ii_identity);

        let anonymous_cli = Cli::parse_from([
            "kinic-vfs-cli",
            "--identity-mode",
            "anonymous",
            "read-node",
            "--path",
            "/Wiki/index.md",
        ]);
        assert_eq!(
            anonymous_cli.connection.identity_mode,
            IdentityModeArg::Anonymous
        );

        let identity_cli = Cli::parse_from([
            "kinic-vfs-cli",
            "--identity-mode",
            "identity",
            "write-node",
            "--path",
            "/Wiki/index.md",
            "--input",
            "index.md",
        ]);
        assert_eq!(
            identity_cli.connection.identity_mode,
            IdentityModeArg::Identity
        );

        let non_ii_cli = Cli::parse_from([
            "kinic-vfs-cli",
            "--allow-non-ii-identity",
            "read-node",
            "--path",
            "/Wiki/index.md",
        ]);
        assert!(non_ii_cli.connection.allow_non_ii_identity);
    }

    #[test]
    fn main_cli_rejects_local_and_replica_host_together() {
        let parsed = Cli::try_parse_from([
            "kinic-vfs-cli",
            "--local",
            "--replica-host",
            "http://127.0.0.1:8001",
            "status",
        ]);
        assert!(parsed.is_err());
    }

    #[test]
    fn main_cli_rejects_folder_kind_for_write_and_append() {
        let write = Cli::try_parse_from([
            "kinic-vfs-cli",
            "write-node",
            "--path",
            "/Wiki/folder",
            "--kind",
            "folder",
            "--input",
            "folder.md",
        ]);
        assert!(write.is_err());

        let append = Cli::try_parse_from([
            "kinic-vfs-cli",
            "append-node",
            "--path",
            "/Wiki/folder",
            "--kind",
            "folder",
            "--input",
            "folder.md",
        ]);
        assert!(append.is_err());

        let source = Cli::parse_from([
            "kinic-vfs-cli",
            "write-node",
            "--path",
            "/Sources/raw/source/source.md",
            "--kind",
            "source",
            "--input",
            "source.md",
        ]);
        let Command::WriteNode { kind, .. } = source.command else {
            panic!("expected write-node command");
        };
        assert_eq!(kind, NodeKindArg::Source);
    }

    #[test]
    fn main_cli_parses_accident_response_aliases() {
        let search = Cli::parse_from([
            "kinic-vfs-cli",
            "search-nodes",
            "incident",
            "--prefix",
            "/Wiki/run",
            "--json",
        ]);
        let Command::SearchRemote {
            query_text,
            prefix,
            json,
            ..
        } = search.command
        else {
            panic!("expected search-remote command");
        };
        assert_eq!(query_text, "incident");
        assert_eq!(prefix, "/Wiki/run");
        assert!(json);

        let recent = Cli::parse_from([
            "kinic-vfs-cli",
            "recent-nodes",
            "--limit",
            "7",
            "--prefix",
            "/Sources",
        ]);
        let Command::RecentNodes { limit, path, .. } = recent.command else {
            panic!("expected recent-nodes command");
        };
        assert_eq!(limit, 7);
        assert_eq!(path, "/Sources");

        let read = Cli::parse_from([
            "kinic-vfs-cli",
            "read-node",
            "--path",
            "/Wiki/index.md",
            "--metadata-only",
            "--fields",
            "path,kind,etag",
        ]);
        let Command::ReadNode {
            metadata_only,
            fields,
            ..
        } = read.command
        else {
            panic!("expected read-node command");
        };
        assert!(metadata_only);
        assert_eq!(fields.as_deref(), Some("path,kind,etag"));
    }

    #[test]
    fn main_cli_parses_skill_commands() {
        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "skill",
            "find",
            "contract review",
            "--include-deprecated",
            "--json",
        ]);
        let Command::Skill {
            command:
                SkillCommand::Find {
                    query,
                    include_deprecated,
                    json,
                    ..
                },
        } = cli.command
        else {
            panic!("expected skill find command");
        };
        assert_eq!(query, "contract review");
        assert!(include_deprecated);
        assert!(json);

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "skill",
            "upsert",
            "--source-dir",
            "./skills/legal-review",
            "--id",
            "legal-review",
            "--prune",
            "--json",
        ]);
        let Command::Skill {
            command: SkillCommand::Upsert { prune, json, .. },
        } = cli.command
        else {
            panic!("expected skill upsert command");
        };
        assert!(prune);
        assert!(json);

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "skill",
            "set-status",
            "legal-review",
            "--status",
            "deprecated",
        ]);
        let Command::Skill {
            command: SkillCommand::SetStatus { status, .. },
        } = cli.command
        else {
            panic!("expected skill set-status command");
        };
        assert_eq!(status, SkillStatusArg::Deprecated);

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "skill",
            "import",
            "github",
            "owner/repo:skills/foo",
            "--id",
            "foo",
            "--ref",
            "main",
            "--prune",
        ]);
        let Command::Skill {
            command:
                SkillCommand::Import {
                    source:
                        SkillImportCommand::Github {
                            source,
                            id,
                            reference,
                            prune,
                            ..
                        },
                },
        } = cli.command
        else {
            panic!("expected skill import github command");
        };
        assert_eq!(source, "owner/repo:skills/foo");
        assert_eq!(id, "foo");
        assert_eq!(reference, "main");
        assert!(prune);

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "skill",
            "install",
            "legal-review",
            "--lockfile",
            "skill.lock.json",
            "--json",
        ]);
        let Command::Skill {
            command: SkillCommand::Install {
                id, lockfile, json, ..
            },
        } = cli.command
        else {
            panic!("expected skill install command");
        };
        assert_eq!(id, "legal-review");
        assert_eq!(lockfile.to_string_lossy(), "skill.lock.json");
        assert!(json);
    }
}

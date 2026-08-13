// Where: crates/vfs_cli_app/src/cli.rs
// What: clap definitions for the single published kinic-vfs-cli surface.
// Why: Wiki/operator commands and Skill Registry commands share one canister connection.
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;
use vfs_cli::cli::VfsCommand;
pub use vfs_cli::cli::{
    AppendNodeKindArg, ConnectionArgs, CyclesCommand, DatabaseCommand, GlobNodeTypeArg,
    IdentityModeArg, MarketCommand, NodeKindArg, SearchPreviewModeArg,
};
use wiki_domain::WIKI_ROOT_PATH;

const STATUS_AFTER_HELP: &str = r#"Purpose:
  Confirm the selected canister, database, and read access before deeper work.

Examples:
  kinic-vfs-cli --database-id <db> status --json
  kinic-vfs-cli --identity-mode anonymous --database-id <public-db> status --json

Notes:
  Agents should prefer --json. Use this as a target/access check, not as final answer evidence."#;

const LIST_NODES_AFTER_HELP: &str = r#"Purpose:
  Inventory paths, kinds, etags, and child markers without reading node content.

Examples:
  kinic-vfs-cli --database-id <db> list-nodes --prefix /Knowledge --recursive --limit 100 --json
  kinic-vfs-cli --database-id <db> list-nodes --prefix / --recursive --limit 100 --json

Notes:
  Use list-nodes before broad repair, lint, or delete-tree review. Read content later with read-node, query-context, or query-sql."#;

const SEARCH_REMOTE_AFTER_HELP: &str = r#"Purpose:
  Search node content in one database and return candidate paths/snippets.

Examples:
  kinic-vfs-cli --database-id <db> search-remote "auth token" --prefix /Knowledge --top-k 10 --preview-mode content-start --json
  kinic-vfs-cli --database-id <db> search-remote "receipt" --prefix /Sources --top-k 20 --preview-mode content-start --json

Notes:
  Agents should prefer --json and --preview-mode content-start for candidate classification. Search hits are routing data; read final evidence before answering."#;

const SEARCH_PATH_REMOTE_AFTER_HELP: &str = r#"Purpose:
  Search paths and basenames when content search misses or the user names a page.

Examples:
  kinic-vfs-cli --database-id <db> search-path-remote "auth" --prefix /Knowledge --top-k 20 --preview-mode content-start --json

Notes:
  Use this to find likely paths, then read selected nodes with read-node or query-sql."#;

const READ_NODE_AFTER_HELP: &str = r#"Purpose:
  Read one known VFS path. Use this for final evidence checks and etag capture.

Examples:
  kinic-vfs-cli --database-id <db> read-node --path /Knowledge/index.md --json
  kinic-vfs-cli --database-id <db> read-node --path /Knowledge/index.md --fields path,kind,etag,content --json

Notes:
  Agents should prefer --json. Before mutation, capture the current etag and pass it to --expected-etag on the write/edit/delete command."#;

const READ_NODE_CONTEXT_AFTER_HELP: &str = r#"Purpose:
  Read one node plus incoming and outgoing link context.

Examples:
  kinic-vfs-cli --database-id <db> read-node-context --path /Knowledge/index.md --link-limit 20 --json

Notes:
  Use for link-aware catalog/navigation planning. For ordinary body reads, prefer read-node or query-sql."#;

const QUERY_SQL_AFTER_HELP: &str = r#"Purpose:
  Read several known paths or small classified slices with one restricted SELECT.

Examples:
  kinic-vfs-cli --database-id <db> query-sql "SELECT json_object('path', path, 'content', content) FROM fs_nodes WHERE path IN ('/Knowledge/a.md','/Knowledge/b.md') LIMIT 2" --limit 2 --json
  kinic-vfs-cli --database-id <db> query-sql "SELECT json_object('path', path, 'head', substr(content, 1, 700)) FROM fs_nodes WHERE path LIKE '/Sources/%' LIMIT 20" --limit 20 --json

Notes:
  Restricted SELECT guardrail: use one SELECT, only fs_nodes or fs_links, one json_object(...) TEXT column, one explicit SQL LIMIT 1..100, and no mutation tokens. Escape literal single quotes by doubling them."#;

const MEMORY_MANIFEST_AFTER_HELP: &str = r#"Purpose:
  Discover Store API roots, enabled stores, roles, capabilities, and limits.

Examples:
  kinic-vfs-cli --database-id <db> memory-manifest --json

Notes:
  This is discovery metadata, not content evidence. The recommended Store API entrypoint is query-context."#;

const QUERY_CONTEXT_AFTER_HELP: &str = r#"Purpose:
  Read task-scoped Store API context for normal agent question answering.

Examples:
  kinic-vfs-cli --database-id <db> query-context --task "answer auth question" --namespace /Knowledge --entity auth --budget-tokens 8000 --depth 1 --json
  kinic-vfs-cli --database-id <db> query-context --task "summarize current decisions" --namespace /Knowledge --json

Notes:
  Agents should prefer --json and answer from returned nodes/evidence, not search_hits alone. Use --entity multiple times to bias recall. Use --no-evidence only for lightweight routing."#;

const SOURCE_EVIDENCE_AFTER_HELP: &str = r#"Purpose:
  Read /Sources references for one known /Knowledge node.

Examples:
  kinic-vfs-cli --database-id <db> source-evidence --node-path /Knowledge/auth.md --json

Notes:
  Use after the knowledge node path is known and you need citation or trust checks. It returns source paths plus freshness metadata when available."#;

const EXPORT_SNAPSHOT_AFTER_HELP: &str = r#"Purpose:
  Export one read-only Store API snapshot page for a path scope.

Examples:
  kinic-vfs-cli --database-id <db> export-snapshot --prefix /Knowledge --limit 100 --json
  kinic-vfs-cli --database-id <db> export-snapshot --prefix /Knowledge --cursor <cursor> --snapshot-revision <revision> --json

Notes:
  This is a CLI sync/export command. It is intentionally not exposed by the wiki MCP tool surface."#;

const FETCH_UPDATES_AFTER_HELP: &str = r#"Purpose:
  Fetch Store API changes since a known trusted snapshot revision.

Examples:
  kinic-vfs-cli --database-id <db> fetch-updates --known-snapshot-revision <revision> --prefix /Knowledge --limit 100 --json

Notes:
  Use only when the caller already has a trusted snapshot_revision. This is a CLI sync command and is intentionally not exposed by the wiki MCP tool surface."#;

const WRITE_NODE_AFTER_HELP: &str = r#"Purpose:
  Write or replace one node from a local file.

Examples:
  kinic-vfs-cli --database-id <db> read-node --path /Knowledge/page.md --json
  kinic-vfs-cli --database-id <db> write-node --path /Knowledge/page.md --input page.md --expected-etag <etag> --json

Notes:
  For existing nodes, read the current node first and pass --expected-etag. Omit --expected-etag only for intentional new-node creation."#;

const APPEND_NODE_AFTER_HELP: &str = r#"Purpose:
  Append local file content to one node.

Examples:
  kinic-vfs-cli --database-id <db> read-node --path /Knowledge/log.md --json
  kinic-vfs-cli --database-id <db> append-node --path /Knowledge/log.md --input entry.md --expected-etag <etag> --json

Notes:
  Use --expected-etag after read-node for safe appends. Set --separator when the stored content needs an explicit boundary before appended text."#;

const EDIT_NODE_AFTER_HELP: &str = r#"Purpose:
  Replace text inside one node with an optional etag guard.

Examples:
  kinic-vfs-cli --database-id <db> read-node --path /Knowledge/page.md --json
  kinic-vfs-cli --database-id <db> edit-node --path /Knowledge/page.md --old-text "old" --new-text "new" --expected-etag <etag> --json

Notes:
  Always read-node first for current content and etag. Use --replace-all only when every occurrence is intentionally in scope."#;

const MULTI_EDIT_NODE_AFTER_HELP: &str = r#"Purpose:
  Apply multiple prepared text edits to one node.

Examples:
  kinic-vfs-cli --database-id <db> read-node --path /Knowledge/page.md --json
  kinic-vfs-cli --database-id <db> multi-edit-node --path /Knowledge/page.md --edits-file edits.json --expected-etag <etag> --json

Notes:
  Read the node immediately before mutation and pass --expected-etag. Keep the edits file limited to accepted replacements for that path."#;

const DELETE_NODE_AFTER_HELP: &str = r#"Purpose:
  Delete one node with optional etag guards.

Examples:
  kinic-vfs-cli --database-id <db> read-node --path /Knowledge/old.md --json
  kinic-vfs-cli --database-id <db> delete-node --path /Knowledge/old.md --expected-etag <etag> --json

Notes:
  Inspect the target first. Use etag guards for destructive edits, especially when a folder index may change concurrently."#;

const DELETE_TREE_AFTER_HELP: &str = r#"Purpose:
  Delete all real node paths under one prefix, deepest-first.

Examples:
  kinic-vfs-cli --database-id <db> list-nodes --prefix /Knowledge/old --recursive --limit 100 --json
  kinic-vfs-cli --database-id <db> delete-tree --path /Knowledge/old --json

Notes:
  Always inspect with list-nodes --prefix <path> --recursive --json before running delete-tree. Stop if the inventory contains unexpected paths."#;

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
    #[command(about = "Show KINIC cycles configuration")]
    Cycles {
        #[command(subcommand)]
        command: CyclesCommand,
    },
    #[command(about = "Manage database creation, workspace links, grants, and lifecycle")]
    Database {
        #[command(subcommand)]
        command: DatabaseCommand,
    },
    #[command(about = "Inspect marketplace access for the current identity")]
    Market {
        #[command(subcommand)]
        command: MarketCommand,
    },
    #[command(about = "Show the current authenticated canister identity")]
    Identity {
        #[command(subcommand)]
        command: IdentityCommand,
    },
    #[command(about = "Scan, validate, and apply reviewed wiki maintenance proposals")]
    Curator {
        #[command(subcommand)]
        command: CuratorCommand,
    },
    #[command(about = "Manage skill store packages, discovery, status, and run evidence")]
    Skill {
        #[command(subcommand)]
        command: SkillCommand,
    },
    #[command(about = "Install and sync the Kinic Hermes skill plugin")]
    Hermes {
        #[command(subcommand)]
        command: HermesCommand,
    },
    #[command(about = "Install the Kinic Codex skill recorder plugin")]
    Codex {
        #[command(subcommand)]
        command: CodexCommand,
    },
    #[command(about = "Install the Kinic Claude Code skill recorder plugin")]
    Claude {
        #[command(subcommand)]
        command: ClaudeCommand,
    },
    #[command(about = "Ingest GitHub issue or pull request context into the wiki")]
    Github {
        #[command(subcommand)]
        command: GitHubCommand,
    },
    #[command(about = "Export, verify, and inspect generated AI handoff artifacts")]
    ContextPack {
        #[command(subcommand)]
        command: ContextPackCommand,
    },
    #[command(about = "Rebuild the full wiki search index")]
    RebuildIndex,
    #[command(about = "Rebuild the search index for one path scope")]
    RebuildScopeIndex {
        #[arg(long)]
        scope: String,
    },
    #[command(about = "Generate knowledge nodes from a local conversation source")]
    GenerateConversationWiki {
        #[arg(long)]
        source_path: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Read one node by path; agents should prefer --json",
        after_help = READ_NODE_AFTER_HELP
    )]
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
    #[command(about = "Publish one Markdown node and print its public id")]
    PublishNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Show the publication record for one node")]
    GetNodePublication {
        #[arg(long)]
        path: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Remove public access from one published node")]
    UnpublishNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Read one published node by public id without a database selection")]
    ReadPublicNode {
        #[arg(long)]
        public_id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List nodes under a prefix", after_help = LIST_NODES_AFTER_HELP)]
    ListNodes {
        #[arg(long, default_value = WIKI_ROOT_PATH)]
        prefix: String,
        #[arg(long)]
        recursive: bool,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List direct children under one knowledge path; agents should prefer --json")]
    ListChildren {
        #[arg(long, default_value = WIKI_ROOT_PATH)]
        path: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Write or replace one node; use --expected-etag after read-node for safe edits",
        after_help = WRITE_NODE_AFTER_HELP
    )]
    WriteNode {
        #[arg(long)]
        path: String,
        #[arg(long, value_enum, default_value_t = NodeKindArg::File)]
        kind: NodeKindArg,
        #[arg(long)]
        input: PathBuf,
        #[arg(long, default_value = "{}")]
        metadata_json: String,
        #[arg(long, help = "Reject the write if the current node etag differs")]
        expected_etag: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Write or replace multiple nodes atomically from a JSON array")]
    WriteNodes {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Append content to one node; use --expected-etag after read-node for safe edits",
        after_help = APPEND_NODE_AFTER_HELP
    )]
    AppendNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        input: PathBuf,
        #[arg(long, value_enum)]
        kind: Option<AppendNodeKindArg>,
        #[arg(long)]
        metadata_json: Option<String>,
        #[arg(long, help = "Reject the append if the current node etag differs")]
        expected_etag: Option<String>,
        #[arg(long)]
        separator: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Replace text inside one node; use --expected-etag after read-node for safe edits",
        after_help = EDIT_NODE_AFTER_HELP
    )]
    EditNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        old_text: String,
        #[arg(long)]
        new_text: String,
        #[arg(long, help = "Reject the edit if the current node etag differs")]
        expected_etag: Option<String>,
        #[arg(long)]
        replace_all: bool,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Delete one node; use etag guards for safe destructive edits",
        after_help = DELETE_NODE_AFTER_HELP
    )]
    DeleteNode {
        #[arg(long)]
        path: String,
        #[arg(long, help = "Reject the delete if the current node etag differs")]
        expected_etag: Option<String>,
        #[arg(
            long,
            help = "Reject the delete if the parent folder index etag differs"
        )]
        expected_folder_index_etag: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Delete a node tree", after_help = DELETE_TREE_AFTER_HELP)]
    DeleteTree {
        #[arg(long)]
        path: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Remove source capture source and generated target nodes")]
    PurgeSourceCapture {
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
    #[command(about = "Create a directory node")]
    MkdirNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Move or rename one node; use --expected-etag for safe edits")]
    MoveNode {
        #[arg(long)]
        from_path: String,
        #[arg(long)]
        to_path: String,
        #[arg(long, help = "Reject the move if the current node etag differs")]
        expected_etag: Option<String>,
        #[arg(long, help = "Required to overwrite an existing target node")]
        expected_target_etag: Option<String>,
        #[arg(long)]
        overwrite: bool,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Find nodes by glob pattern under a path")]
    GlobNodes {
        pattern: String,
        #[arg(long, default_value = WIKI_ROOT_PATH)]
        path: String,
        #[arg(long, value_enum)]
        node_type: Option<GlobNodeTypeArg>,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Read one node with incoming and outgoing link context; agents should prefer --json",
        after_help = READ_NODE_CONTEXT_AFTER_HELP
    )]
    ReadNodeContext {
        #[arg(long)]
        path: String,
        #[arg(long, default_value_t = 20)]
        link_limit: u32,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Inspect nearby wiki links around one node")]
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
    #[command(about = "List graph links under a path prefix")]
    GraphLinks {
        #[arg(long, default_value = WIKI_ROOT_PATH)]
        prefix: String,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List nodes that link to one path")]
    IncomingLinks {
        #[arg(long)]
        path: String,
        #[arg(long, default_value_t = 20)]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List links written by one node")]
    OutgoingLinks {
        #[arg(long)]
        path: String,
        #[arg(long, default_value_t = 20)]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Apply multiple text edits to one node with an optional etag guard",
        after_help = MULTI_EDIT_NODE_AFTER_HELP
    )]
    MultiEditNode {
        #[arg(long)]
        path: String,
        #[arg(long)]
        edits_file: PathBuf,
        #[arg(long, help = "Reject the edits if the current node etag differs")]
        expected_etag: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(alias = "search-nodes")]
    #[command(
        about = "Search node content; agents should prefer --json before read-node",
        after_help = SEARCH_REMOTE_AFTER_HELP
    )]
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
    #[command(
        about = "Search node paths; agents should prefer --json",
        after_help = SEARCH_PATH_REMOTE_AFTER_HELP
    )]
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
    #[command(
        about = "Run one restricted JSON SELECT against the selected database; auto identity uses anonymous for public DBs unless the selected identity is a member",
        after_help = QUERY_SQL_AFTER_HELP
    )]
    QuerySql {
        sql: String,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Discover Store API roots, capabilities, and limits",
        after_help = MEMORY_MANIFEST_AFTER_HELP
    )]
    MemoryManifest {
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Read task-scoped Store API context; agents should prefer --json",
        after_help = QUERY_CONTEXT_AFTER_HELP
    )]
    QueryContext {
        #[arg(long)]
        task: String,
        #[arg(long = "entity")]
        entities: Vec<String>,
        #[arg(long)]
        namespace: Option<String>,
        #[arg(long, default_value_t = 8_000)]
        budget_tokens: u32,
        #[arg(long, default_value_t = 1)]
        depth: u32,
        #[arg(long)]
        no_evidence: bool,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Read source evidence references for one knowledge node",
        after_help = SOURCE_EVIDENCE_AFTER_HELP
    )]
    SourceEvidence {
        #[arg(long)]
        node_path: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Export one Store API snapshot page for a path scope",
        after_help = EXPORT_SNAPSHOT_AFTER_HELP
    )]
    ExportSnapshot {
        #[arg(long)]
        prefix: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long)]
        snapshot_revision: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Fetch Store API changes since a known snapshot revision",
        after_help = FETCH_UPDATES_AFTER_HELP
    )]
    FetchUpdates {
        #[arg(long)]
        known_snapshot_revision: String,
        #[arg(long)]
        prefix: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long)]
        target_snapshot_revision: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Show target canister and database access status", after_help = STATUS_AFTER_HELP)]
    Status {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum CuratorCommand {
    #[command(about = "Export a private four-store maintenance scan artifact")]
    Scan {
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value_t = 90)]
        stale_after_days: u32,
        #[arg(long)]
        overwrite: bool,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Validate a Curator proposal artifact without writing to the wiki")]
    Validate {
        #[arg(long)]
        plan: PathBuf,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Preview or atomically apply selected Curator proposals")]
    Apply {
        #[arg(long)]
        plan: PathBuf,
        #[arg(long = "proposal", action = clap::ArgAction::Append, conflicts_with = "all", required_unless_present = "all")]
        proposals: Vec<String>,
        #[arg(long, conflicts_with = "proposals")]
        all: bool,
        #[arg(long)]
        confirm: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum SkillCommand {
    #[command(about = "Store or update a skill store package from a local directory")]
    Upsert {
        #[arg(long)]
        source_dir: PathBuf,
        #[arg(long)]
        id: String,
        #[arg(long)]
        prune: bool,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Find skill store packages for a task query")]
    Find {
        query: String,
        #[arg(long)]
        include_deprecated: bool,
        #[arg(long, default_value_t = 10)]
        top_k: u32,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Inspect one skill store package, files, and recent run evidence")]
    Inspect {
        id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Record run evidence after a skill was used")]
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
        json: bool,
    },
    #[command(about = "Move a skill through draft, reviewed, promoted, or deprecated")]
    SetStatus {
        id: String,
        #[arg(long, value_enum)]
        status: SkillStatusArg,
        #[arg(long)]
        reason: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Import a skill store package from an external source")]
    Import {
        #[command(subcommand)]
        source: SkillImportCommand,
    },
    #[command(about = "Record a correction for an existing skill run")]
    RecordCorrection {
        id: String,
        run_id: String,
        #[arg(long)]
        notes_file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Restore a previous skill version")]
    Rollback {
        id: String,
        version_id: String,
        #[arg(long)]
        projection_dir: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Export one skill package to a local agent skill directory")]
    Export {
        id: String,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Export one skill package to GitHub through gh")]
    ExportGithub {
        id: String,
        target: String,
        #[arg(long)]
        branch: String,
        #[arg(long)]
        message: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List skill versions, runs, and corrections")]
    History {
        id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Write a lockfile for a selected skill package")]
    Install {
        id: String,
        #[arg(long)]
        lockfile: PathBuf,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum ContextPackCommand {
    #[command(about = "Export an OKF markdown bundle from a database namespace")]
    Export(ContextPackExportArgs),
    #[command(about = "Verify a local OKF bundle directory")]
    Verify(ContextPackVerifyArgs),
    #[command(about = "Inspect a local OKF bundle summary")]
    Inspect(ContextPackLocalArgs),
}

#[derive(Args, Debug, Clone)]
pub struct ContextPackExportArgs {
    #[arg(long)]
    pub task: String,
    #[arg(long, default_value = "/")]
    pub namespace: String,
    #[arg(long, default_value_t = 8_000)]
    pub budget_tokens: u32,
    #[arg(long, default_value_t = 1)]
    pub depth: u32,
    #[arg(long = "entity")]
    pub entities: Vec<String>,
    #[arg(long)]
    pub out: PathBuf,
    #[arg(long)]
    pub expires_at: String,
    #[arg(long, default_value = "draft")]
    pub trust_level: String,
    #[arg(long)]
    pub approved_by: Vec<String>,
    #[arg(long)]
    pub overwrite: bool,
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone)]
pub struct ContextPackLocalArgs {
    pub path: PathBuf,
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone)]
pub struct ContextPackVerifyArgs {
    pub path: PathBuf,
    #[arg(long)]
    pub fail_on_truncated: bool,
    #[arg(long)]
    pub json: bool,
}

#[derive(Subcommand, Debug, Clone)]
pub enum IdentityCommand {
    #[command(about = "Show the selected icp-cli identity principal")]
    Show {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum HermesCommand {
    #[command(about = "Install the Hermes plugin and export reviewed or promoted skills")]
    Setup {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Refresh the local Hermes skill projection")]
    Pull {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Show Hermes plugin and projection status")]
    Status {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Submit pending Hermes skill run evidence")]
    FlushPending {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List Hermes shadow correction files")]
    Shadows {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum CodexCommand {
    #[command(about = "Install the Codex skill recorder plugin")]
    Setup {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum ClaudeCommand {
    #[command(about = "Install the Claude Code skill recorder plugin")]
    Setup {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum SkillImportCommand {
    #[command(about = "Import a skill package from GitHub")]
    Github {
        source: String,
        #[arg(long)]
        id: String,
        #[arg(long = "ref", default_value = "HEAD")]
        reference: String,
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
    #[command(about = "Ingest GitHub issue or pull request content")]
    Ingest {
        #[command(subcommand)]
        command: GitHubIngestCommand,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum GitHubIngestCommand {
    #[command(about = "Ingest one GitHub issue into source nodes")]
    Issue {
        target: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Ingest one GitHub pull request into source nodes")]
    Pr {
        target: String,
        #[arg(long)]
        json: bool,
    },
}

impl Command {
    pub fn requires_identity(&self) -> bool {
        match self {
            Self::Cycles { command: _ } => false,
            Self::Database { command } => matches!(
                command,
                DatabaseCommand::Create { .. }
                    | DatabaseCommand::PurchaseCycles { .. }
                    | DatabaseCommand::CyclesHistory { .. }
                    | DatabaseCommand::Metadata { .. }
                    | DatabaseCommand::Grant { .. }
                    | DatabaseCommand::GrantCurrentIdentity { .. }
                    | DatabaseCommand::Revoke { .. }
                    | DatabaseCommand::Members { .. }
            ),
            Self::Market { command: _ } => true,
            Self::Skill { command } => !matches!(
                command,
                SkillCommand::Find { .. } | SkillCommand::Inspect { .. }
            ),
            Self::Hermes { command } => matches!(
                command,
                HermesCommand::Setup { .. }
                    | HermesCommand::Pull { .. }
                    | HermesCommand::FlushPending { .. }
            ),
            Self::Codex { .. } | Self::Claude { .. } => false,
            Self::Identity { .. } => true,
            Self::Curator { command } => {
                matches!(command, CuratorCommand::Apply { confirm: true, .. })
            }
            Self::Github { .. }
            | Self::RebuildIndex
            | Self::RebuildScopeIndex { .. }
            | Self::GenerateConversationWiki { .. }
            | Self::PublishNode { .. }
            | Self::GetNodePublication { .. }
            | Self::UnpublishNode { .. }
            | Self::WriteNode { .. }
            | Self::WriteNodes { .. }
            | Self::AppendNode { .. }
            | Self::EditNode { .. }
            | Self::DeleteNode { .. }
            | Self::DeleteTree { .. }
            | Self::PurgeSourceCapture { .. }
            | Self::MkdirNode { .. }
            | Self::MoveNode { .. }
            | Self::MultiEditNode { .. } => true,
            Self::ReadNode { .. }
            | Self::ReadPublicNode { .. }
            | Self::ListNodes { .. }
            | Self::ListChildren { .. }
            | Self::GlobNodes { .. }
            | Self::ReadNodeContext { .. }
            | Self::GraphNeighborhood { .. }
            | Self::GraphLinks { .. }
            | Self::IncomingLinks { .. }
            | Self::OutgoingLinks { .. }
            | Self::SearchRemote { .. }
            | Self::SearchPathRemote { .. }
            | Self::QuerySql { .. }
            | Self::MemoryManifest { .. }
            | Self::QueryContext { .. }
            | Self::SourceEvidence { .. }
            | Self::ExportSnapshot { .. }
            | Self::FetchUpdates { .. }
            | Self::Status { .. }
            | Self::ContextPack {
                command:
                    ContextPackCommand::Export(_)
                    | ContextPackCommand::Verify(_)
                    | ContextPackCommand::Inspect(_),
            } => false,
        }
    }

    pub fn probes_anonymous_database_read(&self) -> bool {
        match self {
            Self::Skill { command } => matches!(
                command,
                SkillCommand::Find { .. } | SkillCommand::Inspect { .. }
            ),
            Self::ReadNode { .. }
            | Self::Curator {
                command: CuratorCommand::Scan { .. } | CuratorCommand::Apply { confirm: false, .. },
            }
            | Self::ContextPack {
                command: ContextPackCommand::Export(_),
            }
            | Self::ListNodes { .. }
            | Self::ListChildren { .. }
            | Self::GlobNodes { .. }
            | Self::ReadNodeContext { .. }
            | Self::GraphNeighborhood { .. }
            | Self::GraphLinks { .. }
            | Self::IncomingLinks { .. }
            | Self::OutgoingLinks { .. }
            | Self::SearchRemote { .. }
            | Self::SearchPathRemote { .. }
            | Self::QuerySql { .. }
            | Self::MemoryManifest { .. }
            | Self::QueryContext { .. }
            | Self::SourceEvidence { .. }
            | Self::ExportSnapshot { .. }
            | Self::FetchUpdates { .. }
            | Self::Status { .. } => true,
            Self::Database { .. }
            | Self::Market { .. }
            | Self::Cycles { .. }
            | Self::Identity { .. }
            | Self::Curator {
                command:
                    CuratorCommand::Validate { .. } | CuratorCommand::Apply { confirm: true, .. },
            }
            | Self::Hermes { .. }
            | Self::Codex { .. }
            | Self::Claude { .. }
            | Self::Github { .. }
            | Self::ContextPack {
                command: ContextPackCommand::Verify(_) | ContextPackCommand::Inspect(_),
            }
            | Self::RebuildIndex
            | Self::RebuildScopeIndex { .. }
            | Self::GenerateConversationWiki { .. }
            | Self::PublishNode { .. }
            | Self::GetNodePublication { .. }
            | Self::UnpublishNode { .. }
            | Self::ReadPublicNode { .. }
            | Self::WriteNode { .. }
            | Self::WriteNodes { .. }
            | Self::AppendNode { .. }
            | Self::EditNode { .. }
            | Self::DeleteNode { .. }
            | Self::DeleteTree { .. }
            | Self::PurgeSourceCapture { .. }
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
                | Self::Hermes {
                    command: HermesCommand::Status { .. },
                }
        )
    }

    pub fn as_vfs_command(&self) -> Option<VfsCommand> {
        match self {
            Self::Cycles { command } => Some(VfsCommand::Cycles {
                command: command.clone(),
            }),
            Self::Database { command } => Some(VfsCommand::Database {
                command: command.clone(),
            }),
            Self::Market { command } => Some(VfsCommand::Market {
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
            Self::PublishNode { path, json } => Some(VfsCommand::PublishNode {
                path: path.clone(),
                json: *json,
            }),
            Self::GetNodePublication { path, json } => Some(VfsCommand::GetNodePublication {
                path: path.clone(),
                json: *json,
            }),
            Self::UnpublishNode { path, json } => Some(VfsCommand::UnpublishNode {
                path: path.clone(),
                json: *json,
            }),
            Self::ReadPublicNode { public_id, json } => Some(VfsCommand::ReadPublicNode {
                public_id: public_id.clone(),
                json: *json,
            }),
            Self::ListNodes {
                prefix,
                recursive,
                limit,
                json,
            } => Some(VfsCommand::ListNodes {
                prefix: prefix.clone(),
                recursive: *recursive,
                limit: *limit,
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
            Self::WriteNodes { input, json } => Some(VfsCommand::WriteNodes {
                input: input.clone(),
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
            Self::PurgeSourceCapture { .. } => None,
            Self::MkdirNode { path, json } => Some(VfsCommand::MkdirNode {
                path: path.clone(),
                json: *json,
            }),
            Self::MoveNode {
                from_path,
                to_path,
                expected_etag,
                expected_target_etag,
                overwrite,
                json,
            } => Some(VfsCommand::MoveNode {
                from_path: from_path.clone(),
                to_path: to_path.clone(),
                expected_etag: expected_etag.clone(),
                expected_target_etag: expected_target_etag.clone(),
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
            Self::QuerySql { sql, limit, json } => Some(VfsCommand::QuerySql {
                sql: sql.clone(),
                limit: *limit,
                json: *json,
            }),
            Self::MemoryManifest { json } => Some(VfsCommand::MemoryManifest { json: *json }),
            Self::QueryContext {
                task,
                entities,
                namespace,
                budget_tokens,
                depth,
                no_evidence,
                json,
            } => Some(VfsCommand::QueryContext {
                task: task.clone(),
                entities: entities.clone(),
                namespace: namespace.clone(),
                budget_tokens: *budget_tokens,
                depth: *depth,
                no_evidence: *no_evidence,
                json: *json,
            }),
            Self::SourceEvidence { node_path, json } => Some(VfsCommand::SourceEvidence {
                node_path: node_path.clone(),
                json: *json,
            }),
            Self::ExportSnapshot {
                prefix,
                limit,
                cursor,
                snapshot_revision,
                json,
            } => Some(VfsCommand::ExportSnapshot {
                prefix: prefix.clone(),
                limit: *limit,
                cursor: cursor.clone(),
                snapshot_revision: snapshot_revision.clone(),
                json: *json,
            }),
            Self::FetchUpdates {
                known_snapshot_revision,
                prefix,
                limit,
                cursor,
                target_snapshot_revision,
                json,
            } => Some(VfsCommand::FetchUpdates {
                known_snapshot_revision: known_snapshot_revision.clone(),
                prefix: prefix.clone(),
                limit: *limit,
                cursor: cursor.clone(),
                target_snapshot_revision: target_snapshot_revision.clone(),
                json: *json,
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests;

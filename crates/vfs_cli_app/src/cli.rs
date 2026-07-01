// Where: crates/vfs_cli_app/src/cli.rs
// What: clap definitions for the single published kinic-vfs-cli surface.
// Why: Wiki/operator commands and Skill Registry commands share one canister connection.
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;
use vfs_cli::cli::VfsCommand;
pub use vfs_cli::cli::{
    ConnectionArgs, CyclesCommand, DatabaseCommand, GlobNodeTypeArg, IdentityModeArg,
    MarketCommand, NodeKindArg, SearchPreviewModeArg,
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
        kind: Option<NodeKindArg>,
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
            Self::Github { .. }
            | Self::RebuildIndex
            | Self::RebuildScopeIndex { .. }
            | Self::GenerateConversationWiki { .. }
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
mod tests {
    use super::{
        ClaudeCommand, Cli, CodexCommand, Command, ContextPackCommand, CyclesCommand,
        DatabaseCommand, HermesCommand, IdentityModeArg, MarketCommand, NodeKindArg, SkillCommand,
        SkillImportCommand, SkillRunOutcomeArg, SkillStatusArg,
    };
    use clap::{CommandFactory, Parser};
    use std::path::PathBuf;
    use vfs_cli::cli::VfsCommand;

    fn top_level_command_help(name: &str) -> String {
        let mut command = Cli::command();
        command
            .find_subcommand_mut(name)
            .unwrap_or_else(|| panic!("missing {name} subcommand"))
            .render_long_help()
            .to_string()
    }

    #[test]
    fn main_cli_help_describes_agent_entrypoints() {
        let mut command = Cli::command();
        let help = command.render_long_help().to_string();

        assert!(help.contains("Manage database creation"));
        assert!(help.contains("Inspect marketplace access"));
        assert!(help.contains("Manage skill store packages"));
        assert!(help.contains("Read one node by path"));
        assert!(help.contains("Search node content"));
    }

    #[test]
    fn skill_help_describes_standard_registry_loop() {
        let mut command = Cli::command();
        let help = command
            .find_subcommand_mut("skill")
            .expect("skill subcommand")
            .render_long_help()
            .to_string();

        assert!(help.contains("Find skill store packages"));
        assert!(help.contains("Inspect one skill store package"));
        assert!(help.contains("Record run evidence"));
    }

    #[test]
    fn database_help_describes_connection_commands() {
        let mut command = Cli::command();
        let help = command
            .find_subcommand_mut("database")
            .expect("database subcommand")
            .render_long_help()
            .to_string();

        assert!(help.contains("workspace database link"));
        assert!(help.contains("List databases attached"));
        assert!(help.contains("Grant owner, writer, or reader access"));
    }

    #[test]
    fn main_cli_subcommand_help_includes_operational_guidance() {
        let query_context = top_level_command_help("query-context");
        assert!(query_context.contains("Examples:"));
        assert!(query_context.contains("--json"));
        assert!(query_context.contains("--namespace"));

        let query_sql = top_level_command_help("query-sql");
        assert!(query_sql.contains("Restricted SELECT guardrail"));
        assert!(query_sql.contains("fs_nodes"));
        assert!(query_sql.contains("json_object"));

        let edit_node = top_level_command_help("edit-node");
        assert!(edit_node.contains("read-node"));
        assert!(edit_node.contains("--expected-etag"));

        let delete_tree = top_level_command_help("delete-tree");
        assert!(delete_tree.contains("list-nodes --prefix <path> --recursive --json"));
        assert!(delete_tree.contains("unexpected paths"));

        let store_api_help = [
            ("memory-manifest", "Discover Store API roots"),
            ("query-context", "Read task-scoped Store API context"),
            ("source-evidence", "Read /Sources references"),
            ("export-snapshot", "CLI sync/export command"),
            ("fetch-updates", "known trusted snapshot revision"),
        ];
        for (command, expected) in store_api_help {
            assert!(
                top_level_command_help(command).contains(expected),
                "{command} help should contain {expected}"
            );
        }
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
            "/Knowledge/a.md",
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
        assert_eq!(path, "/Knowledge/a.md");
        assert_eq!(link_limit, 7);
        assert!(json);

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "list-nodes",
            "--prefix",
            "/Knowledge",
            "--recursive",
            "--limit",
            "50",
            "--json",
        ]);
        let Command::ListNodes {
            prefix,
            recursive,
            limit,
            json,
        } = cli.command
        else {
            panic!("expected list-nodes command");
        };
        assert_eq!(prefix, "/Knowledge");
        assert!(recursive);
        assert_eq!(limit, 50);
        assert!(json);

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "graph-neighborhood",
            "--center-path",
            "/Knowledge/a.md",
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
        assert_eq!(center_path, "/Knowledge/a.md");
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

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "database",
            "purchase-cycles",
            "db_alpha",
            "1.25",
        ]);
        let Command::Database {
            command: DatabaseCommand::PurchaseCycles { database_id, kinic },
        } = cli.command
        else {
            panic!("expected database cycle purchase command");
        };
        assert_eq!(database_id, "db_alpha");
        assert_eq!(kinic, "1.25");

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "database",
            "cycles",
            "db_alpha",
            "--browser-origin",
            "http://127.0.0.1:3000",
        ]);
        let Command::Database {
            command:
                DatabaseCommand::Cycles {
                    database_id,
                    browser_origin,
                },
        } = cli.command
        else {
            panic!("expected database cycles command");
        };
        assert_eq!(database_id, "db_alpha");
        assert_eq!(browser_origin.as_deref(), Some("http://127.0.0.1:3000"));
        assert!(
            Cli::try_parse_from(["kinic-vfs-cli", "database", "cycles", "db_alpha", "1.25"])
                .is_err()
        );

        let cli = Cli::parse_from(["kinic-vfs-cli", "database", "cycles-history", "db_alpha"]);
        let Command::Database {
            command: DatabaseCommand::CyclesHistory { database_id, json },
        } = cli.command
        else {
            panic!("expected database cycles-history command");
        };
        assert_eq!(database_id, "db_alpha");
        assert!(!json);

        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "database",
            "metadata",
            "db_alpha",
            "--input",
            "metadata.json",
            "--json",
        ]);
        let Command::Database {
            command:
                DatabaseCommand::Metadata {
                    database_id,
                    input,
                    json,
                },
        } = cli.command
        else {
            panic!("expected database metadata command");
        };
        assert_eq!(database_id, "db_alpha");
        assert_eq!(input, PathBuf::from("metadata.json"));
        assert!(json);

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
    }

    #[test]
    fn main_cli_parses_cycles_commands() {
        let cli = Cli::parse_from(["kinic-vfs-cli", "cycles", "config"]);
        let Command::Cycles {
            command: CyclesCommand::Config { json },
        } = cli.command
        else {
            panic!("expected cycles config command");
        };
        assert!(!json);
    }

    #[test]
    fn main_cli_parses_market_entitlements_commands() {
        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "market",
            "entitlements",
            "--cursor",
            "cursor-1",
            "--limit",
            "50",
            "--json",
        ]);
        let Command::Market {
            command:
                MarketCommand::Entitlements {
                    cursor,
                    limit,
                    json,
                },
        } = &cli.command
        else {
            panic!("expected market entitlements command");
        };
        assert_eq!(cursor.as_deref(), Some("cursor-1"));
        assert_eq!(*limit, 50);
        assert!(*json);

        let Some(VfsCommand::Market {
            command:
                MarketCommand::Entitlements {
                    cursor,
                    limit,
                    json,
                },
        }) = cli.command.as_vfs_command()
        else {
            panic!("expected VFS market entitlements command");
        };
        assert_eq!(cursor.as_deref(), Some("cursor-1"));
        assert_eq!(limit, 50);
        assert!(json);
    }

    #[test]
    fn main_cli_parses_query_sql_command() {
        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "query-sql",
            "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1",
            "--limit",
            "10",
            "--json",
        ]);
        let Command::QuerySql { sql, limit, json } = &cli.command else {
            panic!("expected query-sql command");
        };
        assert_eq!(sql, "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1");
        assert_eq!(*limit, 10);
        assert!(*json);

        let Some(VfsCommand::QuerySql { sql, limit, json }) = cli.command.as_vfs_command() else {
            panic!("expected VFS query-sql command");
        };
        assert_eq!(sql, "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1");
        assert_eq!(limit, 10);
        assert!(json);
    }

    #[test]
    fn main_cli_parses_store_api_commands() {
        let manifest = Cli::parse_from(["kinic-vfs-cli", "memory-manifest", "--json"]);
        let Some(VfsCommand::MemoryManifest { json }) = manifest.command.as_vfs_command() else {
            panic!("expected VFS memory-manifest command");
        };
        assert!(json);

        let context = Cli::parse_from([
            "kinic-vfs-cli",
            "query-context",
            "--task",
            "answer auth",
            "--entity",
            "auth",
            "--entity",
            "ii",
            "--namespace",
            "/Knowledge/auth",
            "--budget-tokens",
            "12000",
            "--depth",
            "2",
            "--no-evidence",
            "--json",
        ]);
        let Some(VfsCommand::QueryContext {
            task,
            entities,
            namespace,
            budget_tokens,
            depth,
            no_evidence,
            json,
        }) = context.command.as_vfs_command()
        else {
            panic!("expected VFS query-context command");
        };
        assert_eq!(task, "answer auth");
        assert_eq!(entities, vec!["auth", "ii"]);
        assert_eq!(namespace.as_deref(), Some("/Knowledge/auth"));
        assert_eq!(budget_tokens, 12000);
        assert_eq!(depth, 2);
        assert!(no_evidence);
        assert!(json);

        let context_defaults =
            Cli::parse_from(["kinic-vfs-cli", "query-context", "--task", "summarize"]);
        let Some(VfsCommand::QueryContext {
            namespace,
            budget_tokens,
            depth,
            no_evidence,
            json,
            ..
        }) = context_defaults.command.as_vfs_command()
        else {
            panic!("expected VFS query-context default command");
        };
        assert_eq!(namespace, None);
        assert_eq!(budget_tokens, 8000);
        assert_eq!(depth, 1);
        assert!(!no_evidence);
        assert!(!json);

        let evidence = Cli::parse_from([
            "kinic-vfs-cli",
            "source-evidence",
            "--node-path",
            "/Knowledge/a.md",
            "--json",
        ]);
        let Some(VfsCommand::SourceEvidence { node_path, json }) =
            evidence.command.as_vfs_command()
        else {
            panic!("expected VFS source-evidence command");
        };
        assert_eq!(node_path, "/Knowledge/a.md");
        assert!(json);

        let snapshot = Cli::parse_from([
            "kinic-vfs-cli",
            "export-snapshot",
            "--prefix",
            "/Knowledge",
            "--limit",
            "25",
            "--cursor",
            "cursor-1",
            "--snapshot-revision",
            "rev-1",
            "--json",
        ]);
        let Some(VfsCommand::ExportSnapshot {
            prefix,
            limit,
            cursor,
            snapshot_revision,
            json,
        }) = snapshot.command.as_vfs_command()
        else {
            panic!("expected VFS export-snapshot command");
        };
        assert_eq!(prefix.as_deref(), Some("/Knowledge"));
        assert_eq!(limit, 25);
        assert_eq!(cursor.as_deref(), Some("cursor-1"));
        assert_eq!(snapshot_revision.as_deref(), Some("rev-1"));
        assert!(json);

        let updates = Cli::parse_from([
            "kinic-vfs-cli",
            "fetch-updates",
            "--known-snapshot-revision",
            "rev-1",
            "--prefix",
            "/Knowledge",
            "--limit",
            "25",
            "--cursor",
            "cursor-1",
            "--target-snapshot-revision",
            "rev-2",
            "--json",
        ]);
        let Some(VfsCommand::FetchUpdates {
            known_snapshot_revision,
            prefix,
            limit,
            cursor,
            target_snapshot_revision,
            json,
        }) = updates.command.as_vfs_command()
        else {
            panic!("expected VFS fetch-updates command");
        };
        assert_eq!(known_snapshot_revision, "rev-1");
        assert_eq!(prefix.as_deref(), Some("/Knowledge"));
        assert_eq!(limit, 25);
        assert_eq!(cursor.as_deref(), Some("cursor-1"));
        assert_eq!(target_snapshot_revision.as_deref(), Some("rev-2"));
        assert!(json);
    }

    #[test]
    fn main_cli_parses_context_pack_commands() {
        let export = Cli::parse_from([
            "kinic-vfs-cli",
            "context-pack",
            "export",
            "--task",
            "review auth",
            "--namespace",
            "/Knowledge/projects/acme",
            "--budget-tokens",
            "12000",
            "--depth",
            "2",
            "--entity",
            "auth",
            "--out",
            "pack",
            "--expires-at",
            "2999-01-01T00:00:00Z",
            "--trust-level",
            "team-approved",
            "--approved-by",
            "principal:aaaaa-aa",
            "--overwrite",
            "--json",
        ]);
        let Command::ContextPack {
            command: ContextPackCommand::Export(args),
        } = export.command
        else {
            panic!("expected context-pack export command");
        };
        assert_eq!(args.task, "review auth");
        assert_eq!(args.namespace, "/Knowledge/projects/acme");
        assert_eq!(args.budget_tokens, 12000);
        assert_eq!(args.depth, 2);
        assert_eq!(args.entities, vec!["auth"]);
        assert_eq!(args.out.to_string_lossy(), "pack");
        assert_eq!(args.expires_at, "2999-01-01T00:00:00Z");
        assert_eq!(args.trust_level, "team-approved");
        assert_eq!(args.approved_by, vec!["principal:aaaaa-aa"]);
        assert!(args.overwrite);
        assert!(args.json);

        let export_default_namespace = Cli::parse_from([
            "kinic-vfs-cli",
            "context-pack",
            "export",
            "--task",
            "review auth",
            "--out",
            "pack",
            "--expires-at",
            "2999-01-01T00:00:00Z",
        ]);
        let Command::ContextPack {
            command: ContextPackCommand::Export(args),
        } = export_default_namespace.command
        else {
            panic!("expected context-pack export command");
        };
        assert_eq!(args.namespace, "/");

        let verify = Cli::parse_from([
            "kinic-vfs-cli",
            "context-pack",
            "verify",
            "pack",
            "--fail-on-truncated",
            "--json",
        ]);
        let Command::ContextPack {
            command: ContextPackCommand::Verify(args),
        } = verify.command
        else {
            panic!("expected context-pack verify command");
        };
        assert_eq!(args.path.to_string_lossy(), "pack");
        assert!(args.fail_on_truncated);
        assert!(args.json);

        let inspect = Cli::parse_from(["kinic-vfs-cli", "context-pack", "inspect", "pack"]);
        let Command::ContextPack {
            command: ContextPackCommand::Inspect(args),
        } = inspect.command
        else {
            panic!("expected context-pack inspect command");
        };
        assert_eq!(args.path.to_string_lossy(), "pack");
        assert!(!args.json);

        let root_arg = Cli::try_parse_from([
            "kinic-vfs-cli",
            "context-pack",
            "export",
            "--root",
            "/Knowledge/projects/acme",
            "--task",
            "review auth",
            "--out",
            "pack",
            "--expires-at",
            "2999-01-01T00:00:00Z",
        ]);
        assert!(root_arg.is_err());
    }

    #[test]
    fn command_identity_requirement_keeps_reads_anonymous() {
        let status_with_database =
            Cli::parse_from(["kinic-vfs-cli", "--database-id", "db_x", "status"]);
        assert_eq!(
            status_with_database.connection.database_id.as_deref(),
            Some("db_x")
        );
        assert!(!status_with_database.command.requires_identity());
        assert!(
            status_with_database
                .command
                .probes_anonymous_database_read()
        );

        let read = Cli::parse_from([
            "kinic-vfs-cli",
            "read-node",
            "--path",
            "/Knowledge/index.md",
        ]);
        assert!(!read.command.requires_identity());
        assert!(read.command.probes_anonymous_database_read());

        let query_sql = Cli::parse_from([
            "kinic-vfs-cli",
            "query-sql",
            "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1",
        ]);
        assert!(!query_sql.command.requires_identity());
        assert!(query_sql.command.probes_anonymous_database_read());

        let status = Cli::parse_from(["kinic-vfs-cli", "status"]);
        assert!(!status.command.requires_identity());
        assert!(status.command.probes_anonymous_database_read());

        for command in [
            Cli::parse_from(["kinic-vfs-cli", "memory-manifest"]).command,
            Cli::parse_from(["kinic-vfs-cli", "query-context", "--task", "summary"]).command,
            Cli::parse_from([
                "kinic-vfs-cli",
                "source-evidence",
                "--node-path",
                "/Knowledge/a.md",
            ])
            .command,
            Cli::parse_from(["kinic-vfs-cli", "export-snapshot"]).command,
            Cli::parse_from([
                "kinic-vfs-cli",
                "fetch-updates",
                "--known-snapshot-revision",
                "rev-1",
            ])
            .command,
        ] {
            assert!(!command.requires_identity());
            assert!(command.probes_anonymous_database_read());
        }

        let context_pack_export = Cli::parse_from([
            "kinic-vfs-cli",
            "context-pack",
            "export",
            "--task",
            "summary",
            "--out",
            "pack",
            "--expires-at",
            "2999-01-01T00:00:00Z",
        ]);
        assert!(!context_pack_export.command.requires_identity());
        assert!(context_pack_export.command.probes_anonymous_database_read());

        let context_pack_verify =
            Cli::parse_from(["kinic-vfs-cli", "context-pack", "verify", "pack"]);
        assert!(!context_pack_verify.command.requires_identity());
        assert!(!context_pack_verify.command.probes_anonymous_database_read());

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

        assert!(
            Cli::try_parse_from([
                "kinic-vfs-cli",
                "skill",
                "install",
                "legal-review",
                "--lockfile",
                "skill.lock.json",
                "--public",
            ])
            .is_err()
        );

        let write = Cli::parse_from([
            "kinic-vfs-cli",
            "write-node",
            "--path",
            "/Knowledge/index.md",
            "--input",
            "index.md",
        ]);
        assert!(write.command.requires_identity());
        assert!(!write.command.probes_anonymous_database_read());

        let batch_write = Cli::parse_from([
            "kinic-vfs-cli",
            "write-nodes",
            "--input",
            "nodes.json",
            "--json",
        ]);
        assert!(batch_write.command.requires_identity());
        assert!(!batch_write.command.probes_anonymous_database_read());

        let list = Cli::parse_from(["kinic-vfs-cli", "database", "list"]);
        assert!(!list.command.requires_identity());
        assert!(list.command.prefers_identity_in_auto());

        let cycles_config = Cli::parse_from(["kinic-vfs-cli", "cycles", "config"]);
        assert!(!cycles_config.command.requires_identity());
        assert!(!cycles_config.command.probes_anonymous_database_read());

        let database_cycles_purchase = Cli::parse_from([
            "kinic-vfs-cli",
            "database",
            "purchase-cycles",
            "db_alpha",
            "1.25",
        ]);
        assert!(database_cycles_purchase.command.requires_identity());

        let database_cycles_history =
            Cli::parse_from(["kinic-vfs-cli", "database", "cycles-history", "db_alpha"]);
        assert!(database_cycles_history.command.requires_identity());

        let database_cycles = Cli::parse_from(["kinic-vfs-cli", "database", "cycles", "db_alpha"]);
        assert!(!database_cycles.command.requires_identity());

        let market_entitlements = Cli::parse_from(["kinic-vfs-cli", "market", "entitlements"]);
        assert!(market_entitlements.command.requires_identity());
        assert!(!market_entitlements.command.probes_anonymous_database_read());
    }

    #[test]
    fn main_cli_parses_record_run() {
        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "skill",
            "record-run",
            "legal-review",
            "--task",
            "review redlines",
            "--outcome",
            "success",
            "--notes-file",
            "notes.md",
            "--json",
        ]);
        let Command::Skill {
            command:
                SkillCommand::RecordRun {
                    id,
                    task,
                    outcome,
                    notes_file,
                    json,
                    ..
                },
        } = cli.command
        else {
            panic!("expected skill record-run command");
        };
        assert_eq!(id, "legal-review");
        assert_eq!(task.as_deref(), Some("review redlines"));
        assert_eq!(outcome, Some(SkillRunOutcomeArg::Success));
        assert_eq!(notes_file.unwrap().to_string_lossy(), "notes.md");
        assert!(json);
    }

    #[test]
    fn main_cli_rejects_removed_skill_proposal_commands() {
        for removed_command in [
            "propose-improvement",
            "approve-proposal",
            "apply-proposal",
            "evolve-jobs",
        ] {
            assert!(
                Cli::try_parse_from(["kinic-vfs-cli", "skill", removed_command]).is_err(),
                "{removed_command} should be removed"
            );
        }
    }

    #[test]
    fn main_cli_parses_identity_mode() {
        let default_cli = Cli::parse_from([
            "kinic-vfs-cli",
            "read-node",
            "--path",
            "/Knowledge/index.md",
        ]);
        assert_eq!(default_cli.connection.identity_mode, IdentityModeArg::Auto);
        assert!(!default_cli.connection.allow_non_ii_identity);

        let anonymous_cli = Cli::parse_from([
            "kinic-vfs-cli",
            "--identity-mode",
            "anonymous",
            "read-node",
            "--path",
            "/Knowledge/index.md",
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
            "/Knowledge/index.md",
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
            "/Knowledge/index.md",
        ]);
        assert!(non_ii_cli.connection.allow_non_ii_identity);
    }

    #[test]
    fn main_cli_rejects_local_and_replica_host_together() {
        let parsed = Cli::try_parse_from([
            "kinic-vfs-cli",
            "--local",
            "--replica-host",
            "http://127.0.0.1:8011",
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
            "/Knowledge/folder",
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
            "/Knowledge/folder",
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
            "/Sources/source/source.md",
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
    fn main_cli_parses_write_nodes() {
        let cli = Cli::parse_from([
            "kinic-vfs-cli",
            "write-nodes",
            "--input",
            "nodes.json",
            "--json",
        ]);
        let Command::WriteNodes { input, json } = &cli.command else {
            panic!("expected write-nodes command");
        };
        assert_eq!(input.to_string_lossy(), "nodes.json");
        assert!(*json);

        let Some(VfsCommand::WriteNodes { input, json }) = cli.command.as_vfs_command() else {
            panic!("expected VFS write-nodes command");
        };
        assert_eq!(input.to_string_lossy(), "nodes.json");
        assert!(json);
    }

    #[test]
    fn main_cli_parses_accident_response_aliases() {
        let search = Cli::parse_from([
            "kinic-vfs-cli",
            "search-nodes",
            "incident",
            "--prefix",
            "/Knowledge/run",
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
        assert_eq!(prefix, "/Knowledge/run");
        assert!(json);

        let read = Cli::parse_from([
            "kinic-vfs-cli",
            "read-node",
            "--path",
            "/Knowledge/index.md",
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

    #[test]
    fn main_cli_parses_hermes_surfaces() {
        let setup = Cli::parse_from(["kinic-vfs-cli", "hermes", "setup", "--json"]);
        let Command::Hermes {
            command: HermesCommand::Setup { json },
        } = &setup.command
        else {
            panic!("expected hermes setup command");
        };
        assert!(*json);
        assert!(setup.command.requires_identity());

        let pull = Cli::parse_from(["kinic-vfs-cli", "hermes", "pull", "--json"]);
        let Command::Hermes {
            command: HermesCommand::Pull { json },
        } = &pull.command
        else {
            panic!("expected hermes pull command");
        };
        assert!(*json);
        assert!(pull.command.requires_identity());

        let status = Cli::parse_from(["kinic-vfs-cli", "hermes", "status"]);
        let Command::Hermes {
            command: HermesCommand::Status { json },
        } = &status.command
        else {
            panic!("expected hermes status command");
        };
        assert!(!*json);
        assert!(!status.command.requires_identity());
        assert!(status.command.prefers_identity_in_auto());

        let flush = Cli::parse_from(["kinic-vfs-cli", "hermes", "flush-pending"]);
        let Command::Hermes {
            command: HermesCommand::FlushPending { .. },
        } = &flush.command
        else {
            panic!("expected hermes flush-pending command");
        };
        assert!(flush.command.requires_identity());

        let shadows = Cli::parse_from(["kinic-vfs-cli", "hermes", "shadows"]);
        let Command::Hermes {
            command: HermesCommand::Shadows { .. },
        } = &shadows.command
        else {
            panic!("expected hermes shadows command");
        };
        assert!(!shadows.command.requires_identity());

        let removed_command = ["run", "ready"].join("-");
        assert!(
            Cli::try_parse_from(["kinic-vfs-cli", "skill", "evolve-jobs", &removed_command])
                .is_err()
        );
    }

    #[test]
    fn main_cli_parses_codex_setup_as_local_command() {
        let setup = Cli::parse_from(["kinic-vfs-cli", "codex", "setup", "--json"]);
        let Command::Codex {
            command: CodexCommand::Setup { json },
        } = &setup.command
        else {
            panic!("expected codex setup command");
        };
        assert!(*json);
        assert!(!setup.command.requires_identity());
        assert!(!setup.command.probes_anonymous_database_read());
    }

    #[test]
    fn main_cli_parses_claude_setup_as_local_command() {
        let setup = Cli::parse_from(["kinic-vfs-cli", "claude", "setup", "--json"]);
        let Command::Claude {
            command: ClaudeCommand::Setup { json },
        } = &setup.command
        else {
            panic!("expected claude setup command");
        };
        assert!(*json);
        assert!(!setup.command.requires_identity());
        assert!(!setup.command.probes_anonymous_database_read());
    }
}

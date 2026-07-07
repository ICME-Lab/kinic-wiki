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
fn main_cli_accepts_folder_kind_for_write_but_rejects_append() {
    let write = Cli::parse_from([
        "kinic-vfs-cli",
        "write-node",
        "--path",
        "/Knowledge/folder",
        "--kind",
        "folder",
        "--input",
        "folder.md",
    ]);
    let Command::WriteNode { kind, .. } = write.command else {
        panic!("expected write-node command");
    };
    assert_eq!(kind, NodeKindArg::Folder);

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

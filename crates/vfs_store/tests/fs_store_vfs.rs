use rusqlite::Connection;
use tempfile::tempdir;
use vfs_store::FsStore;
use vfs_types::{
    AppendNodeRequest, DeleteNodeRequest, EditNodeRequest, GlobNodeType, GlobNodesRequest,
    GraphLinksRequest, GraphNeighborhoodRequest, IncomingLinksRequest, ListNodesRequest,
    MkdirNodeRequest, MoveNodeRequest, MultiEdit, MultiEditNodeRequest, NodeContextRequest,
    NodeEntryKind, NodeKind, OutgoingLinksRequest, QueryContextRequest, SearchNodePathsRequest,
    SearchPreviewMode, SourceEvidenceRequest, WriteNodeRequest,
};

fn new_store() -> (tempfile::TempDir, FsStore) {
    let dir = tempdir().expect("temp dir should exist");
    let store = FsStore::new(dir.path().join("wiki.sqlite3"));
    store
        .run_fs_migrations()
        .expect("fs migrations should succeed");
    (dir, store)
}

fn ensure_parent_folders(store: &FsStore, path: &str, now: i64) {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut current = String::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        current.push('/');
        current.push_str(segment);
        store
            .mkdir_node(
                MkdirNodeRequest {
                    database_id: "default".to_string(),
                    path: current.clone(),
                },
                now,
            )
            .expect("parent folder should exist or be created");
    }
}

#[test]
fn write_mkdir_and_move_require_existing_folder_parent() {
    let (_dir, store) = new_store();
    let write_error = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/missing/file.md".to_string(),
                kind: NodeKind::File,
                content: "orphan".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect_err("write without parent folder should fail");
    assert_eq!(
        write_error,
        "parent folder does not exist: /Knowledge/missing"
    );

    let append_error = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/missing/appended.md".to_string(),
                content: "orphan append".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect_err("append without parent folder should fail");
    assert_eq!(
        append_error,
        "parent folder does not exist: /Knowledge/missing"
    );

    let mkdir_error = store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/missing/child".to_string(),
            },
            11,
        )
        .expect_err("mkdir without parent folder should fail");
    assert_eq!(
        mkdir_error,
        "parent folder does not exist: /Knowledge/missing"
    );

    let source = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/a.md".to_string(),
                content: "alpha".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            12,
        )
        .expect("source node should create");
    let move_error = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/a.md".to_string(),
                to_path: "/Knowledge/missing/a.md".to_string(),
                expected_etag: Some(source.node.etag),
                overwrite: false,
            },
            13,
        )
        .expect_err("move without target parent folder should fail");
    assert_eq!(
        move_error,
        "parent folder does not exist: /Knowledge/missing"
    );
}

#[test]
fn file_and_source_parents_cannot_contain_children() {
    let (_dir, store) = new_store();
    let file_parent = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/file".to_string(),
                content: "file parent".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("file parent should create");
    let file_child_error = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/file/child.md".to_string(),
                kind: NodeKind::File,
                content: "child".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            11,
        )
        .expect_err("write below file should fail");
    assert_eq!(
        file_child_error,
        "parent path is not a folder: /Knowledge/file"
    );

    ensure_parent_folders(&store, "/Sources/source/source.md", 12);
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/source/source.md".to_string(),
                content: "source parent".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: Some(NodeKind::Source),
            },
            13,
        )
        .expect("source parent should create");
    let mkdir_error = store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/source/source.md/child".to_string(),
            },
            14,
        )
        .expect_err("mkdir below source should fail");
    assert_eq!(
        mkdir_error,
        "parent path is not a folder: /Sources/source/source.md"
    );
    let move_error = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/file".to_string(),
                to_path: "/Sources/source/source.md/file".to_string(),
                expected_etag: Some(file_parent.node.etag),
                overwrite: false,
            },
            15,
        )
        .expect_err("move below source should fail");
    assert_eq!(
        move_error,
        "parent path is not a folder: /Sources/source/source.md"
    );
}

#[test]
fn append_node_creates_updates_and_checks_etag() {
    let (_dir, store) = new_store();

    let created = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/log.md".to_string(),
                content: "alpha".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: Some("{\"t\":1}".to_string()),
                kind: Some(NodeKind::File),
            },
            10,
        )
        .expect("append create should succeed");
    assert!(created.created);
    assert_eq!(
        store
            .read_node("/Knowledge/log.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "alpha"
    );

    let updated = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/log.md".to_string(),
                content: "beta".to_string(),
                expected_etag: Some(created.node.etag.clone()),
                separator: Some("\n".to_string()),
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("append update should succeed");
    assert_eq!(
        store
            .read_node("/Knowledge/log.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "alpha\nbeta"
    );
    assert_ne!(updated.node.etag, created.node.etag);

    let stale = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/log.md".to_string(),
                content: "gamma".to_string(),
                expected_etag: Some("stale".to_string()),
                separator: None,
                metadata_json: None,
                kind: None,
            },
            12,
        )
        .expect_err("stale append should fail");
    assert!(stale.contains("expected_etag"));
}

#[test]
fn append_node_preserves_existing_kind_and_metadata() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Sources/log/log.md", 9);

    let created = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/log/log.md".to_string(),
                content: "alpha".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: Some("{\"v\":1}".to_string()),
                kind: Some(NodeKind::Source),
            },
            10,
        )
        .expect("append create should succeed");

    let _updated = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/log/log.md".to_string(),
                content: "beta".to_string(),
                expected_etag: Some(created.node.etag),
                separator: Some("\n".to_string()),
                metadata_json: Some("{\"v\":2}".to_string()),
                kind: Some(NodeKind::File),
            },
            11,
        )
        .expect("append update should succeed");

    let current = store
        .read_node("/Sources/log/log.md")
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(current.kind, NodeKind::Source);
    assert_eq!(current.metadata_json, "{\"v\":1}");
    assert_eq!(current.content, "alpha\nbeta");
}

#[test]
fn link_index_tracks_write_edit_append_delete_and_move() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/topic/source.md", 9);
    ensure_parent_folders(&store, "/Knowledge/moved/source.md", 9);

    let created = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic/source.md".to_string(),
                content: "[Alpha](../alpha.md \"Alpha title\") [Paren](../paren.md (Paren title)) [After](../after.md) [[/Knowledge/beta.md]] [[Project \"Alpha\".md]] [[Project (Alpha).md]] [External](https://example.com) [Custom](web+foo:bar) [Git](git+ssh://example/repo) [Urn](urn:isbn:123) [Anchor](#top)".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("append create should succeed");
    assert_eq!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/alpha.md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")
            .len(),
        1
    );
    assert_eq!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/alpha.md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")[0]
            .raw_href,
        "../alpha.md \"Alpha title\""
    );
    assert_eq!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/paren.md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")[0]
            .raw_href,
        "../paren.md (Paren title)"
    );
    assert_eq!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/after.md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")
            .len(),
        1
    );
    assert_eq!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic/Project \"Alpha\".md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")
            .len(),
        1
    );
    assert_eq!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic/Project (Alpha).md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")
            .len(),
        1
    );
    assert_eq!(
        store
            .outgoing_links(OutgoingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic/source.md".to_string(),
                limit: 10,
            })
            .expect("outgoing should load")
            .len(),
        6
    );

    let edited = store
        .edit_node(
            EditNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic/source.md".to_string(),
                old_text: "../alpha.md \"Alpha title\"".to_string(),
                new_text: "../gamma.md?view=raw#section \"Gamma title\"".to_string(),
                expected_etag: Some(created.node.etag.clone()),
                replace_all: false,
            },
            11,
        )
        .expect("edit should succeed");
    assert!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/alpha.md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")
            .is_empty()
    );
    assert_eq!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/gamma.md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")[0]
            .raw_href,
        "../gamma.md?view=raw#section \"Gamma title\""
    );

    let appended = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic/source.md".to_string(),
                content: "[Delta](./delta.md)".to_string(),
                expected_etag: Some(edited.node.etag.clone()),
                separator: Some("\n".to_string()),
                metadata_json: None,
                kind: None,
            },
            12,
        )
        .expect("append update should succeed");
    assert_eq!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic/delta.md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")
            .len(),
        1
    );

    let moved = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/topic/source.md".to_string(),
                to_path: "/Knowledge/moved/source.md".to_string(),
                expected_etag: Some(appended.node.etag.clone()),
                overwrite: false,
            },
            13,
        )
        .expect("move should succeed");
    assert!(
        store
            .outgoing_links(OutgoingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic/source.md".to_string(),
                limit: 10,
            })
            .expect("outgoing should load")
            .is_empty()
    );
    assert_eq!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/gamma.md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")[0]
            .source_path,
        "/Knowledge/moved/source.md"
    );

    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/moved/source.md".to_string(),
                expected_etag: Some(moved.node.etag),
                expected_folder_index_etag: None,
            },
            14,
        )
        .expect("delete should succeed");
    assert!(
        store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/gamma.md".to_string(),
                limit: 10,
            })
            .expect("incoming should load")
            .is_empty()
    );
}

#[test]
fn graph_links_respects_prefix_and_limit() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/scope/source-0.md", 9);
    ensure_parent_folders(&store, "/Knowledge/other/source.md", 19);
    for index in 0..3 {
        store
            .append_node(
                AppendNodeRequest {
                    database_id: "default".to_string(),
                    path: format!("/Knowledge/scope/source-{index}.md"),
                    content: format!("[Target](/Knowledge/target-{index}.md)"),
                    expected_etag: None,
                    separator: None,
                    metadata_json: None,
                    kind: None,
                },
                10 + index,
            )
            .expect("append create should succeed");
    }
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/other/source.md".to_string(),
                content: "[Target](/Knowledge/other-target.md)".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            20,
        )
        .expect("append create should succeed");

    let graph = store
        .graph_links(GraphLinksRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge/scope".to_string(),
            limit: 2,
        })
        .expect("graph should load");
    assert_eq!(graph.len(), 2);
    assert!(
        graph
            .iter()
            .all(|edge| edge.source_path.starts_with("/Knowledge/scope/"))
    );
}

#[test]
fn node_context_returns_node_and_indexed_links() {
    let (_dir, store) = new_store();
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/a.md".to_string(),
                content: "[B](/Knowledge/b.md)".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("a write should succeed");
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/c.md".to_string(),
                content: "[A](/Knowledge/a.md)".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("c write should succeed");

    let context = store
        .read_node_context(NodeContextRequest {
            database_id: "default".to_string(),
            path: "/Knowledge/a.md".to_string(),
            link_limit: 10,
        })
        .expect("context should load")
        .expect("node should exist");
    assert_eq!(context.node.path, "/Knowledge/a.md");
    assert_eq!(context.outgoing_links[0].target_path, "/Knowledge/b.md");
    assert_eq!(context.incoming_links[0].source_path, "/Knowledge/c.md");

    let invalid_path = store
        .read_node_context(NodeContextRequest {
            database_id: "default".to_string(),
            path: "Wiki/a.md".to_string(),
            link_limit: 10,
        })
        .expect_err("non-absolute path should fail");
    assert!(invalid_path.contains("start with"));

    let missing = store
        .read_node_context(NodeContextRequest {
            database_id: "default".to_string(),
            path: "/Knowledge/missing.md".to_string(),
            link_limit: 10,
        })
        .expect("missing context should load");
    assert!(missing.is_none());
}

#[test]
fn memory_queries_return_context_and_scope_evidence() {
    let (_dir, store) = new_store();
    for (path, content, now) in [
        (
            "/Knowledge/scope/index.md",
            "# Index\n\n- [Overview](overview.md)\n- [Alpha](alpha.md)",
            10,
        ),
        (
            "/Knowledge/scope/overview.md",
            "# Overview\n\nalpha synthesis [Raw](/Sources/a/a.md)",
            11,
        ),
        ("/Knowledge/scope/schema.md", "# Schema\n\nread-only", 12),
        (
            "/Knowledge/scope/provenance.md",
            "# Provenance\n\n[Raw](/Sources/a/a.md)",
            13,
        ),
        (
            "/Knowledge/scope/alpha.md",
            "# Alpha\n\nbeam full reset detail [Raw](/Sources/a/a.md)",
            14,
        ),
        (
            "/Knowledge/scope/topics/foo.md",
            "# Foo\n\ntopic detail",
            15,
        ),
        ("/Sources/a/a.md", "raw source", 16),
    ] {
        ensure_parent_folders(&store, path, now - 1);
        store
            .append_node(
                AppendNodeRequest {
                    database_id: "default".to_string(),
                    path: path.to_string(),
                    content: content.to_string(),
                    expected_etag: None,
                    separator: None,
                    metadata_json: None,
                    kind: Some(if path.starts_with("/Sources/") {
                        NodeKind::Source
                    } else {
                        NodeKind::File
                    }),
                },
                now,
            )
            .expect("node write should succeed");
    }

    let context = store
        .query_context(QueryContextRequest {
            database_id: "default".to_string(),
            task: "beam reset".to_string(),
            entities: vec!["alpha".to_string()],
            namespace: Some("/Knowledge/scope".to_string()),
            budget_tokens: 1_000,
            include_evidence: true,
            depth: 1,
        })
        .expect("context should load");
    assert_eq!(context.namespace, "/Knowledge/scope");
    assert!(
        context
            .nodes
            .iter()
            .any(|node| node.node.path == "/Knowledge/scope/alpha.md")
    );
    assert!(!context.search_hits.is_empty());
    assert!(!context.graph_links.is_empty());
    assert!(context.evidence.iter().any(|evidence| {
        evidence
            .refs
            .iter()
            .any(|item| item.source_path == "/Sources/a/a.md")
    }));

    let evidence = store
        .source_evidence(SourceEvidenceRequest {
            database_id: "default".to_string(),
            node_path: "/Knowledge/scope/overview.md".to_string(),
        })
        .expect("evidence should load");
    assert_eq!(evidence.node_path, "/Knowledge/scope/overview.md");
    assert!(
        evidence
            .refs
            .iter()
            .any(|item| item.source_path == "/Sources/a/a.md")
    );
    let raw_ref = evidence
        .refs
        .iter()
        .find(|item| item.source_path == "/Sources/a/a.md")
        .expect("raw source ref should exist");
    assert!(raw_ref.source_etag.is_some());
    assert!(raw_ref.source_updated_at.is_some());
    assert!(raw_ref.source_content_hash.is_some());

    let topic_evidence = store
        .source_evidence(SourceEvidenceRequest {
            database_id: "default".to_string(),
            node_path: "/Knowledge/scope/topics/foo.md".to_string(),
        })
        .expect("topic evidence should load");
    assert!(topic_evidence.refs.iter().any(|item| {
        item.via_path == "/Knowledge/scope/provenance.md" && item.source_path == "/Sources/a/a.md"
    }));

    let small_context = store
        .query_context(QueryContextRequest {
            database_id: "default".to_string(),
            task: "summary".to_string(),
            entities: Vec::new(),
            namespace: Some("/Knowledge/scope".to_string()),
            budget_tokens: 1,
            include_evidence: true,
            depth: 1,
        })
        .expect("small context should load");
    assert!(small_context.truncated);

    let invalid_depth = store.query_context(QueryContextRequest {
        database_id: "default".to_string(),
        task: "beam".to_string(),
        entities: Vec::new(),
        namespace: Some("/Knowledge/scope".to_string()),
        budget_tokens: 1_000,
        include_evidence: false,
        depth: 3,
    });
    assert_eq!(
        invalid_depth.expect_err("invalid depth should fail"),
        "depth must be 0, 1, or 2"
    );
}

#[test]
fn query_context_trims_search_hits_and_preserves_candidate_order() {
    let (_dir, store) = new_store();
    for (path, content, now) in [
        ("/Knowledge/order/index.md", "# Index", 10),
        ("/Knowledge/order/overview.md", "# Overview", 11),
        ("/Knowledge/order/schema.md", "# Schema", 12),
        (
            "/Knowledge/order/aaa.md",
            "# Aaa\n\nneedle alpha detail",
            13,
        ),
        ("/Knowledge/order/zzz.md", "# Zzz\n\nneedle zeta detail", 14),
    ] {
        ensure_parent_folders(&store, path, now - 1);
        store
            .append_node(
                AppendNodeRequest {
                    database_id: "default".to_string(),
                    path: path.to_string(),
                    content: content.to_string(),
                    expected_etag: None,
                    separator: None,
                    metadata_json: None,
                    kind: Some(NodeKind::File),
                },
                now,
            )
            .expect("node write should succeed");
    }

    let ordered = store
        .query_context(QueryContextRequest {
            database_id: "default".to_string(),
            task: "needle".to_string(),
            entities: Vec::new(),
            namespace: Some("/Knowledge/order".to_string()),
            budget_tokens: 1_000,
            include_evidence: false,
            depth: 0,
        })
        .expect("context should load");
    let ordered_paths = ordered
        .nodes
        .iter()
        .map(|context| context.node.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        &ordered_paths[..3],
        [
            "/Knowledge/order/index.md",
            "/Knowledge/order/overview.md",
            "/Knowledge/order/schema.md",
        ]
    );
    assert!(ordered_paths.contains(&"/Knowledge/order/aaa.md"));

    let (_dir, budget_store) = new_store();
    ensure_parent_folders(&budget_store, "/Knowledge/budget/long.md", 19);
    budget_store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/budget/long.md".to_string(),
                content: "# Long\n\nneedle detail that cannot fit in a one token budget"
                    .to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: Some(NodeKind::File),
            },
            20,
        )
        .expect("node write should succeed");

    let small = budget_store
        .query_context(QueryContextRequest {
            database_id: "default".to_string(),
            task: "needle".to_string(),
            entities: Vec::new(),
            namespace: Some("/Knowledge/budget".to_string()),
            budget_tokens: 1,
            include_evidence: false,
            depth: 0,
        })
        .expect("small context should load");
    assert!(small.search_hits.is_empty());
    assert_eq!(small.nodes.len(), 1);
    assert_eq!(small.nodes[0].node.path, "/Knowledge/budget/long.md");
    assert!(small.truncated);
}

#[test]
fn graph_neighborhood_returns_center_hops() {
    let (_dir, store) = new_store();
    for (path, content) in [
        ("/Knowledge/a.md", "[B](/Knowledge/b.md)"),
        ("/Knowledge/b.md", "[C](/Knowledge/c.md)"),
        ("/Knowledge/d.md", "[B](/Knowledge/b.md)"),
        ("/Knowledge/e.md", "[D](/Knowledge/d.md)"),
    ] {
        store
            .append_node(
                AppendNodeRequest {
                    database_id: "default".to_string(),
                    path: path.to_string(),
                    content: content.to_string(),
                    expected_etag: None,
                    separator: None,
                    metadata_json: None,
                    kind: None,
                },
                10,
            )
            .expect("node write should succeed");
    }

    let depth_one = store
        .graph_neighborhood(GraphNeighborhoodRequest {
            database_id: "default".to_string(),
            center_path: "/Knowledge/b.md".to_string(),
            depth: 1,
            limit: 10,
        })
        .expect("depth one should load");
    assert_eq!(depth_one.len(), 3);
    assert!(
        depth_one
            .iter()
            .any(|edge| edge.source_path == "/Knowledge/a.md"
                && edge.target_path == "/Knowledge/b.md")
    );
    assert!(
        depth_one
            .iter()
            .any(|edge| edge.source_path == "/Knowledge/b.md"
                && edge.target_path == "/Knowledge/c.md")
    );

    let depth_two = store
        .graph_neighborhood(GraphNeighborhoodRequest {
            database_id: "default".to_string(),
            center_path: "/Knowledge/b.md".to_string(),
            depth: 2,
            limit: 10,
        })
        .expect("depth two should load");
    assert!(
        depth_two
            .iter()
            .any(|edge| edge.source_path == "/Knowledge/e.md"
                && edge.target_path == "/Knowledge/d.md")
    );

    let limited = store
        .graph_neighborhood(GraphNeighborhoodRequest {
            database_id: "default".to_string(),
            center_path: "/Knowledge/b.md".to_string(),
            depth: 1,
            limit: 2,
        })
        .expect("limited graph should load");
    assert_eq!(limited.len(), 2);

    let invalid = store
        .graph_neighborhood(GraphNeighborhoodRequest {
            database_id: "default".to_string(),
            center_path: "/Knowledge/b.md".to_string(),
            depth: 3,
            limit: 10,
        })
        .expect_err("invalid depth should fail");
    assert!(invalid.contains("depth"));

    let invalid_path = store
        .graph_neighborhood(GraphNeighborhoodRequest {
            database_id: "default".to_string(),
            center_path: "Wiki/b.md".to_string(),
            depth: 1,
            limit: 10,
        })
        .expect_err("non-absolute center should fail");
    assert!(invalid_path.contains("start with"));
}

#[test]
fn edit_node_enforces_plain_text_replacement_rules() {
    let (_dir, store) = new_store();
    let created = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/edit.md".to_string(),
                content: "one two one".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("append create should succeed");

    let ambiguous = store
        .edit_node(
            EditNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/edit.md".to_string(),
                old_text: "one".to_string(),
                new_text: "three".to_string(),
                expected_etag: Some(created.node.etag.clone()),
                replace_all: false,
            },
            11,
        )
        .expect_err("ambiguous edit should fail");
    assert!(ambiguous.contains("multiple"));

    let edited = store
        .edit_node(
            EditNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/edit.md".to_string(),
                old_text: "one".to_string(),
                new_text: "three".to_string(),
                expected_etag: Some(created.node.etag.clone()),
                replace_all: true,
            },
            12,
        )
        .expect("replace_all edit should succeed");
    assert_eq!(edited.replacement_count, 2);
    assert_eq!(
        store
            .read_node("/Knowledge/edit.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "three two three"
    );

    let missing = store
        .edit_node(
            EditNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/edit.md".to_string(),
                old_text: "absent".to_string(),
                new_text: "x".to_string(),
                expected_etag: Some(edited.node.etag),
                replace_all: true,
            },
            13,
        )
        .expect_err("missing edit should fail");
    assert!(missing.contains("did not match"));
}

#[test]
fn mkdir_node_creates_folder_node() {
    let (_dir, store) = new_store();
    let mkdir = store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/folder".to_string(),
            },
            10,
        )
        .expect("mkdir should succeed");
    assert!(mkdir.created);
    let created = store
        .read_node("/Knowledge/folder")
        .expect("read should succeed")
        .expect("folder should exist");
    assert_eq!(created.kind, NodeKind::Folder);

    let invalid = store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/folder/".to_string(),
            },
            11,
        )
        .expect_err("invalid mkdir path should fail");
    assert!(invalid.contains("must not end with"));

    let conn = Connection::open(store.database_path()).expect("db should open");
    let count = conn
        .query_row("SELECT COUNT(*) FROM fs_nodes", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("count should succeed");
    assert_eq!(count, 8);

    let list = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge".to_string(),
            recursive: false,
        })
        .expect("list should succeed");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].kind, NodeEntryKind::Folder);
}

#[test]
fn move_node_renames_and_updates_search() {
    let (_dir, store) = new_store();
    let created = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/from.md".to_string(),
                content: "alpha".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("create should succeed");
    let conn = Connection::open(store.database_path()).expect("db should open");
    let before_row_id: i64 = conn
        .query_row(
            "SELECT id FROM fs_nodes WHERE path = ?1",
            ["/Knowledge/from.md"],
            |row| row.get(0),
        )
        .expect("source row id should exist");
    drop(conn);

    let moved = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/from.md".to_string(),
                to_path: "/Knowledge/to.md".to_string(),
                expected_etag: Some(created.node.etag.clone()),
                overwrite: false,
            },
            11,
        )
        .expect("move should succeed");
    assert_eq!(moved.from_path, "/Knowledge/from.md");
    assert_eq!(moved.node.path, "/Knowledge/to.md");
    assert!(!moved.overwrote);

    let old = store
        .read_node("/Knowledge/from.md")
        .expect("old read should succeed");
    assert!(old.is_none());

    let new = store
        .read_node("/Knowledge/to.md")
        .expect("new read should succeed")
        .expect("new node should exist");
    assert_eq!(new.content, "alpha");

    let conn = Connection::open(store.database_path()).expect("db should open");
    let current_row_id: i64 = conn
        .query_row(
            "SELECT id FROM fs_nodes WHERE path = ?1",
            ["/Knowledge/to.md"],
            |row| row.get(0),
        )
        .expect("moved row id should exist");
    assert_eq!(current_row_id, before_row_id);

    let hits = store
        .search_nodes(vfs_types::SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alpha".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "/Knowledge/to.md");

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "TO".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 5,
            preview_mode: None,
        })
        .expect("path search should succeed");
    assert_eq!(path_hits.len(), 1);
    assert_eq!(path_hits[0].path, "/Knowledge/to.md");
}

#[test]
fn move_node_rejects_protected_root_folders() {
    let (_dir, store) = new_store();
    for path in [
        "/Memory",
        "/Sessions",
        "/Knowledge",
        "/Skills",
        "/Sources",
        "/Sources/sessions",
        "/Sources/skill-runs",
    ] {
        let node = store
            .read_node(path)
            .expect("read should succeed")
            .expect("protected root should exist");
        let error = store
            .move_node(
                MoveNodeRequest {
                    database_id: "default".to_string(),
                    from_path: path.to_string(),
                    to_path: format!("{path}-renamed"),
                    expected_etag: Some(node.etag),
                    overwrite: false,
                },
                11,
            )
            .expect_err("protected root move should fail");
        assert!(error.contains("cannot move protected folder"));
    }
}

#[test]
fn delete_node_rejects_empty_protected_root_folders() {
    let (_dir, store) = new_store();
    for path in [
        "/Memory",
        "/Sessions",
        "/Knowledge",
        "/Skills",
        "/Sources/sessions",
        "/Sources/skill-runs",
    ] {
        let node = store
            .read_node(path)
            .expect("read should succeed")
            .expect("protected root should exist");
        let error = store
            .delete_node(
                DeleteNodeRequest {
                    database_id: "default".to_string(),
                    path: path.to_string(),
                    expected_etag: Some(node.etag),
                    expected_folder_index_etag: None,
                },
                12,
            )
            .expect_err("protected root delete should fail");
        assert!(error.contains("cannot delete protected folder"));
    }
}

#[test]
fn move_node_moves_non_root_folder_subtree() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/work/item.md", 9);
    ensure_parent_folders(&store, "/Knowledge/archive/item.md", 9);
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/work/item.md".to_string(),
                content: "alpha".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("child create should succeed");
    let folder = store
        .read_node("/Knowledge/work")
        .expect("read should succeed")
        .expect("folder should exist");

    let moved = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/work".to_string(),
                to_path: "/Knowledge/archive/work".to_string(),
                expected_etag: Some(folder.etag),
                overwrite: false,
            },
            11,
        )
        .expect("folder move should succeed");

    assert_eq!(moved.node.path, "/Knowledge/archive/work");
    assert!(
        store
            .read_node("/Knowledge/work")
            .expect("read should succeed")
            .is_none()
    );
    assert_eq!(
        store
            .read_node("/Knowledge/archive/work/item.md")
            .expect("read should succeed")
            .expect("moved child should exist")
            .content,
        "alpha"
    );
}

#[test]
fn folder_move_collision_fails_without_partial_updates() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/work/item.md", 9);
    let _source_child = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/work/item.md".to_string(),
                content: "source child".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("source child should create");
    ensure_parent_folders(&store, "/Knowledge/archive/work/item.md", 10);
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/archive/work/item.md".to_string(),
                content: "target child".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("target child should create");
    let folder = store
        .read_node("/Knowledge/work")
        .expect("folder read should succeed")
        .expect("folder should exist");

    let error = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/work".to_string(),
                to_path: "/Knowledge/archive/work".to_string(),
                expected_etag: Some(folder.etag),
                overwrite: false,
            },
            12,
        )
        .expect_err("folder move collision should fail");

    assert!(error.contains("target node already exists"));
    assert_eq!(
        store
            .read_node("/Knowledge/work/item.md")
            .expect("old child read should succeed")
            .expect("old child should remain")
            .content,
        "source child"
    );
    assert_eq!(
        store
            .read_node("/Knowledge/archive/work/item.md")
            .expect("target child read should succeed")
            .expect("target child should remain")
            .content,
        "target child"
    );
}

#[test]
fn move_node_overwrite_replaces_live_target() {
    let (_dir, store) = new_store();
    let source = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/from.md".to_string(),
                content: "source".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("source create should succeed");
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/to.md".to_string(),
                content: "target".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("target create should succeed");

    let moved = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/from.md".to_string(),
                to_path: "/Knowledge/to.md".to_string(),
                expected_etag: Some(source.node.etag),
                overwrite: true,
            },
            12,
        )
        .expect("move should succeed");

    assert!(moved.overwrote);
    assert_eq!(moved.node.path, "/Knowledge/to.md");
    assert!(
        store
            .read_node("/Knowledge/from.md")
            .expect("read should succeed")
            .is_none()
    );
    assert_eq!(
        store
            .read_node("/Knowledge/to.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "source"
    );
}

#[test]
fn move_node_overwrite_reuses_deleted_target_path() {
    let (_dir, store) = new_store();
    let source = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/from.md".to_string(),
                content: "source".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("source create should succeed");
    let target = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/to.md".to_string(),
                content: "target".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("target create should succeed");
    store
        .delete_node(
            vfs_types::DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/to.md".to_string(),
                expected_etag: Some(target.node.etag),
                expected_folder_index_etag: None,
            },
            12,
        )
        .expect("delete should succeed");

    let moved = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/from.md".to_string(),
                to_path: "/Knowledge/to.md".to_string(),
                expected_etag: Some(source.node.etag),
                overwrite: true,
            },
            13,
        )
        .expect("move should succeed");

    assert!(!moved.overwrote);
    assert_eq!(
        store
            .read_node("/Knowledge/to.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "source"
    );
}

#[test]
fn glob_nodes_matches_files_and_virtual_directories() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/nested/deep.md", 10);
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/root.md".to_string(),
                content: "root".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("root create should succeed");
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/nested/deep.md".to_string(),
                content: "deep".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("nested create should succeed");

    let direct_files = store
        .glob_nodes(GlobNodesRequest {
            database_id: "default".to_string(),
            pattern: "*.md".to_string(),
            path: Some("/Knowledge".to_string()),
            node_type: Some(GlobNodeType::File),
        })
        .expect("direct glob should succeed");
    assert_eq!(direct_files.len(), 1);
    assert_eq!(direct_files[0].path, "/Knowledge/root.md");

    let nested_files = store
        .glob_nodes(GlobNodesRequest {
            database_id: "default".to_string(),
            pattern: "**/*.md".to_string(),
            path: Some("/Knowledge".to_string()),
            node_type: Some(GlobNodeType::File),
        })
        .expect("nested glob should succeed");
    assert_eq!(nested_files.len(), 2);

    let directories = store
        .glob_nodes(GlobNodesRequest {
            database_id: "default".to_string(),
            pattern: "**".to_string(),
            path: Some("/Knowledge".to_string()),
            node_type: Some(GlobNodeType::Directory),
        })
        .expect("directory glob should succeed");
    assert!(
        directories
            .iter()
            .any(|hit| hit.path == "/Knowledge/nested" && hit.kind == NodeEntryKind::Folder)
    );
}

#[test]
fn list_and_glob_do_not_depend_on_large_content_loading() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/nested/child.md", 10);
    let large = "x".repeat(128 * 1024);
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/large.md".to_string(),
                content: large,
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("large create should succeed");
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/nested/child.md".to_string(),
                content: "child".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("nested create should succeed");

    let list = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge".to_string(),
            recursive: false,
        })
        .expect("list should succeed");
    assert!(list.iter().any(|entry| entry.path == "/Knowledge/large.md"));
    assert!(list.iter().any(|entry| entry.path == "/Knowledge/nested"));

    let glob = store
        .glob_nodes(GlobNodesRequest {
            database_id: "default".to_string(),
            pattern: "**/*.md".to_string(),
            path: Some("/Knowledge".to_string()),
            node_type: Some(GlobNodeType::File),
        })
        .expect("glob should succeed");
    assert!(glob.iter().any(|hit| hit.path == "/Knowledge/large.md"));
    assert!(
        glob.iter()
            .any(|hit| hit.path == "/Knowledge/nested/child.md")
    );
}

#[test]
fn glob_nodes_rejects_overlong_patterns() {
    let (_dir, store) = new_store();
    let error = store
        .glob_nodes(GlobNodesRequest {
            database_id: "default".to_string(),
            pattern: "*".repeat(513),
            path: Some("/Knowledge".to_string()),
            node_type: Some(GlobNodeType::Any),
        })
        .expect_err("glob should reject long pattern");
    assert!(error.contains("pattern is too long"));
}

#[test]
fn glob_nodes_tolerates_existing_paths_longer_than_previous_match_limit() {
    let (_dir, store) = new_store();
    let long_segment = "a".repeat(4097);
    let long_path = format!("/Knowledge/{long_segment}.md");
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: long_path,
                content: "long".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("long path create should succeed");
    store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/short.md".to_string(),
                content: "short".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            11,
        )
        .expect("short path create should succeed");

    let hits = store
        .glob_nodes(GlobNodesRequest {
            database_id: "default".to_string(),
            pattern: "*.md".to_string(),
            path: Some("/Knowledge".to_string()),
            node_type: Some(GlobNodeType::File),
        })
        .expect("glob should succeed even with long stored paths");
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().any(|hit| hit.path == "/Knowledge/short.md"));
}

#[test]
fn multi_edit_node_is_atomic() {
    let (_dir, store) = new_store();
    let created = store
        .append_node(
            AppendNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/multi.md".to_string(),
                content: "alpha beta gamma".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            10,
        )
        .expect("create should succeed");

    let updated = store
        .multi_edit_node(
            MultiEditNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/multi.md".to_string(),
                edits: vec![
                    MultiEdit {
                        old_text: "alpha".to_string(),
                        new_text: "one".to_string(),
                    },
                    MultiEdit {
                        old_text: "gamma".to_string(),
                        new_text: "three".to_string(),
                    },
                ],
                expected_etag: Some(created.node.etag.clone()),
            },
            11,
        )
        .expect("multi edit should succeed");
    assert_eq!(updated.replacement_count, 2);
    assert_eq!(
        store
            .read_node("/Knowledge/multi.md")
            .expect("read should succeed")
            .expect("node should exist")
            .content,
        "one beta three"
    );

    let failed = store
        .multi_edit_node(
            MultiEditNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/multi.md".to_string(),
                edits: vec![
                    MultiEdit {
                        old_text: "one".to_string(),
                        new_text: "uno".to_string(),
                    },
                    MultiEdit {
                        old_text: "missing".to_string(),
                        new_text: "x".to_string(),
                    },
                ],
                expected_etag: Some(updated.node.etag.clone()),
            },
            12,
        )
        .expect_err("multi edit should rollback on missing text");
    assert!(failed.contains("did not match"));

    let current = store
        .read_node("/Knowledge/multi.md")
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(current.content, "one beta three");
    assert_eq!(current.etag, updated.node.etag);
}

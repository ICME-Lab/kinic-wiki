mod common;
use common::{new_store, write_file};
use vfs_types::*;

fn item(path: &str, content: &str, etag: Option<String>) -> WriteNodeItem {
    WriteNodeItem {
        path: path.into(),
        kind: NodeKind::File,
        content: content.into(),
        metadata_json: r#"{"authority":"agent"}"#.into(),
        expected_etag: etag,
    }
}
fn request(targets: Vec<WriteNodeItem>, evidence: Vec<RevisionRef>) -> LearningPublicationRequest {
    LearningPublicationRequest {
        scope_guards: vec![],
        database_id: "default".into(),
        operation_id: "operation-1".into(),
        targets,
        evidence,
    }
}
#[test]
fn identities_survive_move_and_history_survives_delete_and_recreation() {
    let (_dir, store) = new_store();
    let etag = write_file(&store, "/Knowledge/one.md", None, 1);
    let first = store
        .current_node_revision("/Knowledge/one.md")
        .unwrap()
        .unwrap();
    store
        .move_node(
            MoveNodeRequest {
                database_id: "default".into(),
                from_path: "/Knowledge/one.md".into(),
                to_path: "/Knowledge/two.md".into(),
                expected_etag: Some(etag),
                overwrite: false,
                expected_target_etag: None,
            },
            2,
        )
        .unwrap();
    let moved = store
        .current_node_revision("/Knowledge/two.md")
        .unwrap()
        .unwrap();
    assert_eq!(moved.node_id, first.node_id);
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/two.md".into(),
                expected_etag: Some(moved.node.etag),
                expected_folder_index_etag: None,
            },
            3,
        )
        .unwrap();
    write_file(&store, "/Knowledge/two.md", None, 4);
    let recreated = store
        .current_node_revision("/Knowledge/two.md")
        .unwrap()
        .unwrap();
    assert_ne!(recreated.node_id, first.node_id);
    let history = store
        .node_history(NodeHistoryRequest {
            database_id: "default".into(),
            node_id: first.node_id,
            before_revision: None,
            limit: 100,
        })
        .unwrap();
    assert_eq!(history.revisions.len(), 3);
    assert!(history.revisions[0].deleted);
    assert_eq!(history.revisions[2].node.path, "/Knowledge/one.md");
}
#[test]
fn learning_publication_is_atomic_guarded_and_idempotent() {
    let (_dir, store) = new_store();
    write_file(&store, "/Sources/evidence.md", None, 1);
    let evidence = store
        .current_node_revision("/Sources/evidence.md")
        .unwrap()
        .unwrap();
    let guard = RevisionRef {
        path: evidence.node.path.clone(),
        node_id: evidence.node_id,
        revision: evidence.revision,
        etag: evidence.node.etag.clone(),
        content_hash: evidence.content_hash,
    };
    let publication = request(
        vec![item("/Knowledge/learned.md", "lesson", None)],
        vec![guard],
    );
    let result = store.publish_learning(publication.clone(), 2).unwrap();
    assert_eq!(
        store.publish_learning(publication.clone(), 3).unwrap(),
        result
    );
    let mut changed = publication.clone();
    changed.targets[0].content = "different".into();
    assert!(store.publish_learning(changed, 3).is_err());
    write_file(&store, "/Sources/evidence.md", Some(&evidence.node.etag), 4);
    let mut stale = publication;
    stale.operation_id = "operation-2".into();
    stale.targets[0].path = "/Knowledge/new.md".into();
    assert!(store.publish_learning(stale, 5).is_err());
    assert!(store.read_node("/Knowledge/new.md").unwrap().is_none());
    write_file(&store, "/Knowledge/human.md", None, 6);
    let human = store.read_node("/Knowledge/human.md").unwrap().unwrap();
    let mut protected = request(
        vec![
            item("/Knowledge/partial.md", "must rollback", None),
            item("/Knowledge/human.md", "overwrite", Some(human.etag)),
        ],
        vec![],
    );
    protected.operation_id = "protected".into();
    assert!(store.publish_learning(protected, 7).is_err());
    assert!(store.read_node("/Knowledge/partial.md").unwrap().is_none());
}

#[test]
fn migration_records_only_current_baseline_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.sqlite3");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(include_str!("../migrations/000_schema_migrations.sql"))
        .unwrap();
    conn.execute_batch(include_str!("../migrations/fresh_fs_schema.sql"))
        .unwrap();
    conn.execute_batch("INSERT INTO schema_migrations VALUES ('vfs_store:001_initial',0),('vfs_store:002_publication_mutation_commits',0),('vfs_store:003_fts_trigram',0); INSERT INTO fs_nodes(path,kind,content,created_at,updated_at,etag,metadata_json,name) VALUES('/Knowledge/baseline.md','file','only current content',1,99,'old-etag','{}','baseline.md');").unwrap();
    drop(conn);
    let store = vfs_store::FsStore::new(path);
    store.run_fs_migrations().unwrap();
    store.run_fs_migrations().unwrap();
    let current = store
        .current_node_revision("/Knowledge/baseline.md")
        .unwrap()
        .unwrap();
    let history = store
        .node_history(NodeHistoryRequest {
            database_id: "default".into(),
            node_id: current.node_id,
            before_revision: None,
            limit: 100,
        })
        .unwrap();
    assert_eq!(history.revisions.len(), 1);
    assert_eq!(history.revisions[0].node.content, "only current content");
    assert_eq!(history.revisions[0].node.updated_at, 99);
}

#[test]
fn history_pagination_is_exclusive_and_preserves_all_revisions() {
    let (_dir, store) = new_store();
    let mut etag = None;
    for now in 1..=5 {
        etag = Some(write_file(
            &store,
            "/Knowledge/pages.md",
            etag.as_deref(),
            now,
        ));
    }
    let current = store
        .current_node_revision("/Knowledge/pages.md")
        .unwrap()
        .unwrap();
    let mut cursor = None;
    let mut revisions = Vec::new();
    loop {
        let page = store
            .node_history(NodeHistoryRequest {
                database_id: "default".into(),
                node_id: current.node_id.clone(),
                before_revision: cursor,
                limit: 2,
            })
            .unwrap();
        revisions.extend(page.revisions.into_iter().map(|r| r.revision));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(revisions.len(), 5);
    assert!(revisions.windows(2).all(|r| r[0] > r[1]));
}

#[test]
fn publication_rejects_stale_targets_and_protected_agent_metadata() {
    let (_dir, store) = new_store();
    let initial = store
        .publish_learning(
            request(vec![item("/Knowledge/agent.md", "first", None)], vec![]),
            1,
        )
        .unwrap();
    let before = store
        .current_node_revision("/Knowledge/agent.md")
        .unwrap()
        .unwrap();
    let mut stale = request(
        vec![
            item("/Knowledge/uncommitted.md", "rollback", None),
            item("/Knowledge/agent.md", "bad", Some("stale".into())),
        ],
        vec![],
    );
    stale.operation_id = "stale-target".into();
    assert!(store.publish_learning(stale, 2).is_err());
    assert!(
        store
            .read_node("/Knowledge/uncommitted.md")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .current_node_revision("/Knowledge/agent.md")
            .unwrap()
            .unwrap(),
        before
    );
    let approved = WriteNodeRequest {
        database_id: "default".into(),
        path: "/Knowledge/agent.md".into(),
        kind: NodeKind::File,
        content: "human approved decision".into(),
        metadata_json: r#"{"authority":"agent","approved":true}"#.into(),
        expected_etag: Some(initial.nodes[0].node.etag.clone()),
    };
    let approved = store.write_node(approved, 3).unwrap();
    let mut overwrite = request(
        vec![item(
            "/Knowledge/agent.md",
            "replace approved",
            Some(approved.node.etag),
        )],
        vec![],
    );
    overwrite.operation_id = "approved".into();
    assert!(store.publish_learning(overwrite, 4).is_err());
    let mut unclassified = item("/Knowledge/unclassified.md", "cannot publish", None);
    unclassified.metadata_json = "{}".into();
    let mut unclassified = request(vec![unclassified], vec![]);
    unclassified.operation_id = "unclassified".into();
    assert!(store.publish_learning(unclassified, 4).is_err());
}

#[test]
fn history_enforces_byte_budget_without_silently_truncating_snapshots() {
    let (_dir, store) = new_store();
    let mut etag = None;
    for now in 1..=3 {
        let written = store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".into(),
                    path: "/Knowledge/large.md".into(),
                    kind: NodeKind::File,
                    content: "x".repeat(600_000),
                    metadata_json: "{}".into(),
                    expected_etag: etag,
                },
                now,
            )
            .unwrap();
        etag = Some(written.node.etag);
    }
    let current = store
        .current_node_revision("/Knowledge/large.md")
        .unwrap()
        .unwrap();
    let page = store
        .node_history(NodeHistoryRequest {
            database_id: "default".into(),
            node_id: current.node_id.clone(),
            before_revision: None,
            limit: 100,
        })
        .unwrap();
    assert_eq!(page.revisions.len(), 1);
    assert_eq!(page.revisions[0].node.content.len(), 600_000);
    assert!(page.next_cursor.is_some());
    let written = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/large.md".into(),
                kind: NodeKind::File,
                content: "x".repeat(1_100_000),
                metadata_json: "{}".into(),
                expected_etag: etag,
            },
            4,
        )
        .unwrap();
    assert!(!written.created);
    assert!(
        store
            .node_history(NodeHistoryRequest {
                database_id: "default".into(),
                node_id: current.node_id,
                before_revision: None,
                limit: 100
            })
            .unwrap_err()
            .contains("byte limit")
    );
}

#[test]
fn publication_checks_each_evidence_identity_revision_and_hash_independently() {
    let (_dir, store) = new_store();
    write_file(&store, "/Sources/snapshot.md", None, 1);
    let node = store
        .current_node_revision("/Sources/snapshot.md")
        .unwrap()
        .unwrap();
    let original = RevisionRef {
        path: node.node.path,
        node_id: node.node_id,
        revision: node.revision,
        etag: node.node.etag,
        content_hash: node.content_hash,
    };
    for field in 0..4 {
        let mut guard = original.clone();
        match field {
            0 => guard.node_id = "wrong".into(),
            1 => guard.revision += 1,
            2 => guard.etag = "wrong".into(),
            _ => guard.content_hash = "wrong".into(),
        }
        let mut guarded = request(
            vec![item("/Knowledge/rejected.md", "not valid", None)],
            vec![guard],
        );
        guarded.operation_id = format!("guard-{field}");
        assert!(store.publish_learning(guarded, 2).is_err());
        assert!(store.read_node("/Knowledge/rejected.md").unwrap().is_none());
    }
}

#[test]
fn scope_revision_tracks_body_metadata_new_paths_deletion_and_moves_out() {
    let (_dir, store) = new_store();
    let start = store.scope_revision("/Knowledge").unwrap();
    let etag = write_file(&store, "/Knowledge/scoped.md", None, 1);
    let created = store.scope_revision("/Knowledge").unwrap();
    assert!(created > start);
    let changed = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/scoped.md".into(),
                kind: NodeKind::File,
                content: "content revision 1".into(),
                metadata_json: r#"{"changed":true}"#.into(),
                expected_etag: Some(etag),
            },
            2,
        )
        .unwrap();
    let metadata = store.scope_revision("/Knowledge").unwrap();
    assert!(metadata > created);
    let etag = write_file(&store, "/Knowledge/scoped.md", Some(&changed.node.etag), 3);
    let body = store.scope_revision("/Knowledge").unwrap();
    assert!(body > metadata);
    write_file(&store, "/Sources/unrelated.md", None, 4);
    assert_eq!(store.scope_revision("/Knowledge").unwrap(), body);
    store
        .move_node(
            MoveNodeRequest {
                database_id: "default".into(),
                from_path: "/Knowledge/scoped.md".into(),
                to_path: "/Sources/moved.md".into(),
                expected_etag: Some(etag),
                overwrite: false,
                expected_target_etag: None,
            },
            5,
        )
        .unwrap();
    let moved = store.scope_revision("/Knowledge").unwrap();
    assert!(moved > body);
    assert_eq!(store.scope_revision("/Knowledge/scoped.md").unwrap(), moved);
    let etag = write_file(&store, "/Knowledge/deleted.md", None, 6);
    let before = store.scope_revision("/Knowledge").unwrap();
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".into(),
                path: "/Knowledge/deleted.md".into(),
                expected_etag: Some(etag),
                expected_folder_index_etag: None,
            },
            7,
        )
        .unwrap();
    assert!(store.scope_revision("/Knowledge").unwrap() > before);
    let all = store.scope_revision("/").unwrap();
    write_file(&store, "/Sources/another.md", None, 8);
    assert!(store.scope_revision("/").unwrap() > all);
}

#[test]
fn scope_prefixes_use_exact_case_and_path_boundaries() {
    let (_dir, store) = new_store();
    assert_eq!(store.scope_revision("/Knowledge/topic").unwrap(), 0);
    write_file(&store, "/Knowledge/topics.md", None, 1);
    write_file(&store, "/Knowledge/Topic/file.md", None, 2);
    assert_eq!(store.scope_revision("/Knowledge/topic").unwrap(), 0);
    write_file(&store, "/Knowledge/topic/a.md", None, 3);
    let revision = store.scope_revision("/Knowledge/topic").unwrap();
    assert!(revision > 0);
    write_file(&store, "/Knowledge/topic_other/b.md", None, 4);
    assert_eq!(store.scope_revision("/Knowledge/topic").unwrap(), revision);
    assert_eq!(store.scope_revision("/Knowledge/%").unwrap(), 0);
    assert!(store.scope_revision("/Knowledge/../Sources").is_err());
}

#[test]
fn publication_rejects_stale_or_forbidden_scopes_and_keeps_retry_idempotent() {
    let (_dir, store) = new_store();
    let revision = store.scope_revision("/Knowledge").unwrap();
    let mut guarded = request(
        vec![item("/Knowledge/new.md", "evaluated lesson", None)],
        vec![],
    );
    guarded.scope_guards = vec![ScopeRevisionGuard {
        prefix: "/Knowledge".into(),
        revision,
    }];
    write_file(&store, "/Knowledge/changes-retrieval.md", None, 1);
    assert!(store.publish_learning(guarded.clone(), 2).is_err());
    assert!(store.read_node("/Knowledge/new.md").unwrap().is_none());
    guarded.scope_guards[0].revision = store.scope_revision("/Knowledge").unwrap();
    write_file(&store, "/Sources/own-intent.json", None, 3);
    let committed = store.publish_learning(guarded.clone(), 4).unwrap();
    assert_eq!(store.publish_learning(guarded, 5).unwrap(), committed);
    for prefix in ["/", "/Sources", "/Knowledge-other"] {
        let mut forbidden = request(
            vec![item("/Knowledge/forbidden.md", "must not publish", None)],
            vec![],
        );
        forbidden.operation_id = format!("forbidden-{prefix}");
        forbidden.scope_guards = vec![ScopeRevisionGuard {
            prefix: prefix.into(),
            revision: store.scope_revision(prefix).unwrap(),
        }];
        assert!(store.publish_learning(forbidden, 6).is_err());
    }
    let mut excessive = request(
        vec![item("/Knowledge/excess.md", "must not publish", None)],
        vec![],
    );
    excessive.operation_id = "excessive-scopes".into();
    excessive.scope_guards = vec![
        ScopeRevisionGuard {
            prefix: "/Knowledge".into(),
            revision: store.scope_revision("/Knowledge").unwrap()
        };
        11
    ];
    assert!(store.publish_learning(excessive, 7).is_err());
}

#[test]
fn guarded_publication_creates_nested_parents_only_inside_successful_transaction() {
    let (_dir, store) = new_store();
    let revision = store.scope_revision("/Knowledge").unwrap();
    let mut publication = request(
        vec![item(
            "/Knowledge/lessons/rust/new.md",
            "nested lesson",
            None,
        )],
        vec![],
    );
    publication.scope_guards = vec![ScopeRevisionGuard {
        prefix: "/Knowledge".into(),
        revision,
    }];
    store.publish_learning(publication.clone(), 1).unwrap();
    assert!(
        store
            .read_node("/Knowledge/lessons/rust/new.md")
            .unwrap()
            .is_some()
    );
    let mut stale = request(
        vec![item(
            "/Knowledge/uncommitted/parents/new.md",
            "stale lesson",
            None,
        )],
        vec![],
    );
    stale.operation_id = "stale-parents".into();
    stale.scope_guards = publication.scope_guards;
    assert!(store.publish_learning(stale, 2).is_err());
    assert!(store.read_node("/Knowledge/uncommitted").unwrap().is_none());
}

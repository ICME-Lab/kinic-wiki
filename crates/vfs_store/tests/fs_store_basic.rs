mod common;

use common::{ensure_parent_folders, new_store, write_file};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::process::{Command, Stdio};
use tempfile::{TempDir, tempdir};
use vfs_store::FsStore;
use vfs_types::{
    DeleteNodeItem, DeleteNodeRequest, ExportSnapshotRequest, FetchUpdatesRequest,
    GitRepositorySnapshot, ListChildrenRequest, ListDeletedNodesRequest, ListGitObjectsRequest,
    ListNodeHistoryRequest, ListNodesRequest, MkdirNodeRequest, MoveNodeItem, MoveNodeRequest,
    MutateNodesBatchRequest, NodeEntryKind, NodeHistoryChangeKind, NodeHistoryTarget, NodeKind,
    NodeMutation, NodeMutationErrorCode, OutgoingLinksRequest, ReadGitObjectChunkRequest,
    ReadNodeVersionRequest, RestoreNodeVersionRequest, SearchNodePathsRequest, SearchNodesRequest,
    SearchPreviewField, SearchPreviewMode, WriteNodeItem, WriteNodeRequest, WriteNodesRequest,
};

fn export_git_repository(store: &FsStore) -> (TempDir, GitRepositorySnapshot) {
    let snapshot = store
        .git_repository_snapshot()
        .expect("Git snapshot should exist");
    let output = tempdir().expect("temporary Git directory should exist");
    let init = Command::new("git")
        .args(["init", "--bare", "--object-format=sha1"])
        .arg(output.path())
        .output()
        .expect("git init should run");
    assert!(
        init.status.success(),
        "{}",
        String::from_utf8_lossy(&init.stderr)
    );

    let mut cursor = None;
    loop {
        let page = store
            .list_git_objects(ListGitObjectsRequest {
                database_id: "default".to_string(),
                snapshot_change_id: snapshot.change_id,
                cursor: cursor.clone(),
                limit: 100,
            })
            .expect("Git object list should succeed");
        for summary in page.objects {
            let mut data = Vec::new();
            let mut offset = 0;
            while offset < summary.size {
                let chunk = store
                    .read_git_object_chunk(ReadGitObjectChunkRequest {
                        database_id: "default".to_string(),
                        snapshot_change_id: snapshot.change_id,
                        oid: summary.oid.clone(),
                        offset,
                        limit: 512 * 1024,
                    })
                    .expect("Git object chunk should read")
                    .expect("Git object should exist");
                data.extend_from_slice(&chunk.data);
                offset = chunk.next_offset.unwrap_or(summary.size);
            }
            let mut child = Command::new("git")
                .arg("--git-dir")
                .arg(output.path())
                .args(["hash-object", "-w", "-t", &summary.object_type, "--stdin"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("git hash-object should start");
            child
                .stdin
                .take()
                .expect("stdin should exist")
                .write_all(&data)
                .unwrap();
            let hashed = child
                .wait_with_output()
                .expect("git hash-object should finish");
            assert!(hashed.status.success());
            assert_eq!(String::from_utf8_lossy(&hashed.stdout).trim(), summary.oid);
        }
        let Some(next) = page.next_cursor else { break };
        cursor = Some(next);
    }
    std::fs::write(output.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::create_dir_all(output.path().join("refs/heads")).unwrap();
    std::fs::write(
        output.path().join("refs/heads/main"),
        format!("{}\n", snapshot.head_commit_oid),
    )
    .unwrap();
    let fsck = Command::new("git")
        .arg("--git-dir")
        .arg(output.path())
        .args(["fsck", "--full"])
        .output()
        .expect("git fsck should run");
    assert!(
        fsck.status.success(),
        "{}",
        String::from_utf8_lossy(&fsck.stderr)
    );
    (output, snapshot)
}

#[test]
fn git_objects_export_to_a_repository_accepted_by_git() {
    let (_dir, store) = new_store();
    write_file(&store, "/Knowledge/git.md", None, 10);
    let (output, snapshot) = export_git_repository(&store);
    assert_eq!(snapshot.object_format, "sha1");
    let tree = Command::new("git")
        .arg("--git-dir")
        .arg(output.path())
        .args(["ls-tree", "-r", "HEAD"])
        .output()
        .expect("git ls-tree should run");
    let tree = String::from_utf8(tree.stdout).unwrap();
    assert!(tree.contains("Knowledge/git.md"));
    assert!(tree.contains(".kinic/format.json"));
    assert!(tree.contains(".kinic/pages/"));
    let log = Command::new("git")
        .arg("--git-dir")
        .arg(output.path())
        .args(["log", "--format=%H"])
        .output()
        .expect("git log should run");
    assert!(
        log.status.success(),
        "{}",
        String::from_utf8_lossy(&log.stderr)
    );
    assert!(String::from_utf8_lossy(&log.stdout).contains(&snapshot.head_commit_oid));
    let checkout = tempdir().expect("checkout directory should exist");
    let checked_out = Command::new("git")
        .arg("--git-dir")
        .arg(output.path())
        .arg("--work-tree")
        .arg(checkout.path())
        .args(["checkout", "HEAD", "--", "."])
        .output()
        .expect("checkout from the bare repository should run");
    assert!(
        checked_out.status.success(),
        "{}",
        String::from_utf8_lossy(&checked_out.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(checkout.path().join("Knowledge/git.md")).unwrap(),
        "content revision 10"
    );
}

#[test]
fn git_object_queries_pin_objects_to_the_requested_snapshot() {
    let (_dir, store) = new_store();
    write_file(&store, "/Knowledge/first.md", None, 10);
    let first = store.git_repository_snapshot().unwrap();
    write_file(&store, "/Knowledge/second.md", None, 20);
    let second = store.git_repository_snapshot().unwrap();
    assert!(second.change_id > first.change_id);

    let previous = store
        .list_git_objects(ListGitObjectsRequest {
            database_id: "default".to_string(),
            snapshot_change_id: first.change_id,
            cursor: None,
            limit: 100,
        })
        .unwrap();
    let current = store
        .list_git_objects(ListGitObjectsRequest {
            database_id: "default".to_string(),
            snapshot_change_id: second.change_id,
            cursor: None,
            limit: 100,
        })
        .unwrap();
    let new_object = current
        .objects
        .iter()
        .find(|object| !previous.objects.iter().any(|old| old.oid == object.oid))
        .expect("the second write should create a new object");
    assert!(
        store
            .read_git_object_chunk(ReadGitObjectChunkRequest {
                database_id: "default".to_string(),
                snapshot_change_id: first.change_id,
                oid: new_object.oid.clone(),
                offset: 0,
                limit: 1,
            })
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .list_git_objects(ListGitObjectsRequest {
                database_id: "default".to_string(),
                snapshot_change_id: second.change_id + 1,
                cursor: None,
                limit: 100,
            })
            .is_err()
    );
    assert!(
        store
            .list_git_objects(ListGitObjectsRequest {
                database_id: "default".to_string(),
                snapshot_change_id: second.change_id,
                cursor: Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string()),
                limit: 100,
            })
            .is_err()
    );
}

#[test]
fn git_reserved_top_level_names_are_rejected_case_insensitively() {
    let (_dir, store) = new_store();
    for path in ["/.git/config", "/.KINIC/pages/example.json"] {
        let error = store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: "reserved".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                10,
            )
            .expect_err("reserved Git paths should not be writable");
        assert!(error.message.contains("reserved"), "{}", error.message);
    }
}

#[test]
fn git_finalize_failures_roll_back_vfs_history_objects_and_ref() {
    let (_dir, store) = new_store();
    let initial = store.git_repository_snapshot().unwrap();
    let initial_objects = store
        .list_git_objects(ListGitObjectsRequest {
            database_id: "default".to_string(),
            snapshot_change_id: initial.change_id,
            cursor: None,
            limit: 100,
        })
        .unwrap()
        .objects
        .len();
    for stage in 1..=4 {
        vfs_store::set_git_finalize_failpoint_for_test(stage);
        let path = format!("/fail-{stage}.md");
        let error = store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: path.clone(),
                    kind: NodeKind::File,
                    content: format!("failure stage {stage}"),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                stage as i64,
            )
            .expect_err("the injected finalize failure should abort the mutation");
        assert!(error.message.contains("injected Git finalize failure"));
        assert!(store.read_node(&path).unwrap().is_none());
        let current = store.git_repository_snapshot().unwrap();
        assert_eq!(current.head_commit_oid, initial.head_commit_oid);
        assert_eq!(current.change_id, initial.change_id);
        assert_eq!(
            store
                .list_git_objects(ListGitObjectsRequest {
                    database_id: "default".to_string(),
                    snapshot_change_id: current.change_id,
                    cursor: None,
                    limit: 100,
                })
                .unwrap()
                .objects
                .len(),
            initial_objects
        );
    }
}

#[test]
fn git_mutation_limits_reject_oversized_and_101_node_changes_atomically() {
    let (_dir, store) = new_store();
    let oversized = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/oversized.md".to_string(),
                kind: NodeKind::File,
                content: "x".repeat(1_537_000),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect_err("a mutation above 1.5 MiB should fail");
    assert!(oversized.message.contains("1.5 MiB"));
    assert!(store.read_node("/oversized.md").unwrap().is_none());

    let batch_oversized = store
        .mutate_nodes_batch(
            MutateNodesBatchRequest {
                database_id: "default".to_string(),
                operations: vec![
                    NodeMutation::Write(WriteNodeItem {
                        path: "/batch-oversized-a.md".to_string(),
                        kind: NodeKind::File,
                        content: "a".repeat(800 * 1024),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    }),
                    NodeMutation::Write(WriteNodeItem {
                        path: "/batch-oversized-b.md".to_string(),
                        kind: NodeKind::File,
                        content: "b".repeat(800 * 1024),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    }),
                ],
            },
            15,
        )
        .expect_err("a batch above 1.5 MiB should fail before applying writes");
    assert!(batch_oversized.message.contains("1.5 MiB"));
    assert!(store.read_node("/batch-oversized-a.md").unwrap().is_none());
    assert!(store.read_node("/batch-oversized-b.md").unwrap().is_none());

    let nodes = (0..101)
        .map(|index| WriteNodeItem {
            path: format!("/bulk-{index:03}.md"),
            kind: NodeKind::File,
            content: "small".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .collect();
    let too_many = store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes,
            },
            20,
        )
        .expect_err("a mutation affecting 101 nodes should fail");
    assert!(too_many.message.contains("100"), "{}", too_many.message);
    assert!(store.read_node("/bulk-000.md").unwrap().is_none());
    assert!(store.read_node("/bulk-100.md").unwrap().is_none());
}

fn moved_node_etag(path: &str, content: &str, metadata_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{path}\nfile\n{content}\n{metadata_json}"));
    let digest = hasher.finalize();
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("v4h:{hex}")
}

#[test]
fn git_batch_resolves_blob_oids_for_sequential_moves() {
    let (_dir, store) = new_store();
    let original = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/batch-move.md".to_string(),
                kind: NodeKind::File,
                content: "batch content".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("fixture should write");
    let first_path = "/Knowledge/batch-move-one.md";
    let second_path = "/Knowledge/batch-move-two.md";
    let first_etag = moved_node_etag(first_path, "batch content", "{}");
    let before = store.git_repository_snapshot().unwrap();

    store
        .mutate_nodes_batch(
            MutateNodesBatchRequest {
                database_id: "default".to_string(),
                operations: vec![
                    NodeMutation::Move(MoveNodeItem {
                        from_path: "/Knowledge/batch-move.md".to_string(),
                        to_path: first_path.to_string(),
                        expected_etag: Some(original.node.etag),
                        expected_target_etag: None,
                        overwrite: false,
                    }),
                    NodeMutation::Move(MoveNodeItem {
                        from_path: first_path.to_string(),
                        to_path: second_path.to_string(),
                        expected_etag: Some(first_etag),
                        expected_target_etag: None,
                        overwrite: false,
                    }),
                ],
            },
            20,
        )
        .expect("sequential moves should commit as one mutation");

    let after = store.git_repository_snapshot().unwrap();
    assert_eq!(after.change_id, before.change_id + 1);
    let history = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "default".to_string(),
            target: NodeHistoryTarget::CurrentPath(second_path.to_string()),
            cursor: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(history.entries.len(), 3);
    let baseline_oid = history.entries[2]
        .after_version
        .as_ref()
        .map(|version| version.blob_oid.clone())
        .expect("baseline blob OID should exist");
    for entry in history.entries.iter().take(2) {
        assert_eq!(
            entry.before_version.as_ref().unwrap().blob_oid,
            baseline_oid
        );
        assert_eq!(entry.after_version.as_ref().unwrap().blob_oid, baseline_oid);
    }
}

#[test]
fn git_same_content_update_reuses_the_existing_blob_object() {
    let (_dir, store) = new_store();
    let original = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/reuse.md".to_string(),
                kind: NodeKind::File,
                content: "same content".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("fixture should write");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/reuse.md".to_string(),
                kind: NodeKind::File,
                content: "same content".to_string(),
                metadata_json: "{\"title\":\"updated\"}".to_string(),
                expected_etag: Some(original.node.etag),
            },
            20,
        )
        .expect("metadata-only update should commit");

    let history = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "default".to_string(),
            target: NodeHistoryTarget::CurrentPath("/Knowledge/reuse.md".to_string()),
            cursor: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(history.entries.len(), 2);
    assert_eq!(
        history.entries[0].after_version.as_ref().unwrap().blob_oid,
        history.entries[1].after_version.as_ref().unwrap().blob_oid
    );
    let connection = Connection::open(store.database_path()).unwrap();
    let content_blob_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM git_objects
             WHERE object_type = 'blob' AND data = CAST(?1 AS BLOB)",
            ["same content"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(content_blob_count, 1);
}

#[test]
fn git_folder_move_rejects_more_than_100_nodes_before_rewriting_paths() {
    let (_dir, store) = new_store();
    let nodes = (0..100)
        .map(|index| WriteNodeItem {
            path: format!("/Knowledge/large-folder/file-{index:03}.md"),
            kind: NodeKind::File,
            content: "small".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .collect();
    ensure_parent_folders(&store, "/Knowledge/large-folder/file-000.md", 9);
    store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes,
            },
            10,
        )
        .expect("first 100 children should commit");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/large-folder/file-100.md".to_string(),
                kind: NodeKind::File,
                content: "small".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            20,
        )
        .expect("the 101st child should commit separately");
    let folder = store
        .read_node("/Knowledge/large-folder")
        .unwrap()
        .expect("folder should exist");
    let before = store.git_repository_snapshot().unwrap();

    let error = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/large-folder".to_string(),
                to_path: "/Knowledge/large-folder-moved".to_string(),
                expected_etag: Some(folder.etag),
                expected_target_etag: None,
                overwrite: false,
            },
            30,
        )
        .expect_err("folder move above the node limit should fail");
    assert!(error.message.contains("100"), "{}", error.message);
    assert_eq!(store.git_repository_snapshot().unwrap(), before);
    assert!(
        store
            .read_node("/Knowledge/large-folder")
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .read_node("/Knowledge/large-folder-moved")
            .unwrap()
            .is_none()
    );
}

#[test]
fn git_folder_move_reuses_large_content_blobs_without_counting_them_again() {
    let (_dir, store) = new_store();
    let content = "x".repeat(800 * 1024);
    for (index, now) in [10, 20].into_iter().enumerate() {
        let path = format!("/Knowledge/large-move/file-{index}.md");
        ensure_parent_folders(&store, &path, now - 1);
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path,
                    kind: NodeKind::File,
                    content: content.clone(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                now,
            )
            .expect("each large file should fit in its own mutation");
    }
    ensure_parent_folders(&store, "/Knowledge/archive/placeholder", 29);
    let folder = store
        .read_node("/Knowledge/large-move")
        .unwrap()
        .expect("source folder should exist");
    let before = store.git_repository_snapshot().unwrap();

    store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/large-move".to_string(),
                to_path: "/Knowledge/archive/large-move".to_string(),
                expected_etag: Some(folder.etag),
                expected_target_etag: None,
                overwrite: false,
            },
            30,
        )
        .expect("moving unchanged content should not consume the content byte budget");

    let after = store.git_repository_snapshot().unwrap();
    assert_eq!(after.change_id, before.change_id + 1);
    let moved_path = "/Knowledge/archive/large-move/file-0.md";
    assert_eq!(
        store.read_node(moved_path).unwrap().unwrap().content,
        content
    );
    let history = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "default".to_string(),
            target: NodeHistoryTarget::CurrentPath(moved_path.to_string()),
            cursor: None,
            limit: 2,
        })
        .expect("moved file history should load");
    let moved = &history.entries[0];
    assert_eq!(moved.change_kind, NodeHistoryChangeKind::Move);
    assert_eq!(
        moved.before_version.as_ref().unwrap().blob_oid,
        moved.after_version.as_ref().unwrap().blob_oid
    );

    let file_paths = [
        "/Knowledge/archive/large-move/file-0.md",
        "/Knowledge/archive/large-move/file-1.md",
    ];
    let mut delete_operations = file_paths
        .iter()
        .map(|path| {
            let node = store.read_node(path).unwrap().unwrap();
            NodeMutation::Delete(DeleteNodeItem {
                path: (*path).to_string(),
                expected_etag: Some(node.etag),
                expected_folder_index_etag: None,
            })
        })
        .collect::<Vec<_>>();
    let moved_folder = store
        .read_node("/Knowledge/archive/large-move")
        .unwrap()
        .unwrap();
    delete_operations.push(NodeMutation::Delete(DeleteNodeItem {
        path: moved_folder.path,
        expected_etag: Some(moved_folder.etag),
        expected_folder_index_etag: None,
    }));
    store
        .mutate_nodes_batch(
            MutateNodesBatchRequest {
                database_id: "default".to_string(),
                operations: delete_operations,
            },
            40,
        )
        .expect("deleting unchanged large content should not consume the content byte budget");
    for path in file_paths {
        assert!(store.read_node(path).unwrap().is_none());
    }
    assert!(
        store
            .read_node("/Knowledge/archive/large-move")
            .unwrap()
            .is_none()
    );
}

#[test]
fn git_move_without_a_previous_blob_oid_rolls_back_the_mutation() {
    let (_dir, store) = new_store();
    let etag = write_file(&store, "/Knowledge/missing-oid.md", None, 10);
    let before = store.git_repository_snapshot().unwrap();
    let before_history = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "default".to_string(),
            target: NodeHistoryTarget::CurrentPath("/Knowledge/missing-oid.md".to_string()),
            cursor: None,
            limit: 100,
        })
        .unwrap();
    let connection = Connection::open(store.database_path()).unwrap();
    connection
        .execute(
            "UPDATE fs_history_versions SET git_blob_oid = NULL
             WHERE id = (
                 SELECT current_version_id FROM fs_history_pages
                 WHERE current_path = '/Knowledge/missing-oid.md'
             )",
            [],
        )
        .unwrap();
    drop(connection);

    let error = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/missing-oid.md".to_string(),
                to_path: "/Knowledge/moved.md".to_string(),
                expected_etag: Some(etag),
                expected_target_etag: None,
                overwrite: false,
            },
            20,
        )
        .expect_err("move must fail instead of re-reading content when the blob OID is missing");
    assert!(
        error.message.contains("Git blob OID is missing"),
        "{error:?}"
    );
    assert!(
        store
            .read_node("/Knowledge/missing-oid.md")
            .unwrap()
            .is_some()
    );
    assert!(store.read_node("/Knowledge/moved.md").unwrap().is_none());
    assert_eq!(store.git_repository_snapshot().unwrap(), before);
    let connection = Connection::open(store.database_path()).unwrap();
    let after_history_count = connection
        .query_row(
            "SELECT COUNT(*)
             FROM fs_history_versions version
             JOIN fs_history_pages page ON page.id = version.page_id
             WHERE page.current_path = '/Knowledge/missing-oid.md'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(after_history_count as usize, before_history.entries.len());
}

#[test]
fn git_object_payload_mismatch_rolls_back_the_mutation() {
    let (_dir, store) = new_store();
    let content = "shared collision payload";
    ensure_parent_folders(&store, "/Knowledge/collision-a.md", 9);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/collision-a.md".to_string(),
                kind: NodeKind::File,
                content: content.to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .unwrap();
    let history = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "default".to_string(),
            target: NodeHistoryTarget::CurrentPath("/Knowledge/collision-a.md".to_string()),
            cursor: None,
            limit: 1,
        })
        .unwrap();
    let content_oid = history.entries[0]
        .after_version
        .as_ref()
        .unwrap()
        .blob_oid
        .clone();
    let before = store.git_repository_snapshot().unwrap();
    let connection = Connection::open(store.database_path()).unwrap();
    connection
        .execute(
            "UPDATE git_objects SET data = ?2 WHERE oid = ?1",
            rusqlite::params![content_oid, b"corrupt".as_slice()],
        )
        .unwrap();
    drop(connection);

    let error = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/collision-b.md".to_string(),
                kind: NodeKind::File,
                content: content.to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            20,
        )
        .expect_err("a mismatched stored object must fail the entire mutation");
    assert!(error.message.contains("collision or corrupt"), "{error:?}");
    assert!(
        store
            .read_node("/Knowledge/collision-b.md")
            .unwrap()
            .is_none()
    );
    assert_eq!(store.git_repository_snapshot().unwrap(), before);
}

#[test]
fn git_v002_migration_builds_scaled_trees_and_chunks_a_large_legacy_blob() {
    let (_dir, store) = new_store();
    let mut conn = Connection::open(store.database_path()).expect("db should open");
    for trigger in [
        "fs_history_node_insert",
        "fs_history_node_update",
        "fs_history_node_delete",
    ] {
        conn.execute(&format!("DROP TRIGGER {trigger}"), [])
            .expect("history trigger should drop");
    }
    for table in [
        "git_index_entries",
        "git_refs",
        "git_objects",
        "fs_history_items",
        "fs_history_active_change",
        "fs_history_changes",
        "fs_history_versions",
        "fs_history_blobs",
        "fs_history_pages",
    ] {
        conn.execute(&format!("DROP TABLE {table}"), [])
            .expect("history table should drop");
    }
    conn.execute(
        "DELETE FROM schema_migrations WHERE version = ?1",
        ["vfs_store:003_node_history"],
    )
    .expect("v003 marker should delete");

    let transaction = conn
        .transaction()
        .expect("fixture transaction should start");
    let knowledge_id = transaction
        .query_row(
            "SELECT id FROM fs_nodes WHERE path = '/Knowledge'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("Knowledge root should exist");
    let mut next_id = transaction
        .query_row("SELECT MAX(id) + 1 FROM fs_nodes", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("next node id should load");
    let legacy_id = next_id;
    next_id += 1;
    transaction
        .execute(
            "INSERT INTO fs_nodes
                 (id, path, kind, content, created_at, updated_at, etag, metadata_json, parent_id, name)
             VALUES (?1, '/Knowledge/legacy', 'folder', '', 1, 1,
                     'legacy-root', '{}', ?2, 'legacy')",
            rusqlite::params![legacy_id, knowledge_id],
        )
        .expect("legacy root should insert");
    for index in 0..128 {
        let branch_id = next_id;
        next_id += 1;
        let branch_path = format!("/Knowledge/legacy/branch-{index:03}");
        let deep_id = next_id;
        transaction
            .execute(
                "INSERT INTO fs_nodes
                     (id, path, kind, content, created_at, updated_at, etag, metadata_json, parent_id, name)
                 VALUES (?1, ?2, 'folder', '', 1, 1, ?3, '{}', ?4, ?5)",
                rusqlite::params![
                    branch_id,
                    branch_path,
                    format!("legacy-branch-{index:03}"),
                    legacy_id,
                    format!("branch-{index:03}")
                ],
            )
            .expect("legacy branch should insert");
        transaction
            .execute(
                "INSERT INTO fs_nodes
                     (id, path, kind, content, created_at, updated_at, etag, metadata_json, parent_id, name)
                 VALUES (?1, ?2, 'folder', '', 1, 1, ?3, '{}', ?4, 'deep')",
                rusqlite::params![
                    deep_id,
                    format!("{branch_path}/deep"),
                    format!("legacy-deep-{index:03}"),
                    branch_id
                ],
            )
            .expect("legacy deep folder should insert");
        next_id += 1;
        transaction
            .execute(
                "INSERT INTO fs_nodes
                     (id, path, kind, content, created_at, updated_at, etag, metadata_json, parent_id, name)
                 VALUES (?1, ?2, 'file', 'leaf', 1, 1, ?3, '{}', ?4, 'leaf.md')",
                rusqlite::params![
                    next_id,
                    format!("{branch_path}/deep/leaf.md"),
                    format!("legacy-leaf-{index:03}"),
                    deep_id
                ],
            )
            .expect("legacy leaf should insert");
        next_id += 1;
    }
    let data = (0..1_600_000)
        .map(|index| char::from(b'a' + (index % 23) as u8))
        .collect::<String>();
    transaction
        .execute(
            "INSERT INTO fs_nodes
                 (id, path, kind, content, created_at, updated_at, etag, metadata_json, parent_id, name)
             VALUES (?1, '/Knowledge/legacy/large.md', 'file', ?2, 1, 1,
                     'legacy-large', '{}', ?3, 'large.md')",
            rusqlite::params![next_id, data, legacy_id],
        )
        .expect("large legacy file should insert");
    transaction.commit().expect("fixture should commit");
    drop(conn);

    store
        .run_fs_migrations()
        .expect("v002 fixture should migrate to v003");
    let snapshot = store.git_repository_snapshot().unwrap();
    let conn = Connection::open(store.database_path()).expect("db should reopen");
    let directory_count = conn
        .query_row(
            "SELECT COUNT(*) FROM git_index_entries
             WHERE mode = 40000
               AND (path = 'Knowledge/legacy' OR path LIKE 'Knowledge/legacy/%')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("migrated directory count should load");
    assert_eq!(directory_count, 257);
    let oid = conn
        .query_row(
            "SELECT oid FROM git_index_entries WHERE path = 'Knowledge/legacy/large.md'",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("large legacy blob oid should load");
    drop(conn);

    for (offset, limit) in [
        (0_u64, 512 * 1024),
        (512 * 1024, 512 * 1024),
        (1_599_877, 512 * 1024),
        (1_600_000, 512 * 1024),
    ] {
        let chunk = store
            .read_git_object_chunk(ReadGitObjectChunkRequest {
                database_id: "default".to_string(),
                snapshot_change_id: snapshot.change_id,
                oid: oid.clone(),
                offset,
                limit,
            })
            .unwrap()
            .expect("large legacy object should exist");
        let end = offset
            .saturating_add(u64::from(limit))
            .min(data.len() as u64);
        assert_eq!(chunk.data, data.as_bytes()[offset as usize..end as usize]);
        assert_eq!(chunk.next_offset, (end < data.len() as u64).then_some(end));
    }
    assert!(
        store
            .read_git_object_chunk(ReadGitObjectChunkRequest {
                database_id: "default".to_string(),
                snapshot_change_id: snapshot.change_id,
                oid,
                offset: data.len() as u64 + 1,
                limit: 1,
            })
            .is_err()
    );
    let (_repository, exported_snapshot) = export_git_repository(&store);
    assert_eq!(exported_snapshot.head_commit_oid, snapshot.head_commit_oid);
}

#[test]
fn node_history_tracks_authors_moves_deletes_and_restores() {
    let (_dir, store) = new_store();
    let created = store
        .write_node_with_publication_commit_as(
            WriteNodeRequest {
                database_id: "db".to_string(),
                path: "/Knowledge/history.md".to_string(),
                kind: NodeKind::File,
                content: "first\n".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
            None,
            "alice",
        )
        .expect("initial write should succeed");
    let updated = store
        .write_node_with_publication_commit_as(
            WriteNodeRequest {
                database_id: "db".to_string(),
                path: "/Knowledge/history.md".to_string(),
                kind: NodeKind::File,
                content: "second\n".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(created.node.etag),
            },
            20,
            None,
            "bob",
        )
        .expect("update should succeed");
    store
        .move_node_with_publication_commit_as(
            MoveNodeRequest {
                database_id: "db".to_string(),
                from_path: "/Knowledge/history.md".to_string(),
                to_path: "/Knowledge/moved.md".to_string(),
                expected_etag: Some(updated.node.etag),
                expected_target_etag: None,
                overwrite: false,
            },
            30,
            None,
            "carol",
        )
        .expect("move should succeed");
    let history = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "db".to_string(),
            target: NodeHistoryTarget::CurrentPath("/Knowledge/moved.md".to_string()),
            cursor: None,
            limit: 20,
        })
        .expect("history should load");
    assert_eq!(history.entries.len(), 3);
    assert_eq!(history.entries[0].author_principal, "carol");
    assert_eq!(history.entries[0].change_kind, NodeHistoryChangeKind::Move);
    assert_eq!(history.entries[1].author_principal, "bob");
    assert_eq!(history.entries[2].author_principal, "alice");
    let first_version_id = history.entries[2]
        .after_version
        .as_ref()
        .expect("create should have after version")
        .version_id;
    let first = store
        .read_node_version(ReadNodeVersionRequest {
            database_id: "db".to_string(),
            page_id: history.page_id,
            version_id: first_version_id,
        })
        .expect("version read should succeed")
        .expect("version should exist");
    assert_eq!(first.content, "first\n");

    let moved = store
        .read_node("/Knowledge/moved.md")
        .expect("current read should succeed")
        .expect("moved node should exist");
    store
        .delete_node_with_publication_commit_as(
            DeleteNodeRequest {
                database_id: "db".to_string(),
                path: moved.path,
                expected_etag: Some(moved.etag),
                expected_folder_index_etag: None,
            },
            40,
            None,
            "dave",
        )
        .expect("delete should succeed");
    let deleted = store
        .list_deleted_nodes(ListDeletedNodesRequest {
            database_id: "db".to_string(),
            cursor: None,
            limit: 20,
        })
        .expect("deleted nodes should load");
    let tombstone = deleted
        .nodes
        .iter()
        .find(|node| node.page_id == history.page_id)
        .expect("deleted page should be discoverable");
    assert_eq!(tombstone.deleted_by, "dave");
    assert_eq!(tombstone.deleted_at, 40);

    let restored = store
        .restore_node_version_as(
            RestoreNodeVersionRequest {
                database_id: "db".to_string(),
                page_id: history.page_id,
                version_id: first_version_id,
                expected_current_etag: None,
            },
            50,
            None,
            "erin",
        )
        .expect("deleted version restore should succeed");
    assert!(restored.created);
    assert_eq!(restored.node.path, "/Knowledge/history.md");
    let restored_history = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "db".to_string(),
            target: NodeHistoryTarget::PageId(history.page_id),
            cursor: None,
            limit: 20,
        })
        .expect("restored history should load");
    assert_eq!(restored_history.entries[0].author_principal, "erin");
    assert_eq!(
        restored_history.entries[0].change_kind,
        NodeHistoryChangeKind::Restore
    );
}

#[test]
fn node_history_lists_large_versions_without_losing_pagination_or_full_reads() {
    let (_dir, store) = new_store();
    let path = "/Knowledge/large-history.md";
    let mut expected_etag = None;
    let mut latest_content = String::new();
    for revision in 0..20 {
        latest_content = format!("revision {revision}\n{}", "x".repeat(256 * 1024));
        let written = store
            .write_node_with_publication_commit_as(
                WriteNodeRequest {
                    database_id: "db".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: latest_content.clone(),
                    metadata_json: format!(r#"{{"revision":{revision}}}"#),
                    expected_etag,
                },
                revision + 1,
                None,
                "writer",
            )
            .expect("large history write should succeed");
        expected_etag = Some(written.node.etag);
    }

    let first = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "db".to_string(),
            target: NodeHistoryTarget::CurrentPath(path.to_string()),
            cursor: None,
            limit: 10,
        })
        .expect("first history page should load");
    assert_eq!(first.entries.len(), 10);
    let cursor = first
        .next_cursor
        .expect("another history page should exist");
    let second = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "db".to_string(),
            target: NodeHistoryTarget::PageId(first.page_id),
            cursor: Some(cursor),
            limit: 10,
        })
        .expect("second history page should load");
    assert_eq!(second.entries.len(), 10);
    assert!(second.next_cursor.is_none());
    assert!(first.entries.iter().all(|left| {
        second
            .entries
            .iter()
            .all(|right| left.item_id != right.item_id)
    }));

    let latest_version_id = first.entries[0]
        .after_version
        .as_ref()
        .expect("latest entry should have an after version")
        .version_id;
    let latest = store
        .read_node_version(ReadNodeVersionRequest {
            database_id: "db".to_string(),
            page_id: first.page_id,
            version_id: latest_version_id,
        })
        .expect("full version read should succeed")
        .expect("latest version should exist");
    assert_eq!(latest.content, latest_content);
    assert_eq!(latest.metadata_json, r#"{"revision":19}"#);
}

#[test]
fn deleted_node_pagination_keeps_items_from_the_same_change() {
    let (_dir, store) = new_store();
    let first_etag = write_file(&store, "/Knowledge/first.md", None, 10);
    let second_etag = write_file(&store, "/Knowledge/second.md", None, 11);
    store
        .mutate_nodes_batch(
            MutateNodesBatchRequest {
                database_id: "default".to_string(),
                operations: vec![
                    NodeMutation::Delete(DeleteNodeItem {
                        path: "/Knowledge/first.md".to_string(),
                        expected_etag: Some(first_etag),
                        expected_folder_index_etag: None,
                    }),
                    NodeMutation::Delete(DeleteNodeItem {
                        path: "/Knowledge/second.md".to_string(),
                        expected_etag: Some(second_etag),
                        expected_folder_index_etag: None,
                    }),
                ],
            },
            20,
        )
        .expect("batch delete should succeed");

    let first_page = store
        .list_deleted_nodes(ListDeletedNodesRequest {
            database_id: "default".to_string(),
            cursor: None,
            limit: 1,
        })
        .expect("first deleted page should load");
    assert_eq!(first_page.nodes.len(), 1);
    let second_page = store
        .list_deleted_nodes(ListDeletedNodesRequest {
            database_id: "default".to_string(),
            cursor: first_page.next_cursor,
            limit: 1,
        })
        .expect("second deleted page should load");
    assert_eq!(second_page.nodes.len(), 1);
    assert_ne!(first_page.nodes[0].page_id, second_page.nodes[0].page_id);
    assert_eq!(second_page.next_cursor, None);
}

fn assert_v5_snapshot_revision_without_state_hash(snapshot_revision: &str) {
    let parts = snapshot_revision.split(':').collect::<Vec<_>>();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0], "v5");
    assert!(parts[1].parse::<i64>().expect("revision should parse") >= 0);
    assert!(!parts[2].is_empty());
}

#[test]
fn logical_size_bytes_rejects_missing_database_without_creating_file() {
    let dir = tempdir().expect("temp dir should exist");
    let database_path = dir.path().join("missing.sqlite3");
    let store = FsStore::new(database_path.clone());

    let error = store
        .logical_size_bytes()
        .expect_err("missing database should fail");

    assert!(!error.is_empty());
    assert!(!database_path.exists());
}

#[test]
fn source_capture_request_is_stored_as_opaque_vfs_content() {
    let (_dir, store) = new_store();
    let path = "/Sources/source-capture-requests/opaque.md";
    ensure_parent_folders(&store, path, 1);
    let content = "---\nkind: kinic.source_capture_request\noutput_language: klingon\n---\n";

    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: content.to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("VFS must not interpret source capture output_language");

    let stored = store
        .read_node(path)
        .expect("node should load")
        .expect("node should exist");
    assert_eq!(stored.content, content);
}

#[test]
fn logical_size_bytes_uses_sqlite_page_size() {
    let (_dir, store) = new_store();
    let database_path = store.database_path().to_path_buf();
    let empty_size = store
        .logical_size_bytes()
        .expect("empty logical size should load");

    assert!(empty_size > 0);
    assert_eq!(
        empty_size,
        std::fs::metadata(&database_path)
            .expect("database file should exist")
            .len()
    );

    write_file(&store, "/Knowledge/size.md", None, 10);
    let written_size = store
        .logical_size_bytes()
        .expect("written logical size should load");

    assert!(written_size >= empty_size);
    assert_eq!(
        written_size,
        std::fs::metadata(database_path)
            .expect("database file should exist")
            .len()
    );
}

#[test]
fn fs_migrations_create_tables() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    let tables = [
        "fs_nodes",
        "fs_nodes_fts",
        "fs_change_log",
        "fs_path_state",
        "schema_migrations",
    ];
    for table in tables {
        let exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = ?1 LIMIT 1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .expect("table lookup should succeed");
        assert_eq!(exists, 1);
    }

    let fs_nodes_columns: Vec<(String, String, i64)> = conn
        .prepare("PRAGMA table_info(fs_nodes)")
        .expect("pragma should prepare")
        .query_map([], |row| Ok((row.get(1)?, row.get(2)?, row.get(5)?)))
        .expect("pragma should query")
        .collect::<Result<Vec<_>, _>>()
        .expect("pragma rows should collect");
    assert!(
        fs_nodes_columns.iter().any(|(name, ty, pk)| {
            name == "id" && ty.eq_ignore_ascii_case("INTEGER") && *pk == 1
        })
    );
    assert!(fs_nodes_columns.iter().any(|(name, _, _)| name == "path"));

    let fts_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'fs_nodes_fts'",
            [],
            |row| row.get(0),
        )
        .expect("fts sql lookup should succeed");
    assert!(fts_sql.contains("fts5(\n    path,"));
    assert!(fts_sql.contains("title,"));
    assert!(fts_sql.contains("content\n"));

    let versions: Vec<String> = conn
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .expect("version query should prepare")
        .query_map([], |row| row.get(0))
        .expect("version query should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("versions should collect");
    assert_eq!(
        versions,
        vec![
            "vfs_store:001_initial".to_string(),
            "vfs_store:002_publication_mutation_commits".to_string(),
            "vfs_store:003_node_history".to_string(),
        ]
    );

    {
        let table = "fs_links";
        let exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .expect("snapshot table lookup should succeed");
        assert_eq!(exists, 1);
    }

    for index in [
        "fs_nodes_path_covering_idx",
        "fs_nodes_recent_covering_idx",
        "fs_links_target_path_idx",
        "fs_links_source_path_idx",
    ] {
        let exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1 LIMIT 1",
                [index],
                |row| row.get::<_, i64>(0),
            )
            .expect("index lookup should succeed");
        assert_eq!(exists, 1);
    }
}

#[test]
fn fs_migrations_reject_an_incomplete_branch_local_v003_with_recreate_guidance() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute("DROP TABLE git_objects", [])
        .expect("Git object table should drop");
    drop(conn);

    let error = store
        .run_fs_migrations()
        .expect_err("an incomplete schema with the current marker must be rejected");

    assert!(error.contains("missing table git_objects"), "{error}");
    assert!(error.contains("recreate database"), "{error}");
}

#[test]
fn current_fs_schema_missing_links_column_is_rejected() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute_batch(
        "DROP TABLE fs_links;
         CREATE TABLE fs_links (
             source_path TEXT NOT NULL,
             target_path TEXT NOT NULL,
             raw_href TEXT NOT NULL,
             link_text TEXT NOT NULL,
             link_kind TEXT NOT NULL,
             PRIMARY KEY (source_path, target_path, raw_href)
         );
         CREATE INDEX fs_links_target_path_idx
             ON fs_links (target_path, source_path);
         CREATE INDEX fs_links_source_path_idx
             ON fs_links (source_path, target_path);",
    )
    .expect("malformed links table should create");
    drop(conn);

    let error = store
        .run_fs_migrations()
        .expect_err("missing links column should reject");

    assert!(error.contains("missing column fs_links.updated_at"));
}

#[test]
fn current_fs_schema_missing_change_log_column_is_rejected() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute_batch(
        "DROP TABLE fs_change_log;
         CREATE TABLE fs_change_log (
             revision INTEGER PRIMARY KEY AUTOINCREMENT,
             path TEXT NOT NULL
         );",
    )
    .expect("malformed change log table should create");
    drop(conn);

    let error = store
        .run_fs_migrations()
        .expect_err("missing change log column should reject");

    assert!(error.contains("missing column fs_change_log.change_kind"));
}

#[test]
fn current_fs_schema_missing_path_state_column_is_rejected() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute_batch(
        "DROP TABLE fs_path_state;
         CREATE TABLE fs_path_state (
             path TEXT PRIMARY KEY
         );",
    )
    .expect("malformed path state table should create");
    drop(conn);

    let error = store
        .run_fs_migrations()
        .expect_err("missing path state column should reject");

    assert!(error.contains("missing column fs_path_state.last_change_revision"));
}

#[test]
fn current_fs_schema_rejects_wrong_fts_column_order() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute_batch(
        "DROP TABLE fs_nodes_fts;
         CREATE VIRTUAL TABLE fs_nodes_fts USING fts5(
             title,
             path,
             content
         );",
    )
    .expect("malformed fts table should create");
    drop(conn);

    let error = store
        .run_fs_migrations()
        .expect_err("wrong fts column order should reject");

    assert!(error.contains("invalid fs_nodes_fts shape"));
}

#[test]
fn current_fs_schema_rejects_extra_fts_column() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute_batch(
        "DROP TABLE fs_nodes_fts;
         CREATE VIRTUAL TABLE fs_nodes_fts USING fts5(
             path,
             title,
             content,
             extra
         );",
    )
    .expect("malformed fts table should create");
    drop(conn);

    let error = store
        .run_fs_migrations()
        .expect_err("extra fts column should reject");

    assert!(error.contains("invalid fs_nodes_fts shape"));
}

#[test]
fn list_queries_use_covering_indexes() {
    let (_dir, store) = new_store();
    write_file(&store, "/Knowledge/indexed.md", None, 10);
    let conn = Connection::open(store.database_path()).expect("db should open");

    let list_plan = explain_query_plan(
        &conn,
        "SELECT path, kind, updated_at, etag
         FROM fs_nodes
         WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'
         ORDER BY path ASC",
        ["/Knowledge", "/Knowledge/%"],
    );
    assert!(
        list_plan.contains("COVERING INDEX fs_nodes_path_covering_idx"),
        "list should avoid table lookups: {list_plan}"
    );
}

#[test]
fn list_children_queries_use_parent_indexes() {
    let (_dir, store) = new_store();
    write_file(&store, "/Knowledge/indexed.md", None, 10);
    write_file(&store, "/Knowledge/nested/child.md", None, 11);
    let conn = Connection::open(store.database_path()).expect("db should open");
    let wiki_id = conn
        .query_row(
            "SELECT id FROM fs_nodes WHERE path = '/Knowledge'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("wiki id should exist");

    let folder_plan = explain_query_plan_dynamic(
        &conn,
        "SELECT child.path, child.kind, child.updated_at, child.etag, length(CAST(child.content AS BLOB))
         FROM fs_nodes child
         WHERE child.parent_id = ?1
         ORDER BY child.name ASC",
        &[&wiki_id as &dyn rusqlite::ToSql],
    );
    assert!(
        folder_plan.contains("USING INDEX fs_nodes_parent_name_idx")
            || folder_plan.contains("USING INDEX fs_nodes_parent_idx"),
        "folder child query should use parent index: {folder_plan}"
    );

    let root_plan = explain_query_plan_dynamic(
        &conn,
        "SELECT child.path, child.kind, child.updated_at, child.etag, length(CAST(child.content AS BLOB))
         FROM fs_nodes child
         WHERE child.parent_id IS NULL
         ORDER BY child.name ASC",
        &[],
    );
    assert!(
        root_plan.contains("USING INDEX fs_nodes_parent_name_idx")
            || root_plan.contains("USING INDEX fs_nodes_parent_idx"),
        "root child query should use parent index: {root_plan}"
    );
}

#[test]
fn folder_move_subtree_query_uses_path_range_scan() {
    let (_dir, store) = new_store();
    write_file(&store, "/Knowledge/move/a.md", None, 10);
    write_file(&store, "/Knowledge/move/deep/b.md", None, 11);
    let conn = Connection::open(store.database_path()).expect("db should open");
    let prefix = "/Knowledge/move/".to_string();
    let upper = "/Knowledge/move/\u{10ffff}".to_string();

    let plan = explain_query_plan_dynamic(
        &conn,
        "SELECT path FROM fs_nodes
         WHERE path = ?1 OR (path >= ?2 AND path < ?3)
         ORDER BY length(path), path",
        &[&"/Knowledge/move" as &dyn rusqlite::ToSql, &prefix, &upper],
    );
    assert!(
        plan.contains("path>? AND path<?") || plan.contains("MULTI-INDEX OR"),
        "folder move subtree query should use path range scan: {plan}"
    );
}

#[test]
fn prefix_filters_escape_sql_like_wildcards() {
    assert_prefix_scope_with_wildcards(
        "/Knowledge/a_b",
        "/Knowledge/a_b/page.md",
        "/Knowledge/axb/page.md",
        100,
    );
    assert_prefix_scope_with_wildcards(
        "/Knowledge/a%b",
        "/Knowledge/a%b/page.md",
        "/Knowledge/azzzb/page.md",
        200,
    );
}

fn assert_prefix_scope_with_wildcards(
    prefix: &str,
    expected_path: &str,
    lookalike_path: &str,
    now_base: i64,
) {
    let (_dir, store) = new_store();
    let expected_etag = write_searchable_file(&store, expected_path, now_base);
    let lookalike_etag = write_searchable_file(&store, lookalike_path, now_base + 1);
    write_searchable_file(&store, "/Knowledge/a_b/other.md", now_base + 2);
    write_searchable_file(&store, "/Knowledge/a%b/other.md", now_base + 3);

    let list_paths = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: prefix.to_string(),
            recursive: true,
            limit: 100,
        })
        .expect("list should succeed")
        .into_iter()
        .map(|entry| entry.path)
        .collect::<Vec<_>>();
    assert!(list_paths.contains(&expected_path.to_string()));
    assert!(!list_paths.contains(&lookalike_path.to_string()));

    let search_paths = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "wildcard-token".to_string(),
            prefix: Some(prefix.to_string()),
            top_k: 100,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed")
        .into_iter()
        .map(|hit| hit.path)
        .collect::<Vec<_>>();
    assert!(search_paths.contains(&expected_path.to_string()));
    assert!(!search_paths.contains(&lookalike_path.to_string()));

    let path_search_paths = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "page".to_string(),
            prefix: Some(prefix.to_string()),
            top_k: 100,
            preview_mode: None,
        })
        .expect("path search should succeed")
        .into_iter()
        .map(|hit| hit.path)
        .collect::<Vec<_>>();
    assert!(path_search_paths.contains(&expected_path.to_string()));
    assert!(!path_search_paths.contains(&lookalike_path.to_string()));

    let snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            database_id: "default".to_string(),
            prefix: Some(prefix.to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("snapshot should succeed");
    let snapshot_paths = snapshot
        .nodes
        .iter()
        .map(|node| node.path.clone())
        .collect::<Vec<_>>();
    assert!(snapshot_paths.contains(&expected_path.to_string()));
    assert!(!snapshot_paths.contains(&lookalike_path.to_string()));

    update_searchable_file(&store, expected_path, &expected_etag, now_base + 10);
    update_searchable_file(&store, lookalike_path, &lookalike_etag, now_base + 11);
    let updates = store
        .fetch_updates(FetchUpdatesRequest {
            database_id: "default".to_string(),
            known_snapshot_revision: snapshot.snapshot_revision,
            prefix: Some(prefix.to_string()),
            limit: 100,
            cursor: None,
            target_snapshot_revision: None,
        })
        .expect("updates should succeed");
    let update_paths = updates
        .changed_nodes
        .into_iter()
        .map(|node| node.path)
        .collect::<Vec<_>>();
    assert!(update_paths.contains(&expected_path.to_string()));
    assert!(!update_paths.contains(&lookalike_path.to_string()));
}

fn write_searchable_file(store: &FsStore, path: &str, now: i64) -> String {
    ensure_parent_folders(store, path, now - 1);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: "wildcard-token body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            now,
        )
        .expect("write should succeed")
        .node
        .etag
}

fn update_searchable_file(store: &FsStore, path: &str, etag: &str, now: i64) {
    ensure_parent_folders(store, path, now - 1);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: format!("wildcard-token updated {now}"),
                metadata_json: "{}".to_string(),
                expected_etag: Some(etag.to_string()),
            },
            now,
        )
        .expect("update should succeed");
}

fn explain_query_plan(conn: &Connection, sql: &str, params: [&str; 2]) -> String {
    explain_query_plan_dynamic(conn, sql, &[&params[0] as &dyn rusqlite::ToSql, &params[1]])
}

fn explain_query_plan_dynamic(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> String {
    conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .expect("explain should prepare")
        .query_map(params, |row| row.get::<_, String>(3))
        .expect("explain should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("explain rows should collect")
        .join("\n")
}

#[test]
fn status_counts_live_files_and_sources() {
    let (_dir, store) = new_store();
    let file = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/file.md".to_string(),
                kind: NodeKind::File,
                content: "alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("file write should succeed");
    ensure_parent_folders(&store, "/Sources/source/source.md", 10);
    let source = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/source/source.md".to_string(),
                kind: NodeKind::Source,
                content: "source".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            11,
        )
        .expect("source write should succeed");
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/file.md".to_string(),
                expected_etag: Some(file.node.etag),
                expected_folder_index_etag: None,
            },
            12,
        )
        .expect("delete should succeed");

    let status = store.status().expect("status should succeed");
    assert_eq!(status.file_count, 0);
    assert_eq!(status.source_count, 1);
    assert_eq!(source.node.kind, NodeKind::Source);
}

#[test]
fn write_nodes_creates_files_and_sources_atomically() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Sources/source/source.md", 9);

    let results = store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes: vec![
                    WriteNodeItem {
                        path: "/Knowledge/batch-a.md".to_string(),
                        kind: NodeKind::File,
                        content: "alpha link [[batch-b]]".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                    WriteNodeItem {
                        path: "/Sources/source/source.md".to_string(),
                        kind: NodeKind::Source,
                        content: "source alpha".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                ],
            },
            10,
        )
        .expect("batch write should succeed");

    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|result| result.created));
    assert!(
        store
            .read_node("/Knowledge/batch-a.md")
            .expect("read should succeed")
            .is_some()
    );
    assert!(
        store
            .read_node("/Sources/source/source.md")
            .expect("read should succeed")
            .is_some()
    );
}

#[test]
fn full_replacement_preserves_explicit_source_kind_and_metadata_across_write_apis() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Sources/preserved/source.md", 9);
    let metadata = r#"{"source_url":"https://example.com"}"#;
    let created = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/preserved/source.md".to_string(),
                kind: NodeKind::Source,
                content: "one".to_string(),
                metadata_json: metadata.to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("source should create");
    let batch = store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes: vec![WriteNodeItem {
                    path: "/Sources/preserved/source.md".to_string(),
                    kind: NodeKind::Source,
                    content: "two".to_string(),
                    metadata_json: metadata.to_string(),
                    expected_etag: Some(created.node.etag),
                }],
            },
            11,
        )
        .expect("source should be replaced");
    let mutation = store
        .mutate_nodes_batch(
            MutateNodesBatchRequest {
                database_id: "default".to_string(),
                operations: vec![NodeMutation::Write(WriteNodeItem {
                    path: "/Sources/preserved/source.md".to_string(),
                    kind: NodeKind::Source,
                    content: "three".to_string(),
                    metadata_json: metadata.to_string(),
                    expected_etag: Some(batch[0].node.etag.clone()),
                })],
            },
            12,
        )
        .expect("batch mutation should replace source");

    assert_eq!(mutation.len(), 1);
    let node = store
        .read_node("/Sources/preserved/source.md")
        .expect("source should read")
        .expect("source should exist");
    assert_eq!(node.kind, NodeKind::Source);
    assert_eq!(node.metadata_json, metadata);
    assert_eq!(node.content, "three");
}

#[test]
fn mutation_errors_do_not_classify_expected_etag_from_a_missing_path() {
    let (_dir, store) = new_store();
    let error = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Memory/expected_etag.md".to_string(),
                kind: NodeKind::File,
                content: "missing".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some("stale".to_string()),
            },
            10,
        )
        .expect_err("a conditional write cannot create a missing node");

    assert_eq!(error.code, NodeMutationErrorCode::NotFound);
    assert_eq!(error.conflict_path, None);
}

#[test]
fn write_nodes_rolls_back_when_later_item_fails() {
    let (_dir, store) = new_store();
    let existing = write_file(&store, "/Knowledge/existing.md", None, 9);

    let error = store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes: vec![
                    WriteNodeItem {
                        path: "/Knowledge/new-before-error.md".to_string(),
                        kind: NodeKind::File,
                        content: "new content".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                    WriteNodeItem {
                        path: "/Knowledge/existing.md".to_string(),
                        kind: NodeKind::File,
                        content: "stale update".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: Some("stale".to_string()),
                    },
                ],
            },
            10,
        )
        .expect_err("stale item should fail");

    assert_eq!(error.failed_index, Some(1));
    assert!(error.message.contains("expected_etag"));
    assert!(
        store
            .read_node("/Knowledge/new-before-error.md")
            .expect("read should succeed")
            .is_none()
    );
    assert_eq!(
        store
            .read_node("/Knowledge/existing.md")
            .expect("read should succeed")
            .expect("existing node should remain")
            .etag,
        existing
    );
}

#[test]
fn write_nodes_creates_folder_items() {
    let (_dir, store) = new_store();

    let results = store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes: vec![
                    WriteNodeItem {
                        path: "/Knowledge/new-before-folder.md".to_string(),
                        kind: NodeKind::File,
                        content: "new content".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                    WriteNodeItem {
                        path: "/Knowledge/folder".to_string(),
                        kind: NodeKind::Folder,
                        content: String::new(),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                ],
            },
            10,
        )
        .expect("folder item should create");

    assert_eq!(results.len(), 2);
    assert!(results[1].created);
    assert_eq!(results[1].node.path, "/Knowledge/folder");
    assert_eq!(results[1].node.kind, NodeKind::Folder);
    assert_eq!(
        store
            .read_node("/Knowledge/folder")
            .expect("read should succeed")
            .expect("folder should exist")
            .kind,
        NodeKind::Folder
    );
}

#[test]
fn write_node_creates_folder_idempotently() {
    let (_dir, store) = new_store();

    let created = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/write-node-folder".to_string(),
                kind: NodeKind::Folder,
                content: String::new(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("folder write should create");
    let replay = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/write-node-folder".to_string(),
                kind: NodeKind::Folder,
                content: String::new(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            11,
        )
        .expect("existing folder write should replay");

    assert!(created.created);
    assert_eq!(created.node.kind, NodeKind::Folder);
    assert!(!replay.created);
    assert_eq!(replay.node.path, "/Knowledge/write-node-folder");
}

#[test]
fn write_node_rejects_invalid_folder_requests() {
    let (_dir, store) = new_store();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/existing.md".to_string(),
                kind: NodeKind::File,
                content: "file".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("file should create");

    let non_empty = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/non-empty-folder".to_string(),
                kind: NodeKind::Folder,
                content: "not empty".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            11,
        )
        .expect_err("folder content should reject");
    let metadata = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/metadata-folder".to_string(),
                kind: NodeKind::Folder,
                content: String::new(),
                metadata_json: r#"{"a":1}"#.to_string(),
                expected_etag: None,
            },
            12,
        )
        .expect_err("folder metadata should reject");
    let etag = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/etag-folder".to_string(),
                kind: NodeKind::Folder,
                content: String::new(),
                metadata_json: "{}".to_string(),
                expected_etag: Some("etag".to_string()),
            },
            13,
        )
        .expect_err("folder etag should reject");
    let collision = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/existing.md".to_string(),
                kind: NodeKind::Folder,
                content: String::new(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            14,
        )
        .expect_err("folder over file should reject");

    assert!(
        non_empty
            .message
            .contains("folder item content must be empty")
    );
    assert!(
        metadata
            .message
            .contains("folder item metadata_json must be empty object")
    );
    assert!(
        etag.message
            .contains("expected_etag must be None for folder item")
    );
    assert!(
        collision
            .message
            .contains("node already exists and is not a folder")
    );
}

#[test]
fn write_nodes_updates_search_and_links() {
    let (_dir, store) = new_store();

    store
        .write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes: vec![WriteNodeItem {
                    path: "/Knowledge/linking.md".to_string(),
                    kind: NodeKind::File,
                    content: "batch-token links to [[target]]".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                }],
            },
            10,
        )
        .expect("batch write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "batch-token".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert!(hits.iter().any(|hit| hit.path == "/Knowledge/linking.md"));
    let links = store
        .outgoing_links(OutgoingLinksRequest {
            database_id: "default".to_string(),
            path: "/Knowledge/linking.md".to_string(),
            limit: 10,
        })
        .expect("links should load");
    assert!(
        links
            .iter()
            .any(|link| link.target_path == "/Knowledge/target")
    );
}

#[test]
fn change_log_retains_all_recorded_revisions() {
    let (_dir, store) = new_store();
    for now in 10..=270 {
        let path = format!("/Knowledge/history-{now}.md");
        write_file(&store, &path, None, now);
    }

    let conn = Connection::open(store.database_path()).expect("db should open");
    let revision_count = conn
        .query_row("SELECT COUNT(*) FROM fs_change_log", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("count should succeed");
    let oldest_revision = conn
        .query_row("SELECT MIN(revision) FROM fs_change_log", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("min revision should succeed");
    let newest_revision = conn
        .query_row("SELECT MAX(revision) FROM fs_change_log", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("max revision should succeed");

    assert_eq!(revision_count, 269);
    assert_eq!(oldest_revision, 1);
    assert_eq!(newest_revision, 269);
}

#[test]
fn fs_path_state_tracks_latest_change_revision() {
    let (_dir, store) = new_store();
    let first = write_file(&store, "/Knowledge/file.md", None, 10);
    let second = write_file(&store, "/Knowledge/file.md", Some(&first), 11);
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/file.md".to_string(),
                expected_etag: Some(second),
                expected_folder_index_etag: None,
            },
            12,
        )
        .expect("delete should succeed");

    let conn = Connection::open(store.database_path()).expect("db should open");
    let revision = conn
        .query_row(
            "SELECT last_change_revision FROM fs_path_state WHERE path = '/Knowledge/file.md'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("path state should exist");
    assert_eq!(revision, 11);
}

#[test]
fn delete_folder_with_index_deletes_both_nodes() {
    let (_dir, store) = new_store();
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic".to_string(),
            },
            10,
        )
        .expect("folder should create");
    let folder = store
        .read_node("/Knowledge/topic")
        .expect("folder should read")
        .expect("folder should exist");
    let index_etag = write_file(&store, "/Knowledge/topic/index.md", None, 11);

    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic".to_string(),
                expected_etag: Some(folder.etag),
                expected_folder_index_etag: Some(index_etag),
            },
            12,
        )
        .expect("folder delete should succeed");

    assert!(
        store
            .read_node("/Knowledge/topic")
            .expect("folder read should succeed")
            .is_none()
    );
    assert!(
        store
            .read_node("/Knowledge/topic/index.md")
            .expect("index read should succeed")
            .is_none()
    );
}

#[test]
fn delete_folder_with_index_and_visible_child_keeps_all_nodes() {
    let (_dir, store) = new_store();
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic".to_string(),
            },
            10,
        )
        .expect("folder should create");
    let folder = store
        .read_node("/Knowledge/topic")
        .expect("folder should read")
        .expect("folder should exist");
    let index_etag = write_file(&store, "/Knowledge/topic/index.md", None, 11);
    write_file(&store, "/Knowledge/topic/child.md", None, 12);

    let error = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic".to_string(),
                expected_etag: Some(folder.etag),
                expected_folder_index_etag: Some(index_etag),
            },
            13,
        )
        .expect_err("visible child should block folder delete");

    assert!(error.message.contains("folder is not empty"));
    for path in [
        "/Knowledge/topic",
        "/Knowledge/topic/index.md",
        "/Knowledge/topic/child.md",
    ] {
        assert!(
            store
                .read_node(path)
                .expect("node read should succeed")
                .is_some(),
            "{path} should remain"
        );
    }
}

#[test]
fn delete_folder_with_stale_index_etag_keeps_folder_and_index() {
    let (_dir, store) = new_store();
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic".to_string(),
            },
            10,
        )
        .expect("folder should create");
    let folder = store
        .read_node("/Knowledge/topic")
        .expect("folder should read")
        .expect("folder should exist");
    write_file(&store, "/Knowledge/topic/index.md", None, 11);

    let error = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic".to_string(),
                expected_etag: Some(folder.etag),
                expected_folder_index_etag: Some("stale".to_string()),
            },
            12,
        )
        .expect_err("stale index etag should fail");

    assert!(error.message.contains("expected_folder_index_etag"));
    assert_eq!(error.code, NodeMutationErrorCode::EtagConflict);
    assert_eq!(
        error.conflict_path.as_deref(),
        Some("/Knowledge/topic/index.md")
    );
    assert!(
        store
            .read_node("/Knowledge/topic")
            .expect("folder read should succeed")
            .is_some()
    );
    assert!(
        store
            .read_node("/Knowledge/topic/index.md")
            .expect("index read should succeed")
            .is_some()
    );
}

#[test]
fn delete_empty_folder_without_index_still_succeeds() {
    let (_dir, store) = new_store();
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic".to_string(),
            },
            10,
        )
        .expect("folder should create");
    let folder = store
        .read_node("/Knowledge/topic")
        .expect("folder should read")
        .expect("folder should exist");

    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic".to_string(),
                expected_etag: Some(folder.etag),
                expected_folder_index_etag: None,
            },
            11,
        )
        .expect("empty folder delete should succeed");

    assert!(
        store
            .read_node("/Knowledge/topic")
            .expect("folder read should succeed")
            .is_none()
    );
}

#[test]
fn delete_file_rejects_folder_index_etag() {
    let (_dir, store) = new_store();
    let etag = write_file(&store, "/Knowledge/file.md", None, 10);

    let error = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/file.md".to_string(),
                expected_etag: Some(etag),
                expected_folder_index_etag: Some("index".to_string()),
            },
            11,
        )
        .expect_err("file delete should reject folder index etag");

    assert!(error.message.contains("expected_folder_index_etag"));
    assert!(
        store
            .read_node("/Knowledge/file.md")
            .expect("file read should succeed")
            .is_some()
    );
}

#[test]
fn fs_migrations_are_idempotent() {
    let (_dir, store) = new_store();
    write_file(&store, "/Knowledge/alpha.md", None, 10);
    write_file(&store, "/Knowledge/beta.md", None, 11);

    store
        .run_fs_migrations()
        .expect("rerunning migrations should be a no-op");

    let conn = Connection::open(store.database_path()).expect("db should open");
    let versions = conn
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .expect("version query should prepare")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("version query should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("versions should collect");
    assert_eq!(
        versions,
        vec![
            "vfs_store:001_initial".to_string(),
            "vfs_store:002_publication_mutation_commits".to_string(),
            "vfs_store:003_node_history".to_string(),
        ]
    );

    let tracked_paths = conn
        .query_row("SELECT COUNT(*) FROM fs_path_state", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("path state count should succeed");
    assert_eq!(tracked_paths, 10);
}

#[test]
fn fs_migrations_apply_publication_commit_marker_once() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute("DROP TABLE publication_mutation_commits", [])
        .expect("publication commit table should drop");
    for trigger in [
        "fs_history_node_insert",
        "fs_history_node_update",
        "fs_history_node_delete",
    ] {
        conn.execute(&format!("DROP TRIGGER {trigger}"), [])
            .expect("history trigger should drop");
    }
    for table in [
        "git_index_entries",
        "git_refs",
        "git_objects",
        "fs_history_items",
        "fs_history_active_change",
        "fs_history_changes",
        "fs_history_versions",
        "fs_history_blobs",
        "fs_history_pages",
    ] {
        conn.execute(&format!("DROP TABLE {table}"), [])
            .expect("history table should drop");
    }
    conn.execute(
        "DELETE FROM schema_migrations WHERE version IN (?1, ?2)",
        [
            "vfs_store:002_publication_mutation_commits",
            "vfs_store:003_node_history",
        ],
    )
    .expect("publication commit migration marker should delete");
    drop(conn);

    store
        .run_fs_migrations()
        .expect("001 to 002 migration should apply");
    store
        .run_fs_migrations()
        .expect("002 migration should apply only once");

    let conn = Connection::open(store.database_path()).expect("db should reopen");
    let table_count = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'publication_mutation_commits'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("publication commit table should exist");
    assert_eq!(table_count, 1);
    let marker_count = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
            ["vfs_store:002_publication_mutation_commits"],
            |row| row.get::<_, i64>(0),
        )
        .expect("publication commit marker should exist");
    assert_eq!(marker_count, 1);
}

#[test]
fn write_node_creates_missing_store_root_on_current_schema() {
    let (_dir, store) = new_store();
    let page_id = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "default".to_string(),
            target: NodeHistoryTarget::CurrentPath("/Knowledge".to_string()),
            cursor: None,
            limit: 1,
        })
        .expect("knowledge root history should load")
        .page_id;
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute("DELETE FROM fs_nodes WHERE path = '/Knowledge'", [])
        .expect("knowledge root should delete");
    drop(conn);

    let written = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/lazy.md".to_string(),
                kind: NodeKind::File,
                content: "lazy root".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            40,
        )
        .expect("write should create missing store root");

    assert!(written.created);
    let root = store
        .read_node("/Knowledge")
        .expect("root should read")
        .expect("root should exist");
    assert_eq!(root.kind, NodeKind::Folder);
    let child = store
        .read_node("/Knowledge/lazy.md")
        .expect("child should read")
        .expect("child should exist");
    assert_eq!(child.kind, NodeKind::File);
    let repaired_history = store
        .list_node_history(ListNodeHistoryRequest {
            database_id: "default".to_string(),
            target: NodeHistoryTarget::CurrentPath("/Knowledge".to_string()),
            cursor: None,
            limit: 10,
        })
        .expect("repaired root history should load");
    assert_eq!(repaired_history.page_id, page_id);
    assert_eq!(repaired_history.entries.len(), 1);
    assert_eq!(
        repaired_history.entries[0].change_kind,
        NodeHistoryChangeKind::Create
    );
}

#[test]
fn mkdir_node_creates_missing_skills_root_on_current_schema() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute("DELETE FROM fs_nodes WHERE path = '/Skills'", [])
        .expect("skills root should delete");
    drop(conn);

    let created = store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Skills/package".to_string(),
            },
            40,
        )
        .expect("mkdir should create missing store root");

    assert!(created.created);
    let root = store
        .read_node("/Skills")
        .expect("root should read")
        .expect("root should exist");
    assert_eq!(root.kind, NodeKind::Folder);
    let child = store
        .read_node("/Skills/package")
        .expect("child should read")
        .expect("child should exist");
    assert_eq!(child.kind, NodeKind::Folder);
}

#[test]
fn move_node_creates_missing_store_root_on_current_schema() {
    let (_dir, store) = new_store();
    let source_etag = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Memory/move-source.md".to_string(),
                kind: NodeKind::File,
                content: "move root".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            40,
        )
        .expect("source should write")
        .node
        .etag;
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute("DELETE FROM fs_nodes WHERE path = '/Knowledge'", [])
        .expect("knowledge root should delete");
    drop(conn);

    let moved = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Memory/move-source.md".to_string(),
                to_path: "/Knowledge/moved.md".to_string(),
                expected_etag: Some(source_etag),
                expected_target_etag: None,
                overwrite: false,
            },
            41,
        )
        .expect("move should create missing store root");

    assert_eq!(moved.node.path, "/Knowledge/moved.md");
    let root = store
        .read_node("/Knowledge")
        .expect("root should read")
        .expect("root should exist");
    assert_eq!(root.kind, NodeKind::Folder);
}

#[test]
fn search_nodes_returns_error_for_invalid_stored_kind() {
    let (_dir, store) = new_store();
    let conn = Connection::open(store.database_path()).expect("db should open");
    conn.execute(
        "INSERT INTO fs_nodes (id, path, kind, content, created_at, updated_at, etag, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            100_i64,
            "/Knowledge/broken.md",
            "broken",
            "searchable broken content",
            10_i64,
            10_i64,
            "etag-broken",
            "{}",
        ],
    )
    .expect("invalid kind row should insert");
    conn.execute(
        "INSERT INTO fs_nodes_fts (rowid, path, title, content) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![
            100_i64,
            "/Knowledge/broken.md",
            "broken",
            "searchable broken content"
        ],
    )
    .expect("fts row should insert");

    let error = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "searchable".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 10,
            preview_mode: None,
        })
        .expect_err("invalid kind should return error");
    assert!(error.contains("Invalid column type"));
}

#[test]
fn fs_nodes_fts_stores_title_using_current_basename_rule() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/nested/archive.tar.gz", 19);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/nested/archive.tar.gz".to_string(),
                kind: NodeKind::File,
                content: "payload".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            20,
        )
        .expect("write should succeed");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/nested/.env".to_string(),
                kind: NodeKind::File,
                content: "payload".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            21,
        )
        .expect("write should succeed");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/nested/trailing.".to_string(),
                kind: NodeKind::File,
                content: "payload".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            22,
        )
        .expect("write should succeed");

    let conn = Connection::open(store.database_path()).expect("db should open");
    let rows = conn
        .prepare("SELECT path, title FROM fs_nodes_fts ORDER BY path ASC")
        .expect("query should prepare")
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows should collect");
    assert_eq!(
        rows,
        vec![
            ("/Knowledge/nested/.env".to_string(), ".env".to_string()),
            (
                "/Knowledge/nested/archive.tar.gz".to_string(),
                "archive.tar".to_string()
            ),
            (
                "/Knowledge/nested/trailing.".to_string(),
                "trailing.".to_string()
            ),
        ]
    );
}

#[test]
fn write_update_delete_and_recreate_follow_etag_rules() {
    let (_dir, store) = new_store();
    let first = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/foo.md".to_string(),
                kind: NodeKind::File,
                content: "alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("first write should succeed");
    assert!(first.created);
    assert_eq!(
        store
            .read_node("/Knowledge/foo.md")
            .expect("read should succeed"),
        Some(vfs_types::Node {
            path: first.node.path.clone(),
            kind: first.node.kind.clone(),
            content: "alpha".to_string(),
            created_at: 10,
            updated_at: 10,
            etag: first.node.etag.clone(),
            metadata_json: "{}".to_string(),
        })
    );

    let stale_error = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/foo.md".to_string(),
                kind: NodeKind::File,
                content: "beta".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some("stale".to_string()),
            },
            11,
        )
        .expect_err("stale write should fail");
    assert!(stale_error.message.contains("expected_etag"));
    assert_eq!(stale_error.code, NodeMutationErrorCode::EtagConflict);
    assert_eq!(
        stale_error.conflict_path.as_deref(),
        Some("/Knowledge/foo.md")
    );

    let second = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/foo.md".to_string(),
                kind: NodeKind::File,
                content: "beta".to_string(),
                metadata_json: "{\"v\":2}".to_string(),
                expected_etag: Some(first.node.etag.clone()),
            },
            12,
        )
        .expect("update should succeed");
    assert!(!second.created);
    assert_ne!(first.node.etag, second.node.etag);
    let second_node = store
        .read_node("/Knowledge/foo.md")
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(second_node.created_at, 10);

    let _deleted = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/foo.md".to_string(),
                expected_etag: Some(second.node.etag.clone()),
                expected_folder_index_etag: None,
            },
            13,
        )
        .expect("delete should succeed");
    let stale_delete = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/foo.md".to_string(),
                expected_etag: Some(second.node.etag),
                expected_folder_index_etag: None,
            },
            14,
        )
        .expect_err("stale delete should fail");
    assert!(stale_delete.message.contains("node does not exist"));
    assert!(
        store
            .read_node("/Knowledge/foo.md")
            .expect("read after delete should succeed")
            .is_none()
    );

    let recreated = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/foo.md".to_string(),
                kind: NodeKind::File,
                content: "gamma".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            15,
        )
        .expect("recreate should succeed");
    let recreated_node = store
        .read_node("/Knowledge/foo.md")
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(recreated_node.created_at, 15);
    assert_eq!(recreated.node.updated_at, 15);
}

#[test]
fn list_search_and_export_respect_deleted_and_prefix() {
    let (_dir, store) = new_store();
    let alpha = write_file(&store, "/Knowledge/alpha.md", None, 10);
    let beta = write_file(&store, "/Knowledge/nested/beta.md", None, 11);
    write_file(&store, "/Knowledge/tree/leaf.md", None, 12);
    write_file(&store, "/Knowledge/deleted/leaf.md", None, 13);
    let root_entries = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge".to_string(),
            recursive: false,
            limit: 100,
        })
        .expect("root list should succeed");
    assert_eq!(root_entries.len(), 4);
    assert!(
        root_entries
            .iter()
            .any(|entry| entry.path == "/Knowledge/alpha.md" && !entry.has_children)
    );
    assert!(root_entries.iter().any(|entry| {
        entry.path == "/Knowledge/nested"
            && entry.kind == NodeEntryKind::Folder
            && !entry.etag.is_empty()
            && entry.has_children
    }));
    assert!(root_entries.iter().any(|entry| {
        entry.path == "/Knowledge/deleted"
            && entry.kind == NodeEntryKind::Folder
            && !entry.etag.is_empty()
            && entry.has_children
    }));
    assert!(
        root_entries
            .iter()
            .any(|entry| entry.path == "/Knowledge/tree" && entry.has_children)
    );

    let nested_entries = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge/nested".to_string(),
            recursive: true,
            limit: 100,
        })
        .expect("nested list should succeed");
    assert_eq!(nested_entries.len(), 2);
    assert!(
        nested_entries
            .iter()
            .any(|entry| entry.path == "/Knowledge/nested" && entry.kind == NodeEntryKind::Folder)
    );
    assert!(nested_entries.iter().any(
        |entry| entry.path == "/Knowledge/nested/beta.md" && entry.kind == NodeEntryKind::File
    ));

    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/alpha.md".to_string(),
                expected_etag: Some(alpha),
                expected_folder_index_etag: None,
            },
            12,
        )
        .expect("delete should succeed");
    let _deleted_leaf = store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/deleted/leaf.md".to_string(),
                expected_etag: Some(
                    store
                        .read_node("/Knowledge/deleted/leaf.md")
                        .expect("deleted leaf read should succeed")
                        .expect("deleted leaf should exist")
                        .etag,
                ),
                expected_folder_index_etag: None,
            },
            14,
        )
        .expect("deleted leaf delete should succeed");
    let visible_after_delete = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge".to_string(),
            recursive: true,
            limit: 100,
        })
        .expect("visible list should succeed");
    assert_eq!(visible_after_delete.len(), 6);
    assert!(
        visible_after_delete
            .iter()
            .any(|entry| entry.path == "/Knowledge/nested/beta.md")
    );
    assert!(
        visible_after_delete
            .iter()
            .any(|entry| entry.path == "/Knowledge/tree")
    );
    assert!(
        visible_after_delete
            .iter()
            .any(|entry| entry.path == "/Knowledge/tree/leaf.md")
    );

    let root_after_delete = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge".to_string(),
            recursive: false,
            limit: 100,
        })
        .expect("root list after delete should succeed");
    assert!(root_after_delete.iter().any(|entry| {
        entry.path == "/Knowledge/deleted"
            && entry.kind == NodeEntryKind::Folder
            && !entry.has_children
    }));

    let deleted_entries = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge".to_string(),
            recursive: true,
            limit: 100,
        })
        .expect("deleted list should succeed");
    assert_eq!(deleted_entries.len(), 6);

    let deleted_root_entries = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge".to_string(),
            recursive: false,
            limit: 100,
        })
        .expect("deleted root list should succeed");
    assert!(deleted_root_entries.iter().any(|entry| {
        entry.path == "/Knowledge/deleted"
            && entry.kind == NodeEntryKind::Folder
            && !entry.has_children
    }));

    let search_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "nested".to_string(),
            prefix: Some("/Knowledge/nested".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    let beta_search_hit = search_hits
        .iter()
        .find(|hit| hit.path == "/Knowledge/nested/beta.md")
        .expect("nested file search hit should exist");
    assert_eq!(
        beta_search_hit.snippet.as_deref(),
        Some("/Knowledge/nested/beta.md")
    );
    assert!(
        beta_search_hit
            .match_reasons
            .contains(&"path_substring".to_string())
    );

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "NeStEd".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 5,
            preview_mode: None,
        })
        .expect("path search should succeed");
    let beta_path_hit = path_hits
        .iter()
        .find(|hit| hit.path == "/Knowledge/nested/beta.md")
        .expect("nested file path hit should exist");
    assert_eq!(
        beta_path_hit.snippet.as_deref(),
        Some("/Knowledge/nested/beta.md")
    );
    assert_eq!(
        beta_path_hit.match_reasons,
        vec!["path_substring".to_string()]
    );

    let missing_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alpha".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert!(missing_hits.is_empty());

    let snapshot = store
        .export_snapshot(ExportSnapshotRequest {
            database_id: "default".to_string(),
            prefix: Some("/Knowledge".to_string()),
            limit: 100,
            cursor: None,
            snapshot_revision: None,
            snapshot_session_id: None,
        })
        .expect("snapshot should succeed");
    assert_eq!(snapshot.nodes.len(), 6);
    assert!(
        snapshot
            .nodes
            .iter()
            .any(|node| node.path == "/Knowledge/nested/beta.md")
    );
    assert_v5_snapshot_revision_without_state_hash(&snapshot.snapshot_revision);
    assert!(beta.starts_with("v4h:"));
}

#[test]
fn list_nodes_clamps_and_applies_limit() {
    let (_dir, store) = new_store();
    write_file(&store, "/Knowledge/a.md", None, 10);
    write_file(&store, "/Knowledge/b.md", None, 11);
    write_file(&store, "/Knowledge/c/leaf.md", None, 12);

    let direct = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge".to_string(),
            recursive: false,
            limit: 2,
        })
        .expect("direct list should succeed");
    assert_eq!(
        direct
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/Knowledge/a.md", "/Knowledge/b.md"]
    );

    let recursive = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Knowledge".to_string(),
            recursive: true,
            limit: 0,
        })
        .expect("recursive list should succeed");
    assert_eq!(recursive.len(), 1);
    assert_eq!(recursive[0].path, "/Knowledge");
}

#[test]
fn list_children_returns_direct_children_with_folders() {
    let (_dir, store) = new_store();
    let alpha_etag = write_file(&store, "/Knowledge/alpha.md", None, 10);
    write_file(&store, "/Knowledge/zeta.md", None, 11);
    write_file(&store, "/Knowledge/nested/beta.md", None, 12);
    write_file(&store, "/Knowledge/aaa/gamma.md", None, 13);
    write_file(&store, "/Knowledge/tree/leaf.md", None, 14);

    let children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Knowledge/".to_string(),
        })
        .expect("children should list");
    let paths = children
        .iter()
        .map(|child| child.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "/Knowledge/aaa",
            "/Knowledge/nested",
            "/Knowledge/tree",
            "/Knowledge/alpha.md",
            "/Knowledge/zeta.md"
        ]
    );

    let directory = children
        .iter()
        .find(|child| child.path == "/Knowledge/aaa")
        .expect("folder should exist");
    assert_eq!(directory.kind, NodeEntryKind::Folder);
    assert_eq!(directory.name, "aaa");
    assert!(directory.updated_at.is_some());
    assert!(directory.etag.is_some());
    assert_eq!(directory.size_bytes, Some(0));
    assert!(!directory.is_virtual);

    let alpha = children
        .iter()
        .find(|child| child.path == "/Knowledge/alpha.md")
        .expect("file child should exist");
    assert_eq!(alpha.kind, NodeEntryKind::File);
    assert_eq!(alpha.name, "alpha.md");
    assert_eq!(alpha.updated_at, Some(10));
    assert_eq!(alpha.etag.as_deref(), Some(alpha_etag.as_str()));
    assert_eq!(alpha.size_bytes, Some("content revision 10".len() as u64));
    assert!(!alpha.is_virtual);

    let tree = children
        .iter()
        .find(|child| child.path == "/Knowledge/tree")
        .expect("folder child with descendants should exist");
    assert_eq!(tree.kind, NodeEntryKind::Folder);
    assert_eq!(tree.name, "tree");
    assert!(tree.updated_at.is_some());
    assert!(tree.etag.is_some());
    assert_eq!(tree.size_bytes, Some(0));
    assert!(!tree.is_virtual);
    assert!(tree.has_children);

    let nested = children
        .iter()
        .find(|child| child.path == "/Knowledge/nested")
        .expect("folder child with descendants should exist");
    assert!(nested.has_children);

    assert!(
        !children
            .iter()
            .find(|child| child.path == "/Knowledge/alpha.md")
            .expect("leaf file child should exist")
            .has_children
    );

    let tree_children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Knowledge/tree".to_string(),
        })
        .expect("concrete node with descendants should list children");
    assert_eq!(
        tree_children
            .iter()
            .map(|child| child.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/Knowledge/tree/leaf.md"]
    );
    assert!(!tree_children[0].has_children);
}

#[test]
fn list_children_excludes_folder_index_from_has_children() {
    let (_dir, store) = new_store();
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/topic".to_string(),
            },
            10,
        )
        .expect("folder should create");
    write_file(&store, "/Knowledge/topic/index.md", None, 11);

    let children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Knowledge".to_string(),
        })
        .expect("children should list");
    let topic = children
        .iter()
        .find(|child| child.path == "/Knowledge/topic")
        .expect("topic folder should exist");
    assert_eq!(topic.kind, NodeEntryKind::Folder);
    assert!(!topic.has_children);
}

#[test]
fn list_children_reports_missing_directory_paths() {
    let (_dir, store) = new_store();

    let missing_error = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Knowledge/no-such-dir".to_string(),
        })
        .expect_err("missing directory should be rejected");
    assert_eq!(missing_error, "path not found: /Knowledge/no-such-dir");

    let root_children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/".to_string(),
        })
        .expect("root directory should list root folders");
    assert_eq!(
        root_children
            .iter()
            .map(|child| child.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/Knowledge", "/Memory", "/Sessions", "/Skills", "/Sources"]
    );
    for path in ["/Memory", "/Sessions", "/Knowledge", "/Skills"] {
        let children = store
            .list_children(ListChildrenRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
            })
            .expect("root-like directory should allow empty listing");
        assert!(children.is_empty());
    }
    let source_children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Sources".to_string(),
        })
        .expect("sources root should list source-kind roots");
    assert_eq!(
        source_children
            .iter()
            .map(|child| child.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "/Sources/sessions",
            "/Sources/skill-runs",
            "/Sources/source-capture-requests"
        ]
    );
}

#[test]
fn list_children_reports_utf8_content_size_in_bytes() {
    let (_dir, store) = new_store();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/japanese.md".to_string(),
                kind: NodeKind::File,
                content: "こんにちは".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            10,
        )
        .expect("write should succeed");

    let children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Knowledge".to_string(),
        })
        .expect("children should list");
    let child = children
        .iter()
        .find(|child| child.path == "/Knowledge/japanese.md")
        .expect("file child should exist");
    assert_eq!(child.size_bytes, Some("こんにちは".len() as u64));
}

#[test]
fn list_children_rejects_non_directory_paths() {
    let (_dir, store) = new_store();
    write_file(&store, "/Knowledge/alpha.md", None, 10);

    let file_error = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Knowledge/alpha.md".to_string(),
        })
        .expect_err("file path should be rejected");
    assert_eq!(file_error, "not a directory: /Knowledge/alpha.md");

    let relative_error = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "Wiki".to_string(),
        })
        .expect_err("relative path should be rejected");
    assert_eq!(relative_error, "path must start with '/': Wiki");
}

#[test]
fn list_children_collapses_many_descendants_to_direct_entries() {
    let (_dir, store) = new_store();
    write_file(&store, "/Knowledge/alpha.md", None, 10);
    for index in 0..300 {
        write_file(
            &store,
            &format!("/Knowledge/bulk-{}/leaf-{}.md", index % 3, index),
            None,
            20 + index,
        );
    }

    let children = store
        .list_children(ListChildrenRequest {
            database_id: "default".to_string(),
            path: "/Knowledge".to_string(),
        })
        .expect("children should list");
    let paths = children
        .iter()
        .map(|child| child.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "/Knowledge/bulk-0",
            "/Knowledge/bulk-1",
            "/Knowledge/bulk-2",
            "/Knowledge/alpha.md"
        ]
    );
    assert_eq!(
        children
            .iter()
            .filter(|child| child.kind == NodeEntryKind::Folder)
            .count(),
        3
    );
}

#[test]
fn root_prefix_searches_all_nodes() {
    let (_dir, store) = new_store();
    write_file(&store, "/Knowledge/root-search.md", None, 10);
    write_file(&store, "/Other/root-search.md", None, 11);

    let search_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "root-search".to_string(),
            prefix: Some("/".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("root search should succeed");
    let search_paths = search_hits
        .iter()
        .map(|hit| hit.path.as_str())
        .collect::<Vec<_>>();
    assert!(search_paths.contains(&"/Knowledge/root-search.md"));
    assert!(search_paths.contains(&"/Other/root-search.md"));

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "root-search".to_string(),
            prefix: Some("/".to_string()),
            top_k: 10,
            preview_mode: None,
        })
        .expect("root path search should succeed");
    let path_search_paths = path_hits
        .iter()
        .map(|hit| hit.path.as_str())
        .collect::<Vec<_>>();
    assert!(path_search_paths.contains(&"/Knowledge/root-search.md"));
    assert!(path_search_paths.contains(&"/Other/root-search.md"));
}

#[test]
fn root_prefix_search_includes_source_nodes() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Sources/web/root-search-source.md", 19);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/web/root-search-source.md".to_string(),
                kind: NodeKind::Source,
                content: "source evidence includes needle-source-token".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            20,
        )
        .expect("source write should succeed");

    let search_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "needle-source-token".to_string(),
            prefix: Some("/".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::Light),
        })
        .expect("root search should include source nodes");
    let root_hit = search_hits
        .iter()
        .find(|hit| hit.path == "/Sources/web/root-search-source.md")
        .expect("root search should return the source content hit");
    assert_eq!(root_hit.kind, NodeKind::Source);
    let root_preview = root_hit
        .preview
        .as_ref()
        .expect("source content hit should include a light preview");
    assert_eq!(root_preview.field, SearchPreviewField::Content);
    assert_eq!(root_preview.match_reason, "content_fts");
    assert!(
        root_preview
            .excerpt
            .as_deref()
            .expect("source content preview should include excerpt")
            .contains("needle-source-token")
    );

    let source_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "needle-source-token".to_string(),
            prefix: Some("/Sources".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::Light),
        })
        .expect("sources search should include source nodes");
    assert_eq!(source_hits.len(), 1);
    assert_eq!(source_hits[0].path, "/Sources/web/root-search-source.md");
    assert_eq!(source_hits[0].kind, NodeKind::Source);
    assert!(
        source_hits[0]
            .preview
            .as_ref()
            .and_then(|preview| preview.excerpt.as_deref())
            .is_some_and(|excerpt| excerpt.contains("needle-source-token"))
    );
}

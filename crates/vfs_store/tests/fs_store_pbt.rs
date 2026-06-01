// Where: crates/vfs_store/tests/fs_store_pbt.rs
// What: Property tests for node mutation and wikilink graph consistency.
// Why: Random path operations should not leave stale nodes, etags, or link edges.
use std::collections::{BTreeMap, BTreeSet};

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, FileFailurePersistence};
use tempfile::{TempDir, tempdir};
use vfs_store::FsStore;
use vfs_types::{
    DeleteNodeRequest, IncomingLinksRequest, ListNodesRequest, MkdirNodeRequest, MoveNodeRequest,
    MultiEdit, MultiEditNodeRequest, NodeKind, OutgoingLinksRequest, WriteNodeItem,
    WriteNodeRequest, WriteNodesRequest,
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct ModelNode {
    kind: NodeKind,
    content: String,
}

#[derive(Clone, Debug)]
enum StoreOp {
    Write {
        slot: u8,
        target: u8,
        alias: u8,
        source: bool,
    },
    Move {
        from: u8,
        to: u8,
    },
    DeleteFile {
        slot: u8,
    },
    Mkdir {
        slot: u8,
    },
    DeleteFolder {
        slot: u8,
    },
}

struct TestStore {
    store: FsStore,
    _dir: TempDir,
}

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(128),
        failure_persistence: Some(Box::new(FileFailurePersistence::Off)),
        ..ProptestConfig::default()
    }
}

fn operation_strategy() -> impl Strategy<Value = StoreOp> {
    let slot = 0_u8..6;
    prop_oneof![
        6 => (slot.clone(), slot.clone(), 0_u8..5, any::<bool>())
            .prop_map(|(slot, target, alias, source)| StoreOp::Write { slot, target, alias, source }),
        3 => (slot.clone(), slot.clone()).prop_map(|(from, to)| StoreOp::Move { from, to }),
        3 => slot.clone().prop_map(|slot| StoreOp::DeleteFile { slot }),
        2 => slot.clone().prop_map(|slot| StoreOp::Mkdir { slot }),
        2 => slot.prop_map(|slot| StoreOp::DeleteFolder { slot }),
    ]
}

fn new_store() -> TestStore {
    let dir = tempdir().expect("tempdir should create");
    let path = dir.path().join("wiki.sqlite3");
    let store = FsStore::new(path);
    store.run_fs_migrations().expect("fs migrations should run");
    TestStore { store, _dir: dir }
}

fn file_path(slot: u8) -> String {
    format!("/Wiki/p{slot}.md")
}

fn folder_path(slot: u8) -> String {
    format!("/Wiki/f{slot}")
}

fn ensure_wiki_folder(store: &FsStore, now: i64) {
    store
        .mkdir_node(
            MkdirNodeRequest {
                database_id: "default".to_string(),
                path: "/Wiki".to_string(),
            },
            now,
        )
        .expect("wiki folder should exist");
}

fn etag(store: &FsStore, path: &str) -> Option<String> {
    store
        .read_node(path)
        .expect("node read should succeed")
        .map(|node| node.etag)
}

fn link_content(slot: u8, target: u8, alias: u8) -> String {
    format!(
        "# Node {slot}\n\nlink [[{}|Alias {alias}]]\n",
        file_path(target)
    )
}

fn target_for(content: &str) -> String {
    let start = content.find("[[").expect("content has wikilink") + 2;
    let end = content[start..].find('|').expect("content has alias") + start;
    content[start..end].to_string()
}

fn alias_for(content: &str) -> String {
    let start = content.find('|').expect("content has alias") + 1;
    let end = content[start..]
        .find("]]")
        .expect("content closes wikilink")
        + start;
    content[start..end].to_string()
}

fn apply_op(store: &FsStore, model: &mut BTreeMap<String, ModelNode>, op: StoreOp, now: i64) {
    match op {
        StoreOp::Write {
            slot,
            target,
            alias,
            source,
        } => {
            ensure_wiki_folder(store, now - 1);
            let path = file_path(slot);
            let kind = if source {
                NodeKind::Source
            } else {
                NodeKind::File
            };
            let content = link_content(slot, target, alias);
            store
                .write_node(
                    WriteNodeRequest {
                        database_id: "default".to_string(),
                        path: path.clone(),
                        kind: kind.clone(),
                        content: content.clone(),
                        metadata_json: "{}".to_string(),
                        expected_etag: etag(store, &path),
                    },
                    now,
                )
                .expect("generated write should succeed");
            model.insert(path, ModelNode { kind, content });
        }
        StoreOp::Move { from, to } => {
            let from_path = file_path(from);
            let to_path = file_path(to);
            let before = model.clone();
            let result = store.move_node(
                MoveNodeRequest {
                    database_id: "default".to_string(),
                    from_path: from_path.clone(),
                    to_path: to_path.clone(),
                    expected_etag: etag(store, &from_path),
                    overwrite: true,
                },
                now,
            );
            if from != to && before.contains_key(&from_path) {
                result.expect("generated move should succeed");
                let moved = model.remove(&from_path).expect("model source should exist");
                model.insert(to_path, moved);
            } else {
                assert!(result.is_err());
                assert_eq!(model, &before);
            }
        }
        StoreOp::DeleteFile { slot } => {
            let path = file_path(slot);
            let before = model.clone();
            let result = store.delete_node(
                DeleteNodeRequest {
                    database_id: "default".to_string(),
                    path: path.clone(),
                    expected_etag: etag(store, &path),
                    expected_folder_index_etag: None,
                },
                now,
            );
            if before.contains_key(&path) {
                result.expect("generated delete should succeed");
                model.remove(&path);
            } else {
                assert!(result.is_err());
                assert_eq!(model, &before);
            }
        }
        StoreOp::Mkdir { slot } => {
            ensure_wiki_folder(store, now - 1);
            let path = folder_path(slot);
            store
                .mkdir_node(
                    MkdirNodeRequest {
                        database_id: "default".to_string(),
                        path: path.clone(),
                    },
                    now,
                )
                .expect("generated mkdir should succeed");
            model.insert(
                path,
                ModelNode {
                    kind: NodeKind::Folder,
                    content: String::new(),
                },
            );
        }
        StoreOp::DeleteFolder { slot } => {
            let path = folder_path(slot);
            let before = model.clone();
            let result = store.delete_node(
                DeleteNodeRequest {
                    database_id: "default".to_string(),
                    path: path.clone(),
                    expected_etag: etag(store, &path),
                    expected_folder_index_etag: None,
                },
                now,
            );
            if before.contains_key(&path) {
                result.expect("generated folder delete should succeed");
                model.remove(&path);
            } else {
                assert!(result.is_err());
                assert_eq!(model, &before);
            }
        }
    }
}

fn assert_store_matches_model(store: &FsStore, model: &BTreeMap<String, ModelNode>) {
    for (path, expected) in model {
        let actual = store
            .read_node(path)
            .expect("model path should read")
            .expect("model path should exist");
        assert_eq!(actual.kind, expected.kind);
        assert_eq!(actual.content, expected.content);
    }

    for slot in 0..6 {
        for path in [file_path(slot), folder_path(slot)] {
            if !model.contains_key(&path) {
                assert!(
                    store
                        .read_node(&path)
                        .expect("missing path should read")
                        .is_none(),
                    "stale node remained at {path}"
                );
            }
        }
    }

    let listed = store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Wiki".to_string(),
            recursive: true,
        })
        .expect("list should succeed")
        .into_iter()
        .map(|entry| entry.path)
        .filter(|path| path.starts_with("/Wiki/p") || path.starts_with("/Wiki/f"))
        .collect::<BTreeSet<_>>();
    let expected_paths = model.keys().cloned().collect::<BTreeSet<_>>();
    assert_eq!(listed, expected_paths);

    let mut expected_incoming = BTreeMap::<String, BTreeSet<String>>::new();
    for (source_path, node) in model {
        let outgoing = store
            .outgoing_links(OutgoingLinksRequest {
                database_id: "default".to_string(),
                path: source_path.clone(),
                limit: 20,
            })
            .expect("outgoing links should load");
        if node.kind == NodeKind::Folder {
            assert!(outgoing.is_empty());
            continue;
        }
        let target = target_for(&node.content);
        let alias = alias_for(&node.content);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].source_path, *source_path);
        assert_eq!(outgoing[0].target_path, target);
        assert_eq!(outgoing[0].link_text, alias);
        assert_eq!(outgoing[0].link_kind, "wikilink");
        expected_incoming
            .entry(target)
            .or_default()
            .insert(source_path.clone());
    }

    for slot in 0..6 {
        let target = file_path(slot);
        let incoming = store
            .incoming_links(IncomingLinksRequest {
                database_id: "default".to_string(),
                path: target.clone(),
                limit: 20,
            })
            .expect("incoming links should load")
            .into_iter()
            .map(|edge| edge.source_path)
            .collect::<BTreeSet<_>>();
        let expected = expected_incoming.remove(&target).unwrap_or_default();
        assert_eq!(incoming, expected);
    }
    assert!(expected_incoming.is_empty());
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn fs_store_pbt(operations in prop::collection::vec(operation_strategy(), 1..80)) {
        let env = new_store();
        let store = &env.store;
        let mut model = BTreeMap::new();

        for (index, operation) in operations.into_iter().enumerate() {
            apply_op(store, &mut model, operation, index as i64 + 10);
            assert_store_matches_model(store, &model);
        }
    }
}

fn write_generated_file(store: &FsStore, path: &str, content: &str, now: i64) {
    ensure_wiki_folder(store, now - 1);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: content.to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: etag(store, path),
            },
            now,
        )
        .expect("generated file should write");
}

fn current_content(store: &FsStore, path: &str) -> Option<String> {
    store
        .read_node(path)
        .expect("node should read")
        .map(|node| node.content)
}

fn path_set(store: &FsStore) -> BTreeSet<String> {
    store
        .list_nodes(ListNodesRequest {
            database_id: "default".to_string(),
            prefix: "/Wiki".to_string(),
            recursive: true,
        })
        .expect("nodes should list")
        .into_iter()
        .map(|entry| entry.path)
        .collect()
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn fs_store_pbt_batch_and_multi_edit_atomicity(
        left in 0_u8..6,
        right in 0_u8..6,
        fail_batch in any::<bool>(),
        fail_multi_edit in any::<bool>(),
    ) {
        prop_assume!(left != right);
        let env = new_store();
        let store = &env.store;
        let left_path = file_path(left);
        let right_path = file_path(right);
        write_generated_file(store, &left_path, "alpha [[/Wiki/p0.md|A]] beta\n", 10);
        write_generated_file(store, &right_path, "right [[/Wiki/p1.md|B]]\n", 11);

        let before_left = current_content(store, &left_path);
        let before_right = current_content(store, &right_path);
        let batch = store.write_nodes(
            WriteNodesRequest {
                database_id: "default".to_string(),
                nodes: vec![
                    WriteNodeItem {
                        path: left_path.clone(),
                        kind: NodeKind::File,
                        content: "left batch [[/Wiki/p2.md|C]]\n".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: etag(store, &left_path),
                    },
                    WriteNodeItem {
                        path: right_path.clone(),
                        kind: NodeKind::File,
                        content: "right batch [[/Wiki/p3.md|D]]\n".to_string(),
                        metadata_json: "{}".to_string(),
                        expected_etag: if fail_batch {
                            Some("stale-etag".to_string())
                        } else {
                            etag(store, &right_path)
                        },
                    },
                ],
            },
            12,
        );
        if fail_batch {
            assert!(batch.is_err());
            assert_eq!(current_content(store, &left_path), before_left);
            assert_eq!(current_content(store, &right_path), before_right);
        } else {
            batch.expect("valid batch should write");
            assert_eq!(
                current_content(store, &left_path).as_deref(),
                Some("left batch [[/Wiki/p2.md|C]]\n")
            );
            assert_eq!(
                current_content(store, &right_path).as_deref(),
                Some("right batch [[/Wiki/p3.md|D]]\n")
            );
        }

        let before_multi = current_content(store, &left_path);
        let multi = store.multi_edit_node(
            MultiEditNodeRequest {
                database_id: "default".to_string(),
                path: left_path.clone(),
                edits: vec![
                    MultiEdit {
                        old_text: if fail_multi_edit {
                            "missing-token".to_string()
                        } else {
                            "batch".to_string()
                        },
                        new_text: "edited".to_string(),
                    },
                    MultiEdit {
                        old_text: "[[".to_string(),
                        new_text: "[[".to_string(),
                    },
                ],
                expected_etag: etag(store, &left_path),
            },
            13,
        );
        if fail_multi_edit || fail_batch {
            assert!(multi.is_err());
            assert_eq!(current_content(store, &left_path), before_multi);
        } else {
            multi.expect("valid multi edit should write");
            assert!(
                current_content(store, &left_path)
                    .expect("left content should exist")
                    .contains("edited")
            );
        }
    }

    #[test]
    fn fs_store_pbt_folder_subtree_move_and_non_empty_delete(
        slot in 0_u8..4,
        target in 4_u8..8,
    ) {
        let env = new_store();
        let store = &env.store;
        ensure_wiki_folder(store, 1);
        let from = folder_path(slot);
        let to = folder_path(target);
        store
            .mkdir_node(
                MkdirNodeRequest {
                    database_id: "default".to_string(),
                    path: from.clone(),
                },
                2,
            )
            .expect("source folder should create");
        write_generated_file(
            store,
            &format!("{from}/child.md"),
            "child [relative](sibling.md?view=raw#h) [[../p0.md|P0]]\n",
            3,
        );
        write_generated_file(store, &format!("{from}/sibling.md"), "sibling\n", 4);

        let before = path_set(store);
        assert!(
            store
                .delete_node(
                    DeleteNodeRequest {
                        database_id: "default".to_string(),
                        path: from.clone(),
                        expected_etag: etag(store, &from),
                        expected_folder_index_etag: None,
                    },
                    5,
                )
                .is_err(),
            "non-empty folder delete must fail"
        );
        assert_eq!(path_set(store), before);

        store
            .move_node(
                MoveNodeRequest {
                    database_id: "default".to_string(),
                    from_path: from.clone(),
                    to_path: to.clone(),
                    expected_etag: etag(store, &from),
                    overwrite: false,
                },
                6,
            )
            .expect("folder subtree should move");
        assert!(store.read_node(&from).expect("old folder read").is_none());
        assert!(store
            .read_node(&format!("{from}/child.md"))
            .expect("old child read")
            .is_none());
        assert!(store
            .read_node(&format!("{to}/child.md"))
            .expect("new child read")
            .is_some());

        let outgoing = store
            .outgoing_links(OutgoingLinksRequest {
                database_id: "default".to_string(),
                path: format!("{to}/child.md"),
                limit: 20,
            })
            .expect("moved child links should load");
        let targets = outgoing
            .iter()
            .map(|edge| (edge.source_path.clone(), edge.target_path.clone(), edge.link_kind.clone()))
            .collect::<BTreeSet<_>>();
        assert!(targets.contains(&(
            format!("{to}/child.md"),
            format!("{to}/sibling.md"),
            "markdown".to_string()
        )));
        assert!(targets.contains(&(
            format!("{to}/child.md"),
            "/Wiki/p0.md".to_string(),
            "wikilink".to_string()
        )));
    }

    #[test]
    fn fs_store_pbt_link_generator_variants(
        wiki_target in 0_u8..6,
        rel_target in 0_u8..6,
        source_target in 0_u8..6,
    ) {
        let env = new_store();
        let store = &env.store;
        let path = "/Wiki/links/source.md";
        ensure_wiki_folder(store, 1);
        store
            .mkdir_node(
                MkdirNodeRequest {
                    database_id: "default".to_string(),
                    path: "/Wiki/links".to_string(),
                },
                2,
            )
            .expect("links folder should create");
        let content = format!(
            concat!(
                "[[{}|Wiki Alias]]\n",
                "[Relative](rel{rel_target}.md?view=raw#section \"Title\")\n",
                "[Source](/Sources/raw/{source_target}.md#frag)\n",
                "[External](https://example.com/nope.md)\n",
                "[Hash](#local)\n",
                "[Root](/outside.md)\n",
                "[Broken](missing\n"
            ),
            file_path(wiki_target),
            rel_target = rel_target,
            source_target = source_target
        );
        write_generated_file(store, path, &content, 3);
        let outgoing = store
            .outgoing_links(OutgoingLinksRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                limit: 20,
            })
            .expect("variant links should load");
        let actual = outgoing
            .iter()
            .map(|edge| (edge.target_path.clone(), edge.link_text.clone(), edge.link_kind.clone()))
            .collect::<BTreeSet<_>>();
        let expected = BTreeSet::from([
            (
                file_path(wiki_target),
                "Wiki Alias".to_string(),
                "wikilink".to_string(),
            ),
            (
                format!("/Wiki/links/rel{rel_target}.md"),
                "Relative".to_string(),
                "markdown".to_string(),
            ),
            (
                format!("/Sources/raw/{source_target}.md"),
                "Source".to_string(),
                "markdown".to_string(),
            ),
        ]);
        assert_eq!(actual, expected);
    }
}

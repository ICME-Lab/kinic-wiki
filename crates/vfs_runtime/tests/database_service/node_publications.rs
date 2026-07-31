// Where: crates/vfs_runtime/tests/database_service/node_publications.rs
// What: Public-node publication integration tests over local SQLite stores.
// Why: Publication lifecycle and isolation scenarios form a cohesive suite outside the main service test file.

use super::*;
use vfs_runtime::fail_next_publication_detach_for_test;
use vfs_types::{
    ListChildrenRequest, MkdirNodeRequest, PublishNodeRequest, WriteNodeItem, WriteNodesRequest,
};

fn node_publication_count(root: &std::path::Path, database_id: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT COUNT(*) FROM node_publications WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("publication count should load")
}

#[test]
fn node_publication_exposes_only_the_selected_live_markdown_node() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .grant_database_access("alpha", "owner", "writer", DatabaseRole::Writer, 2)
        .expect("writer access should grant");
    service
        .grant_database_access("alpha", "owner", "reader", DatabaseRole::Reader, 3)
        .expect("reader access should grant");
    for (path, content) in [
        ("/Knowledge/public.md", "public body"),
        ("/Knowledge/private.md", "private body"),
    ] {
        service
            .write_node(
                "owner",
                WriteNodeRequest {
                    database_id: "alpha".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: content.to_string(),
                    metadata_json: r#"{"private":"metadata"}"#.to_string(),
                    expected_etag: None,
                },
                4,
            )
            .expect("node should write");
    }

    let request = PublishNodeRequest {
        database_id: "alpha".to_string(),
        path: "/Knowledge/public.md".to_string(),
    };
    assert!(
        service
            .publish_node(
                "writer",
                request.clone(),
                "00112233445566778899aabbccddeeff",
                5,
            )
            .is_err(),
        "writer must not publish"
    );
    let publication = service
        .publish_node(
            "owner",
            request.clone(),
            "00112233445566778899aabbccddeeff",
            5,
        )
        .expect("owner should publish");
    assert_eq!(
        service
            .publish_node(
                "owner",
                request.clone(),
                "ffeeddccbbaa99887766554433221100",
                6,
            )
            .expect("republishing should return the existing publication"),
        publication
    );
    assert_eq!(
        service
            .get_node_publication("reader", request.clone())
            .expect("reader should inspect publication"),
        Some(publication.clone())
    );
    assert_eq!(
        service
            .get_node_publication("writer", request.clone())
            .expect("writer should inspect publication"),
        Some(publication.clone())
    );
    assert_eq!(
        service
            .get_node_publication("owner", request.clone())
            .expect("owner should inspect publication"),
        Some(publication.clone())
    );

    let public_node = service
        .read_public_node(&publication.public_id)
        .expect("public read should succeed")
        .expect("published node should exist");
    assert_eq!(public_node.content, "public body");
    assert_eq!(public_node.updated_at, 4);
    assert_eq!(public_node.published_at_ms, 5);
    assert!(
        service
            .read_node("alpha", "2vxsx-fae", "/Knowledge/private.md")
            .is_err(),
        "publication must not grant anonymous database access"
    );
    service
        .grant_database_access("alpha", "owner", "2vxsx-fae", DatabaseRole::Reader, 6)
        .expect("anonymous reader access should grant");
    assert!(
        service
            .get_node_publication("2vxsx-fae", request.clone())
            .expect_err("anonymous reader must not inspect publication")
            .contains("anonymous caller not allowed")
    );

    let current_public = service
        .read_node("alpha", "writer", "/Knowledge/public.md")
        .expect("writer should read")
        .expect("public source node should exist");
    let updated_public = service
        .write_node(
            "writer",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/public.md".to_string(),
                kind: NodeKind::File,
                content: "updated public body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(current_public.etag),
            },
            6,
        )
        .expect("writer should edit");
    assert_eq!(
        service
            .read_public_node(&publication.public_id)
            .expect("updated public read should succeed")
            .expect("published node should remain")
            .content,
        "updated public body"
    );

    service
        .move_node(
            "writer",
            MoveNodeRequest {
                database_id: "alpha".to_string(),
                from_path: "/Knowledge/public.md".to_string(),
                to_path: "/Knowledge/moved.md".to_string(),
                expected_etag: Some(updated_public.node.etag),
                overwrite: false,
            },
            7,
        )
        .expect("writer should move");
    assert!(
        service
            .read_public_node(&publication.public_id)
            .expect("old public lookup should succeed")
            .is_none(),
        "move must invalidate the old public URL"
    );
}

#[test]
fn write_node_unpublishes_when_file_becomes_source_without_resurrection() {
    let service = service();
    service
        .create_database("publication-kind-conversion", "owner", 1)
        .expect("database should create");
    let path = "/Knowledge/public.md";
    let created = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "publication-kind-conversion".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: "public body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("node should write");
    let request = PublishNodeRequest {
        database_id: "publication-kind-conversion".to_string(),
        path: path.to_string(),
    };
    let publication = service
        .publish_node(
            "owner",
            request.clone(),
            "00112233445566778899aabbccddeeff",
            3,
        )
        .expect("node should publish");

    fail_next_publication_detach_for_test("publication-kind-conversion");
    let file_update = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "publication-kind-conversion".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: "updated public body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(created.node.etag),
            },
            4,
        )
        .expect("file update should not detach publication");
    assert_eq!(
        service
            .read_public_node(&publication.public_id)
            .expect("public lookup should succeed")
            .expect("file update should remain published")
            .content,
        "updated public body"
    );

    let detach_error = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "publication-kind-conversion".to_string(),
                path: path.to_string(),
                kind: NodeKind::Source,
                content: "source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(file_update.node.etag.clone()),
            },
            5,
        )
        .expect_err("source conversion should stop when publication detach fails");
    assert!(detach_error.contains("injected publication detach failure"));

    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "publication-kind-conversion".to_string(),
                path: path.to_string(),
                kind: NodeKind::Source,
                content: "source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some("stale-etag".to_string()),
            },
            6,
        )
        .expect_err("stale source conversion should fail");
    assert_eq!(
        service
            .get_node_publication("owner", request.clone())
            .expect("publication should load after failed conversion"),
        Some(publication.clone())
    );

    let source = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "publication-kind-conversion".to_string(),
                path: path.to_string(),
                kind: NodeKind::Source,
                content: "source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(file_update.node.etag),
            },
            7,
        )
        .expect("source conversion should succeed");
    assert_eq!(
        service
            .get_node_publication("owner", request.clone())
            .expect("publication state should load"),
        None
    );
    assert!(
        service
            .read_public_node(&publication.public_id)
            .expect("old public lookup should succeed")
            .is_none()
    );
    assert!(
        service
            .list_children(
                "owner",
                ListChildrenRequest {
                    database_id: "publication-kind-conversion".to_string(),
                    path: "/Knowledge".to_string(),
                },
            )
            .expect("children should list")
            .iter()
            .all(|child| !child.is_published)
    );

    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "publication-kind-conversion".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: "private file body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(source.node.etag),
            },
            8,
        )
        .expect("file conversion should succeed");
    assert!(
        service
            .read_public_node(&publication.public_id)
            .expect("old public lookup should succeed")
            .is_none(),
        "returning to File must not resurrect the old public URL"
    );
}

#[test]
fn write_nodes_unpublishes_only_non_file_items_and_restores_on_batch_failure() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let mut writes = Vec::new();
    let mut publications = Vec::new();
    for (path, public_id) in [
        (
            "/Knowledge/source-target.md",
            "00112233445566778899aabbccddeeff",
        ),
        (
            "/Knowledge/file-target.md",
            "ffeeddccbbaa99887766554433221100",
        ),
    ] {
        let write = service
            .write_node(
                "owner",
                WriteNodeRequest {
                    database_id: "alpha".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: path.to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                2,
            )
            .expect("node should write");
        writes.push(write);
        publications.push(
            service
                .publish_node(
                    "owner",
                    PublishNodeRequest {
                        database_id: "alpha".to_string(),
                        path: path.to_string(),
                    },
                    public_id,
                    3,
                )
                .expect("node should publish"),
        );
    }

    let batch = |second_etag: String| WriteNodesRequest {
        database_id: "alpha".to_string(),
        nodes: vec![
            WriteNodeItem {
                path: "/Knowledge/source-target.md".to_string(),
                kind: NodeKind::Source,
                content: "source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(writes[0].node.etag.clone()),
            },
            WriteNodeItem {
                path: "/Knowledge/file-target.md".to_string(),
                kind: NodeKind::File,
                content: "updated file body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: Some(second_etag),
            },
        ],
    };

    service
        .write_nodes("owner", batch("stale-etag".to_string()), 4)
        .expect_err("failed batch should restore detached publications");
    for publication in &publications {
        assert!(
            service
                .read_public_node(&publication.public_id)
                .expect("public lookup should succeed")
                .is_some()
        );
    }

    service
        .write_nodes("owner", batch(writes[1].node.etag.clone()), 5)
        .expect("mixed batch should succeed");
    assert!(
        service
            .read_public_node(&publications[0].public_id)
            .expect("source public lookup should succeed")
            .is_none()
    );
    assert_eq!(
        service
            .read_public_node(&publications[1].public_id)
            .expect("file public lookup should succeed")
            .expect("file item should remain published")
            .content,
        "updated file body"
    );
}

#[test]
fn write_source_for_generation_unpublishes_the_replaced_file() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let path = "/Sources/raw/chatgpt/public.md";
    ensure_parent_folders(&service, "owner", "alpha", path, 2);
    let file = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: "public source preview".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            3,
        )
        .expect("file should write");
    let publication = service
        .publish_node(
            "owner",
            PublishNodeRequest {
                database_id: "alpha".to_string(),
                path: path.to_string(),
            },
            "00112233445566778899aabbccddeeff",
            4,
        )
        .expect("file should publish");
    let mut source_request =
        write_source_for_generation_request("alpha", path, "publication-session");
    source_request.expected_etag = Some(file.node.etag);

    service
        .write_source_for_generation("owner", source_request, 5)
        .expect("source generation write should succeed");
    assert!(
        service
            .read_public_node(&publication.public_id)
            .expect("public lookup should succeed")
            .is_none()
    );
}

#[test]
fn list_children_marks_publications_only_for_database_members() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .grant_database_access("alpha", "owner", "reader", DatabaseRole::Reader, 2)
        .expect("reader access should grant");
    for path in ["/Knowledge/public.md", "/Knowledge/private.md"] {
        service
            .write_node(
                "owner",
                WriteNodeRequest {
                    database_id: "alpha".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: path.to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                3,
            )
            .expect("node should write");
    }
    let publication_request = PublishNodeRequest {
        database_id: "alpha".to_string(),
        path: "/Knowledge/public.md".to_string(),
    };
    service
        .publish_node(
            "owner",
            publication_request.clone(),
            "00112233445566778899aabbccddeeff",
            4,
        )
        .expect("node should publish");
    let children_request = ListChildrenRequest {
        database_id: "alpha".to_string(),
        path: "/Knowledge".to_string(),
    };

    for caller in ["owner", "reader"] {
        let children = service
            .list_children(caller, children_request.clone())
            .expect("database member should list children");
        assert!(
            children
                .iter()
                .any(|child| child.path == "/Knowledge/public.md" && child.is_published)
        );
        assert!(
            children
                .iter()
                .any(|child| child.path == "/Knowledge/private.md" && !child.is_published)
        );
    }
    assert!(
        service
            .list_children("2vxsx-fae", children_request.clone())
            .is_err(),
        "publication must not grant anonymous directory access"
    );
    service
        .grant_database_access("alpha", "owner", "2vxsx-fae", DatabaseRole::Reader, 5)
        .expect("anonymous reader access should grant");
    assert!(
        service
            .list_children("2vxsx-fae", children_request.clone())
            .expect("anonymous reader should list a public database")
            .iter()
            .all(|child| !child.is_published),
        "anonymous database reads must not expose publication state"
    );

    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.execute(
        "INSERT INTO market_entitlements
         (database_id, buyer_principal, listing_id, order_id, purchased_at_ms, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active')",
        params!["alpha", "market-reader", "listing", "order", 6_i64],
    )
    .expect("market entitlement should insert");
    drop(conn);
    let market_children = service
        .list_children("market-reader", children_request.clone())
        .expect("market reader should list entitled database");
    assert!(
        market_children.iter().all(|child| !child.is_published),
        "market entitlement must not expose publication state"
    );

    service
        .unpublish_node("owner", publication_request.clone())
        .expect("owner should unpublish");
    assert!(
        service
            .list_children("owner", children_request.clone())
            .expect("owner should list after unpublish")
            .iter()
            .all(|child| !child.is_published)
    );

    service
        .publish_node(
            "owner",
            publication_request,
            "ffeeddccbbaa99887766554433221100",
            7,
        )
        .expect("node should republish");
    let public_node = service
        .read_node("alpha", "owner", "/Knowledge/public.md")
        .expect("node read should succeed")
        .expect("public node should exist");
    service
        .move_node(
            "owner",
            MoveNodeRequest {
                database_id: "alpha".to_string(),
                from_path: "/Knowledge/public.md".to_string(),
                to_path: "/Knowledge/moved.md".to_string(),
                expected_etag: Some(public_node.etag),
                overwrite: false,
            },
            8,
        )
        .expect("published node should move");
    assert!(
        service
            .list_children("owner", children_request)
            .expect("owner should list after move")
            .iter()
            .all(|child| !child.is_published),
        "moving a published node must clear the Explorer publication state"
    );
}

#[test]
fn delete_and_unpublish_invalidate_public_urls() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let write = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/public.md".to_string(),
                kind: NodeKind::File,
                content: "public body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("node should write");
    let request = PublishNodeRequest {
        database_id: "alpha".to_string(),
        path: "/Knowledge/public.md".to_string(),
    };
    let first = service
        .publish_node(
            "owner",
            request.clone(),
            "00112233445566778899aabbccddeeff",
            3,
        )
        .expect("node should publish");
    service
        .unpublish_node("owner", request.clone())
        .expect("owner should unpublish");
    assert!(
        service
            .read_public_node(&first.public_id)
            .expect("lookup should succeed")
            .is_none()
    );

    let second = service
        .publish_node("owner", request, "ffeeddccbbaa99887766554433221100", 4)
        .expect("node should republish");
    service
        .delete_node(
            "owner",
            DeleteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/public.md".to_string(),
                expected_etag: Some(write.node.etag),
                expected_folder_index_etag: None,
            },
            5,
        )
        .expect("node should delete");
    assert!(
        service
            .read_public_node(&second.public_id)
            .expect("lookup should succeed")
            .is_none()
    );
}

#[test]
fn unpublish_rejects_non_markdown_paths_and_removes_only_the_exact_publication() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .mkdir_node(
            "owner",
            MkdirNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/nested".to_string(),
            },
            2,
        )
        .expect("nested folder should create");
    for (path, content) in [
        ("/Knowledge/first.md", "first public body"),
        ("/Knowledge/nested/second.md", "second public body"),
        ("/Knowledge/not-markdown.txt", "private text body"),
    ] {
        service
            .write_node(
                "owner",
                WriteNodeRequest {
                    database_id: "alpha".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: content.to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                2,
            )
            .expect("node should write");
    }
    let first_request = PublishNodeRequest {
        database_id: "alpha".to_string(),
        path: "/Knowledge/first.md".to_string(),
    };
    let second_request = PublishNodeRequest {
        database_id: "alpha".to_string(),
        path: "/Knowledge/nested/second.md".to_string(),
    };
    let first = service
        .publish_node(
            "owner",
            first_request.clone(),
            "00112233445566778899aabbccddeeff",
            3,
        )
        .expect("first node should publish");
    let second = service
        .publish_node(
            "owner",
            second_request.clone(),
            "ffeeddccbbaa99887766554433221100",
            3,
        )
        .expect("second node should publish");

    for invalid_path in [
        "",
        "/",
        "Knowledge/first.md",
        "/Knowledge",
        "/Knowledge/not-markdown.txt",
        "/Knowledge/missing.md",
    ] {
        service
            .unpublish_node(
                "owner",
                PublishNodeRequest {
                    database_id: "alpha".to_string(),
                    path: invalid_path.to_string(),
                },
            )
            .expect_err("invalid publication path should reject");
        assert!(
            service
                .read_public_node(&first.public_id)
                .expect("first public lookup should succeed")
                .is_some()
        );
        assert!(
            service
                .read_public_node(&second.public_id)
                .expect("second public lookup should succeed")
                .is_some()
        );
    }

    service
        .unpublish_node("owner", first_request)
        .expect("first node should unpublish");
    assert!(
        service
            .read_public_node(&first.public_id)
            .expect("first public lookup should succeed")
            .is_none()
    );
    assert_eq!(
        service
            .read_public_node(&second.public_id)
            .expect("second public lookup should succeed")
            .expect("second publication should remain")
            .content,
        "second public body"
    );
    assert_eq!(
        service
            .get_node_publication("owner", second_request)
            .expect("owner should inspect remaining publication"),
        Some(second)
    );
}

#[test]
fn failed_node_delete_restores_the_same_publication() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/public.md".to_string(),
                kind: NodeKind::File,
                content: "public body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("node should write");
    let request = PublishNodeRequest {
        database_id: "alpha".to_string(),
        path: "/Knowledge/public.md".to_string(),
    };
    let publication = service
        .publish_node(
            "owner",
            request.clone(),
            "00112233445566778899aabbccddeeff",
            3,
        )
        .expect("node should publish");

    service
        .delete_node(
            "owner",
            DeleteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/public.md".to_string(),
                expected_etag: Some("stale-etag".to_string()),
                expected_folder_index_etag: None,
            },
            4,
        )
        .expect_err("stale delete should fail");

    assert_eq!(
        service
            .get_node_publication("owner", request)
            .expect("publication state should load"),
        Some(publication.clone())
    );
    assert_eq!(
        service
            .read_public_node(&publication.public_id)
            .expect("public lookup should succeed")
            .expect("publication should be restored")
            .content,
        "public body"
    );
}

#[test]
fn publication_detach_failure_aborts_overwrite_move() {
    let service = service();
    service
        .create_database("publication-move-detach", "owner", 1)
        .expect("database should create");
    let source = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "publication-move-detach".to_string(),
                path: "/Knowledge/private.md".to_string(),
                kind: NodeKind::File,
                content: "private body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("private node should write");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "publication-move-detach".to_string(),
                path: "/Knowledge/public.md".to_string(),
                kind: NodeKind::File,
                content: "public body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            3,
        )
        .expect("public node should write");
    let publication = service
        .publish_node(
            "owner",
            PublishNodeRequest {
                database_id: "publication-move-detach".to_string(),
                path: "/Knowledge/public.md".to_string(),
            },
            "00112233445566778899aabbccddeeff",
            4,
        )
        .expect("node should publish");

    fail_next_publication_detach_for_test("publication-move-detach");
    let error = service
        .move_node(
            "owner",
            MoveNodeRequest {
                database_id: "publication-move-detach".to_string(),
                from_path: "/Knowledge/private.md".to_string(),
                to_path: "/Knowledge/public.md".to_string(),
                expected_etag: Some(source.node.etag),
                overwrite: true,
            },
            5,
        )
        .expect_err("move should stop when publication detach fails");
    assert!(error.contains("injected publication detach failure"));
    assert_eq!(
        service
            .read_node("publication-move-detach", "owner", "/Knowledge/private.md")
            .expect("private node read should succeed")
            .expect("private node should remain")
            .content,
        "private body"
    );
    assert_eq!(
        service
            .read_public_node(&publication.public_id)
            .expect("public lookup should succeed")
            .expect("original publication should remain")
            .content,
        "public body"
    );
}

#[test]
fn delete_database_removes_node_publications() {
    let (service, root) = service_with_root();
    service
        .create_database("published", "owner", 1)
        .expect("database should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "published".to_string(),
                path: "/Knowledge/public.md".to_string(),
                kind: NodeKind::File,
                content: "public body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("node should write");
    let publication = service
        .publish_node(
            "owner",
            PublishNodeRequest {
                database_id: "published".to_string(),
                path: "/Knowledge/public.md".to_string(),
            },
            "00112233445566778899aabbccddeeff",
            3,
        )
        .expect("node should publish");
    assert_eq!(node_publication_count(&root, "published"), 1);

    service
        .delete_database(delete_request("published"), "owner", 4)
        .expect("published database should delete");

    assert_eq!(node_publication_count(&root, "published"), 0);
    assert!(
        service
            .read_public_node(&publication.public_id)
            .expect("public lookup should succeed")
            .is_none()
    );
}

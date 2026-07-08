// Where: crates/vfs_store/tests/fs_store_search.rs
// What: Search and SQL-budget integration tests for FsStore.
// Why: Keep basic store tests below the file-size ratchet while preserving search coverage.
mod common;

use common::{ensure_parent_folders, new_store, write_file};
use rusqlite::{Connection, params};
use std::path::Path;
use vfs_types::{
    DeleteNodeRequest, MoveNodeRequest, NodeKind, SearchNodePathsRequest, SearchNodesRequest,
    SearchPreviewField, SearchPreviewMode, WriteNodeRequest,
};

fn seed_sql_budget_rows(database_path: &Path, count: i64) {
    let mut conn = Connection::open(database_path).expect("db should open");
    let tx = conn.transaction().expect("seed transaction should start");
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO fs_nodes
                 (path, kind, content, created_at, updated_at, etag, metadata_json, name)
                 VALUES (?1, 'file', ?2, ?3, ?3, ?4, '{}', ?5)",
            )
            .expect("seed insert should prepare");
        for index in 0_i64..count {
            let name = format!("node-{index:05}.md");
            insert
                .execute(params![
                    format!("/Knowledge/budget/{name}"),
                    format!("budget content row {index}"),
                    index,
                    format!("etag-{index}"),
                    name,
                ])
                .expect("seed row should insert");
        }
    }
    tx.commit().expect("seed transaction should commit");
}

fn heavy_missing_sql() -> String {
    let predicates = vec!["length(content) >= 0"; 50].join(" AND ");
    format!(
        "SELECT json_object('path', path) FROM fs_nodes WHERE {predicates} AND content LIKE '%missing-budget-token%' LIMIT 1"
    )
}

#[test]
fn search_nodes_clamps_snippets_from_large_single_token_content() {
    let (_dir, store) = new_store();
    let ascii_content = "x".repeat(1024 * 1024);
    let multibyte_content = "検索".repeat(600);

    for (index, (path, content)) in [
        ("/Knowledge/large-ascii.md", ascii_content),
        ("/Knowledge/large-multibyte.md", multibyte_content),
    ]
    .into_iter()
    .enumerate()
    {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: content.clone(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                100 + index as i64,
            )
            .expect("large token write should succeed");

        let hits = store
            .search_nodes(SearchNodesRequest {
                database_id: "default".to_string(),
                query_text: content,
                prefix: Some("/Knowledge".to_string()),
                top_k: 5,
                preview_mode: Some(SearchPreviewMode::None),
            })
            .expect("large token search should succeed");

        assert!(
            hits.iter().any(|hit| hit.path == path),
            "large token search should return the written node"
        );
        for hit in hits {
            assert!(
                hit.snippet.is_none(),
                "content hits should not materialize content snippet"
            );
        }
    }
}

#[test]
fn search_nodes_light_preview_reports_content_offset_and_excerpt() {
    let (_dir, store) = new_store();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/preview.md".to_string(),
                kind: NodeKind::File,
                content: "prefix text AlphaBeta suffix text".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            200,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alphabeta".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::Light),
        })
        .expect("search should succeed");

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "/Knowledge/preview.md");
    assert!(hits[0].snippet.is_none());
    let preview = hits[0]
        .preview
        .as_ref()
        .expect("light preview should exist");
    assert_eq!(preview.field, SearchPreviewField::Content);
    assert_eq!(preview.match_reason, "content_fts");
    assert_eq!(preview.char_offset, 12);
    assert!(
        preview
            .excerpt
            .as_deref()
            .expect("excerpt should exist")
            .to_ascii_lowercase()
            .contains("alphabeta")
    );
}

#[test]
fn search_nodes_defaults_to_light_preview_when_mode_is_omitted() {
    let (_dir, store) = new_store();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/default-preview.md".to_string(),
                kind: NodeKind::File,
                content: "prefix text AlphaBeta suffix text".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            201,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alphabeta".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 5,
            preview_mode: None,
        })
        .expect("search should succeed");

    assert_eq!(hits.len(), 1);
    assert!(hits[0].preview.is_some());
}

#[test]
fn search_node_paths_content_start_preview_returns_body_prefix() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/path-preview/topic-note.md", 201);
    let content = format!("{}\n\nignored tail", "x".repeat(240));
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/path-preview/topic-note.md".to_string(),
                kind: NodeKind::File,
                content,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            202,
        )
        .expect("write should succeed");

    let hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "topic-note".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::ContentStart),
        })
        .expect("path search should succeed");

    assert_eq!(hits.len(), 1);
    let preview = hits[0]
        .preview
        .as_ref()
        .expect("content start preview should exist");
    assert_eq!(preview.field, SearchPreviewField::Content);
    assert_eq!(preview.match_reason, "content_start");
    assert_eq!(preview.char_offset, 0);
    assert_eq!(preview.excerpt.as_deref(), Some("x".repeat(200).as_str()));
}

#[test]
fn search_nodes_content_start_preview_covers_content_and_path_hits() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/content-start/path-hit.md", 202);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/content-start/path-hit.md".to_string(),
                kind: NodeKind::File,
                content: "path body\nwith\tspacing".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            203,
        )
        .expect("path hit write should succeed");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/content-start/content-hit.md".to_string(),
                kind: NodeKind::File,
                content: "shared-token content\nwith\tspacing".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            204,
        )
        .expect("content hit write should succeed");

    let path_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "path-hit".to_string(),
            prefix: Some("/Knowledge/content-start".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::ContentStart),
        })
        .expect("path hit search should succeed");
    let content_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "shared-token".to_string(),
            prefix: Some("/Knowledge/content-start".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::ContentStart),
        })
        .expect("content hit search should succeed");

    assert_eq!(
        path_hits[0]
            .preview
            .as_ref()
            .and_then(|preview| preview.excerpt.as_deref()),
        Some("path body with spacing")
    );
    assert_eq!(
        content_hits[0]
            .preview
            .as_ref()
            .and_then(|preview| preview.excerpt.as_deref()),
        Some("shared-token content with spacing")
    );
}

#[test]
fn search_content_start_preview_keeps_empty_body_excerpt_empty() {
    let (_dir, store) = new_store();
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/empty-body.md".to_string(),
                kind: NodeKind::File,
                content: " \n\t ".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            205,
        )
        .expect("write should succeed");

    let hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "empty-body".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::ContentStart),
        })
        .expect("path search should succeed");

    assert_eq!(hits.len(), 1);
    assert_eq!(
        hits[0]
            .preview
            .as_ref()
            .and_then(|preview| preview.excerpt.as_ref()),
        None
    );
}

#[test]
fn search_nodes_handles_ten_large_hits_without_loading_full_content() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/large/node-000.md", 499);
    let payload = format!("shared-bench-search {}", "x".repeat(1024 * 1024 - 20));
    for index in 0..100 {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: format!("/Knowledge/large/node-{index:03}.md"),
                    kind: NodeKind::File,
                    content: payload.clone(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                500 + index as i64,
            )
            .expect("large write should succeed");
    }

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "shared-bench-search".to_string(),
            prefix: Some("/Knowledge/large".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    assert_eq!(hits.len(), 10);
    for window in hits.windows(2) {
        assert!(window[0].score <= window[1].score);
    }
    for hit in hits {
        assert!(hit.path.starts_with("/Knowledge/large/"));
        assert!(
            hit.snippet.is_none(),
            "large content hits should skip content snippet materialization"
        );
    }
}

#[test]
fn search_nodes_mixed_large_and_small_hits_can_omit_content_snippets() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/mixed/large.md", 1_399);
    let large_payload = format!("shared-bench-search {}", "x".repeat(1024 * 1024 - 20));
    let small_payload = "shared-bench-search compact preview".to_string();

    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/mixed/large.md".to_string(),
                kind: NodeKind::File,
                content: large_payload,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_400,
        )
        .expect("large write should succeed");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/mixed/small.md".to_string(),
                kind: NodeKind::File,
                content: small_payload,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_401,
        )
        .expect("small write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "shared-bench-search".to_string(),
            prefix: Some("/Knowledge/mixed".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    let large_hit = hits
        .iter()
        .find(|hit| hit.path == "/Knowledge/mixed/large.md")
        .expect("large hit should exist");
    let small_hit = hits
        .iter()
        .find(|hit| hit.path == "/Knowledge/mixed/small.md")
        .expect("small hit should exist");

    assert!(large_hit.snippet.is_none());
    assert!(small_hit.snippet.is_none());
}

#[test]
fn search_nodes_prefers_basename_matches_over_content_only_hits() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/ranking/alpha-beta.md", 1_499);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/ranking/alpha-beta.md".to_string(),
                kind: NodeKind::File,
                content: "ranking body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_500,
        )
        .expect("write should succeed");
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/ranking/other.md".to_string(),
                kind: NodeKind::File,
                content: "alpha beta body only".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_501,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alpha-beta".to_string(),
            prefix: Some("/Knowledge/ranking".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    assert_eq!(hits[0].path, "/Knowledge/ranking/alpha-beta.md");
    assert!(
        hits[0]
            .match_reasons
            .contains(&"basename_exact".to_string()),
        "basename exact should dominate ranking"
    );
}

#[test]
fn search_nodes_recovers_partial_multi_term_matches() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/recall/node-0.md", 1_599);
    for (index, content) in ["alpha beta gamma", "alpha beta", "alpha only", "gamma only"]
        .into_iter()
        .enumerate()
    {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: format!("/Knowledge/recall/node-{index}.md"),
                    kind: NodeKind::File,
                    content: content.to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_600 + index as i64,
            )
            .expect("write should succeed");
    }

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "alpha beta missing".to_string(),
            prefix: Some("/Knowledge/recall".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    assert!(
        hits.iter()
            .any(|hit| hit.path == "/Knowledge/recall/node-0.md"),
        "exact-ish match should remain"
    );
    assert!(
        hits.iter()
            .any(|hit| hit.path == "/Knowledge/recall/node-1.md"),
        "recall stage should keep partial multi-term match"
    );
}

#[test]
fn search_nodes_supports_japanese_queries_without_spaces() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/日本語/検索改善メモ.md", 1_699);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/日本語/検索改善メモ.md".to_string(),
                kind: NodeKind::File,
                content: "検索精度改善の作業メモ".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_700,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "検索改善".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    assert_eq!(hits[0].path, "/Knowledge/日本語/検索改善メモ.md");
    assert!(
        hits[0]
            .match_reasons
            .iter()
            .any(|reason| reason == "path_substring" || reason == "content_substring"),
        "japanese query should surface path or content recall reason"
    );
}

#[test]
fn search_nodes_path_only_hits_keep_path_snippets() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/path-only/unique-title.md", 1_799);
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/path-only/unique-title.md".to_string(),
                kind: NodeKind::File,
                content: "irrelevant body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_800,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "unique-title".to_string(),
            prefix: Some("/Knowledge/path-only".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::Light),
        })
        .expect("search should succeed");

    assert_eq!(
        hits[0].snippet.as_deref(),
        Some("/Knowledge/path-only/unique-title.md")
    );
    let preview = hits[0].preview.as_ref().expect("path preview should exist");
    assert_eq!(preview.field, SearchPreviewField::Path);
    assert_eq!(preview.match_reason, "basename_exact");
    assert_eq!(preview.char_offset, 21);
    assert!(preview.excerpt.is_none());
}

#[test]
fn search_nodes_keeps_basename_exact_hits_above_fts_only_hits() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/fts-heavy/doc-00.md", 1_849);
    for index in 0..12 {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: format!("/Knowledge/fts-heavy/doc-{index:02}.md"),
                    kind: NodeKind::File,
                    content: "focus-token appears in the body".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_850 + index as i64,
            )
            .expect("write should succeed");
    }
    store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/fts-heavy/focus-token.md".to_string(),
                kind: NodeKind::File,
                content: "body without the keyword".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_900,
        )
        .expect("write should succeed");

    let hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "focus-token".to_string(),
            prefix: Some("/Knowledge/fts-heavy".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");

    assert_eq!(hits[0].path, "/Knowledge/fts-heavy/focus-token.md");
    assert!(
        hits[0]
            .match_reasons
            .contains(&"basename_exact".to_string()),
        "basename exact hit should survive FTS candidate truncation"
    );
}

#[test]
fn move_node_refreshes_search_indexes_for_path_and_basename_queries() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/move/source-name.md", 1_899);
    let created = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/move/source-name.md".to_string(),
                kind: NodeKind::File,
                content: "stable body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_900,
        )
        .expect("write should succeed");
    store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Knowledge/move/source-name.md".to_string(),
                to_path: "/Knowledge/move/renamed-note.md".to_string(),
                expected_etag: Some(created.node.etag),
                overwrite: false,
            },
            1_901,
        )
        .expect("move should succeed");

    let new_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "renamed-note".to_string(),
            prefix: Some("/Knowledge/move".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert_eq!(new_hits.len(), 1);
    assert_eq!(new_hits[0].path, "/Knowledge/move/renamed-note.md");
    assert!(
        new_hits[0]
            .match_reasons
            .contains(&"basename_exact".to_string())
    );

    let stale_hits = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "source-name".to_string(),
            prefix: Some("/Knowledge/move".to_string()),
            top_k: 5,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert!(stale_hits.is_empty());

    let path_hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "renamed-note".to_string(),
            prefix: Some("/Knowledge/move".to_string()),
            top_k: 5,
            preview_mode: None,
        })
        .expect("path search should succeed");
    assert_eq!(path_hits.len(), 1);
    assert_eq!(path_hits[0].path, "/Knowledge/move/renamed-note.md");
    assert!(
        path_hits[0]
            .match_reasons
            .contains(&"basename_exact".to_string())
    );
}

#[test]
fn move_node_allows_safe_nonstandard_target_for_source_nodes() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Sources/source/source.md", 1_909);
    ensure_parent_folders(&store, "/Sources/renamed/wrong.md", 1_909);
    let created = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/source/source.md".to_string(),
                kind: NodeKind::Source,
                content: "source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_910,
        )
        .expect("write should succeed");

    let moved = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Sources/source/source.md".to_string(),
                to_path: "/Sources/renamed/wrong.md".to_string(),
                expected_etag: Some(created.node.etag),
                overwrite: false,
            },
            1_911,
        )
        .expect("move should succeed");

    assert_eq!(moved.node.path, "/Sources/renamed/wrong.md");
}

#[test]
fn move_node_accepts_canonical_target_for_source_nodes() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Sources/source/source.md", 1_919);
    ensure_parent_folders(&store, "/Sources/sessions/claudecode/renamed.md", 1_919);
    let created = store
        .write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: "/Sources/source/source.md".to_string(),
                kind: NodeKind::Source,
                content: "source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_920,
        )
        .expect("write should succeed");

    let moved = store
        .move_node(
            MoveNodeRequest {
                database_id: "default".to_string(),
                from_path: "/Sources/source/source.md".to_string(),
                to_path: "/Sources/sessions/claudecode/renamed.md".to_string(),
                expected_etag: Some(created.node.etag),
                overwrite: false,
            },
            1_921,
        )
        .expect("move should succeed");

    assert_eq!(moved.node.path, "/Sources/sessions/claudecode/renamed.md");
    let current = store
        .read_node("/Sources/sessions/claudecode/renamed.md")
        .expect("read should succeed")
        .expect("moved source should exist");
    assert_eq!(current.kind, NodeKind::Source);
}

#[test]
fn source_nodes_allow_domain_specific_prefix_lookalike_paths() {
    let (_dir, store) = new_store();
    for path in ["/Sourcesfoo/foo.md", "/Sources/sessions-foo/x.md"] {
        ensure_parent_folders(&store, path, 1_929);
        let result = store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::Source,
                    content: "source body".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_930,
            )
            .expect("generic store should not enforce wiki source policy");

        assert_eq!(result.node.path, path);
    }
}

#[test]
fn source_nodes_accept_canonical_paths_under_both_roots() {
    let (_dir, store) = new_store();
    for (index, path) in [
        "/Sources/source/source.md",
        "/Sources/sessions/claudecode/session-1.md",
    ]
    .into_iter()
    .enumerate()
    {
        ensure_parent_folders(&store, path, 1_939 + index as i64);
        let result = store.write_node(
            WriteNodeRequest {
                database_id: "default".to_string(),
                path: path.to_string(),
                kind: NodeKind::Source,
                content: "source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            1_940 + index as i64,
        );

        assert!(result.is_ok(), "safe source path should succeed: {path}");
    }
}

#[test]
fn query_limits_are_capped_at_one_hundred() {
    let (_dir, store) = new_store();
    ensure_parent_folders(&store, "/Knowledge/capped/node-000.md", 999);
    for index in 0..150 {
        store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: format!("/Knowledge/capped/node-{index:03}.md"),
                    kind: NodeKind::File,
                    content: format!("shared-cap-token path-cap-{index}"),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_000 + index,
            )
            .expect("write should succeed");
    }

    let search = store
        .search_nodes(SearchNodesRequest {
            database_id: "default".to_string(),
            query_text: "shared-cap-token".to_string(),
            prefix: Some("/Knowledge/capped".to_string()),
            top_k: 1_000,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .expect("search should succeed");
    assert_eq!(search.len(), 100);

    let path_search = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "node".to_string(),
            prefix: Some("/Knowledge/capped".to_string()),
            top_k: 1_000,
            preview_mode: None,
        })
        .expect("path search should succeed");
    assert_eq!(path_search.len(), 100);
}

#[test]
fn database_sql_json_interrupts_heavy_scan_and_clears_progress_handler() {
    let (_dir, store) = new_store();
    seed_sql_budget_rows(store.database_path(), 10_000);

    let normal = store
        .query_sql_json(
            "SELECT json_object('path', path) FROM fs_nodes WHERE path >= '/Knowledge/budget/node-00000.md' ORDER BY path ASC LIMIT 10",
            10,
        )
        .expect("indexed database SQL should succeed");

    assert_eq!(normal.row_count, 10);
    assert_eq!(
        normal.rows[0],
        r#"{"path":"/Knowledge/budget/node-00000.md"}"#
    );

    let error = store
        .query_sql_json(&heavy_missing_sql(), 1)
        .expect_err("heavy database SQL should exceed budget");

    assert!(
        error.contains("database SQL execution budget exceeded"),
        "unexpected error: {error}"
    );

    let after_interrupt = store
        .query_sql_json(
            "SELECT json_object('path', path) FROM fs_nodes WHERE path = '/Knowledge/budget/node-00001.md' LIMIT 1",
            1,
        )
        .expect("progress handler should be cleared after interrupt");

    assert_eq!(
        after_interrupt.rows,
        vec![r#"{"path":"/Knowledge/budget/node-00001.md"}"#]
    );
}

#[test]
fn search_node_paths_filters_deleted_terms_and_orders_deterministically() {
    let (_dir, store) = new_store();
    let first = write_file(&store, "/Knowledge/aaa/nested-note.md", None, 10);
    write_file(&store, "/Knowledge/nested-note.md", None, 11);
    write_file(&store, "/Knowledge/zzz/nested-note.md", None, 12);

    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/zzz/nested-note.md".to_string(),
                expected_etag: Some(first),
                expected_folder_index_etag: None,
            },
            13,
        )
        .expect_err("mismatched etag should fail");

    let latest = store
        .read_node("/Knowledge/zzz/nested-note.md")
        .expect("read should succeed")
        .expect("node should exist");
    store
        .delete_node(
            DeleteNodeRequest {
                database_id: "default".to_string(),
                path: "/Knowledge/zzz/nested-note.md".to_string(),
                expected_etag: Some(latest.etag),
                expected_folder_index_etag: None,
            },
            14,
        )
        .expect("delete should succeed");

    let hits = store
        .search_node_paths(SearchNodePathsRequest {
            database_id: "default".to_string(),
            query_text: "NESTED note".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 10,
            preview_mode: None,
        })
        .expect("path search should succeed");
    let paths = hits.into_iter().map(|hit| hit.path).collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "/Knowledge/nested-note.md".to_string(),
            "/Knowledge/aaa/nested-note.md".to_string()
        ]
    );
}

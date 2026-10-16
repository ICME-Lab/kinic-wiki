#[allow(dead_code)]
mod common;

use std::collections::BTreeMap;

use common::{ensure_parent_folders, new_store};
use serde_json::{Value, json};
use vfs_types::{
    NodeKind, SearchNodesForRetrievalRequest, SearchNodesRequest, SearchPreviewMode,
    WriteNodeRequest,
};

// Reuse the MCP's frozen documents and labels, but execute the real store search.
// The MCP replay alone cannot detect changes to canister candidate ranking.
#[test]
fn frozen_corpus_preserves_english_recall_and_finds_focused_evidence() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../workers/wiki-mcp/evaluation/retrieval-fixture.json"
    ))
    .unwrap();
    let mut stores = BTreeMap::new();
    for (key, node) in fixture["documents"].as_object().unwrap() {
        let (database, path) = key.split_once(':').unwrap();
        let (_, store) = stores.entry(database.to_owned()).or_insert_with(new_store);
        ensure_parent_folders(store, path, 1);
        store
            .write_node(
                WriteNodeRequest {
                    database_id: database.to_owned(),
                    path: path.to_owned(),
                    kind: if node["kind"] == "source"
                        || (node["kind"].is_null() && path.starts_with("/Sources/"))
                    {
                        NodeKind::Source
                    } else {
                        NodeKind::File
                    },
                    content: node["content"].as_str().unwrap().to_owned(),
                    metadata_json: node["metadataJson"].as_str().unwrap_or("{}").to_owned(),
                    expected_etag: None,
                },
                2,
            )
            .unwrap();
    }
    let search = |case: &Value, query: &str| {
        let database = case["databaseId"].as_str().unwrap();
        let store = &stores[database].1;
        let hits = store
            .search_nodes(SearchNodesRequest {
                database_id: database.to_owned(),
                query_text: query.to_owned(),
                prefix: Some("/".to_owned()),
                top_k: 20,
                preview_mode: Some(SearchPreviewMode::Light),
            })
            .unwrap();
        let retrieval = store
            .search_nodes_for_retrieval(SearchNodesForRetrievalRequest {
                database_id: database.to_owned(),
                query_text: query.to_owned(),
                intent: query.to_owned(),
                prefix: Some("/".to_owned()),
                top_k: 20,
            })
            .unwrap();
        assert_eq!(
            hits,
            retrieval.into_iter().map(|r| r.hit).collect::<Vec<_>>()
        );
        let paths: Vec<_> = hits.iter().map(|h| h.path.clone()).collect();
        let rank = paths
            .iter()
            .position(|p| case["labels"][p] == true)
            .map(|i| i + 1);
        json!({"id":case["id"], "query":query, "paths":paths, "first_gold_rank":rank})
    };
    let cases = fixture["cases"].as_array().unwrap();
    let original: Vec<_> = cases
        .iter()
        .map(|c| search(c, c["query"].as_str().unwrap()))
        .collect();
    let focused: Vec<_> = [
        ("dev-parse-json", "req.json"),
        ("dev-japanese-mixed", "Hono CORS origin"),
        ("holdout-basic", "basic"),
        ("holdout-pretty", "pretty JSON"),
        ("holdout-dom-stable", "stable memory"),
        ("sse-close", "SSE timeout"),
        ("sse-close", "sse"),
    ]
    .iter()
    .map(|(id, query)| search(cases.iter().find(|c| c["id"] == *id).unwrap(), query))
    .collect();
    let english_hit20 = cases
        .iter()
        .zip(&original)
        .filter(|(case, result)| {
            case["query"].as_str().unwrap().is_ascii() && !result["first_gold_rank"].is_null()
        })
        .count();
    let report = json!({"english_hit20":english_hit20, "original":original, "focused":focused});
    if let Ok(path) = std::env::var("KINIC_SEARCH_CORPUS_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    // Measured on this exact frozen corpus before the boundary-ranking change.
    assert!(
        english_hit20 >= 34,
        "English hit@20 regressed from the frozen baseline"
    );
    // The sole English positive missing from the old top20 was dev-parse-json.
    // Check each of the other 34 cases so a new hit cannot hide a lost one.
    for (case, result) in cases.iter().zip(&original) {
        if case["query"].as_str().unwrap().is_ascii()
            && case["labels"]
                .as_object()
                .unwrap()
                .values()
                .any(|v| v == true)
            && case["id"] != "dev-parse-json"
        {
            assert!(
                !result["first_gold_rank"].is_null(),
                "lost English case {}",
                case["id"]
            );
        }
    }
    for result in &focused {
        assert!(
            !result["first_gold_rank"].is_null(),
            "missing evidence for {}",
            result["query"]
        );
    }
}

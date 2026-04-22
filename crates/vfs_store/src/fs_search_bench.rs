// Where: crates/vfs_store/src/fs_search_bench.rs
// What: Internal search-stage toggles for bench-only bottleneck isolation.
// Why: Search perf work needs stage-level attribution without changing the public API.
#[cfg(feature = "bench-search-stages")]
use std::sync::{LazyLock, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum SearchBenchStage {
    FtsCandidates,
    ContentSubstringCandidates,
    PathCandidates,
    RerankAdjustment,
}

#[cfg(feature = "bench-search-stages")]
static DISABLED_STAGES: LazyLock<Mutex<Vec<SearchBenchStage>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

#[cfg(feature = "bench-search-stages")]
pub(crate) fn stage_enabled(stage: SearchBenchStage) -> bool {
    !DISABLED_STAGES
        .lock()
        .expect("bench stage lock should not poison")
        .contains(&stage)
}

#[cfg(not(feature = "bench-search-stages"))]
pub(crate) fn stage_enabled(_stage: SearchBenchStage) -> bool {
    true
}

#[cfg(feature = "bench-search-stages")]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn set_disabled_stages(stages: &[SearchBenchStage]) {
    let mut disabled = DISABLED_STAGES
        .lock()
        .expect("bench stage lock should not poison");
    disabled.clear();
    disabled.extend_from_slice(stages);
}

#[cfg(not(feature = "bench-search-stages"))]
#[allow(dead_code)]
pub(crate) fn set_disabled_stages(_stages: &[SearchBenchStage]) {}

#[cfg(all(test, feature = "bench-search-stages"))]
mod tests {
    use std::time::Instant;

    use tempfile::tempdir;
    use vfs_types::{NodeKind, SearchNodesRequest, SearchPreviewMode, WriteNodeRequest};

    use crate::FsStore;

    use super::{SearchBenchStage, set_disabled_stages};

    fn new_store() -> (tempfile::TempDir, FsStore) {
        let dir = tempdir().expect("temp dir should exist");
        let store = FsStore::new(dir.path().join("wiki.sqlite3"));
        store
            .run_fs_migrations()
            .expect("fs migrations should succeed");
        (dir, store)
    }

    fn make_searchable_payload(payload_size_bytes: usize, index: usize) -> String {
        let seed = format!("shared-bench-search node-{index:03} ");
        let filler = "x".repeat(payload_size_bytes.saturating_sub(seed.len()));
        format!("{seed}{filler}")
    }

    fn seed_search_nodes(store: &FsStore, payload_size_bytes: usize) {
        for index in 0..100 {
            store
                .write_node(
                    WriteNodeRequest {
                        path: format!("/Wiki/bench/node-{index:03}.md"),
                        kind: NodeKind::File,
                        content: make_searchable_payload(payload_size_bytes, index),
                        metadata_json: "{}".to_string(),
                        expected_etag: None,
                    },
                    100 + index as i64,
                )
                .expect("seed write should succeed");
        }
    }

    #[test]
    #[ignore = "manual search-stage bottleneck bench"]
    fn search_stage_bench_reports_latency_and_counters() {
        let scenarios = [
            ("baseline", Vec::new()),
            ("no_path_candidates", vec![SearchBenchStage::PathCandidates]),
            (
                "no_rerank_adjustment",
                vec![SearchBenchStage::RerankAdjustment],
            ),
            (
                "no_content_substring",
                vec![SearchBenchStage::ContentSubstringCandidates],
            ),
            (
                "fts_only",
                vec![
                    SearchBenchStage::PathCandidates,
                    SearchBenchStage::RerankAdjustment,
                    SearchBenchStage::ContentSubstringCandidates,
                ],
            ),
        ];
        for payload_size_bytes in [1_024usize, 10_240, 102_400, 1_048_576] {
            for (label, disabled) in &scenarios {
                let (_dir, store) = new_store();
                seed_search_nodes(&store, payload_size_bytes);
                set_disabled_stages(disabled);
                let started_at = Instant::now();
                let mut last_hit_count = 0;
                for _ in 0..50 {
                    let hits = store
                        .search_nodes(SearchNodesRequest {
                            query_text: "shared-bench-search".to_string(),
                            prefix: Some("/Wiki/bench".to_string()),
                            top_k: 10,
                            preview_mode: Some(SearchPreviewMode::None),
                        })
                        .expect("search should succeed");
                    last_hit_count = hits.len();
                }
                let elapsed_us = started_at.elapsed().as_micros() as u64 / 50;
                println!(
                    "search_stage_bench payload_size_bytes={} scenario={} avg_latency_us={} hit_count={}",
                    payload_size_bytes, label, elapsed_us, last_hit_count
                );
            }
        }
        set_disabled_stages(&[]);
    }
}

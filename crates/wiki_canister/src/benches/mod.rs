// Where: crates/wiki_canister/src/benches/mod.rs
// What: Scale-oriented canbench entrypoints for the FS-first canister API.
// Why: Design review needs operation-by-size growth curves rather than one fixed tiny benchmark.
mod scale;

use canbench_rs::{BenchResult, bench};
use scale::{
    BenchCase, FETCH_UPDATED_COUNT, run_append, run_export_snapshot, run_fetch_updates, run_move,
    run_search, run_write,
};
use wiki_types::SearchPreviewMode;

macro_rules! scale_bench {
    ($fn_name:ident, $runner:ident, $operation:literal, $n:expr, $updated:expr) => {
        #[bench(raw)]
        fn $fn_name() -> BenchResult {
            $runner(BenchCase {
                bench_name: stringify!($fn_name),
                operation: $operation,
                n: $n,
                updated_count: $updated,
                preview_mode: SearchPreviewMode::None,
            })
        }
    };
}

macro_rules! search_scale_bench {
    ($fn_name:ident, $mode:expr, $n:expr) => {
        #[bench(raw)]
        fn $fn_name() -> BenchResult {
            run_search(BenchCase {
                bench_name: stringify!($fn_name),
                operation: "search",
                n: $n,
                updated_count: 0,
                preview_mode: $mode,
            })
        }
    };
}

scale_bench!(write_node_scale_n1000, run_write, "write", 1_000, 1);
scale_bench!(write_node_scale_n10000, run_write, "write", 10_000, 1);
scale_bench!(write_node_scale_n50000, run_write, "write", 50_000, 1);
scale_bench!(append_node_scale_n1000, run_append, "append", 1_000, 1);
scale_bench!(append_node_scale_n10000, run_append, "append", 10_000, 1);
scale_bench!(append_node_scale_n50000, run_append, "append", 50_000, 1);
scale_bench!(move_node_scale_n1000, run_move, "move", 1_000, 1);
scale_bench!(move_node_scale_n10000, run_move, "move", 10_000, 1);
scale_bench!(move_node_scale_n50000, run_move, "move", 50_000, 1);
search_scale_bench!(
    search_nodes_scale_none_n1000,
    SearchPreviewMode::None,
    1_000
);
search_scale_bench!(
    search_nodes_scale_none_n10000,
    SearchPreviewMode::None,
    10_000
);
search_scale_bench!(
    search_nodes_scale_none_n50000,
    SearchPreviewMode::None,
    50_000
);
search_scale_bench!(
    search_nodes_scale_light_n1000,
    SearchPreviewMode::Light,
    1_000
);
search_scale_bench!(
    search_nodes_scale_light_n10000,
    SearchPreviewMode::Light,
    10_000
);
search_scale_bench!(
    search_nodes_scale_light_n50000,
    SearchPreviewMode::Light,
    50_000
);
scale_bench!(
    export_snapshot_scale_n50000,
    run_export_snapshot,
    "export_snapshot",
    50_000,
    0
);
scale_bench!(
    export_snapshot_scale_n10000,
    run_export_snapshot,
    "export_snapshot",
    10_000,
    0
);
scale_bench!(
    export_snapshot_scale_n1000,
    run_export_snapshot,
    "export_snapshot",
    1_000,
    0
);
scale_bench!(
    fetch_updates_scale_n50000,
    run_fetch_updates,
    "fetch_updates",
    50_000,
    FETCH_UPDATED_COUNT
);
scale_bench!(
    fetch_updates_scale_n10000,
    run_fetch_updates,
    "fetch_updates",
    10_000,
    FETCH_UPDATED_COUNT
);
scale_bench!(
    fetch_updates_scale_n1000,
    run_fetch_updates,
    "fetch_updates",
    1_000,
    FETCH_UPDATED_COUNT
);

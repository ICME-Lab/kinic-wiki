// Where: crates/wiki_cli/src/bin/vfs_bench/common.rs
// What: Shared benchmark args, path helpers, and latency aggregation for deployed canister benches.
// Why: The workload and latency runners should share one source of truth for scenario labels and metrics.
use clap::ValueEnum;
use clap::builder::PossibleValue;
use serde::{Serialize, Serializer};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryShape {
    Flat,
    Fanout100x100,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum Temperature {
    ColdSeeded,
    WarmRepeat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkloadOperation {
    Create,
    Update,
    Append,
    Edit,
    MoveSameDir,
    MoveCrossDir,
    Delete,
    Read,
    List,
    Search,
    Mkdir,
    Glob,
    Recent,
    MultiEdit,
}

impl ValueEnum for WorkloadOperation {
    fn value_variants<'a>() -> &'a [Self] {
        &[
            Self::Create,
            Self::Update,
            Self::Append,
            Self::Edit,
            Self::MoveSameDir,
            Self::MoveCrossDir,
            Self::Delete,
            Self::Read,
            Self::List,
            Self::Search,
            Self::Mkdir,
            Self::Glob,
            Self::Recent,
            Self::MultiEdit,
        ]
    }

    fn to_possible_value(&self) -> Option<PossibleValue> {
        Some(PossibleValue::new(match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Append => "append",
            Self::Edit => "edit",
            Self::MoveSameDir => "move-same-dir",
            Self::MoveCrossDir => "move-cross-dir",
            Self::Delete => "delete",
            Self::Read => "read",
            Self::List => "list",
            Self::Search => "search",
            Self::Mkdir => "mkdir",
            Self::Glob => "glob",
            Self::Recent => "recent",
            Self::MultiEdit => "multi-edit",
        }))
    }
}

impl Serialize for WorkloadOperation {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(match self {
            WorkloadOperation::Create => "create",
            WorkloadOperation::Update => "update",
            WorkloadOperation::Append => "append",
            WorkloadOperation::Edit => "edit",
            WorkloadOperation::MoveSameDir => "move_same_dir",
            WorkloadOperation::MoveCrossDir => "move_cross_dir",
            WorkloadOperation::Delete => "delete",
            WorkloadOperation::Read => "read",
            WorkloadOperation::List => "list",
            WorkloadOperation::Search => "search",
            WorkloadOperation::Mkdir => "mkdir",
            WorkloadOperation::Glob => "glob",
            WorkloadOperation::Recent => "recent",
            WorkloadOperation::MultiEdit => "multi_edit",
        })
    }
}

/// OpenAI-compatible tool name and optional variant for workload benchmark reporting.
pub fn openai_tool_for_workload(op: WorkloadOperation) -> (&'static str, Option<&'static str>) {
    match op {
        WorkloadOperation::Create => ("write", Some("create")),
        WorkloadOperation::Update => ("write", Some("overwrite")),
        WorkloadOperation::Append => ("append", None),
        WorkloadOperation::Edit => ("edit", None),
        WorkloadOperation::MoveSameDir => ("mv", Some("same_dir")),
        WorkloadOperation::MoveCrossDir => ("mv", Some("cross_dir")),
        WorkloadOperation::Delete => ("rm", None),
        WorkloadOperation::Read => ("read", None),
        WorkloadOperation::List => ("ls", None),
        WorkloadOperation::Search => ("search", None),
        WorkloadOperation::Mkdir => ("mkdir", None),
        WorkloadOperation::Glob => ("glob", None),
        WorkloadOperation::Recent => ("recent", None),
        WorkloadOperation::MultiEdit => ("multi_edit", None),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum LatencyOperation {
    WriteNode,
    AppendNode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementMode {
    ScenarioTotal,
    IsolatedSingleOp,
}

#[derive(Clone, Debug, Serialize)]
pub struct LatencyStats {
    pub request_count: usize,
    pub total_seconds: f64,
    pub avg_latency_us: f64,
    pub p50_latency_us: u64,
    pub p95_latency_us: u64,
    pub p99_latency_us: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct IoStats {
    pub total_request_payload_bytes: u64,
    pub total_response_payload_bytes: u64,
    pub avg_request_payload_bytes: u64,
    pub avg_response_payload_bytes: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct CallMetric {
    pub latency_us: u64,
    pub request_payload_bytes: u64,
    pub response_payload_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct SetupStats {
    pub request_count: usize,
}

pub fn make_payload(payload_size_bytes: usize) -> String {
    "x".repeat(payload_size_bytes)
}

pub fn make_editable_payload(payload_size_bytes: usize) -> String {
    let marker = "BENCH_TOKEN_OLD";
    if payload_size_bytes <= marker.len() {
        return marker[..payload_size_bytes].to_string();
    }
    let mut content = String::with_capacity(payload_size_bytes);
    content.push_str(marker);
    content.push_str(&"x".repeat(payload_size_bytes - marker.len()));
    content
}

/// Two fixed tokens for `multi_edit_node` benchmarks (same length per slot for stable replace).
pub fn make_multi_editable_payload(payload_size_bytes: usize) -> String {
    let a = "BENCH_MULTI_A0";
    let b = "BENCH_MULTI_B0";
    let header = format!("{a}{b}");
    if payload_size_bytes <= header.len() {
        return header[..payload_size_bytes].to_string();
    }
    let mut content = String::with_capacity(payload_size_bytes);
    content.push_str(&header);
    content.push_str(&"x".repeat(payload_size_bytes - header.len()));
    content
}

pub fn make_searchable_payload(payload_size_bytes: usize, index: usize) -> String {
    let prefix = format!("shared-bench-search term-{:06} ", index);
    if payload_size_bytes <= prefix.len() {
        return prefix[..payload_size_bytes].to_string();
    }
    let mut content = String::with_capacity(payload_size_bytes);
    content.push_str(&prefix);
    while content.len() < payload_size_bytes {
        // Keep filler token lengths bounded. SQLite FTS5 snippet() is token-based,
        // so a single 1MB token can expand the snippet before Rust-side clamping.
        let remaining = payload_size_bytes - content.len();
        let chunk = if remaining >= 11 {
            "benchfill "
        } else {
            "benchfill"
        };
        let take = remaining.min(chunk.len());
        content.push_str(&chunk[..take]);
    }
    content
}

pub fn file_path(prefix: &str, shape: DirectoryShape, index: usize) -> String {
    match shape {
        DirectoryShape::Flat => format!("{prefix}/node-{index:06}.md"),
        DirectoryShape::Fanout100x100 => format!(
            "{prefix}/l1-{l1:02}/l2-{l2:02}/node-{leaf:02}-{index:06}.md",
            l1 = (index / 10_000) % 100,
            l2 = (index / 100) % 100,
            leaf = index % 100
        ),
    }
}

/// Glob benchmark patterns must follow the seeded file layout for each shape.
pub fn glob_pattern(shape: DirectoryShape) -> &'static str {
    match shape {
        DirectoryShape::Flat => "node-*.md",
        DirectoryShape::Fanout100x100 => "**/node-*.md",
    }
}

pub fn same_dir_renamed_path(prefix: &str, shape: DirectoryShape, index: usize) -> String {
    match shape {
        DirectoryShape::Flat => format!("{prefix}/node-{index:06}.renamed.md"),
        DirectoryShape::Fanout100x100 => format!(
            "{prefix}/l1-{l1:02}/l2-{l2:02}/node-{leaf:02}-{index:06}.renamed.md",
            l1 = (index / 10_000) % 100,
            l2 = (index / 100) % 100,
            leaf = index % 100
        ),
    }
}

pub fn cross_dir_renamed_path(prefix: &str, shape: DirectoryShape, index: usize) -> String {
    match shape {
        DirectoryShape::Flat => format!("{prefix}/moved/node-{index:06}.md"),
        DirectoryShape::Fanout100x100 => format!(
            "{prefix}/xmove/l1-{l1:02}/l2-{l2:02}/node-{leaf:02}-{index:06}.md",
            l1 = ((index / 10_000) + 1) % 100,
            l2 = ((index / 100) + 1) % 100,
            leaf = index % 100
        ),
    }
}

pub fn list_prefix(prefix: &str, shape: DirectoryShape) -> String {
    match shape {
        DirectoryShape::Flat => prefix.to_string(),
        DirectoryShape::Fanout100x100 => format!("{prefix}/l1-00/l2-00"),
    }
}

pub fn latency_stats(latencies_us: &[u64], total_seconds: f64) -> LatencyStats {
    let mut sorted = latencies_us.to_vec();
    sorted.sort_unstable();
    let count = sorted.len();
    let total_us = sorted.iter().copied().sum::<u64>();
    LatencyStats {
        request_count: count,
        total_seconds,
        avg_latency_us: if count == 0 {
            0.0
        } else {
            total_us as f64 / count as f64
        },
        p50_latency_us: percentile(&sorted, 50),
        p95_latency_us: percentile(&sorted, 95),
        p99_latency_us: percentile(&sorted, 99),
    }
}

pub fn io_stats(metrics: &[CallMetric]) -> IoStats {
    let request_total = metrics
        .iter()
        .map(|metric| metric.request_payload_bytes)
        .sum::<u64>();
    let response_total = metrics
        .iter()
        .map(|metric| metric.response_payload_bytes)
        .sum::<u64>();
    let count = metrics.len() as u64;
    IoStats {
        total_request_payload_bytes: request_total,
        total_response_payload_bytes: response_total,
        avg_request_payload_bytes: request_total.checked_div(count).unwrap_or(0),
        avg_response_payload_bytes: response_total.checked_div(count).unwrap_or(0),
    }
}

fn percentile(sorted: &[u64], pct: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((pct as f64 / 100.0) * (sorted.len().saturating_sub(1)) as f64).floor() as usize;
    sorted[index]
}

#[cfg(test)]
mod tests {
    use super::{
        CallMetric, DirectoryShape, cross_dir_renamed_path, file_path, glob_pattern, io_stats,
        latency_stats, list_prefix, make_editable_payload, make_multi_editable_payload,
        make_searchable_payload, same_dir_renamed_path,
    };

    #[test]
    fn flat_paths_are_stable() {
        assert_eq!(
            file_path("/Wiki/bench", DirectoryShape::Flat, 12),
            "/Wiki/bench/node-000012.md"
        );
        assert_eq!(
            same_dir_renamed_path("/Wiki/bench", DirectoryShape::Flat, 12),
            "/Wiki/bench/node-000012.renamed.md"
        );
        assert_eq!(
            cross_dir_renamed_path("/Wiki/bench", DirectoryShape::Flat, 12),
            "/Wiki/bench/moved/node-000012.md"
        );
        assert_eq!(
            list_prefix("/Wiki/bench", DirectoryShape::Flat),
            "/Wiki/bench"
        );
    }

    #[test]
    fn fanout_paths_are_stable() {
        assert_eq!(
            file_path("/Wiki/bench", DirectoryShape::Fanout100x100, 12_345),
            "/Wiki/bench/l1-01/l2-23/node-45-012345.md"
        );
        assert_eq!(
            same_dir_renamed_path("/Wiki/bench", DirectoryShape::Fanout100x100, 12_345),
            "/Wiki/bench/l1-01/l2-23/node-45-012345.renamed.md"
        );
        assert_eq!(
            list_prefix("/Wiki/bench", DirectoryShape::Fanout100x100),
            "/Wiki/bench/l1-00/l2-00"
        );
    }

    #[test]
    fn latency_stats_use_sorted_percentiles() {
        let stats = latency_stats(&[10, 40, 20, 30, 100], 0.1);
        assert_eq!(stats.request_count, 5);
        assert_eq!(stats.p50_latency_us, 30);
        assert_eq!(stats.p95_latency_us, 40);
        assert_eq!(stats.p99_latency_us, 40);
    }

    #[test]
    fn io_stats_aggregate_bytes() {
        let stats = io_stats(&[
            CallMetric {
                latency_us: 1,
                request_payload_bytes: 10,
                response_payload_bytes: 20,
            },
            CallMetric {
                latency_us: 2,
                request_payload_bytes: 30,
                response_payload_bytes: 40,
            },
        ]);
        assert_eq!(stats.total_request_payload_bytes, 40);
        assert_eq!(stats.total_response_payload_bytes, 60);
        assert_eq!(stats.avg_request_payload_bytes, 20);
        assert_eq!(stats.avg_response_payload_bytes, 30);
    }

    #[test]
    fn payload_builders_embed_expected_tokens() {
        assert!(make_editable_payload(64).starts_with("BENCH_TOKEN_OLD"));
        assert!(make_searchable_payload(64, 12).contains("shared-bench-search"));
        assert!(make_multi_editable_payload(64).starts_with("BENCH_MULTI_A0"));
        assert!(make_multi_editable_payload(64).contains("BENCH_MULTI_B0"));
    }

    #[test]
    fn searchable_payload_keeps_tokens_bounded_at_1mb() {
        let payload = make_searchable_payload(1024 * 1024, 12);
        assert_eq!(payload.len(), 1024 * 1024);
        let max_token_len = payload
            .split_whitespace()
            .map(str::len)
            .max()
            .expect("payload should include at least one token");
        assert!(max_token_len <= "shared-bench-search".len());
    }

    #[test]
    fn glob_patterns_follow_directory_shape() {
        assert_eq!(glob_pattern(DirectoryShape::Flat), "node-*.md");
        assert_eq!(glob_pattern(DirectoryShape::Fanout100x100), "**/node-*.md");
    }

    #[test]
    fn workload_operation_value_enum_lists_all_variants() {
        use super::ValueEnum;
        assert_eq!(super::WorkloadOperation::value_variants().len(), 14);
    }

    #[test]
    fn openai_tool_mapping_matches_agent_tools() {
        use super::WorkloadOperation;
        assert_eq!(
            super::openai_tool_for_workload(WorkloadOperation::Create),
            ("write", Some("create"))
        );
        assert_eq!(
            super::openai_tool_for_workload(WorkloadOperation::Update),
            ("write", Some("overwrite"))
        );
        assert_eq!(
            super::openai_tool_for_workload(WorkloadOperation::List),
            ("ls", None)
        );
        assert_eq!(
            super::openai_tool_for_workload(WorkloadOperation::Delete),
            ("rm", None)
        );
        assert_eq!(
            super::openai_tool_for_workload(WorkloadOperation::MultiEdit),
            ("multi_edit", None)
        );
    }
}

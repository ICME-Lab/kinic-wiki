// Where: crates/wiki_cli/src/beam_bench/report.rs
// What: Scoring and artifact writing for BEAM benchmark runs.
// Why: The benchmark should emit stable machine-readable results plus a short human-readable report.
use anyhow::{Context, Result};
use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use super::model::ToolCallRecord;

#[derive(Debug, Clone, Serialize)]
pub struct QuestionResult {
    pub conversation_id: String,
    pub question_id: String,
    pub question_type: String,
    pub prompt: String,
    pub reference_answer: Option<String>,
    pub predicted_answer: String,
    pub scorable: bool,
    pub exact_match: bool,
    pub normalized_match: bool,
    pub tool_call_count: usize,
    pub tool_error_count: usize,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub latency_ms: u128,
    pub tool_calls: Vec<ToolCallRecord>,
    pub raw_events: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkSummary {
    pub total_questions: usize,
    pub scorable_questions: usize,
    pub unscorable_questions: usize,
    pub exact_matches: usize,
    pub normalized_matches: usize,
    pub exact_accuracy: f64,
    pub normalized_accuracy: f64,
    pub total_tool_calls: usize,
    pub total_tool_errors: usize,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_tokens: u64,
    pub avg_latency_ms: f64,
}

pub fn summarize(results: &[QuestionResult]) -> BenchmarkSummary {
    let scorable_questions = results.iter().filter(|item| item.scorable).count();
    let exact_matches = results
        .iter()
        .filter(|item| item.scorable && item.exact_match)
        .count();
    let normalized_matches = results
        .iter()
        .filter(|item| item.scorable && item.normalized_match)
        .count();
    let total_input_tokens = results.iter().filter_map(|item| item.input_tokens).sum();
    let total_output_tokens = results.iter().filter_map(|item| item.output_tokens).sum();
    let total_tokens = results.iter().filter_map(|item| item.total_tokens).sum();
    let total_tool_calls = results.iter().map(|item| item.tool_call_count).sum();
    let total_tool_errors = results.iter().map(|item| item.tool_error_count).sum();
    let avg_latency_ms = if results.is_empty() {
        0.0
    } else {
        results
            .iter()
            .map(|item| item.latency_ms as f64)
            .sum::<f64>()
            / results.len() as f64
    };
    BenchmarkSummary {
        total_questions: results.len(),
        scorable_questions,
        unscorable_questions: results.len().saturating_sub(scorable_questions),
        exact_matches,
        normalized_matches,
        exact_accuracy: ratio(exact_matches, scorable_questions),
        normalized_accuracy: ratio(normalized_matches, scorable_questions),
        total_tool_calls,
        total_tool_errors,
        total_input_tokens,
        total_output_tokens,
        total_tokens,
        avg_latency_ms,
    }
}

pub fn write_artifacts(
    output_dir: &Path,
    summary: &BenchmarkSummary,
    results: &[QuestionResult],
) -> Result<()> {
    fs::create_dir_all(output_dir)
        .with_context(|| format!("failed to create output dir: {}", output_dir.display()))?;
    fs::write(
        output_dir.join("summary.json"),
        serde_json::to_vec_pretty(summary)?,
    )?;
    write_jsonl(output_dir.join("results.jsonl").as_path(), results.iter())?;
    write_jsonl(
        output_dir.join("failures.jsonl").as_path(),
        results
            .iter()
            .filter(|item| item.tool_error_count > 0 || (item.scorable && !item.normalized_match)),
    )?;
    fs::write(output_dir.join("report.md"), render_report(summary))?;
    Ok(())
}

fn write_jsonl<'a, T>(path: &Path, values: impl Iterator<Item = &'a T>) -> Result<()>
where
    T: Serialize + 'a,
{
    let mut file =
        File::create(path).with_context(|| format!("failed to create {}", path.display()))?;
    for value in values {
        writeln!(file, "{}", serde_json::to_string(value)?)
            .with_context(|| format!("failed to write {}", path.display()))?;
    }
    Ok(())
}

fn render_report(summary: &BenchmarkSummary) -> String {
    format!(
        "# BEAM Benchmark Report\n\n- total questions: {}\n- scorable questions: {}\n- unscorable questions: {}\n- exact accuracy: {:.4}\n- normalized accuracy: {:.4}\n- total tool calls: {}\n- total tool errors: {}\n- total input tokens: {}\n- total output tokens: {}\n- total tokens: {}\n- average latency ms: {:.2}\n",
        summary.total_questions,
        summary.scorable_questions,
        summary.unscorable_questions,
        summary.exact_accuracy,
        summary.normalized_accuracy,
        summary.total_tool_calls,
        summary.total_tool_errors,
        summary.total_input_tokens,
        summary.total_output_tokens,
        summary.total_tokens,
        summary.avg_latency_ms
    )
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        return 0.0;
    }
    numerator as f64 / denominator as f64
}

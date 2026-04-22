// Where: crates/wiki_cli/src/beam_bench/report.rs
// What: Machine-readable BEAM RAG results plus compact summary/report rendering.
// Why: The benchmark must separate retrieval and answer failures so regressions are attributable.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use super::dataset::BeamQuestionClass;
use super::model::ToolCallRecord;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    MissedGoldPath,
    MissedGoldSpan,
    WrongShortAnswer,
    Timeout,
    ToolError,
    RoundtripLimit,
    ShouldAbstainButAnswered,
    TransformMiss,
    GoldFixtureMismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionResult {
    pub conversation_id: String,
    pub question_id: String,
    pub question_type: String,
    pub question_class: BeamQuestionClass,
    pub query: String,
    pub as_of: Option<String>,
    pub reference_answer: Option<String>,
    pub gold_answers: Vec<String>,
    pub predicted_answer: Option<String>,
    pub gold_paths: Vec<String>,
    pub gold_spans: Vec<String>,
    pub expects_abstention: bool,
    pub tags: Vec<String>,
    pub retrieved_paths: Vec<String>,
    pub matched_gold_path: Option<String>,
    pub matched_gold_span: Option<String>,
    pub source_note_type: Option<String>,
    pub answered: bool,
    pub grounded: bool,
    pub answered_without_grounding: bool,
    pub retrieved_paths_nonempty: bool,
    pub read_before_answer: bool,
    pub included_in_primary_metrics: bool,
    pub retrieval_evaluable: bool,
    pub retrieval_hit: bool,
    #[serde(rename = "gold_path_hit@1")]
    pub gold_path_hit_at_1: bool,
    #[serde(rename = "gold_path_hit@3")]
    pub gold_path_hit_at_3: bool,
    #[serde(rename = "gold_span_hit@1")]
    pub gold_span_hit_at_1: bool,
    #[serde(rename = "gold_span_hit@3")]
    pub gold_span_hit_at_3: bool,
    pub answer_exact_match: bool,
    pub answer_normalized_match: bool,
    pub answer_match_given_span_hit: bool,
    pub abstention_correct: bool,
    pub tool_call_count: usize,
    pub tool_error_count: usize,
    pub docs_read_count: usize,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub latency_ms: u128,
    pub spawned_at_ms: Option<u64>,
    pub pid: Option<u32>,
    pub exit_status: Option<i32>,
    pub timed_out: bool,
    pub stderr: Option<String>,
    pub schema_path: Option<String>,
    pub last_tool_name: Option<String>,
    pub last_tool_arguments: Option<String>,
    pub failure_reason: Option<FailureReason>,
    pub tool_calls: Vec<ToolCallRecord>,
    pub raw_events: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkSummary {
    pub read_only_eval: bool,
    pub operational: OperationalMetrics,
    pub raw_beam_like: RawBeamLikeMetrics,
    pub total_questions: usize,
    pub primary_questions: usize,
    pub retrieval_questions: usize,
    pub retrieval_hits: usize,
    pub gold_path_hits_at_1: usize,
    pub gold_path_hits_at_3: usize,
    pub gold_span_hits_at_1: usize,
    pub gold_span_hits_at_3: usize,
    pub answer_exact_matches: usize,
    pub answer_normalized_matches: usize,
    pub answer_matches_given_span_hit: usize,
    pub abstention_questions: usize,
    pub abstention_correct: usize,
    pub answered_questions: usize,
    pub grounded_answers: usize,
    pub answered_without_grounding: usize,
    pub retrieved_paths_nonempty: usize,
    pub read_before_answer: usize,
    pub supported_questions: usize,
    pub unsupported_questions: usize,
    pub retrieval_hit_rate: f64,
    #[serde(rename = "gold_path_hit_rate@1")]
    pub gold_path_hit_rate_at_1: f64,
    #[serde(rename = "gold_path_hit_rate@3")]
    pub gold_path_hit_rate_at_3: f64,
    #[serde(rename = "gold_span_hit_rate@1")]
    pub gold_span_hit_rate_at_1: f64,
    #[serde(rename = "gold_span_hit_rate@3")]
    pub gold_span_hit_rate_at_3: f64,
    pub answer_exact_match_rate: f64,
    pub answer_normalized_match_rate: f64,
    pub answer_match_rate: f64,
    pub answer_match_rate_given_span_hit: f64,
    pub abstention_correct_rate: f64,
    pub answered_rate: f64,
    pub grounded_answer_rate: f64,
    pub answered_without_grounding_rate: f64,
    pub retrieved_paths_nonempty_rate: f64,
    pub read_before_answer_rate: f64,
    pub avg_docs_read_per_answered_question: f64,
    pub run_completed: bool,
    pub timeout_count: usize,
    pub timed_out_questions: Vec<String>,
    pub total_tool_calls: usize,
    pub total_tool_errors: usize,
    pub average_docs_read_per_question: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_tokens: u64,
    pub avg_latency_ms: f64,
    pub by_question_class: BTreeMap<String, ClassSummary>,
    pub by_question_type: BTreeMap<String, QuestionTypeSummary>,
    pub by_tag: BTreeMap<String, TagSummary>,
    pub by_source_note_type: BTreeMap<String, usize>,
    pub failure_reasons: BTreeMap<String, usize>,
    pub top_k_hit_rate_by_rank: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OperationalMetrics {
    pub grounded_answer_rate: f64,
    pub answered_without_grounding_rate: f64,
    pub read_before_answer_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RawBeamLikeMetrics {
    pub answer_match_rate: f64,
    pub abstention_correct_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassSummary {
    pub questions: usize,
    pub retrieval_hits: usize,
    pub answer_normalized_matches: usize,
    pub grounded_answers: usize,
    pub answered_without_grounding: usize,
    pub grounded_answer_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagSummary {
    pub questions: usize,
    pub retrieval_questions: usize,
    pub grounded_answers: usize,
    pub answered_without_grounding: usize,
    #[serde(rename = "gold_path_hit_rate@3")]
    pub gold_path_hit_rate_at_3: f64,
    pub answer_match_rate: f64,
    pub abstention_correct_rate: f64,
    pub grounded_answer_rate: f64,
    pub answered_without_grounding_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuestionTypeSummary {
    pub questions: usize,
    pub grounded_answers: usize,
    pub answered_without_grounding: usize,
    #[serde(rename = "gold_path_hit_rate@3")]
    pub gold_path_hit_rate_at_3: f64,
    pub answer_match_rate: f64,
    pub grounded_answer_rate: f64,
    pub answered_without_grounding_rate: f64,
    pub read_before_answer_rate: f64,
}

pub fn summarize(results: &[QuestionResult], top_k: u32) -> BenchmarkSummary {
    let primary: Vec<&QuestionResult> = results
        .iter()
        .filter(|item| item.included_in_primary_metrics)
        .collect();
    let retrieval: Vec<&QuestionResult> = primary
        .iter()
        .copied()
        .filter(|item| item.retrieval_evaluable)
        .collect();
    let retrieval_hits = retrieval.iter().filter(|item| item.retrieval_hit).count();
    let gold_path_hits_at_1 = retrieval
        .iter()
        .filter(|item| item.gold_path_hit_at_1)
        .count();
    let gold_path_hits_at_3 = retrieval
        .iter()
        .filter(|item| item.gold_path_hit_at_3)
        .count();
    let gold_span_hits_at_1 = retrieval
        .iter()
        .filter(|item| item.gold_span_hit_at_1)
        .count();
    let gold_span_hits_at_3 = retrieval
        .iter()
        .filter(|item| item.gold_span_hit_at_3)
        .count();
    let answer_exact_matches = primary
        .iter()
        .filter(|item| item.answer_exact_match)
        .count();
    let answer_normalized_matches = primary
        .iter()
        .filter(|item| item.answer_normalized_match)
        .count();
    let answer_matches_given_span_hit = primary
        .iter()
        .filter(|item| item.answer_match_given_span_hit)
        .count();
    let abstention: Vec<&QuestionResult> = results
        .iter()
        .filter(|item| item.expects_abstention)
        .collect();
    let abstention_correct = abstention
        .iter()
        .filter(|item| item.abstention_correct)
        .count();
    let answered_questions = results.iter().filter(|item| item.answered).count();
    let grounded_answers = results.iter().filter(|item| item.grounded).count();
    let answered_without_grounding = results
        .iter()
        .filter(|item| item.answered_without_grounding)
        .count();
    let retrieved_paths_nonempty = results
        .iter()
        .filter(|item| item.retrieved_paths_nonempty)
        .count();
    let read_before_answer = results
        .iter()
        .filter(|item| item.read_before_answer)
        .count();
    let supported_questions = results
        .iter()
        .filter(|item| supported_slice_bucket(item) != "unsupported")
        .count();
    let unsupported_questions = results.len().saturating_sub(supported_questions);
    let timeout_count = results.iter().filter(|item| item.timed_out).count();
    let timed_out_questions = results
        .iter()
        .filter(|item| item.timed_out)
        .map(|item| format!("{}:{}", item.conversation_id, item.question_id))
        .collect();
    let total_input_tokens = results.iter().filter_map(|item| item.input_tokens).sum();
    let total_output_tokens = results.iter().filter_map(|item| item.output_tokens).sum();
    let total_tokens = results.iter().filter_map(|item| item.total_tokens).sum();
    let total_tool_calls = results.iter().map(|item| item.tool_call_count).sum();
    let total_tool_errors = results.iter().map(|item| item.tool_error_count).sum();
    let average_docs_read_per_question = if results.is_empty() {
        0.0
    } else {
        results
            .iter()
            .map(|item| item.docs_read_count as f64)
            .sum::<f64>()
            / results.len() as f64
    };
    let avg_docs_read_per_answered_question = if answered_questions == 0 {
        0.0
    } else {
        results
            .iter()
            .filter(|item| item.answered)
            .map(|item| item.docs_read_count as f64)
            .sum::<f64>()
            / answered_questions as f64
    };
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
        read_only_eval: false,
        operational: OperationalMetrics {
            grounded_answer_rate: ratio(grounded_answers, results.len()),
            answered_without_grounding_rate: ratio(answered_without_grounding, results.len()),
            read_before_answer_rate: ratio(read_before_answer, results.len()),
        },
        raw_beam_like: RawBeamLikeMetrics {
            answer_match_rate: ratio(answer_normalized_matches, primary.len()),
            abstention_correct_rate: ratio(abstention_correct, abstention.len()),
        },
        total_questions: results.len(),
        primary_questions: primary.len(),
        retrieval_questions: retrieval.len(),
        retrieval_hits,
        gold_path_hits_at_1,
        gold_path_hits_at_3,
        gold_span_hits_at_1,
        gold_span_hits_at_3,
        answer_exact_matches,
        answer_normalized_matches,
        answer_matches_given_span_hit,
        abstention_questions: abstention.len(),
        abstention_correct,
        answered_questions,
        grounded_answers,
        answered_without_grounding,
        retrieved_paths_nonempty,
        read_before_answer,
        supported_questions,
        unsupported_questions,
        retrieval_hit_rate: ratio(retrieval_hits, retrieval.len()),
        gold_path_hit_rate_at_1: ratio(gold_path_hits_at_1, retrieval.len()),
        gold_path_hit_rate_at_3: ratio(gold_path_hits_at_3, retrieval.len()),
        gold_span_hit_rate_at_1: ratio(gold_span_hits_at_1, retrieval.len()),
        gold_span_hit_rate_at_3: ratio(gold_span_hits_at_3, retrieval.len()),
        answer_exact_match_rate: ratio(answer_exact_matches, primary.len()),
        answer_normalized_match_rate: ratio(answer_normalized_matches, primary.len()),
        answer_match_rate: ratio(answer_normalized_matches, primary.len()),
        answer_match_rate_given_span_hit: ratio(answer_matches_given_span_hit, gold_span_hits_at_3),
        abstention_correct_rate: ratio(abstention_correct, abstention.len()),
        answered_rate: ratio(answered_questions, results.len()),
        grounded_answer_rate: ratio(grounded_answers, results.len()),
        answered_without_grounding_rate: ratio(answered_without_grounding, results.len()),
        retrieved_paths_nonempty_rate: ratio(retrieved_paths_nonempty, results.len()),
        read_before_answer_rate: ratio(read_before_answer, results.len()),
        avg_docs_read_per_answered_question,
        run_completed: true,
        timeout_count,
        timed_out_questions,
        total_tool_calls,
        total_tool_errors,
        average_docs_read_per_question,
        total_input_tokens,
        total_output_tokens,
        total_tokens,
        avg_latency_ms,
        by_question_class: summarize_by_class(results),
        by_question_type: summarize_by_question_type(results),
        by_tag: summarize_by_tag(results),
        by_source_note_type: summarize_note_types(primary.as_slice()),
        failure_reasons: summarize_failure_reasons(results),
        top_k_hit_rate_by_rank: summarize_top_k(retrieval.as_slice(), top_k),
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
        results.iter().filter(|item| item.failure_reason.is_some()),
    )?;
    write_jsonl(
        output_dir.join("codex_runs.jsonl").as_path(),
        results
            .iter()
            .map(CodexRunRecord::from)
            .collect::<Vec<_>>()
            .iter(),
    )?;
    fs::write(
        output_dir.join("failure_manifest.json"),
        serde_json::to_vec_pretty(&build_failure_manifest(results, false))?,
    )?;
    fs::write(
        output_dir.join("retry_manifest.json"),
        serde_json::to_vec_pretty(&build_failure_manifest(results, true))?,
    )?;
    fs::write(
        output_dir.join("transform_miss_report.json"),
        serde_json::to_vec_pretty(&build_transform_miss_report(results))?,
    )?;
    fs::write(
        output_dir.join("supported_slice_report.json"),
        serde_json::to_vec_pretty(&build_supported_slice_report(results))?,
    )?;
    fs::write(output_dir.join("report.md"), render_report(summary))?;
    Ok(())
}

pub fn init_streaming_artifacts(output_dir: &Path, resume: bool) -> Result<()> {
    fs::create_dir_all(output_dir)
        .with_context(|| format!("failed to create output dir: {}", output_dir.display()))?;
    for name in ["results.jsonl", "failures.jsonl", "codex_runs.jsonl"] {
        let path = output_dir.join(name);
        if resume {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .with_context(|| format!("failed to open {}", path.display()))?;
        } else {
            File::create(&path).with_context(|| format!("failed to create {}", path.display()))?;
        }
    }
    Ok(())
}

pub fn load_existing_results(output_dir: &Path) -> Result<Vec<QuestionResult>> {
    let path = output_dir.join("results.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(&path).with_context(|| format!("failed to open {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut results = Vec::new();
    for (line_no, line) in reader.lines().enumerate() {
        let line = line
            .with_context(|| format!("failed to read {} line {}", path.display(), line_no + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let result = serde_json::from_str::<QuestionResult>(&line).with_context(|| {
            format!(
                "failed to parse {} line {} as QuestionResult",
                path.display(),
                line_no + 1
            )
        })?;
        results.push(result);
    }
    Ok(results)
}

pub fn append_result_artifacts(output_dir: &Path, result: &QuestionResult) -> Result<()> {
    append_jsonl_line(output_dir.join("results.jsonl").as_path(), result)?;
    if result.failure_reason.is_some() {
        append_jsonl_line(output_dir.join("failures.jsonl").as_path(), result)?;
    }
    let codex_run = CodexRunRecord::from(result);
    append_jsonl_line(output_dir.join("codex_runs.jsonl").as_path(), &codex_run)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
struct CodexRunRecord {
    conversation_id: String,
    question_id: String,
    question_class: BeamQuestionClass,
    query: String,
    spawned_at_ms: Option<u64>,
    elapsed_ms: u128,
    timed_out: bool,
    exit_status: Option<i32>,
    pid: Option<u32>,
    stderr: Option<String>,
    schema_path: Option<String>,
    tool_call_count: usize,
    last_tool_name: Option<String>,
    last_tool_arguments: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct TransformMissReport {
    total_transform_like_failures: usize,
    by_category: BTreeMap<String, usize>,
    by_tag: BTreeMap<String, usize>,
    by_question_type: BTreeMap<String, usize>,
    examples: Vec<TransformMissExample>,
}

#[derive(Debug, Clone, Serialize)]
struct TransformMissExample {
    conversation_id: String,
    question_id: String,
    question_type: String,
    tags: Vec<String>,
    category: String,
    query: String,
    gold_paths: Vec<String>,
    gold_spans: Vec<String>,
    retrieved_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct FailureManifestEntry {
    conversation_id: String,
    question_id: String,
    question_type: String,
    question_class: BeamQuestionClass,
    failure_reason: FailureReason,
    query: String,
}

#[derive(Debug, Clone, Serialize)]
struct SupportedSliceReport {
    supported_questions: usize,
    unsupported_questions: usize,
    by_bucket: BTreeMap<String, usize>,
}

impl From<&QuestionResult> for CodexRunRecord {
    fn from(result: &QuestionResult) -> Self {
        Self {
            conversation_id: result.conversation_id.clone(),
            question_id: result.question_id.clone(),
            question_class: result.question_class,
            query: result.query.clone(),
            spawned_at_ms: result.spawned_at_ms,
            elapsed_ms: result.latency_ms,
            timed_out: result.timed_out,
            exit_status: result.exit_status,
            pid: result.pid,
            stderr: result.stderr.clone(),
            schema_path: result.schema_path.clone(),
            tool_call_count: result.tool_call_count,
            last_tool_name: result.last_tool_name.clone(),
            last_tool_arguments: result.last_tool_arguments.clone(),
        }
    }
}

fn build_transform_miss_report(results: &[QuestionResult]) -> TransformMissReport {
    let mut by_category = BTreeMap::new();
    let mut by_tag = BTreeMap::new();
    let mut by_question_type = BTreeMap::new();
    let mut examples = Vec::new();

    for result in results {
        let Some(category) = transform_like_category(result) else {
            continue;
        };
        *by_category.entry(category.clone()).or_insert(0) += 1;
        for tag in &result.tags {
            *by_tag.entry(tag.clone()).or_insert(0) += 1;
        }
        *by_question_type
            .entry(result.question_type.clone())
            .or_insert(0) += 1;
        if examples.len() < 20 {
            examples.push(TransformMissExample {
                conversation_id: result.conversation_id.clone(),
                question_id: result.question_id.clone(),
                question_type: result.question_type.clone(),
                tags: result.tags.clone(),
                category,
                query: result.query.clone(),
                gold_paths: result.gold_paths.clone(),
                gold_spans: result.gold_spans.clone(),
                retrieved_paths: result.retrieved_paths.clone(),
            });
        }
    }

    TransformMissReport {
        total_transform_like_failures: by_category.values().sum(),
        by_category,
        by_tag,
        by_question_type,
        examples,
    }
}

fn build_failure_manifest(
    results: &[QuestionResult],
    retryable_only: bool,
) -> Vec<FailureManifestEntry> {
    results
        .iter()
        .filter_map(|result| {
            let reason = result.failure_reason?;
            if retryable_only
                && !matches!(reason, FailureReason::Timeout | FailureReason::ToolError)
            {
                return None;
            }
            Some(FailureManifestEntry {
                conversation_id: result.conversation_id.clone(),
                question_id: result.question_id.clone(),
                question_type: result.question_type.clone(),
                question_class: result.question_class,
                failure_reason: reason,
                query: result.query.clone(),
            })
        })
        .collect()
}

fn build_supported_slice_report(results: &[QuestionResult]) -> SupportedSliceReport {
    let mut by_bucket = BTreeMap::new();
    let mut supported_questions = 0;
    let mut unsupported_questions = 0;
    for result in results {
        let bucket = supported_slice_bucket(result);
        if bucket == "unsupported" {
            unsupported_questions += 1;
        } else {
            supported_questions += 1;
        }
        *by_bucket.entry(bucket).or_insert(0) += 1;
    }
    SupportedSliceReport {
        supported_questions,
        unsupported_questions,
        by_bucket,
    }
}

fn transform_like_category(result: &QuestionResult) -> Option<String> {
    match result.failure_reason {
        Some(FailureReason::TransformMiss) => {
            if result.gold_paths.is_empty() {
                Some("gold_paths_empty".to_string())
            } else if result.gold_spans.is_empty() {
                Some("gold_spans_empty".to_string())
            } else {
                Some("note_materialization_miss".to_string())
            }
        }
        Some(FailureReason::GoldFixtureMismatch) => Some("note_materialization_miss".to_string()),
        Some(FailureReason::MissedGoldPath) if !result.gold_paths.is_empty() => {
            Some("path_mismatch".to_string())
        }
        _ => None,
    }
}

fn supported_slice_bucket(result: &QuestionResult) -> String {
    match result.question_type.as_str() {
        "abstention"
        | "contradiction_resolution"
        | "event_ordering"
        | "information_extraction"
        | "instruction_following"
        | "knowledge_update"
        | "multi_session_reasoning"
        | "preference_following"
        | "summarization"
        | "temporal_reasoning" => result.question_type.clone(),
        _ => "unsupported".to_string(),
    }
}

fn summarize_by_class(results: &[QuestionResult]) -> BTreeMap<String, ClassSummary> {
    let mut summary = BTreeMap::new();
    for result in results {
        let key = serde_json::to_string(&result.question_class)
            .unwrap_or_else(|_| "\"unknown\"".to_string())
            .trim_matches('"')
            .to_string();
        let entry = summary.entry(key).or_insert(ClassSummary {
            questions: 0,
            retrieval_hits: 0,
            answer_normalized_matches: 0,
            grounded_answers: 0,
            answered_without_grounding: 0,
            grounded_answer_rate: 0.0,
        });
        entry.questions += 1;
        if result.retrieval_evaluable && result.gold_path_hit_at_3 {
            entry.retrieval_hits += 1;
        }
        if result.answer_normalized_match {
            entry.answer_normalized_matches += 1;
        }
        if result.grounded {
            entry.grounded_answers += 1;
        }
        if result.answered_without_grounding {
            entry.answered_without_grounding += 1;
        }
    }
    for entry in summary.values_mut() {
        entry.grounded_answer_rate = ratio(entry.grounded_answers, entry.questions);
    }
    summary
}

fn summarize_note_types(results: &[&QuestionResult]) -> BTreeMap<String, usize> {
    let mut summary = BTreeMap::new();
    for result in results {
        if let Some(note_type) = &result.source_note_type {
            *summary.entry(note_type.clone()).or_insert(0) += 1;
        }
    }
    summary
}

fn summarize_by_tag(results: &[QuestionResult]) -> BTreeMap<String, TagSummary> {
    let mut buckets = BTreeMap::new();
    for result in results {
        for tag in &result.tags {
            let entry = buckets.entry(tag.clone()).or_insert((
                0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0usize,
            ));
            entry.0 += 1;
            if result.retrieval_evaluable {
                entry.1 += 1;
            }
            if result.gold_path_hit_at_3 {
                entry.2 += 1;
            }
            if result.answer_normalized_match {
                entry.3 += 1;
            }
            if result.grounded {
                entry.6 += 1;
            }
            if result.answered_without_grounding {
                entry.7 += 1;
            }
            if result.expects_abstention {
                entry.4 += 1;
                if result.abstention_correct {
                    entry.5 += 1;
                }
            }
        }
    }
    buckets
        .into_iter()
        .map(|(tag, counts)| {
            (
                tag,
                TagSummary {
                    questions: counts.0,
                    retrieval_questions: counts.1,
                    grounded_answers: counts.6,
                    answered_without_grounding: counts.7,
                    gold_path_hit_rate_at_3: ratio(counts.2, counts.1),
                    answer_match_rate: ratio(counts.3, counts.0),
                    abstention_correct_rate: ratio(counts.5, counts.4),
                    grounded_answer_rate: ratio(counts.6, counts.0),
                    answered_without_grounding_rate: ratio(counts.7, counts.0),
                },
            )
        })
        .collect()
}

fn summarize_by_question_type(results: &[QuestionResult]) -> BTreeMap<String, QuestionTypeSummary> {
    let mut buckets = BTreeMap::new();
    for result in results {
        let entry = buckets
            .entry(result.question_type.clone())
            .or_insert((0usize, 0usize, 0usize, 0usize, 0usize, 0usize));
        entry.0 += 1;
        if result.grounded {
            entry.1 += 1;
        }
        if result.answered_without_grounding {
            entry.2 += 1;
        }
        if result.gold_path_hit_at_3 {
            entry.3 += 1;
        }
        if result.answer_normalized_match {
            entry.4 += 1;
        }
        if result.read_before_answer {
            entry.5 += 1;
        }
    }
    buckets
        .into_iter()
        .map(|(question_type, counts)| {
            (
                question_type,
                QuestionTypeSummary {
                    questions: counts.0,
                    grounded_answers: counts.1,
                    answered_without_grounding: counts.2,
                    gold_path_hit_rate_at_3: ratio(counts.3, counts.0),
                    answer_match_rate: ratio(counts.4, counts.0),
                    grounded_answer_rate: ratio(counts.1, counts.0),
                    answered_without_grounding_rate: ratio(counts.2, counts.0),
                    read_before_answer_rate: ratio(counts.5, counts.0),
                },
            )
        })
        .collect()
}

fn summarize_failure_reasons(results: &[QuestionResult]) -> BTreeMap<String, usize> {
    let mut summary = BTreeMap::new();
    for result in results {
        if let Some(reason) = result.failure_reason {
            let key = serde_json::to_string(&reason)
                .unwrap_or_else(|_| "\"unknown\"".to_string())
                .trim_matches('"')
                .to_string();
            *summary.entry(key).or_insert(0) += 1;
        }
    }
    summary
}

fn summarize_top_k(results: &[&QuestionResult], top_k: u32) -> Vec<f64> {
    let mut rates = Vec::new();
    for rank in 1..=top_k.max(1) {
        let hits = results
            .iter()
            .filter(|item| {
                item.gold_paths.iter().any(|gold| {
                    item.retrieved_paths
                        .iter()
                        .take(rank as usize)
                        .any(|path| path == gold)
                })
            })
            .count();
        rates.push(ratio(hits, results.len()));
    }
    rates
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

fn append_jsonl_line<T>(path: &Path, value: &T) -> Result<()>
where
    T: Serialize,
{
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("failed to open {} for append", path.display()))?;
    writeln!(file, "{}", serde_json::to_string(value)?)
        .with_context(|| format!("failed to append {}", path.display()))?;
    file.flush()
        .with_context(|| format!("failed to flush {}", path.display()))?;
    Ok(())
}

fn render_report(summary: &BenchmarkSummary) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# BEAM RAG Benchmark Report");
    let _ = writeln!(out);
    let _ = writeln!(out, "## Headline");
    let _ = writeln!(out);
    let _ = writeln!(out, "- total questions: {}", summary.total_questions);
    let _ = writeln!(out, "- run completed: {}", summary.run_completed);
    let _ = writeln!(
        out,
        "- grounded answer rate: {:.4}",
        summary.operational.grounded_answer_rate
    );
    let _ = writeln!(
        out,
        "- answer match rate: {:.4}",
        summary.raw_beam_like.answer_match_rate
    );
    let _ = writeln!(
        out,
        "- abstention correct rate: {:.4}",
        summary.raw_beam_like.abstention_correct_rate
    );
    let _ = writeln!(out);
    let _ = writeln!(out, "## Operational");
    let _ = writeln!(out);
    let _ = writeln!(out, "- answered rate: {:.4}", summary.answered_rate);
    let _ = writeln!(
        out,
        "- grounded answer rate: {:.4}",
        summary.operational.grounded_answer_rate
    );
    let _ = writeln!(
        out,
        "- answered without grounding rate: {:.4}",
        summary.operational.answered_without_grounding_rate
    );
    let _ = writeln!(
        out,
        "- read before answer rate: {:.4}",
        summary.operational.read_before_answer_rate
    );
    let _ = writeln!(
        out,
        "- retrieved paths nonempty rate: {:.4}",
        summary.retrieved_paths_nonempty_rate
    );
    let _ = writeln!(out);
    let _ = writeln!(out, "## Answer Quality");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "- answer exact match rate: {:.4}",
        summary.answer_exact_match_rate
    );
    let _ = writeln!(
        out,
        "- answer normalized match rate: {:.4}",
        summary.answer_normalized_match_rate
    );
    let _ = writeln!(out, "- answer match rate: {:.4}", summary.answer_match_rate);
    let _ = writeln!(
        out,
        "- answer match rate given span hit: {:.4}",
        summary.answer_match_rate_given_span_hit
    );
    let _ = writeln!(
        out,
        "- abstention correct rate: {:.4}",
        summary.abstention_correct_rate
    );
    let _ = writeln!(out);
    let _ = writeln!(out, "## Retrieval Diagnostics");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "- retrieval hit rate: {:.4}",
        summary.retrieval_hit_rate
    );
    let _ = writeln!(
        out,
        "- gold path hit rate @1: {:.4}",
        summary.gold_path_hit_rate_at_1
    );
    let _ = writeln!(
        out,
        "- gold path hit rate @3: {:.4}",
        summary.gold_path_hit_rate_at_3
    );
    let _ = writeln!(
        out,
        "- gold span hit rate @1: {:.4}",
        summary.gold_span_hit_rate_at_1
    );
    let _ = writeln!(
        out,
        "- gold span hit rate @3: {:.4}",
        summary.gold_span_hit_rate_at_3
    );
    let _ = writeln!(out);
    let _ = writeln!(out, "## Runtime Diagnostics");
    let _ = writeln!(out);
    let _ = writeln!(out, "- read only eval: {}", summary.read_only_eval);
    let _ = writeln!(out, "- primary questions: {}", summary.primary_questions);
    let _ = writeln!(
        out,
        "- retrieval questions: {}",
        summary.retrieval_questions
    );
    let _ = writeln!(
        out,
        "- supported questions: {}",
        summary.supported_questions
    );
    let _ = writeln!(
        out,
        "- unsupported questions: {}",
        summary.unsupported_questions
    );
    let _ = writeln!(out, "- timeout count: {}", summary.timeout_count);
    let _ = writeln!(out, "- total tool calls: {}", summary.total_tool_calls);
    let _ = writeln!(out, "- total tool errors: {}", summary.total_tool_errors);
    let _ = writeln!(
        out,
        "- average docs read: {:.2}",
        summary.average_docs_read_per_question
    );
    let _ = writeln!(
        out,
        "- average docs read per answered question: {:.2}",
        summary.avg_docs_read_per_answered_question
    );
    let _ = writeln!(out, "- average latency ms: {:.2}", summary.avg_latency_ms);
    let _ = writeln!(out, "- total input tokens: {}", summary.total_input_tokens);
    let _ = writeln!(
        out,
        "- total output tokens: {}",
        summary.total_output_tokens
    );
    let _ = writeln!(out, "- total tokens: {}", summary.total_tokens);
    let _ = writeln!(out);
    let _ = writeln!(out, "## Failure Reasons");
    let _ = writeln!(out);
    for (reason, count) in &summary.failure_reasons {
        let _ = writeln!(out, "- {}: {}", reason, count);
    }
    let _ = writeln!(out);
    let _ = writeln!(out, "## Question Types");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "| type | questions | grounded | read_before | answer_match | gold_path@3 | answered_without_grounding |"
    );
    let _ = writeln!(out, "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (question_type, item) in &summary.by_question_type {
        let _ = writeln!(
            out,
            "| {} | {} | {:.4} | {:.4} | {:.4} | {:.4} | {:.4} |",
            question_type,
            item.questions,
            item.grounded_answer_rate,
            item.read_before_answer_rate,
            item.answer_match_rate,
            item.gold_path_hit_rate_at_3,
            item.answered_without_grounding_rate,
        );
    }
    let _ = writeln!(out);
    let _ = writeln!(out, "## Source Note Types");
    let _ = writeln!(out);
    for (note_type, count) in &summary.by_source_note_type {
        let _ = writeln!(out, "- {}: {}", note_type, count);
    }
    let _ = writeln!(out);
    let _ = writeln!(out, "## Key Slices");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "- information_extraction grounded_answer_rate: {:.4}",
        question_type_metric(summary, "information_extraction", |item| item
            .grounded_answer_rate)
    );
    let _ = writeln!(
        out,
        "- temporal_reasoning grounded_answer_rate: {:.4}",
        question_type_metric(summary, "temporal_reasoning", |item| item
            .grounded_answer_rate)
    );
    let _ = writeln!(
        out,
        "- event_ordering grounded_answer_rate: {:.4}",
        question_type_metric(summary, "event_ordering", |item| item.grounded_answer_rate)
    );
    let _ = writeln!(
        out,
        "- instruction_following grounded_answer_rate: {:.4}",
        question_type_metric(summary, "instruction_following", |item| item
            .grounded_answer_rate)
    );
    let _ = writeln!(
        out,
        "- preference_following grounded_answer_rate: {:.4}",
        question_type_metric(summary, "preference_following", |item| item
            .grounded_answer_rate)
    );
    let _ = writeln!(
        out,
        "- knowledge_update grounded_answer_rate: {:.4}",
        question_type_metric(summary, "knowledge_update", |item| item
            .grounded_answer_rate)
    );
    let _ = writeln!(
        out,
        "- contradiction_resolution grounded_answer_rate: {:.4}",
        question_type_metric(summary, "contradiction_resolution", |item| item
            .grounded_answer_rate)
    );
    let _ = writeln!(
        out,
        "- summarization grounded_answer_rate: {:.4}",
        question_type_metric(summary, "summarization", |item| item.grounded_answer_rate)
    );
    let _ = writeln!(
        out,
        "- multi_session_reasoning grounded_answer_rate: {:.4}",
        question_type_metric(summary, "multi_session_reasoning", |item| item
            .grounded_answer_rate)
    );
    let _ = writeln!(
        out,
        "- abstention_correct_rate: {:.4}",
        tag_metric(summary, "abstention", |item| item.abstention_correct_rate)
    );
    out
}

fn tag_metric(summary: &BenchmarkSummary, tag: &str, project: impl Fn(&TagSummary) -> f64) -> f64 {
    summary.by_tag.get(tag).map(project).unwrap_or(0.0)
}

fn question_type_metric(
    summary: &BenchmarkSummary,
    question_type: &str,
    project: impl Fn(&QuestionTypeSummary) -> f64,
) -> f64 {
    summary
        .by_question_type
        .get(question_type)
        .map(project)
        .unwrap_or(0.0)
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        return 0.0;
    }
    numerator as f64 / denominator as f64
}

#[cfg(test)]
mod tests {
    use super::{
        BenchmarkSummary, FailureReason, QuestionResult, init_streaming_artifacts,
        load_existing_results, summarize, write_artifacts,
    };
    use crate::beam_bench::dataset::BeamQuestionClass;
    use crate::beam_bench::report::append_result_artifacts;
    use std::fs;
    use tempfile::tempdir;

    fn result(id: &str, class: BeamQuestionClass) -> QuestionResult {
        QuestionResult {
            conversation_id: "conv".to_string(),
            question_id: id.to_string(),
            question_type: "factoid".to_string(),
            question_class: class,
            query: "When?".to_string(),
            as_of: None,
            reference_answer: Some("March 15, 2024".to_string()),
            gold_answers: vec!["March 15, 2024".to_string()],
            predicted_answer: Some("March 15, 2024".to_string()),
            gold_paths: vec!["/Wiki/run/conv/facts.md".to_string()],
            gold_spans: vec!["March 15, 2024".to_string()],
            expects_abstention: false,
            tags: vec!["factoid".to_string(), "facts".to_string()],
            retrieved_paths: vec!["/Wiki/run/conv/facts.md".to_string()],
            matched_gold_path: Some("/Wiki/run/conv/facts.md".to_string()),
            matched_gold_span: Some("March 15, 2024".to_string()),
            source_note_type: Some("facts".to_string()),
            answered: true,
            grounded: true,
            answered_without_grounding: false,
            retrieved_paths_nonempty: true,
            read_before_answer: true,
            included_in_primary_metrics: class == BeamQuestionClass::Factoid,
            retrieval_evaluable: true,
            retrieval_hit: true,
            gold_path_hit_at_1: true,
            gold_path_hit_at_3: true,
            gold_span_hit_at_1: true,
            gold_span_hit_at_3: true,
            answer_exact_match: true,
            answer_normalized_match: true,
            answer_match_given_span_hit: true,
            abstention_correct: false,
            tool_call_count: 2,
            tool_error_count: 0,
            docs_read_count: 1,
            input_tokens: Some(0),
            output_tokens: Some(0),
            total_tokens: Some(0),
            latency_ms: 10,
            spawned_at_ms: Some(1),
            pid: Some(2),
            exit_status: Some(0),
            timed_out: false,
            stderr: None,
            schema_path: None,
            last_tool_name: None,
            last_tool_arguments: None,
            failure_reason: None,
            tool_calls: Vec::new(),
            raw_events: Vec::new(),
        }
    }

    #[test]
    fn summarize_tracks_primary_metrics_only() {
        let mut reasoning = result("reasoning", BeamQuestionClass::Reasoning);
        reasoning.included_in_primary_metrics = false;
        reasoning.retrieval_hit = false;
        reasoning.gold_path_hit_at_3 = false;
        reasoning.answer_normalized_match = false;
        reasoning.failure_reason = Some(FailureReason::MissedGoldPath);
        let summary: BenchmarkSummary =
            summarize(&[result("fact", BeamQuestionClass::Factoid), reasoning], 3);
        assert_eq!(summary.primary_questions, 1);
        assert_eq!(summary.retrieval_questions, 1);
        assert_eq!(summary.retrieval_hits, 1);
        assert_eq!(summary.gold_path_hit_rate_at_3, 1.0);
        assert_eq!(
            summary.failure_reasons.get("missed_gold_path").copied(),
            Some(1)
        );
        assert_eq!(summary.top_k_hit_rate_by_rank.len(), 3);
    }

    #[test]
    fn summarize_excludes_non_evaluable_retrieval_from_denominator() {
        let mut legacy = result("legacy", BeamQuestionClass::Factoid);
        legacy.retrieval_evaluable = false;
        legacy.retrieval_hit = false;
        legacy.gold_path_hit_at_1 = false;
        legacy.gold_path_hit_at_3 = false;
        let summary = summarize(&[legacy], 3);
        assert_eq!(summary.primary_questions, 1);
        assert_eq!(summary.retrieval_questions, 0);
        assert_eq!(summary.retrieval_hit_rate, 0.0);
    }

    #[test]
    fn summarize_tracks_tag_slices() {
        let mut plan = result("plan", BeamQuestionClass::Factoid);
        plan.tags = vec!["factoid".to_string(), "plan".to_string()];
        plan.source_note_type = Some("plans.md".to_string());
        let mut abstention = result("abstention", BeamQuestionClass::Abstention);
        abstention.expects_abstention = true;
        abstention.included_in_primary_metrics = false;
        abstention.retrieval_evaluable = false;
        abstention.abstention_correct = true;
        abstention.tags = vec!["abstention".to_string()];
        let summary = summarize(
            &[result("fact", BeamQuestionClass::Factoid), plan, abstention],
            3,
        );
        assert_eq!(summary.by_tag["facts"].questions, 1);
        assert_eq!(summary.by_tag["plan"].questions, 1);
        assert_eq!(summary.by_tag["abstention"].abstention_correct_rate, 1.0);
    }

    #[test]
    fn init_streaming_artifacts_truncates_without_resume() {
        let dir = tempdir().expect("tempdir should exist");
        let path = dir.path().join("results.jsonl");
        fs::write(&path, "stale\n").expect("seed file should be written");

        init_streaming_artifacts(dir.path(), false).expect("artifacts should initialize");

        assert_eq!(
            fs::read_to_string(&path).expect("results should exist"),
            String::new()
        );
    }

    #[test]
    fn init_streaming_artifacts_preserves_results_with_resume() {
        let dir = tempdir().expect("tempdir should exist");
        let path = dir.path().join("results.jsonl");
        fs::write(&path, "{\"question_id\":\"q\"}\n").expect("seed file should be written");

        init_streaming_artifacts(dir.path(), true).expect("artifacts should initialize");

        assert_eq!(
            fs::read_to_string(&path).expect("results should exist"),
            "{\"question_id\":\"q\"}\n"
        );
    }

    #[test]
    fn load_existing_results_reads_jsonl_rows() {
        let dir = tempdir().expect("tempdir should exist");
        let result = result("fact", BeamQuestionClass::Factoid);
        fs::write(
            dir.path().join("results.jsonl"),
            format!(
                "{}\n",
                serde_json::to_string(&result).expect("result should serialize")
            ),
        )
        .expect("results should be written");

        let loaded = load_existing_results(dir.path()).expect("results should load");

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].question_id, "fact");
    }

    #[test]
    fn resume_preserves_existing_rows_and_allows_new_appends() {
        let dir = tempdir().expect("tempdir should exist");
        let existing = result("fact", BeamQuestionClass::Factoid);
        let next = result("next", BeamQuestionClass::Factoid);

        init_streaming_artifacts(dir.path(), false).expect("artifacts should initialize");
        append_result_artifacts(dir.path(), &existing).expect("existing row should append");
        init_streaming_artifacts(dir.path(), true).expect("resume should preserve rows");
        append_result_artifacts(dir.path(), &next).expect("next row should append");

        let loaded = load_existing_results(dir.path()).expect("results should load");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].question_id, "fact");
        assert_eq!(loaded[1].question_id, "next");
    }

    #[test]
    fn write_artifacts_emits_failure_and_retry_manifests() {
        let dir = tempdir().expect("tempdir should exist");
        let mut timeout = result("timeout", BeamQuestionClass::Factoid);
        timeout.failure_reason = Some(FailureReason::Timeout);
        let mut wrong = result("wrong", BeamQuestionClass::Factoid);
        wrong.failure_reason = Some(FailureReason::WrongShortAnswer);
        let results = vec![timeout, wrong];
        let summary = summarize(&results, 3);

        write_artifacts(dir.path(), &summary, &results).expect("artifacts should write");

        let failure_manifest = fs::read_to_string(dir.path().join("failure_manifest.json"))
            .expect("failure manifest should exist");
        let retry_manifest = fs::read_to_string(dir.path().join("retry_manifest.json"))
            .expect("retry manifest should exist");
        assert!(failure_manifest.contains("\"question_id\": \"timeout\""));
        assert!(failure_manifest.contains("\"question_id\": \"wrong\""));
        assert!(retry_manifest.contains("\"question_id\": \"timeout\""));
        assert!(!retry_manifest.contains("\"question_id\": \"wrong\""));
    }
}

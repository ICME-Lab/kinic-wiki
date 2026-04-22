// Where: crates/wiki_cli/src/beam_bench/agent_scoring.rs
// What: Score agent tool-use runs for the BEAM-derived wiki benchmark.
// Why: The benchmark should grade the agent's skill-driven retrieval path, not a fixed Rust query.
use std::collections::BTreeSet;

use serde_json::Value;

use super::answer_match::{
    abstention_match, answer_exact_match as matches_exact_answer,
    answer_normalized_match as matches_normalized_answer,
};
use super::dataset::BeamQuestion;
use super::gold_paths::{has_explicit_gold_paths, note_counts_as_retrieved, resolve_gold_paths};
use super::import::{ImportedConversation, ImportedNote};
use super::model::{ModelRun, ToolCallRecord};
use super::report::{FailureReason, QuestionResult};

pub fn score_question(
    conversation_id: String,
    imported: &ImportedConversation,
    question: BeamQuestion,
    run: ModelRun,
) -> QuestionResult {
    if let Some(failure_reason) = runtime_failure_reason(&run) {
        return build_runtime_failure(conversation_id, question, run, failure_reason);
    }
    let gold = materialize_gold(imported, &question);
    if let Some(failure_reason) = gold.failure_reason {
        return build_precheck_failure(conversation_id, question, run, gold, failure_reason);
    }

    let retrieved_paths =
        derive_retrieved_paths(imported, &question, &run.tool_calls, &run.raw_events);
    let matched_gold_path = first_matching_path(&retrieved_paths, &gold.gold_paths);
    let matched_gold_span = first_matching_span(imported, &retrieved_paths, &gold.gold_spans, 3);
    let predicted_answer = (!run.answer.trim().is_empty()).then_some(run.answer.clone());
    let answered = predicted_answer.is_some();
    let retrieved_paths_nonempty = !retrieved_paths.is_empty();
    let grounded = answered && retrieved_paths_nonempty;
    let gold_path_hit_at_1 = hit_within_rank(&retrieved_paths, &gold.gold_paths, 1);
    let gold_path_hit_at_3 = hit_within_rank(&retrieved_paths, &gold.gold_paths, 3);
    let gold_span_hit_at_1 = span_hit_within_rank(imported, &retrieved_paths, &gold.gold_spans, 1);
    let gold_span_hit_at_3 = span_hit_within_rank(imported, &retrieved_paths, &gold.gold_spans, 3);
    let answer_exact_match = matches_exact_answer(&question, predicted_answer.as_deref());
    let answer_normalized_match = matches_normalized_answer(&question, predicted_answer.as_deref());
    let answer_match_given_span_hit = gold_span_hit_at_3 && answer_normalized_match;
    let abstention_correct =
        question.expects_abstention && predicted_answer.as_deref().is_some_and(abstention_match);
    let tool_error_count = run.tool_calls.iter().filter(|call| call.is_error).count();
    let docs_read_count = run
        .tool_calls
        .iter()
        .filter(|call| is_read_tool_name(&call.name))
        .count();
    let read_before_answer = answered && docs_read_count > 0;
    let failure_reason = determine_failure_reason(
        &question,
        tool_error_count,
        gold_path_hit_at_3,
        gold_span_hit_at_3,
        predicted_answer.as_deref(),
        answer_normalized_match,
    );

    QuestionResult {
        conversation_id,
        question_id: question.question_id,
        question_type: question.question_type,
        question_class: question.question_class,
        query: question.query,
        as_of: question.as_of,
        reference_answer: question.reference_answer,
        gold_answers: question.gold_answers,
        predicted_answer,
        gold_paths: gold.gold_paths,
        gold_spans: gold.gold_spans,
        expects_abstention: question.expects_abstention,
        tags: question.tags,
        retrieved_paths,
        matched_gold_path: matched_gold_path.clone(),
        matched_gold_span,
        source_note_type: matched_gold_path
            .as_deref()
            .map(|path| note_type_for_path(path, &imported.notes)),
        answered,
        grounded,
        answered_without_grounding: answered && !retrieved_paths_nonempty,
        retrieved_paths_nonempty,
        read_before_answer,
        included_in_primary_metrics: !question.expects_abstention,
        retrieval_evaluable: !question.expects_abstention,
        retrieval_hit: gold_path_hit_at_3,
        gold_path_hit_at_1,
        gold_path_hit_at_3,
        gold_span_hit_at_1,
        gold_span_hit_at_3,
        answer_exact_match,
        answer_normalized_match,
        answer_match_given_span_hit,
        abstention_correct,
        tool_call_count: run.tool_calls.len(),
        tool_error_count,
        docs_read_count,
        input_tokens: run.input_tokens,
        output_tokens: run.output_tokens,
        total_tokens: run.total_tokens,
        latency_ms: run.latency_ms,
        spawned_at_ms: Some(run.spawned_at_ms),
        pid: run.pid,
        exit_status: run.exit_status,
        timed_out: run.timed_out,
        stderr: (!run.stderr.is_empty()).then_some(run.stderr),
        schema_path: Some(run.schema_path),
        last_tool_name: run.last_tool_name,
        last_tool_arguments: run.last_tool_arguments,
        failure_reason,
        tool_calls: run.tool_calls,
        raw_events: run.raw_events,
    }
}

#[derive(Default)]
struct MaterializedGold {
    gold_paths: Vec<String>,
    gold_spans: Vec<String>,
    gold_answers: Vec<String>,
    failure_reason: Option<FailureReason>,
}

fn materialize_gold(imported: &ImportedConversation, question: &BeamQuestion) -> MaterializedGold {
    let gold_paths = resolve_gold_paths(imported, question);
    let gold_answers = if question.gold_answers.is_empty() {
        question.reference_answer.clone().into_iter().collect()
    } else {
        question.gold_answers.clone()
    };
    let gold_spans = resolve_gold_spans(imported, question, &gold_paths, &gold_answers);
    if question.expects_abstention {
        return MaterializedGold {
            gold_paths,
            gold_spans,
            gold_answers,
            failure_reason: None,
        };
    }
    if gold_paths.is_empty() {
        return MaterializedGold {
            gold_paths,
            gold_spans,
            gold_answers,
            failure_reason: Some(FailureReason::TransformMiss),
        };
    }
    if !gold_spans.is_empty()
        && !gold_paths.iter().any(|path| {
            imported
                .notes
                .iter()
                .find(|note| &note.path == path)
                .is_some_and(|note| gold_spans.iter().any(|span| note.content.contains(span)))
        })
    {
        return MaterializedGold {
            gold_paths,
            gold_spans,
            gold_answers,
            failure_reason: Some(FailureReason::GoldFixtureMismatch),
        };
    }
    MaterializedGold {
        gold_paths,
        gold_spans,
        gold_answers,
        failure_reason: None,
    }
}

fn resolve_gold_spans(
    imported: &ImportedConversation,
    question: &BeamQuestion,
    gold_paths: &[String],
    gold_answers: &[String],
) -> Vec<String> {
    if !question.gold_spans.is_empty() {
        return question.gold_spans.clone();
    }
    gold_answers
        .iter()
        .filter(|answer| {
            gold_paths.iter().any(|path| {
                imported
                    .notes
                    .iter()
                    .find(|note| &note.path == path)
                    .is_some_and(|note| note.content.contains(answer.as_str()))
            })
        })
        .cloned()
        .collect()
}

fn derive_retrieved_paths(
    imported: &ImportedConversation,
    question: &BeamQuestion,
    tool_calls: &[ToolCallRecord],
    raw_events: &[Value],
) -> Vec<String> {
    let allow_explicit_gold_paths = has_explicit_gold_paths(question);
    let mut paths =
        extract_search_paths_from_events(imported, raw_events, allow_explicit_gold_paths);
    let mut seen = paths.iter().cloned().collect::<BTreeSet<_>>();
    for call in tool_calls {
        if !is_read_tool_name(&call.name) {
            continue;
        }
        for path in extract_note_paths(&call.arguments, &imported.base_path) {
            if note_counts_as_retrieved(&path, &imported.notes, allow_explicit_gold_paths)
                && seen.insert(path.clone())
            {
                paths.push(path);
            }
        }
    }
    paths
}

fn is_read_tool_name(name: &str) -> bool {
    matches!(name, "read" | "read-node")
}

fn extract_search_paths_from_events(
    imported: &ImportedConversation,
    raw_events: &[Value],
    allow_explicit_gold_paths: bool,
) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = BTreeSet::new();
    for event in raw_events {
        let Some(item) = event.get("item") else {
            continue;
        };
        let Some(command) = item.get("command").and_then(Value::as_str) else {
            continue;
        };
        if !command.contains("search-remote") && !command.contains("search-path-remote") {
            continue;
        }
        for text in collect_strings(item) {
            for path in extract_note_paths(&text, &imported.base_path) {
                if note_counts_as_retrieved(&path, &imported.notes, allow_explicit_gold_paths)
                    && seen.insert(path.clone())
                {
                    paths.push(path);
                }
            }
        }
    }
    paths
}

fn collect_strings(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect_strings_into(value, &mut out);
    out
}

fn collect_strings_into(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_strings_into(item, out)),
        Value::Object(map) => map
            .values()
            .for_each(|item| collect_strings_into(item, out)),
        _ => {}
    }
}

fn extract_note_paths(text: &str, base_path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(index) = rest.find(base_path) {
        let candidate = &rest[index..];
        let end = candidate
            .find(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '/' | '-' | '_' | '.')))
            .unwrap_or(candidate.len());
        let path = &candidate[..end];
        if path.ends_with(".md") {
            out.push(path.to_string());
        }
        rest = &candidate[end..];
    }
    out
}

fn build_precheck_failure(
    conversation_id: String,
    question: BeamQuestion,
    run: ModelRun,
    gold: MaterializedGold,
    failure_reason: FailureReason,
) -> QuestionResult {
    let answered = !run.answer.trim().is_empty();
    let read_before_answer = answered
        && run
            .tool_calls
            .iter()
            .any(|call| is_read_tool_name(&call.name));
    QuestionResult {
        conversation_id,
        question_id: question.question_id,
        question_type: question.question_type,
        question_class: question.question_class,
        query: question.query,
        as_of: question.as_of,
        reference_answer: question.reference_answer,
        gold_answers: gold.gold_answers,
        predicted_answer: answered.then_some(run.answer),
        gold_paths: gold.gold_paths,
        gold_spans: gold.gold_spans,
        expects_abstention: question.expects_abstention,
        tags: question.tags,
        retrieved_paths: Vec::new(),
        matched_gold_path: None,
        matched_gold_span: None,
        source_note_type: None,
        answered,
        grounded: false,
        answered_without_grounding: answered,
        retrieved_paths_nonempty: false,
        read_before_answer,
        included_in_primary_metrics: !question.expects_abstention,
        retrieval_evaluable: !question.expects_abstention,
        retrieval_hit: false,
        gold_path_hit_at_1: false,
        gold_path_hit_at_3: false,
        gold_span_hit_at_1: false,
        gold_span_hit_at_3: false,
        answer_exact_match: false,
        answer_normalized_match: false,
        answer_match_given_span_hit: false,
        abstention_correct: false,
        tool_call_count: run.tool_calls.len(),
        tool_error_count: run.tool_calls.iter().filter(|call| call.is_error).count(),
        docs_read_count: run
            .tool_calls
            .iter()
            .filter(|call| is_read_tool_name(&call.name))
            .count(),
        input_tokens: run.input_tokens,
        output_tokens: run.output_tokens,
        total_tokens: run.total_tokens,
        latency_ms: run.latency_ms,
        spawned_at_ms: Some(run.spawned_at_ms),
        pid: run.pid,
        exit_status: run.exit_status,
        timed_out: run.timed_out,
        stderr: (!run.stderr.is_empty()).then_some(run.stderr),
        schema_path: Some(run.schema_path),
        last_tool_name: run.last_tool_name,
        last_tool_arguments: run.last_tool_arguments,
        failure_reason: Some(failure_reason),
        tool_calls: run.tool_calls,
        raw_events: run.raw_events,
    }
}

fn build_runtime_failure(
    conversation_id: String,
    question: BeamQuestion,
    run: ModelRun,
    failure_reason: FailureReason,
) -> QuestionResult {
    let answered = !run.answer.trim().is_empty();
    let read_before_answer = answered
        && run
            .tool_calls
            .iter()
            .any(|call| is_read_tool_name(&call.name));
    QuestionResult {
        conversation_id,
        question_id: question.question_id,
        question_type: question.question_type,
        question_class: question.question_class,
        query: question.query,
        as_of: question.as_of,
        reference_answer: question.reference_answer,
        gold_answers: question.gold_answers,
        predicted_answer: answered.then_some(run.answer),
        gold_paths: question.gold_paths,
        gold_spans: question.gold_spans,
        expects_abstention: question.expects_abstention,
        tags: question.tags,
        retrieved_paths: Vec::new(),
        matched_gold_path: None,
        matched_gold_span: None,
        source_note_type: None,
        answered,
        grounded: false,
        answered_without_grounding: answered,
        retrieved_paths_nonempty: false,
        read_before_answer,
        included_in_primary_metrics: !question.expects_abstention,
        retrieval_evaluable: false,
        retrieval_hit: false,
        gold_path_hit_at_1: false,
        gold_path_hit_at_3: false,
        gold_span_hit_at_1: false,
        gold_span_hit_at_3: false,
        answer_exact_match: false,
        answer_normalized_match: false,
        answer_match_given_span_hit: false,
        abstention_correct: false,
        tool_call_count: run.tool_calls.len(),
        tool_error_count: usize::from(!run.timed_out),
        docs_read_count: run
            .tool_calls
            .iter()
            .filter(|call| is_read_tool_name(&call.name))
            .count(),
        input_tokens: run.input_tokens,
        output_tokens: run.output_tokens,
        total_tokens: run.total_tokens,
        latency_ms: run.latency_ms,
        spawned_at_ms: Some(run.spawned_at_ms),
        pid: run.pid,
        exit_status: run.exit_status,
        timed_out: run.timed_out,
        stderr: (!run.stderr.is_empty()).then_some(run.stderr),
        schema_path: Some(run.schema_path),
        last_tool_name: run.last_tool_name,
        last_tool_arguments: run.last_tool_arguments,
        failure_reason: Some(failure_reason),
        tool_calls: run.tool_calls,
        raw_events: run.raw_events,
    }
}

fn hit_within_rank(retrieved_paths: &[String], gold_paths: &[String], rank: usize) -> bool {
    retrieved_paths
        .iter()
        .take(rank)
        .any(|path| gold_paths.contains(path))
}

fn span_hit_within_rank(
    imported: &ImportedConversation,
    retrieved_paths: &[String],
    gold_spans: &[String],
    rank: usize,
) -> bool {
    retrieved_paths.iter().take(rank).any(|path| {
        imported
            .notes
            .iter()
            .find(|note| &note.path == path)
            .is_some_and(|note| gold_spans.iter().any(|span| note.content.contains(span)))
    })
}

fn first_matching_path(retrieved_paths: &[String], gold_paths: &[String]) -> Option<String> {
    retrieved_paths
        .iter()
        .find(|path| gold_paths.contains(*path))
        .cloned()
}

fn first_matching_span(
    imported: &ImportedConversation,
    retrieved_paths: &[String],
    gold_spans: &[String],
    rank: usize,
) -> Option<String> {
    retrieved_paths.iter().take(rank).find_map(|path| {
        imported
            .notes
            .iter()
            .find(|note| &note.path == path)
            .and_then(|note| {
                gold_spans
                    .iter()
                    .find(|span| note.content.contains(span.as_str()))
                    .cloned()
            })
    })
}

fn note_type_for_path(path: &str, notes: &[ImportedNote]) -> String {
    notes
        .iter()
        .find(|note| note.path == path)
        .map(|note| note.note_type.clone())
        .unwrap_or_else(|| "unknown".to_string())
}

fn determine_failure_reason(
    question: &BeamQuestion,
    tool_error_count: usize,
    gold_path_hit_at_3: bool,
    gold_span_hit_at_3: bool,
    predicted_answer: Option<&str>,
    answer_normalized_match: bool,
) -> Option<FailureReason> {
    if question.expects_abstention {
        return predicted_answer
            .filter(|answer| !abstention_match(answer))
            .map(|_| FailureReason::ShouldAbstainButAnswered);
    }
    if tool_error_count > 0 {
        return Some(FailureReason::ToolError);
    }
    if !gold_path_hit_at_3 {
        return Some(FailureReason::MissedGoldPath);
    }
    if !gold_span_hit_at_3 {
        return Some(FailureReason::MissedGoldSpan);
    }
    if predicted_answer.is_some() && !answer_normalized_match {
        return Some(FailureReason::WrongShortAnswer);
    }
    None
}

fn runtime_failure_reason(run: &ModelRun) -> Option<FailureReason> {
    if run.timed_out {
        return Some(FailureReason::Timeout);
    }
    run.failure_message
        .as_ref()
        .map(|_| FailureReason::ToolError)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use serde_json::json;

    use super::score_question;
    use crate::beam_bench::dataset::{BeamQuestion, BeamQuestionClass};
    use crate::beam_bench::import::{ImportedConversation, ImportedNote};
    use crate::beam_bench::model::{ModelRun, ToolCallRecord};
    use crate::beam_bench::report::FailureReason;

    fn imported() -> ImportedConversation {
        ImportedConversation {
            conversation_id: "conv-1".to_string(),
            namespace_path: "/Wiki/run".to_string(),
            namespace_index_path: "/Wiki/run/index.md".to_string(),
            base_path: "/Wiki/run/conv-1".to_string(),
            note_paths: vec![
                "/Wiki/run/conv-1/facts.md".to_string(),
                "/Wiki/run/conv-1/plans.md".to_string(),
                "/Wiki/run/conv-1/provenance.md".to_string(),
            ],
            notes: vec![
                ImportedNote {
                    path: "/Wiki/run/conv-1/facts.md".to_string(),
                    content: "meeting date: March 15, 2024".to_string(),
                    note_type: "facts.md".to_string(),
                },
                ImportedNote {
                    path: "/Wiki/run/conv-1/plans.md".to_string(),
                    content: "conversation plan: Discuss one meeting date and confirm it."
                        .to_string(),
                    note_type: "plans.md".to_string(),
                },
                ImportedNote {
                    path: "/Wiki/run/conv-1/provenance.md".to_string(),
                    content:
                        "source_path: /Sources/raw/run-conv-1/run-conv-1.md\nmeeting date: March 15, 2024"
                            .to_string(),
                    note_type: "provenance.md".to_string(),
                },
            ],
        }
    }

    fn fact_question() -> BeamQuestion {
        BeamQuestion {
            question_id: "factoid-000".to_string(),
            question_type: "factoid".to_string(),
            question_class: BeamQuestionClass::Factoid,
            query: "When is the meeting?".to_string(),
            as_of: None,
            reference_answer: Some("March 15, 2024".to_string()),
            gold_answers: vec!["March 15, 2024".to_string()],
            gold_paths: vec!["facts.md".to_string()],
            gold_spans: vec!["March 15, 2024".to_string()],
            expects_abstention: false,
            tags: vec!["factoid".to_string(), "facts".to_string()],
            rubric_items: Vec::new(),
            raw: json!({}),
        }
    }

    fn model_run(
        answer: &str,
        tool_calls: Vec<ToolCallRecord>,
        raw_events: Vec<Value>,
    ) -> ModelRun {
        ModelRun {
            answer: answer.to_string(),
            tool_calls,
            input_tokens: Some(1),
            output_tokens: Some(1),
            total_tokens: Some(2),
            latency_ms: 5,
            raw_events,
            spawned_at_ms: 1,
            pid: Some(42),
            exit_status: Some(0),
            timed_out: false,
            failure_message: None,
            stderr: String::new(),
            schema_path: "/tmp/schema.json".to_string(),
            last_tool_name: None,
            last_tool_arguments: None,
        }
    }

    #[test]
    fn search_output_paths_are_ranked_before_reads() {
        let result = score_question(
            "conv-1".to_string(),
            &imported(),
            fact_question(),
            model_run(
                "March 15, 2024",
                vec![ToolCallRecord {
                    name: "read-node".to_string(),
                    arguments: "cargo run -p vfs-cli --bin vfs-cli -- --local read-node --path /Wiki/run/conv-1/facts.md --json".to_string(),
                    is_error: false,
                }],
                vec![json!({
                    "type": "item.completed",
                    "item": {
                        "command": "cargo run -p vfs-cli --bin vfs-cli -- --local search-path-remote meeting --prefix /Wiki/run/conv-1 --json",
                        "stdout": "[{\"path\":\"/Wiki/run/conv-1/facts.md\"}]"
                    }
                })],
            ),
        );
        assert!(result.gold_path_hit_at_1);
        assert_eq!(
            result.retrieved_paths,
            vec!["/Wiki/run/conv-1/facts.md".to_string()]
        );
    }

    #[test]
    fn read_tool_counts_as_retrieved_path() {
        let result = score_question(
            "conv-1".to_string(),
            &imported(),
            fact_question(),
            model_run(
                "March 15, 2024",
                vec![ToolCallRecord {
                    name: "read".to_string(),
                    arguments: r#"{"path":"/Wiki/run/conv-1/facts.md"}"#.to_string(),
                    is_error: false,
                }],
                Vec::new(),
            ),
        );

        assert_eq!(
            result.retrieved_paths,
            vec!["/Wiki/run/conv-1/facts.md".to_string()]
        );
        assert!(result.gold_path_hit_at_3);
        assert!(result.gold_span_hit_at_3);
        assert_eq!(result.docs_read_count, 1);
    }

    #[test]
    fn provenance_only_read_does_not_count_as_structured_hit() {
        let result = score_question(
            "conv-1".to_string(),
            &imported(),
            fact_question(),
            model_run(
                "March 15, 2024",
                vec![ToolCallRecord {
                    name: "read-node".to_string(),
                    arguments: r#"{"path":"/Wiki/run/conv-1/provenance.md"}"#.to_string(),
                    is_error: false,
                }],
                Vec::new(),
            ),
        );
        assert!(!result.gold_path_hit_at_3);
        assert_eq!(result.failure_reason, Some(FailureReason::MissedGoldPath));
    }

    #[test]
    fn abstention_requires_insufficient_evidence() {
        let mut question = fact_question();
        question.question_id = "abstention-000".to_string();
        question.question_class = BeamQuestionClass::Abstention;
        question.expects_abstention = true;
        question.reference_answer = Some("insufficient evidence".to_string());
        question.gold_answers = vec!["insufficient evidence".to_string()];
        question.gold_paths = Vec::new();
        question.gold_spans = Vec::new();
        let result = score_question(
            "conv-1".to_string(),
            &imported(),
            question,
            model_run("March 15, 2024", Vec::new(), Vec::new()),
        );
        assert_eq!(
            result.failure_reason,
            Some(FailureReason::ShouldAbstainButAnswered)
        );
    }

    #[test]
    fn explicit_provenance_gold_path_is_preserved() {
        let mut question = fact_question();
        question.gold_paths = vec!["provenance.md".to_string()];
        question.gold_spans = vec!["March 15, 2024".to_string()];
        let result = score_question(
            "conv-1".to_string(),
            &imported(),
            question,
            model_run("March 15, 2024", Vec::new(), Vec::new()),
        );
        assert_eq!(
            result.gold_paths,
            vec!["/Wiki/run/conv-1/provenance.md".to_string()]
        );
        assert_ne!(result.failure_reason, Some(FailureReason::TransformMiss));
    }

    #[test]
    fn explicit_provenance_gold_path_counts_when_agent_reads_it() {
        let mut question = fact_question();
        question.gold_paths = vec!["provenance.md".to_string()];
        question.gold_spans = vec!["March 15, 2024".to_string()];
        let result = score_question(
            "conv-1".to_string(),
            &imported(),
            question,
            model_run(
                "March 15, 2024",
                vec![ToolCallRecord {
                    name: "read-node".to_string(),
                    arguments: "cargo run -p vfs-cli --bin vfs-cli -- --local read-node --path /Wiki/run/conv-1/provenance.md --json".to_string(),
                    is_error: false,
                }],
                Vec::new(),
            ),
        );
        assert_eq!(
            result.retrieved_paths,
            vec!["/Wiki/run/conv-1/provenance.md".to_string()]
        );
        assert!(result.gold_path_hit_at_1);
    }
}

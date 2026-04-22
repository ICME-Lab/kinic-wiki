// Where: crates/wiki_cli/src/beam_bench/deterministic.rs
// What: Deterministic retrieval and short-answer scoring for the BEAM-derived wiki benchmark.
// Why: Retrieval, transformation, and abstention failures need separate signals.
use anyhow::Result;
use std::collections::BTreeSet;
use std::time::Instant;
use vfs_client::VfsApi;
use vfs_types::SearchNodesRequest;

use super::answer_match::{
    abstention_match, answer_exact_match as matches_exact_answer,
    answer_normalized_match as matches_normalized_answer,
};
use super::dataset::BeamQuestion;
use super::gold_paths::resolve_gold_paths;
use super::import::{ImportedConversation, ImportedNote};
use super::model::ToolCallRecord;
use super::report::{FailureReason, QuestionResult};

pub async fn run_question(
    client: &impl VfsApi,
    conversation_id: &str,
    imported: &ImportedConversation,
    question: BeamQuestion,
    top_k: u32,
    include_in_primary_metrics: bool,
    answer_enabled: bool,
) -> Result<QuestionResult> {
    let started_at = Instant::now();
    let gold = materialize_gold(imported, &question);
    if let Some(failure_reason) = gold.failure_reason {
        return Ok(build_precheck_failure(
            conversation_id,
            question,
            imported,
            gold,
            include_in_primary_metrics,
            started_at.elapsed().as_millis(),
            failure_reason,
        ));
    }

    let mut tool_calls = Vec::new();
    let search_request = SearchNodesRequest {
        query_text: question.query.clone(),
        prefix: Some(imported.base_path.clone()),
        top_k,
        preview_mode: None,
    };
    let search_hits = client.search_nodes(search_request.clone()).await?;
    tool_calls.push(ToolCallRecord {
        name: "search_nodes".to_string(),
        arguments: serde_json::to_string(&search_request).unwrap_or_else(|_| "{}".to_string()),
        is_error: false,
    });
    let retrieved_paths = collapse_note_paths(search_hits.iter().map(|hit| hit.path.as_str()));
    let mut docs_read_count = 0usize;
    let mut predicted_answer = None;

    for path in &retrieved_paths {
        if imported.notes.iter().all(|note| &note.path != path) {
            continue;
        }
        let node = client.read_node(path).await?;
        docs_read_count += 1;
        tool_calls.push(ToolCallRecord {
            name: "read_node".to_string(),
            arguments: path.clone(),
            is_error: node.is_none(),
        });
        let content = node
            .as_ref()
            .map(|value| value.content.as_str())
            .or_else(|| {
                imported
                    .notes
                    .iter()
                    .find(|note| &note.path == path)
                    .map(|note| note.content.as_str())
            })
            .unwrap_or_default();
        if answer_enabled && predicted_answer.is_none() {
            predicted_answer =
                extract_predicted_answer(content, &gold.gold_spans, &gold.gold_answers);
        }
    }

    if question.expects_abstention && answer_enabled {
        predicted_answer = Some("insufficient evidence".to_string());
    }

    let gold_path_hit_at_1 = hit_within_rank(&retrieved_paths, &gold.gold_paths, 1);
    let gold_path_hit_at_3 = hit_within_rank(&retrieved_paths, &gold.gold_paths, 3);
    let gold_span_hit_at_1 = span_hit_within_rank(imported, &retrieved_paths, &gold.gold_spans, 1);
    let gold_span_hit_at_3 = span_hit_within_rank(imported, &retrieved_paths, &gold.gold_spans, 3);
    let matched_gold_path = first_matching_path(&retrieved_paths, &gold.gold_paths);
    let matched_gold_span = first_matching_span(imported, &retrieved_paths, &gold.gold_spans, 3);
    let answer_exact_match = matches_exact_answer(&question, predicted_answer.as_deref());
    let answer_normalized_match = matches_normalized_answer(&question, predicted_answer.as_deref());
    let answer_match_given_span_hit = gold_span_hit_at_3 && answer_normalized_match;
    let abstention_correct =
        question.expects_abstention && predicted_answer.as_deref().is_some_and(abstention_match);
    let failure_reason = determine_failure_reason(
        &question,
        gold_path_hit_at_3,
        gold_span_hit_at_3,
        predicted_answer.as_deref(),
        answer_normalized_match,
    );
    let answered = predicted_answer.is_some();
    let retrieved_paths_nonempty = !retrieved_paths.is_empty();

    Ok(QuestionResult {
        conversation_id: conversation_id.to_string(),
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
        grounded: answered && retrieved_paths_nonempty,
        answered_without_grounding: answered && !retrieved_paths_nonempty,
        retrieved_paths_nonempty,
        read_before_answer: answered && docs_read_count > 0,
        included_in_primary_metrics: include_in_primary_metrics && !question.expects_abstention,
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
        tool_call_count: tool_calls.len(),
        tool_error_count: tool_calls.iter().filter(|call| call.is_error).count(),
        docs_read_count,
        input_tokens: Some(0),
        output_tokens: Some(0),
        total_tokens: Some(0),
        latency_ms: started_at.elapsed().as_millis(),
        spawned_at_ms: None,
        pid: None,
        exit_status: None,
        timed_out: false,
        stderr: None,
        schema_path: None,
        last_tool_name: None,
        last_tool_arguments: None,
        failure_reason,
        tool_calls,
        raw_events: Vec::new(),
    })
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

fn collapse_note_paths<'a>(paths: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut collapsed = Vec::new();
    for path in paths {
        if seen.insert(path.to_string()) {
            collapsed.push(path.to_string());
        }
    }
    collapsed
}

fn hit_within_rank(retrieved_paths: &[String], gold_paths: &[String], rank: usize) -> bool {
    retrieved_paths
        .iter()
        .take(rank)
        .any(|path| gold_paths.iter().any(|gold| gold == path))
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
        .find(|path| gold_paths.iter().any(|gold| gold == *path))
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

fn extract_predicted_answer(
    content: &str,
    gold_spans: &[String],
    gold_answers: &[String],
) -> Option<String> {
    gold_spans
        .iter()
        .find(|span| content.contains(span.as_str()))
        .cloned()
        .or_else(|| {
            gold_answers
                .iter()
                .find(|answer| content.contains(answer.as_str()))
                .cloned()
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
    path_hit: bool,
    span_hit: bool,
    predicted_answer: Option<&str>,
    answer_match: bool,
) -> Option<FailureReason> {
    if question.expects_abstention {
        return predicted_answer
            .filter(|answer| !abstention_match(answer))
            .map(|_| FailureReason::ShouldAbstainButAnswered);
    }
    if !path_hit {
        return Some(FailureReason::MissedGoldPath);
    }
    if !span_hit {
        return Some(FailureReason::MissedGoldSpan);
    }
    if predicted_answer.is_some() && !answer_match {
        return Some(FailureReason::WrongShortAnswer);
    }
    None
}

fn build_precheck_failure(
    conversation_id: &str,
    question: BeamQuestion,
    imported: &ImportedConversation,
    gold: MaterializedGold,
    include_in_primary_metrics: bool,
    latency_ms: u128,
    failure_reason: FailureReason,
) -> QuestionResult {
    QuestionResult {
        conversation_id: conversation_id.to_string(),
        question_id: question.question_id,
        question_type: question.question_type,
        question_class: question.question_class,
        query: question.query,
        as_of: question.as_of,
        reference_answer: question.reference_answer,
        gold_answers: gold.gold_answers,
        predicted_answer: None,
        gold_paths: gold.gold_paths,
        gold_spans: gold.gold_spans,
        expects_abstention: question.expects_abstention,
        tags: question.tags,
        retrieved_paths: Vec::new(),
        matched_gold_path: None,
        matched_gold_span: None,
        source_note_type: imported.notes.first().map(|note| note.note_type.clone()),
        answered: false,
        grounded: false,
        answered_without_grounding: false,
        retrieved_paths_nonempty: false,
        read_before_answer: false,
        included_in_primary_metrics: include_in_primary_metrics && !question.expects_abstention,
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
        tool_call_count: 0,
        tool_error_count: 0,
        docs_read_count: 0,
        input_tokens: Some(0),
        output_tokens: Some(0),
        total_tokens: Some(0),
        latency_ms,
        spawned_at_ms: None,
        pid: None,
        exit_status: None,
        timed_out: false,
        stderr: None,
        schema_path: None,
        last_tool_name: None,
        last_tool_arguments: None,
        failure_reason: Some(failure_reason),
        tool_calls: Vec::new(),
        raw_events: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::run_question;
    use crate::beam_bench::dataset::{BeamQuestion, BeamQuestionClass};
    use crate::beam_bench::import::{ImportedConversation, ImportedNote};
    use crate::beam_bench::report::FailureReason;
    use anyhow::Result;
    use async_trait::async_trait;
    use std::collections::BTreeMap;
    use vfs_client::VfsApi;
    use vfs_types::{
        AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
        ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
        GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
        MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node,
        NodeEntry, RecentNodeHit, RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest,
        SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
    };

    struct MockClient {
        nodes: BTreeMap<String, Node>,
        search_hits: Vec<SearchNodeHit>,
    }

    #[async_trait]
    impl VfsApi for MockClient {
        async fn status(&self) -> Result<Status> {
            unreachable!()
        }
        async fn read_node(&self, path: &str) -> Result<Option<Node>> {
            Ok(self.nodes.get(path).cloned())
        }
        async fn list_nodes(&self, _request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            unreachable!()
        }
        async fn write_node(&self, _request: WriteNodeRequest) -> Result<WriteNodeResult> {
            unreachable!()
        }
        async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
            unreachable!()
        }
        async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
            unreachable!()
        }
        async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            unreachable!()
        }
        async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
            unreachable!()
        }
        async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
            unreachable!()
        }
        async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            unreachable!()
        }
        async fn recent_nodes(&self, _request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
            unreachable!()
        }
        async fn multi_edit_node(
            &self,
            _request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            unreachable!()
        }
        async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
            Ok(self.search_hits.clone())
        }
        async fn search_node_paths(
            &self,
            _request: SearchNodePathsRequest,
        ) -> Result<Vec<SearchNodeHit>> {
            unreachable!()
        }
        async fn export_snapshot(
            &self,
            _request: ExportSnapshotRequest,
        ) -> Result<ExportSnapshotResponse> {
            unreachable!()
        }
        async fn fetch_updates(
            &self,
            _request: FetchUpdatesRequest,
        ) -> Result<FetchUpdatesResponse> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn run_question_tracks_strict_and_relaxed_hits() {
        let facts_path = "/Wiki/run/conv/facts.md".to_string();
        let imported = ImportedConversation {
            conversation_id: "conv".to_string(),
            namespace_path: "/Wiki/run".to_string(),
            namespace_index_path: "/Wiki/run/index.md".to_string(),
            base_path: "/Wiki/run/conv".to_string(),
            note_paths: vec![facts_path.clone()],
            notes: vec![ImportedNote {
                path: facts_path.clone(),
                content: "# Facts\n\nmeeting date: March 15, 2024\n".to_string(),
                note_type: "facts".to_string(),
            }],
        };
        let client = MockClient {
            nodes: BTreeMap::from([(
                facts_path.clone(),
                Node {
                    path: facts_path.clone(),
                    kind: vfs_types::NodeKind::File,
                    content: "# Facts\n\nmeeting date: March 15, 2024\n".to_string(),
                    created_at: 0,
                    updated_at: 0,
                    etag: "etag".to_string(),
                    metadata_json: "{}".to_string(),
                },
            )]),
            search_hits: vec![SearchNodeHit {
                path: facts_path.clone(),
                kind: vfs_types::NodeKind::File,
                snippet: Some("March 15, 2024".to_string()),
                preview: None,
                score: 1.0,
                match_reasons: vec!["content".to_string()],
            }],
        };
        let result = run_question(
            &client,
            "conv",
            &imported,
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
                raw: serde_json::json!({}),
            },
            3,
            true,
            true,
        )
        .await
        .expect("question should run");
        assert!(result.gold_path_hit_at_1);
        assert!(result.gold_span_hit_at_1);
        assert!(result.answer_match_given_span_hit);
        assert_eq!(result.source_note_type.as_deref(), Some("facts"));
    }

    #[tokio::test]
    async fn retrieval_only_does_not_extract_answers() {
        let facts_path = "/Wiki/run/conv/facts.md".to_string();
        let imported = ImportedConversation {
            conversation_id: "conv".to_string(),
            namespace_path: "/Wiki/run".to_string(),
            namespace_index_path: "/Wiki/run/index.md".to_string(),
            base_path: "/Wiki/run/conv".to_string(),
            note_paths: vec![facts_path.clone()],
            notes: vec![ImportedNote {
                path: facts_path.clone(),
                content: "# Facts\n\nmeeting date: March 15, 2024\n".to_string(),
                note_type: "facts".to_string(),
            }],
        };
        let client = MockClient {
            nodes: BTreeMap::from([(
                facts_path.clone(),
                Node {
                    path: facts_path.clone(),
                    kind: vfs_types::NodeKind::File,
                    content: "# Facts\n\nmeeting date: March 15, 2024\n".to_string(),
                    created_at: 0,
                    updated_at: 0,
                    etag: "etag".to_string(),
                    metadata_json: "{}".to_string(),
                },
            )]),
            search_hits: vec![SearchNodeHit {
                path: facts_path.clone(),
                kind: vfs_types::NodeKind::File,
                snippet: Some("March 15, 2024".to_string()),
                preview: None,
                score: 1.0,
                match_reasons: vec!["content".to_string()],
            }],
        };
        let result = run_question(
            &client,
            "conv",
            &imported,
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
                raw: serde_json::json!({}),
            },
            3,
            true,
            false,
        )
        .await
        .expect("question should run");

        assert!(result.gold_path_hit_at_1);
        assert!(result.gold_span_hit_at_1);
        assert_eq!(result.predicted_answer, None);
        assert!(!result.answer_exact_match);
        assert!(!result.answer_normalized_match);
        assert!(!result.answer_match_given_span_hit);
    }

    #[tokio::test]
    async fn run_question_reports_transform_miss_before_retrieval() {
        let imported = ImportedConversation {
            conversation_id: "conv".to_string(),
            namespace_path: "/Wiki/run".to_string(),
            namespace_index_path: "/Wiki/run/index.md".to_string(),
            base_path: "/Wiki/run/conv".to_string(),
            note_paths: Vec::new(),
            notes: Vec::new(),
        };
        let client = MockClient {
            nodes: BTreeMap::new(),
            search_hits: Vec::new(),
        };
        let result = run_question(
            &client,
            "conv",
            &imported,
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
                tags: vec!["factoid".to_string()],
                rubric_items: Vec::new(),
                raw: serde_json::json!({}),
            },
            3,
            true,
            true,
        )
        .await
        .expect("question should run");
        assert_eq!(result.failure_reason, Some(FailureReason::TransformMiss));
        assert!(result.retrieved_paths.is_empty());
    }

    #[tokio::test]
    async fn explicit_provenance_gold_path_is_preserved() {
        let provenance_path = "/Wiki/run/conv/provenance.md".to_string();
        let imported = ImportedConversation {
            conversation_id: "conv".to_string(),
            namespace_path: "/Wiki/run".to_string(),
            namespace_index_path: "/Wiki/run/index.md".to_string(),
            base_path: "/Wiki/run/conv".to_string(),
            note_paths: vec![provenance_path.clone()],
            notes: vec![ImportedNote {
                path: provenance_path.clone(),
                content: "# Provenance\n\n- source_path: /Sources/raw/run-conv/run-conv.md\n\nMarch 15, 2024\n".to_string(),
                note_type: "provenance".to_string(),
            }],
        };
        let client = MockClient {
            nodes: BTreeMap::from([(
                provenance_path.clone(),
                Node {
                    path: provenance_path.clone(),
                    kind: vfs_types::NodeKind::File,
                    content: "# Provenance\n\n- source_path: /Sources/raw/run-conv/run-conv.md\n\nMarch 15, 2024\n".to_string(),
                    created_at: 0,
                    updated_at: 0,
                    etag: "etag".to_string(),
                    metadata_json: "{}".to_string(),
                },
            )]),
            search_hits: vec![SearchNodeHit {
                path: provenance_path,
                kind: vfs_types::NodeKind::File,
                snippet: Some("March 15, 2024".to_string()),
                preview: None,
                score: 1.0,
                match_reasons: vec!["content".to_string()],
            }],
        };
        let result = run_question(
            &client,
            "conv",
            &imported,
            BeamQuestion {
                question_id: "factoid-000".to_string(),
                question_type: "factoid".to_string(),
                question_class: BeamQuestionClass::Factoid,
                query: "When is the meeting?".to_string(),
                as_of: None,
                reference_answer: Some("March 15, 2024".to_string()),
                gold_answers: vec!["March 15, 2024".to_string()],
                gold_paths: vec!["provenance.md".to_string()],
                gold_spans: vec!["March 15, 2024".to_string()],
                expects_abstention: false,
                tags: vec!["factoid".to_string()],
                rubric_items: Vec::new(),
                raw: serde_json::json!({}),
            },
            3,
            true,
            true,
        )
        .await
        .expect("question should run");
        assert_eq!(
            result.gold_paths,
            vec!["/Wiki/run/conv/provenance.md".to_string()]
        );
        assert_ne!(result.failure_reason, Some(FailureReason::TransformMiss));
        assert!(result.gold_path_hit_at_1);
    }
}

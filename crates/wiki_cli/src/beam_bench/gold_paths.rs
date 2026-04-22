// Where: crates/wiki_cli/src/beam_bench/gold_paths.rs
// What: Shared helpers for explicit and inferred BEAM gold-path handling.
// Why: Deterministic and agent scoring must not drift on transcript/index note eligibility.
use super::dataset::BeamQuestion;
use super::import::{ImportedConversation, ImportedNote};
use super::question_types::canonical_note_candidates;

pub(crate) fn resolve_gold_paths(
    imported: &ImportedConversation,
    question: &BeamQuestion,
) -> Vec<String> {
    if has_explicit_gold_paths(question) {
        return question
            .gold_paths
            .iter()
            .map(|path| {
                if path.starts_with('/') {
                    path.clone()
                } else {
                    format!("{}/{}", imported.base_path, path.trim_start_matches('/'))
                }
            })
            .filter(|path| note_exists(path, &imported.notes))
            .collect();
    }
    let mut paths = canonical_note_candidates(&question.question_type)
        .iter()
        .filter_map(|note_type| {
            imported
                .notes
                .iter()
                .find(|note| note_type_matches(&note.note_type, note_type))
                .map(|note| note.path.clone())
        })
        .collect::<Vec<_>>();
    for path in imported
        .notes
        .iter()
        .filter(|note| is_structured_note(&note.path, &imported.notes))
        .filter(|note| {
            question
                .gold_answers
                .iter()
                .any(|answer| note.content.contains(answer))
        })
        .map(|note| note.path.clone())
    {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

fn note_type_matches(actual: &str, expected: &str) -> bool {
    actual == expected || actual.trim_end_matches(".md") == expected.trim_end_matches(".md")
}

pub(crate) fn note_counts_as_retrieved(
    path: &str,
    notes: &[ImportedNote],
    allow_explicit_gold_paths: bool,
) -> bool {
    if is_structured_note(path, notes) {
        return true;
    }
    allow_explicit_gold_paths && note_exists(path, notes)
}

pub(crate) fn has_explicit_gold_paths(question: &BeamQuestion) -> bool {
    !question.gold_paths.is_empty()
}

pub(crate) fn note_exists(path: &str, notes: &[ImportedNote]) -> bool {
    notes.iter().any(|note| note.path == path)
}

pub(crate) fn is_structured_note(path: &str, notes: &[ImportedNote]) -> bool {
    notes.iter().any(|note| {
        note.path == path
            && note.note_type != "index.md"
            && note.note_type != "index"
            && note.note_type != "provenance.md"
            && note.note_type != "provenance"
            && !note.path.starts_with("/Sources/raw/")
    })
}

#[cfg(test)]
mod tests {
    use super::resolve_gold_paths;
    use crate::beam_bench::dataset::{BeamQuestion, BeamQuestionClass};
    use crate::beam_bench::import::{ImportedConversation, ImportedNote};
    use serde_json::json;

    #[test]
    fn instruction_questions_resolve_to_plan_note_without_span_match() {
        let imported = ImportedConversation {
            conversation_id: "conv-1".to_string(),
            namespace_path: "/Wiki/run".to_string(),
            namespace_index_path: "/Wiki/run/index.md".to_string(),
            base_path: "/Wiki/run/conv-1".to_string(),
            note_paths: vec!["/Wiki/run/conv-1/plans.md".to_string()],
            notes: vec![ImportedNote {
                path: "/Wiki/run/conv-1/plans.md".to_string(),
                content: "# Plans\n\n## Scope Directives\n\n- Always use syntax highlighting.\n"
                    .to_string(),
                note_type: "plans.md".to_string(),
            }],
        };
        let question = BeamQuestion {
            question_id: "instruction_following-000".to_string(),
            question_type: "instruction_following".to_string(),
            question_class: BeamQuestionClass::Factoid,
            query: "Which libraries are used in this project?".to_string(),
            as_of: None,
            reference_answer: None,
            gold_answers: vec!["explicit version details for each dependency".to_string()],
            gold_paths: Vec::new(),
            gold_spans: Vec::new(),
            expects_abstention: false,
            tags: vec!["instruction_following".to_string()],
            rubric_items: vec![
                "LLM response should contain: explicit version details for each dependency"
                    .to_string(),
            ],
            raw: json!({}),
        };
        assert_eq!(
            resolve_gold_paths(&imported, &question),
            vec!["/Wiki/run/conv-1/plans.md".to_string()]
        );
    }

    #[test]
    fn information_extraction_prefers_facts_note_only() {
        let imported = ImportedConversation {
            conversation_id: "conv-1".to_string(),
            namespace_path: "/Wiki/run".to_string(),
            namespace_index_path: "/Wiki/run/index.md".to_string(),
            base_path: "/Wiki/run/conv-1".to_string(),
            note_paths: vec!["/Wiki/run/conv-1/facts.md".to_string()],
            notes: vec![ImportedNote {
                path: "/Wiki/run/conv-1/facts.md".to_string(),
                content: "# Facts\n\n- stack: React and Tailwind\n".to_string(),
                note_type: "facts.md".to_string(),
            }],
        };
        let question = BeamQuestion {
            question_id: "information_extraction-000".to_string(),
            question_type: "information_extraction".to_string(),
            question_class: BeamQuestionClass::Factoid,
            query: "Which stack is used?".to_string(),
            as_of: None,
            reference_answer: Some("React and Tailwind".to_string()),
            gold_answers: vec!["React and Tailwind".to_string()],
            gold_paths: Vec::new(),
            gold_spans: Vec::new(),
            expects_abstention: false,
            tags: vec!["information_extraction".to_string()],
            rubric_items: Vec::new(),
            raw: json!({}),
        };
        assert_eq!(
            resolve_gold_paths(&imported, &question),
            vec!["/Wiki/run/conv-1/facts.md".to_string()]
        );
    }
}

// Where: crates/wiki_cli/src/beam_bench/gold_paths.rs
// What: Shared helpers for explicit and inferred BEAM gold-path handling.
// Why: Deterministic and agent scoring must not drift on transcript/index note eligibility.
use super::dataset::BeamQuestion;
use super::import::{ImportedConversation, ImportedNote};

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
    imported
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
        .collect()
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
            && note.note_type != "conversation.md"
            && note.note_type != "conversation"
            && note.note_type != "index.md"
            && note.note_type != "index"
    })
}

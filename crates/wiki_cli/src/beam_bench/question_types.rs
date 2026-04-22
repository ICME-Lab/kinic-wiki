// Where: crates/wiki_cli/src/beam_bench/question_types.rs
// What: Shared BEAM question-type routing and reporting helpers.
// Why: Note generation, gold materialization, and reporting must agree on canonical note roles.
pub fn normalize_question_type(question_type: &str) -> String {
    question_type.trim().to_ascii_lowercase()
}

pub fn canonical_note_candidates(question_type: &str) -> &'static [&'static str] {
    match normalize_question_type(question_type).as_str() {
        "information_extraction" => &["facts.md"],
        "temporal_reasoning" | "event_ordering" => &["events.md"],
        "instruction_following" => &["plans.md"],
        "preference_following" => &["preferences.md"],
        "knowledge_update" => &["facts.md"],
        "contradiction_resolution" => &["open_questions.md"],
        "summarization" | "multi_session_reasoning" => &["summary.md"],
        "abstention" => &["facts.md", "events.md", "plans.md", "preferences.md"],
        _ => &["facts.md", "events.md", "plans.md"],
    }
}

pub fn question_type_tags(question_type: &str) -> Vec<String> {
    let normalized = normalize_question_type(question_type);
    let mut tags = vec![normalized.clone()];
    match normalized.as_str() {
        "information_extraction" => tags.push("facts".to_string()),
        "temporal_reasoning" | "event_ordering" => tags.push("temporal".to_string()),
        "instruction_following" => tags.push("instruction".to_string()),
        "preference_following" => tags.push("preference".to_string()),
        "knowledge_update" => tags.push("facts".to_string()),
        "contradiction_resolution" => tags.push("open_questions".to_string()),
        "summarization" | "multi_session_reasoning" => tags.push("summary".to_string()),
        "abstention" => tags.push("abstention".to_string()),
        _ => {}
    }
    tags.sort();
    tags.dedup();
    tags
}

pub fn is_summary_like(question_type: &str) -> bool {
    matches!(
        normalize_question_type(question_type).as_str(),
        "summarization" | "multi_session_reasoning"
    )
}

pub fn is_update_like(question_type: &str) -> bool {
    matches!(
        normalize_question_type(question_type).as_str(),
        "knowledge_update" | "contradiction_resolution"
    )
}

#[cfg(test)]
mod tests {
    use super::{canonical_note_candidates, question_type_tags};

    #[test]
    fn canonical_candidates_cover_full_question_types() {
        assert_eq!(
            canonical_note_candidates("information_extraction"),
            &["facts.md"]
        );
        assert_eq!(
            canonical_note_candidates("instruction_following"),
            &["plans.md"]
        );
        assert_eq!(canonical_note_candidates("knowledge_update"), &["facts.md"]);
        assert_eq!(
            canonical_note_candidates("contradiction_resolution"),
            &["open_questions.md"]
        );
        assert_eq!(canonical_note_candidates("summarization"), &["summary.md"]);
    }

    #[test]
    fn question_type_tags_add_note_role_tags() {
        assert_eq!(
            question_type_tags("preference_following"),
            vec!["preference".to_string(), "preference_following".to_string()]
        );
    }
}

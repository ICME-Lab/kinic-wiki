// Where: crates/wiki_cli/src/beam_bench/answer_match.rs
// What: Question-type-aware BEAM answer matching helpers.
// Why: Full BEAM coverage includes open-ended, directive, and update questions that exceed exact-value matching.
use super::dataset::BeamQuestion;
use super::question_types::{is_summary_like, is_update_like, normalize_question_type};

pub fn answer_exact_match(question: &BeamQuestion, predicted: Option<&str>) -> bool {
    question
        .reference_answer
        .as_deref()
        .zip(predicted)
        .map(|(expected, actual)| expected.trim() == actual.trim())
        .unwrap_or(false)
}

pub fn answer_normalized_match(question: &BeamQuestion, predicted: Option<&str>) -> bool {
    let Some(predicted) = predicted else {
        return false;
    };
    if question.expects_abstention
        || normalize_question_type(&question.question_type) == "abstention"
    {
        return abstention_match(predicted);
    }
    if question.gold_answers.iter().any(|expected| {
        normalize_text(expected) == normalize_text(predicted)
            && !normalize_text(expected).is_empty()
    }) {
        return true;
    }
    let rubric = question
        .rubric_items
        .iter()
        .map(|item| clean_rubric_clause(item))
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    if rubric.is_empty() {
        return false;
    }
    let normalized_type = normalize_question_type(&question.question_type);
    if normalized_type == "instruction_following" {
        return instruction_match(predicted, &rubric);
    }
    if normalized_type == "preference_following" {
        return preference_match(predicted, &rubric);
    }
    if normalized_type == "contradiction_resolution" {
        return contradiction_match(predicted, &rubric);
    }
    if is_update_like(&normalized_type) {
        return rubric_match(predicted, &rubric, 1);
    }
    if is_summary_like(&normalized_type) || normalized_type == "event_ordering" {
        return rubric_match(predicted, &rubric, minimum_summary_hits(rubric.len()));
    }
    rubric_match(predicted, &rubric, 1)
}

fn minimum_summary_hits(len: usize) -> usize {
    if len <= 1 { 1 } else { len.div_ceil(2) }
}

fn instruction_match(predicted: &str, rubric: &[String]) -> bool {
    let lowered = predicted.to_ascii_lowercase();
    if rubric
        .iter()
        .any(|item| item.contains("syntax highlighting"))
        && (predicted.contains("```rust")
            || predicted.contains("```python")
            || predicted.contains("```ts")
            || predicted.contains("```js")
            || predicted.contains("```sql")
            || predicted.contains("```"))
    {
        return true;
    }
    rubric_match(predicted, rubric, 1) || lowered.contains("```") || lowered.contains("code block")
}

fn preference_match(predicted: &str, rubric: &[String]) -> bool {
    let lowered = predicted.to_ascii_lowercase();
    if [
        "lightweight",
        "minimal dependenc",
        "simple",
        "easy to maintain",
        "avoid heavy",
        "built-in",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
    {
        return true;
    }
    rubric_match(predicted, rubric, 1)
}

pub fn abstention_match(predicted: &str) -> bool {
    let normalized = normalize_text(predicted);
    if abstention_disqualifier_phrases()
        .iter()
        .any(|phrase| normalized.contains(phrase))
    {
        return false;
    }
    abstention_phrases().iter().any(|phrase| {
        let normalized_phrase = normalize_text(phrase);
        normalized == normalized_phrase
            || normalized
                .strip_prefix(&normalized_phrase)
                .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with(' '))
    })
}

fn contradiction_match(predicted: &str, rubric: &[String]) -> bool {
    let lowered = predicted.to_ascii_lowercase();
    let expects_resolution = rubric_expects_resolution(rubric);
    let expects_conflict = rubric_expects_conflict(rubric);
    let rubric_hits = rubric
        .iter()
        .filter(|item| rubric_clause_matches(item, predicted))
        .count();
    let has_clarification = contradiction_phrases()
        .iter()
        .any(|phrase| lowered.contains(phrase));
    if expects_conflict && !expects_resolution {
        return has_clarification && rubric_hits >= 1;
    }
    if has_clarification {
        return rubric_hits >= 1;
    }
    if is_plain_yes_no(&lowered) && expects_resolution {
        return true;
    }
    rubric_match(predicted, rubric, 2.min(rubric.len()))
}

fn is_plain_yes_no(value: &str) -> bool {
    matches!(value.trim(), "yes" | "no" | "yes." | "no.")
}

fn rubric_expects_resolution(rubric: &[String]) -> bool {
    rubric.iter().any(|item| {
        let lowered = item.to_ascii_lowercase();
        ["latest", "corrected", "resolved", "current", "up to date"]
            .iter()
            .any(|needle| lowered.contains(needle))
    })
}

fn rubric_expects_conflict(rubric: &[String]) -> bool {
    rubric.iter().any(|item| {
        let lowered = item.to_ascii_lowercase();
        [
            "contradict",
            "conflicting information",
            "clarif",
            "which is correct",
            "which statement is correct",
        ]
        .iter()
        .any(|needle| lowered.contains(needle))
    })
}

fn rubric_match(predicted: &str, rubric: &[String], minimum_hits: usize) -> bool {
    let hits = rubric
        .iter()
        .filter(|item| rubric_clause_matches(item, predicted))
        .count();
    hits >= minimum_hits.max(1)
}

fn clean_rubric_clause(value: &str) -> String {
    [
        "LLM response should state:",
        "LLM response should mention:",
        "LLM response should contain:",
        "Response should include:",
        "Response should contain:",
    ]
    .iter()
    .find_map(|prefix| value.strip_prefix(prefix))
    .unwrap_or(value)
    .trim()
    .to_string()
}

fn rubric_clause_matches(expected: &str, actual: &str) -> bool {
    let left = normalize_text(expected);
    let right = normalize_text(actual);
    !left.is_empty()
        && !right.is_empty()
        && (left == right || right.contains(&left) || left.contains(&right))
}

fn normalize_text(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || char.is_whitespace() {
                char
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn abstention_phrases() -> &'static [&'static str] {
    &[
        "insufficient evidence",
        "no information",
        "not enough information",
        "there is not enough information in the chat",
        "not mentioned",
        "not provided in the chat",
        "there is no information related to",
        "based on the provided chat there is no information",
        "based on the chat there is no information",
    ]
}

fn abstention_disqualifier_phrases() -> &'static [&'static str] {
    &[" but ", " probably ", " likely ", " maybe ", " perhaps "]
}

fn contradiction_phrases() -> &'static [&'static str] {
    &[
        "contradictory information",
        "conflicting information",
        "please clarify",
        "clarify which is correct",
        "which is correct",
        "which statement is correct",
        "there is a contradiction",
    ]
}

#[cfg(test)]
mod tests {
    use super::{abstention_match, answer_normalized_match};
    use crate::beam_bench::dataset::{BeamQuestion, BeamQuestionClass};
    use serde_json::json;

    fn question(question_type: &str, gold_answers: &[&str], rubric_items: &[&str]) -> BeamQuestion {
        BeamQuestion {
            question_id: "q".to_string(),
            question_type: question_type.to_string(),
            question_class: BeamQuestionClass::Reasoning,
            query: "q".to_string(),
            as_of: None,
            reference_answer: gold_answers.first().map(|value| (*value).to_string()),
            gold_answers: gold_answers
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            gold_paths: Vec::new(),
            gold_spans: Vec::new(),
            expects_abstention: false,
            tags: vec![question_type.to_string()],
            rubric_items: rubric_items
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            raw: json!({}),
        }
    }

    #[test]
    fn instruction_match_accepts_syntax_highlighted_blocks() {
        let question = question(
            "instruction_following",
            &[],
            &["LLM response should contain: code blocks with syntax highlighting"],
        );
        assert!(answer_normalized_match(
            &question,
            Some("Use this:\n```rust\nfn main() {}\n```")
        ));
    }

    #[test]
    fn contradiction_match_accepts_clarification_language_with_rubric_content() {
        let question = question(
            "contradiction_resolution",
            &[],
            &["LLM response should state: conflicting information between March 15 and April 10"],
        );
        assert!(answer_normalized_match(
            &question,
            Some(
                "There is conflicting information between March 15 and April 10. Please clarify which is correct."
            )
        ));
    }

    #[test]
    fn contradiction_match_rejects_plain_yes_no() {
        let question = question(
            "contradiction_resolution",
            &[],
            &["LLM response should state: there is contradictory information"],
        );
        assert!(!answer_normalized_match(&question, Some("yes")));
    }

    #[test]
    fn contradiction_match_accepts_plain_yes_no_for_resolved_value() {
        let question = question(
            "contradiction_resolution",
            &[],
            &["LLM response should state: the corrected latest value is yes"],
        );
        assert!(answer_normalized_match(&question, Some("yes")));
    }

    #[test]
    fn gold_answer_does_not_match_partial_prediction() {
        let question = question("information_extraction", &["March 15, 2024"], &[]);
        assert!(!answer_normalized_match(&question, Some("March")));
    }

    #[test]
    fn short_gold_answer_does_not_match_longer_prediction() {
        let question = question("information_extraction", &["15"], &[]);
        assert!(!answer_normalized_match(&question, Some("March 15, 2024")));
    }

    #[test]
    fn abstention_match_accepts_common_rejection_phrases() {
        assert!(abstention_match("insufficient evidence"));
        assert!(abstention_match(
            "There is not enough information in the chat."
        ));
        assert!(abstention_match(
            "Based on the provided chat, there is no information about Bryan's advice."
        ));
    }

    #[test]
    fn abstention_match_rejects_topical_answer() {
        assert!(!abstention_match(
            "The feedback improved the sidebar and dark mode before launch."
        ));
    }

    #[test]
    fn abstention_match_rejects_guess_after_refusal() {
        assert!(!abstention_match(
            "insufficient evidence, but it was probably React"
        ));
    }

    #[test]
    fn contradiction_match_rejects_clarify_only_answer() {
        let question = question(
            "contradiction_resolution",
            &[],
            &["LLM response should state: conflicting information between March 15 and April 10"],
        );
        assert!(!answer_normalized_match(
            &question,
            Some("There is conflicting information here. Please clarify which is correct.")
        ));
    }
}

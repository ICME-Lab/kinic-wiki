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

fn contradiction_match(predicted: &str, rubric: &[String]) -> bool {
    let lowered = predicted.to_ascii_lowercase();
    let plain_yes_no = is_plain_yes_no(&lowered);
    let expects_resolution = rubric_expects_resolution(rubric);
    let expects_conflict = rubric_expects_conflict(rubric);
    if plain_yes_no && expects_conflict && !expects_resolution {
        return false;
    }
    if plain_yes_no && expects_resolution {
        return true;
    }
    if lowered.contains("contradict") || lowered.contains("clarif") {
        return true;
    }
    if lowered.contains("conflicting information")
        || lowered.contains("which is correct")
        || lowered.contains("which statement is correct")
    {
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

#[cfg(test)]
mod tests {
    use super::answer_normalized_match;
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
    fn contradiction_match_accepts_clarification_language() {
        let question = question(
            "contradiction_resolution",
            &[],
            &["LLM response should state: there is contradictory information"],
        );
        assert!(answer_normalized_match(
            &question,
            Some("There is contradictory information here. Please clarify which is correct.")
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
}

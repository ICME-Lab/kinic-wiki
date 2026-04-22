// Where: crates/wiki_cli/src/beam_bench/note_extract.rs
// What: Role-specific extraction for BEAM structured notes beyond facts/events/plans.
// Why: Keep unresolved state and recap separate from stable knowledge notes.
use super::dataset::BeamConversation;
use super::note_support::{ChatTurn, flatten_chat};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
struct SubjectValue {
    subject: String,
    value: String,
    explicit_latest: bool,
}

#[derive(Debug, Clone)]
struct CapabilityClaim {
    topic: String,
    claim: String,
}

pub fn extract_preference_lines(conversation: &BeamConversation) -> Vec<String> {
    let mut lines = Vec::new();
    append_profile_preferences(&conversation.user_profile.to_string(), &mut lines);
    for turn in flatten_chat(&conversation.chat)
        .into_iter()
        .filter(|turn| turn.label() == "user")
    {
        let text = turn.content.trim();
        let lowered = text.to_ascii_lowercase();
        if lowered.contains("prefer ")
            || lowered.contains("i like ")
            || lowered.contains("i dislike ")
            || lowered.contains("favorite ")
            || lowered.contains("lightweight")
            || lowered.contains("easy to maintain")
        {
            lines.push(text.to_string());
        }
    }
    dedupe(lines)
}

pub fn extract_instruction_lines(conversation: &BeamConversation) -> Vec<String> {
    let mut lines = Vec::new();
    for turn in flatten_chat(&conversation.chat)
        .into_iter()
        .filter(|turn| turn.label() == "user")
    {
        let text = turn.content.trim();
        if !looks_concise_directive_candidate(text) {
            continue;
        }
        let lowered = text.to_ascii_lowercase();
        if lowered.starts_with("please ")
            || lowered.starts_with("always ")
            || lowered.starts_with("do not ")
            || lowered.starts_with("don't ")
            || lowered.starts_with("remember ")
            || lowered.contains("when i ask")
        {
            lines.push(text.to_string());
        }
    }
    dedupe(lines)
}

pub fn extract_open_question_lines(conversation: &BeamConversation) -> Vec<String> {
    let mut history = BTreeMap::<String, Vec<SubjectValue>>::new();
    let mut negative_claims = Vec::new();
    let mut affirmative_claims = Vec::new();
    for turn in flatten_chat(&conversation.chat)
        .into_iter()
        .filter(|turn| turn.label() == "user")
    {
        collect_capability_claims(
            turn.content.trim(),
            &mut negative_claims,
            &mut affirmative_claims,
        );
        if let Some(subject_value) = extract_subject_value(&turn.content) {
            history
                .entry(subject_value.subject.clone())
                .or_default()
                .push(subject_value);
        }
    }
    let mut lines = Vec::new();
    for (subject, values) in history {
        if values.is_empty() {
            continue;
        }
        let distinct = distinct_values(&values);
        if distinct.len() > 1 {
            lines.push(format!("{subject} conflict: yes"));
            lines.push(format!(
                "{subject} conflicting_values: {}",
                distinct.join(" | ")
            ));
            if let Some(latest) = resolved_latest_value(&values) {
                lines.push(format!("{subject} resolved: yes"));
                lines.push(format!("{subject} latest_value: {latest}"));
                lines.push(format!("{subject} corrected_value: {latest}"));
            } else {
                lines.push(format!("{subject} resolved: no"));
            }
        }
    }
    let explicit_conflicts = explicit_conflict_lines(&conversation.conversation_plan)
        .into_iter()
        .chain(explicit_conflict_lines(&conversation.narratives))
        .collect::<Vec<_>>();
    if !explicit_conflicts.is_empty() {
        lines.push("explicit_conflict: yes".to_string());
        lines.push("explicit_conflict_resolved: no".to_string());
        for line in explicit_conflicts {
            lines.push(format!("explicit_conflict_statement: {line}"));
        }
    }
    if let Some((negative, affirmative)) =
        matching_capability_conflict(&negative_claims, &affirmative_claims)
    {
        lines.push("capability_conflict: yes".to_string());
        lines.push("capability_conflict_resolved: no".to_string());
        lines.push(format!(
            "capability_conflicting_claims: {} | {}",
            negative.claim, affirmative.claim
        ));
    }
    dedupe(lines)
}

pub fn extract_summary_lines(conversation: &BeamConversation) -> Vec<String> {
    let mut lines = Vec::new();
    lines.push(format!("conversation_id: {}", conversation.conversation_id));
    if let Some(title) = conversation
        .conversation_seed
        .get("title")
        .and_then(|value| value.as_str())
    {
        lines.push(format!("scope title: {title}"));
    }
    if let Some(category) = conversation
        .conversation_seed
        .get("category")
        .and_then(|value| value.as_str())
    {
        lines.push(format!("scope category: {category}"));
    }
    lines.push(format!(
        "turn count: {}",
        flatten_chat(&conversation.chat).len()
    ));
    dedupe(lines)
}

pub fn render_turn_reference(turn: &ChatTurn, ordinal: usize) -> String {
    let mut parts = vec![format!("Turn {ordinal:04}")];
    if let Some(chat_id) = &turn.chat_id {
        parts.push(format!("chat_id {}", chat_id));
    }
    if let Some(index) = &turn.index {
        parts.push(format!("index {}", index));
    }
    if let Some(anchor) = &turn.time_anchor {
        parts.push(format!("time_anchor {}", anchor));
    }
    if let Some(question_type) = &turn.question_type {
        parts.push(format!("question_type {}", question_type));
    }
    parts.join(" | ")
}

fn append_profile_preferences(text: &str, lines: &mut Vec<String>) {
    let lowered = text.to_ascii_lowercase();
    for needle in [
        "prefer",
        "preference",
        "favorite",
        "lightweight",
        "simple",
        "maintain",
    ] {
        if lowered.contains(needle) {
            lines.push(text.to_string());
            return;
        }
    }
}

fn extract_subject_value(text: &str) -> Option<SubjectValue> {
    if !looks_concise_update_candidate(text) {
        return None;
    }
    let lowered = text.to_ascii_lowercase();
    for (separator, suffix) in [
        (" is on ", Some("date")),
        (" is at ", Some("time")),
        (" is in ", Some("location")),
        (" averages ", None),
        (" average is ", None),
        (" is ", None),
    ] {
        let Some(index) = lowered.find(separator) else {
            continue;
        };
        let mut subject = text[..index].trim().to_ascii_lowercase();
        subject = subject
            .trim_start_matches("please remember that ")
            .trim_start_matches("update: ")
            .trim_start_matches("updated: ")
            .trim_start_matches("the ")
            .trim_start_matches("my ")
            .trim()
            .to_string();
        if let Some(suffix) = suffix {
            subject.push(' ');
            subject.push_str(suffix);
        }
        let value = text[index + separator.len()..].trim().trim_end_matches('.');
        if subject.is_empty()
            || value.is_empty()
            || subject.len() > 48
            || value.len() > 120
            || subject.split_whitespace().count() > 6
        {
            return None;
        }
        return Some(SubjectValue {
            subject,
            value: value.to_string(),
            explicit_latest: has_explicit_latest_marker(text),
        });
    }
    None
}

fn looks_concise_update_candidate(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() > 180 {
        return false;
    }
    if trimmed.contains('\n') || trimmed.contains("```") || trimmed.contains('?') {
        return false;
    }
    true
}

fn looks_concise_directive_candidate(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() > 240 {
        return false;
    }
    if trimmed.contains('\n') || trimmed.contains("```") {
        return false;
    }
    true
}

fn dedupe(lines: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        if !out.contains(&line) {
            out.push(line);
        }
    }
    out
}

fn distinct_values(values: &[SubjectValue]) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        if !out.contains(&value.value) {
            out.push(value.value.clone());
        }
    }
    out
}

fn has_resolved_latest(values: &[SubjectValue]) -> bool {
    values.iter().any(|value| value.explicit_latest)
}

fn resolved_latest_value(values: &[SubjectValue]) -> Option<String> {
    if !has_resolved_latest(values) {
        return None;
    }
    values
        .iter()
        .rev()
        .find(|value| value.explicit_latest)
        .map(|value| value.value.clone())
}

fn has_explicit_latest_marker(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    [
        "latest:",
        "corrected",
        "correction",
        "actually",
        "update:",
        "updated",
        "now ",
        "currently",
        "recently",
        "has grown to",
        "grew to",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

fn explicit_conflict_lines(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("• **Logical Contradiction:**"))
        .map(|line| line.trim().to_string())
        .collect()
}

fn collect_capability_claims(
    text: &str,
    negative_claims: &mut Vec<CapabilityClaim>,
    affirmative_claims: &mut Vec<CapabilityClaim>,
) {
    let lowered = text.to_ascii_lowercase();
    if let Some(topic) = extract_capability_topic(&lowered) {
        if [
            "i have never ",
            "i've never ",
            "i never ",
            "i have not ",
            "i haven't ",
            "starting from scratch",
        ]
        .iter()
        .any(|needle| lowered.contains(needle))
        {
            negative_claims.push(CapabilityClaim {
                topic: topic.clone(),
                claim: squeeze_line(text),
            });
        }
        if [
            "i implemented ",
            "i added ",
            "i configured ",
            "i deployed ",
            "i fixed ",
            "i created ",
            "i wrote ",
            "i set up ",
            "i integrated ",
            "i upgraded ",
        ]
        .iter()
        .any(|needle| lowered.contains(needle))
        {
            affirmative_claims.push(CapabilityClaim {
                topic,
                claim: squeeze_line(text),
            });
        }
    }
}

fn extract_capability_topic(text: &str) -> Option<String> {
    let normalized = text
        .replace("any ", "")
        .replace("a basic ", "")
        .replace("this project", "")
        .replace("with ", " ")
        .replace(" in ", " ")
        .replace(" for ", " ");
    for (marker, canonical) in [
        ("flask route", "route"),
        ("route", "route"),
        ("homepage", "homepage"),
        ("deployment", "deployment"),
        ("production", "production"),
        ("react component", "component"),
        ("component", "component"),
        ("api endpoint", "endpoint"),
        ("endpoint", "endpoint"),
        ("database schema", "schema"),
        ("schema", "schema"),
    ] {
        if normalized.contains(marker) {
            return Some(canonical.to_string());
        }
    }
    None
}

fn matching_capability_conflict<'a>(
    negative_claims: &'a [CapabilityClaim],
    affirmative_claims: &'a [CapabilityClaim],
) -> Option<(&'a CapabilityClaim, &'a CapabilityClaim)> {
    negative_claims.iter().find_map(|negative| {
        affirmative_claims
            .iter()
            .find(|affirmative| affirmative.topic == negative.topic)
            .map(|affirmative| (negative, affirmative))
    })
}

fn squeeze_line(text: &str) -> String {
    let mut out = text.trim().replace('\n', " ");
    if out.len() > 160 {
        out.truncate(157);
        out.push_str("...");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{extract_instruction_lines, extract_open_question_lines, extract_summary_lines};
    use crate::beam_bench::dataset::BeamConversation;
    use serde_json::json;

    fn conversation_with_chat(lines: &[&str]) -> BeamConversation {
        let messages = lines
            .iter()
            .map(|line| json!({"role":"user","content":line}))
            .collect::<Vec<_>>();
        BeamConversation {
            conversation_id: "conv-1".to_string(),
            conversation_seed: json!({"title":"Sample","category":"General"}),
            narratives: "High-level recap".to_string(),
            user_profile: json!({}),
            conversation_plan: "Discuss changes".to_string(),
            user_questions: json!([]),
            chat: json!([messages]),
            probing_questions: "{}".to_string(),
        }
    }

    #[test]
    fn extract_open_question_lines_marks_unresolved_conflict() {
        let conversation = conversation_with_chat(&[
            "The deployment is on March 15, 2024.",
            "The deployment is on April 10, 2024.",
        ]);
        let lines = extract_open_question_lines(&conversation);
        assert!(lines.contains(&"deployment date conflict: yes".to_string()));
        assert!(lines.contains(&"deployment date resolved: no".to_string()));
        assert!(lines.iter().any(|line| line.contains("conflicting_values")));
    }

    #[test]
    fn extract_open_question_lines_keeps_resolved_latest_value() {
        let conversation = conversation_with_chat(&[
            "The deployment is on March 15, 2024.",
            "Update: the deployment is on April 10, 2024.",
        ]);
        let lines = extract_open_question_lines(&conversation);
        assert!(lines.contains(&"deployment date conflict: yes".to_string()));
        assert!(lines.contains(&"deployment date resolved: yes".to_string()));
        assert!(lines.contains(&"deployment date latest_value: April 10, 2024".to_string()));
        assert!(lines.contains(&"deployment date corrected_value: April 10, 2024".to_string()));
    }

    #[test]
    fn extract_summary_lines_stays_coarse() {
        let conversation =
            conversation_with_chat(&["Please remember that the meeting is on March 15, 2024."]);
        let lines = extract_summary_lines(&conversation);
        assert!(lines.contains(&"conversation_id: conv-1".to_string()));
        assert!(lines.contains(&"scope title: Sample".to_string()));
        assert!(!lines.iter().any(|line| line.contains("March 15, 2024")));
    }

    #[test]
    fn extract_open_question_lines_marks_capability_conflict() {
        let conversation = conversation_with_chat(&[
            "I've never written any Flask routes in this project.",
            "I implemented a basic homepage route with Flask.",
        ]);
        let lines = extract_open_question_lines(&conversation);
        assert!(lines.contains(&"capability_conflict: yes".to_string()));
        assert!(lines.contains(&"capability_conflict_resolved: no".to_string()));
        assert!(
            lines
                .iter()
                .any(|line| line.contains("capability_conflicting_claims"))
        );
    }

    #[test]
    fn extract_open_question_lines_ignores_mismatched_capability_topics() {
        let conversation = conversation_with_chat(&[
            "I've never deployed to production.",
            "I implemented a basic homepage route with Flask.",
        ]);
        let lines = extract_open_question_lines(&conversation);
        assert!(!lines.contains(&"capability_conflict: yes".to_string()));
        assert!(
            !lines
                .iter()
                .any(|line| line.contains("capability_conflicting_claims"))
        );
    }

    #[test]
    fn extract_open_question_lines_ignores_long_question_prompts() {
        let conversation = conversation_with_chat(&[
            "I'm trying to use a public weather API without OAuth, but I'm worried about exposing my API key in the browser. How should I store it securely?",
        ]);
        let lines = extract_open_question_lines(&conversation);
        assert!(!lines.iter().any(|line| line.contains("latest_value")));
        assert!(!lines.iter().any(|line| line.contains("resolved: yes")));
    }

    #[test]
    fn extract_open_question_lines_collects_explicit_conflicts_from_plan_text() {
        let mut conversation = conversation_with_chat(&[]);
        conversation.conversation_plan =
            "BATCH 1 PLAN\n• **Logical Contradiction:** I have never submitted the cover letter."
                .to_string();
        let lines = extract_open_question_lines(&conversation);
        assert!(lines.contains(&"explicit_conflict: yes".to_string()));
        assert!(lines.iter().any(|line| {
            line == "explicit_conflict_statement: I have never submitted the cover letter."
        }));
    }

    #[test]
    fn extract_instruction_lines_keeps_concise_scope_directives_only() {
        let conversation = conversation_with_chat(&[
            "Always include version numbers when I ask about software dependencies or libraries used.",
            "I'm trying to implement Flask-Login here.\n```python\nprint('hi')\n```",
            "I've never written any Flask routes or handled HTTP requests in this project before.",
        ]);
        let lines = extract_instruction_lines(&conversation);
        assert_eq!(
            lines,
            vec!["Always include version numbers when I ask about software dependencies or libraries used.".to_string()]
        );
    }
}

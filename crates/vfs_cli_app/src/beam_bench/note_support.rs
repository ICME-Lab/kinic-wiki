// Where: crates/wiki_cli/src/beam_bench/note_support.rs
// What: Shared note helpers plus lightweight fact and identifier extraction.
// Why: BEAM notes need stable role-specific rendering without growing one renderer file indefinitely.
use super::dataset::BeamConversation;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Debug, Clone)]
pub struct ChatTurn {
    role: Option<String>,
    pub content: String,
    pub chat_id: Option<String>,
    pub index: Option<String>,
    pub question_type: Option<String>,
    pub time_anchor: Option<String>,
}

impl ChatTurn {
    pub fn label(&self) -> String {
        self.role
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("message")
            .to_string()
    }
}

pub fn flatten_chat(value: &Value) -> Vec<ChatTurn> {
    let mut turns = Vec::new();
    collect_chat_messages(value, &mut turns);
    turns
}

pub fn extract_fact_lines(conversation: &BeamConversation) -> Vec<String> {
    let mut lines = Vec::new();
    for turn in flatten_chat(&conversation.chat) {
        if turn.label() == "assistant" {
            continue;
        }
        let trimmed = turn.content.trim();
        if let Some(line) = extract_stable_statement_fact(trimmed) {
            lines.push(line);
        }
    }
    dedupe_lines(lines)
}

pub fn extract_identifier_lines(conversation: &BeamConversation) -> Vec<String> {
    let mut lines = vec![format!("conversation_id: {}", conversation.conversation_id)];
    push_named_scalar(
        &conversation.conversation_seed,
        "title",
        "title",
        &mut lines,
    );
    push_named_scalar(
        &conversation.conversation_seed,
        "category",
        "category",
        &mut lines,
    );
    dedupe_lines(lines)
}

pub fn append_related_section(out: &mut String, base_path: &str, note_names: &[&str]) {
    out.push_str("## Related\n\n");
    for note_name in note_names {
        out.push_str(&format!("- [{note_name}]({base_path}/{note_name})\n"));
    }
    out.push('\n');
}

pub fn append_json_section(out: &mut String, title: &str, value: &Value) {
    out.push_str(&format!("## {title}\n\n"));
    out.push_str(&fenced_json(value));
    out.push_str("\n\n");
}

pub fn append_text_section(out: &mut String, title: &str, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    out.push_str(&format!("## {title}\n\n{trimmed}\n\n"));
}

fn collect_chat_messages(value: &Value, turns: &mut Vec<ChatTurn>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_chat_messages(item, turns);
            }
        }
        Value::Object(object) => {
            if let Some(content) = object.get("content").and_then(Value::as_str) {
                turns.push(ChatTurn {
                    role: object
                        .get("role")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    content: content.to_string(),
                    chat_id: object.get("id").map(scalar_value),
                    index: object.get("index").map(scalar_value),
                    question_type: object.get("question_type").map(scalar_value),
                    time_anchor: object.get("time_anchor").map(scalar_value),
                });
                return;
            }
            if let Some(nested) = object.get("messages") {
                collect_chat_messages(nested, turns);
            }
        }
        Value::String(text) => turns.push(ChatTurn {
            role: None,
            content: text.clone(),
            chat_id: None,
            index: None,
            question_type: None,
            time_anchor: None,
        }),
        _ => {}
    }
}

fn push_named_scalar(value: &Value, key: &str, label: &str, lines: &mut Vec<String>) {
    if let Some(text) = value.get(key).and_then(Value::as_str) {
        push_fact_line(label, None, text, lines);
    }
}

fn push_fact_line(label: &str, prefix: Option<String>, value: &str, lines: &mut Vec<String>) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    match prefix {
        Some(prefix) => lines.push(format!("{label}.{prefix}: {trimmed}")),
        None => lines.push(format!("{label}: {trimmed}")),
    }
}

fn dedupe_lines(lines: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for line in lines {
        if seen.insert(line.clone()) {
            out.push(line);
        }
    }
    out
}

fn extract_stable_statement_fact(text: &str) -> Option<String> {
    let normalized = text
        .trim()
        .trim_end_matches('.')
        .trim_start_matches("Please remember that ")
        .trim_start_matches("please remember that ");
    let lowered = normalized.to_ascii_lowercase();
    if let Some((subject, value)) = split_once_insensitive(normalized, " is on ") {
        let subject = normalize_subject(subject);
        return Some(format!("{subject} date: {}", value.trim()));
    }
    if let Some((subject, value)) = split_once_insensitive(normalized, " is at ") {
        let subject = normalize_subject(subject);
        return Some(format!("{subject} time: {}", value.trim()));
    }
    if let Some((subject, value)) = split_once_insensitive(normalized, " is in ") {
        let subject = normalize_subject(subject);
        return Some(format!("{subject} location: {}", value.trim()));
    }
    if let Some((subject, value)) = split_once_insensitive(normalized, " has ") {
        let subject = normalize_subject(subject);
        let value = value.trim();
        if value
            .chars()
            .next()
            .is_some_and(|char| char.is_ascii_digit())
        {
            return Some(format!("{subject} detail: {value}"));
        }
    }
    if lowered.starts_with("my ") && lowered.contains(" preference is ") {
        return Some(format!("preference: {normalized}"));
    }
    None
}

fn split_once_insensitive<'a>(text: &'a str, needle: &str) -> Option<(&'a str, &'a str)> {
    let lowered = text.to_ascii_lowercase();
    let index = lowered.find(needle)?;
    Some((&text[..index], &text[index + needle.len()..]))
}

fn normalize_subject(subject: &str) -> String {
    let lowered = subject.trim().to_ascii_lowercase();
    lowered
        .trim_start_matches("the ")
        .trim_start_matches("my ")
        .trim()
        .to_string()
}

fn fenced_json(value: &Value) -> String {
    format!(
        "```json\n{}\n```",
        serde_json::to_string_pretty(value).expect("JSON value should serialize")
    )
}

fn scalar_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::extract_fact_lines;
    use crate::beam_bench::dataset::BeamConversation;
    use serde_json::json;

    fn conversation_with_chat(text: &str) -> BeamConversation {
        BeamConversation {
            conversation_id: "Conv 1".to_string(),
            conversation_seed: json!({"title":"Sample","category":"General"}),
            narratives: String::new(),
            user_profile: json!({}),
            conversation_plan: String::new(),
            user_questions: json!([]),
            chat: json!([[{"role":"user","content":text}]]),
            probing_questions: "{}".to_string(),
        }
    }

    #[test]
    fn extract_fact_lines_keeps_numeric_non_temporal_statements() {
        let conversation = conversation_with_chat("The order has 3 items.");
        let lines = extract_fact_lines(&conversation);
        assert!(lines.contains(&"order detail: 3 items".to_string()));
    }

    #[test]
    fn extract_fact_lines_still_skips_temporal_ordered_statements() {
        let conversation = conversation_with_chat("The first delivery arrives after the second.");
        let lines = extract_fact_lines(&conversation);
        assert!(!lines.iter().any(|line| line.contains("delivery")));
    }

    #[test]
    fn extract_fact_lines_drops_topic_only_requests() {
        let conversation =
            conversation_with_chat("Can you help me improve the UI/UX before the public launch?");
        let lines = extract_fact_lines(&conversation);
        assert!(!lines.iter().any(|line| line.contains("UI/UX")));
    }

    #[test]
    fn extract_fact_lines_do_not_dump_seed_or_plan_text() {
        let mut conversation =
            conversation_with_chat("Please remember that the meeting is on March 15, 2024.");
        conversation.conversation_plan =
            "BATCH 1 PLAN\n• **Current Situation:** drafting the memo".to_string();
        conversation.narratives = "Label dump".to_string();
        let lines = extract_fact_lines(&conversation);
        assert!(!lines.iter().any(|line| line.contains("conversation_seed")));
        assert!(!lines.iter().any(|line| line.contains("conversation_plan")));
        assert!(!lines.iter().any(|line| line.contains("narratives")));
        assert!(lines.contains(&"meeting date: March 15, 2024".to_string()));
    }
}

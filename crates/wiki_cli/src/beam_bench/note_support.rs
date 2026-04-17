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
    push_json_facts(
        "conversation_seed",
        &conversation.conversation_seed,
        &mut lines,
    );
    push_json_facts("user_profile", &conversation.user_profile, &mut lines);
    push_text_fact(
        "conversation_plan",
        &conversation.conversation_plan,
        &mut lines,
    );
    push_text_fact("narratives", &conversation.narratives, &mut lines);
    for turn in flatten_chat(&conversation.chat) {
        if turn.label() == "assistant" {
            continue;
        }
        lines.push(format!("statement: {}", turn.content.trim()));
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
    push_text_fact("plan", &conversation.conversation_plan, &mut lines);
    push_json_facts_limited("user_profile", &conversation.user_profile, &mut lines, 2);
    for line in extract_fact_lines(conversation)
        .into_iter()
        .filter(|line| {
            !line.starts_with("conversation_seed.")
                && !line.starts_with("conversation_plan:")
                && !line.starts_with("narratives:")
        })
        .take(3)
    {
        lines.push(line);
    }
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
        }),
        _ => {}
    }
}

fn push_json_facts(label: &str, value: &Value, lines: &mut Vec<String>) {
    collect_json_facts(label, value, lines, None, None);
}

fn push_json_facts_limited(label: &str, value: &Value, lines: &mut Vec<String>, limit: usize) {
    collect_json_facts(label, value, lines, None, Some(limit));
}

fn collect_json_facts(
    label: &str,
    value: &Value,
    lines: &mut Vec<String>,
    prefix: Option<String>,
    limit: Option<usize>,
) {
    if limit.is_some_and(|value| lines.len() >= value) {
        return;
    }
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let next = match &prefix {
                    Some(existing) => format!("{existing}.{key}"),
                    None => key.clone(),
                };
                collect_json_facts(label, child, lines, Some(next), limit);
                if limit.is_some_and(|value| lines.len() >= value) {
                    return;
                }
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                let next = match &prefix {
                    Some(existing) => format!("{existing}[{index}]"),
                    None => format!("[{index}]"),
                };
                collect_json_facts(label, child, lines, Some(next), limit);
                if limit.is_some_and(|value| lines.len() >= value) {
                    return;
                }
            }
        }
        Value::String(text) => push_fact_line(label, prefix, text, lines),
        Value::Number(number) => push_fact_line(label, prefix, &number.to_string(), lines),
        Value::Bool(boolean) => push_fact_line(label, prefix, &boolean.to_string(), lines),
        Value::Null => {}
    }
}

fn push_named_scalar(value: &Value, key: &str, label: &str, lines: &mut Vec<String>) {
    if let Some(text) = value.get(key).and_then(Value::as_str) {
        push_fact_line(label, None, text, lines);
    }
}

fn push_text_fact(label: &str, value: &str, lines: &mut Vec<String>) {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        lines.push(format!("{label}: {trimmed}"));
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

fn fenced_json(value: &Value) -> String {
    format!(
        "```json\n{}\n```",
        serde_json::to_string_pretty(value).expect("JSON value should serialize")
    )
}

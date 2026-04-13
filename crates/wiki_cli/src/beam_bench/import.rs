// Where: crates/wiki_cli/src/beam_bench/import.rs
// What: Deterministic conversion from BEAM raw conversations into llm-wiki notes.
// Why: The benchmark should measure retrieval over stable wiki-shaped notes rather than over ad hoc JSON blobs.
use crate::client::WikiApi;
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use wiki_types::{NodeKind, WriteNodeRequest};

use super::dataset::BeamConversation;

#[derive(Debug, Clone, Serialize)]
pub struct ImportedConversation {
    pub conversation_id: String,
    pub base_path: String,
    pub note_paths: Vec<String>,
}

pub async fn import_conversation(
    client: &impl WikiApi,
    namespace: &str,
    conversation: &BeamConversation,
) -> Result<ImportedConversation> {
    let base_path = format!(
        "/Wiki/beam/{}/{}",
        sanitize_segment(namespace),
        sanitize_segment(&conversation.conversation_id)
    );
    let documents = build_documents(conversation, &base_path);
    let mut note_paths = Vec::with_capacity(documents.len());
    for (path, content) in documents {
        client
            .write_node(WriteNodeRequest {
                path: path.clone(),
                kind: NodeKind::File,
                content,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            })
            .await?;
        note_paths.push(path);
    }
    Ok(ImportedConversation {
        conversation_id: conversation.conversation_id.clone(),
        base_path,
        note_paths,
    })
}

fn build_documents(conversation: &BeamConversation, base_path: &str) -> Vec<(String, String)> {
    vec![
        (
            format!("{base_path}/conversation.md"),
            conversation_markdown(conversation),
        ),
        (
            format!("{base_path}/profile.md"),
            json_markdown("Profile", &conversation.user_profile),
        ),
        (
            format!("{base_path}/plan.md"),
            text_markdown("Plan", &conversation.conversation_plan),
        ),
        (
            format!("{base_path}/user_questions.md"),
            json_markdown("User Questions", &conversation.user_questions),
        ),
    ]
}

fn conversation_markdown(conversation: &BeamConversation) -> String {
    let mut lines = vec![
        format!("# BEAM Conversation {}", conversation.conversation_id),
        String::new(),
        "## Seed".to_string(),
        fenced_json(&conversation.conversation_seed),
        String::new(),
    ];
    if !conversation.narratives.trim().is_empty() {
        lines.push("## Narratives".to_string());
        lines.push(conversation.narratives.trim().to_string());
        lines.push(String::new());
    }
    lines.push("## Chat".to_string());
    let messages = flatten_chat(&conversation.chat);
    if messages.is_empty() {
        lines.push("_No chat messages extracted._".to_string());
    } else {
        for (index, message) in messages.iter().enumerate() {
            lines.push(format!("### {:04} {}", index + 1, message.label()));
            lines.push(message.content.clone());
            lines.push(String::new());
        }
    }
    lines.join("\n")
}

fn json_markdown(title: &str, value: &Value) -> String {
    format!("# {title}\n\n{}", fenced_json(value))
}

fn text_markdown(title: &str, value: &str) -> String {
    format!("# {title}\n\n{}", value.trim())
}

fn fenced_json(value: &Value) -> String {
    format!(
        "```json\n{}\n```",
        serde_json::to_string_pretty(value).expect("JSON value should serialize")
    )
}

fn sanitize_segment(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "unknown".to_string();
    }
    trimmed
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

#[derive(Debug, Clone)]
struct ChatMessage {
    role: Option<String>,
    content: String,
}

impl ChatMessage {
    fn label(&self) -> String {
        self.role
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("message")
            .to_string()
    }
}

fn flatten_chat(value: &Value) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    collect_chat_messages(value, &mut messages);
    messages
}

fn collect_chat_messages(value: &Value, messages: &mut Vec<ChatMessage>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_chat_messages(item, messages);
            }
        }
        Value::Object(object) => {
            if let Some(content) = object.get("content").and_then(Value::as_str) {
                messages.push(ChatMessage {
                    role: object
                        .get("role")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    content: content.to_string(),
                });
                return;
            }
            if let Some(nested) = object.get("messages") {
                collect_chat_messages(nested, messages);
            }
        }
        Value::String(text) => {
            messages.push(ChatMessage {
                role: None,
                content: text.clone(),
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{build_documents, flatten_chat};
    use crate::beam_bench::dataset::BeamConversation;
    use serde_json::json;

    fn sample_conversation() -> BeamConversation {
        BeamConversation {
            conversation_id: "conv-1".to_string(),
            conversation_seed: json!({"category":"General"}),
            narratives: "narrative".to_string(),
            user_profile: json!({"user_info":"profile"}),
            conversation_plan: "plan".to_string(),
            user_questions: json!([{"messages":["question"]}]),
            chat: json!([[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"}]]),
            probing_questions:
                "{\"abstention\":[{\"question\":\"What did the assistant say?\",\"answer\":\"hi\"}]}"
                    .to_string(),
        }
    }

    #[test]
    fn flatten_chat_preserves_message_order() {
        let messages = flatten_chat(&sample_conversation().chat);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "hello");
        assert_eq!(messages[1].content, "hi");
    }

    #[test]
    fn build_documents_emits_deterministic_note_set() {
        let documents = build_documents(&sample_conversation(), "/Wiki/beam/run/conv-1");
        let paths = documents
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                "/Wiki/beam/run/conv-1/conversation.md".to_string(),
                "/Wiki/beam/run/conv-1/profile.md".to_string(),
                "/Wiki/beam/run/conv-1/plan.md".to_string(),
                "/Wiki/beam/run/conv-1/user_questions.md".to_string()
            ]
        );
        assert!(documents[0].1.contains("### 0001 user"));
        assert!(documents[0].1.contains("### 0002 assistant"));
    }
}

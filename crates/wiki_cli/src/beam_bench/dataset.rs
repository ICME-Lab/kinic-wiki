// Where: crates/wiki_cli/src/beam_bench/dataset.rs
// What: BEAM dataset loading, normalization, and deterministic question extraction.
// Why: The benchmark runner needs one stable internal shape even when the raw file is JSON, JSONL, or split-keyed JSON.
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeamConversation {
    pub conversation_id: String,
    pub conversation_seed: Value,
    pub narratives: String,
    pub user_profile: Value,
    pub conversation_plan: String,
    pub user_questions: Value,
    pub chat: Value,
    pub probing_questions: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BeamQuestion {
    pub question_id: String,
    pub question_type: String,
    pub prompt: String,
    pub reference_answer: Option<String>,
    pub raw: Value,
}

#[derive(Debug, Deserialize)]
struct BeamConversationRaw {
    #[serde(alias = "id")]
    conversation_id: Value,
    conversation_seed: Value,
    narratives: Option<String>,
    user_profile: Value,
    conversation_plan: Option<String>,
    user_questions: Value,
    chat: Value,
    probing_questions: String,
}

pub fn load_dataset(path: &Path, split: &str, limit: usize) -> Result<Vec<BeamConversation>> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read dataset file: {}", path.display()))?;
    let entries = if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
        parse_jsonl(&raw)?
    } else {
        parse_json(&raw, split)?
    };
    Ok(entries.into_iter().take(limit).collect())
}

pub fn extract_questions(conversation: &BeamConversation) -> Result<Vec<BeamQuestion>> {
    let literal = conversation.probing_questions.trim();
    let parsed: Value = serde_json::from_str(literal)
        .or_else(|_| json5::from_str(literal))
        .with_context(|| "failed to parse probing_questions")?;
    let object = parsed
        .as_object()
        .ok_or_else(|| anyhow!("probing_questions must decode to an object"))?;
    let mut questions = Vec::new();
    for (question_type, items) in object {
        let Some(list) = items.as_array() else {
            continue;
        };
        for (index, item) in list.iter().enumerate() {
            let Some(question) = item.get("question").and_then(Value::as_str) else {
                continue;
            };
            questions.push(BeamQuestion {
                question_id: format!("{question_type}-{index:03}"),
                question_type: question_type.clone(),
                prompt: question.to_string(),
                reference_answer: extract_reference_answer(item),
                raw: item.clone(),
            });
        }
    }
    Ok(questions)
}

fn extract_reference_answer(item: &Value) -> Option<String> {
    [
        "answer",
        "ideal_response",
        "expected_answer",
        "reference_answer",
        "gold_answer",
        "ground_truth",
    ]
    .iter()
    .find_map(|key| item.get(*key).and_then(Value::as_str))
    .or_else(|| {
        item.get("rubric")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
    })
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToOwned::to_owned)
}

fn parse_json(raw: &str, split: &str) -> Result<Vec<BeamConversation>> {
    let value: Value = serde_json::from_str(raw).with_context(|| "failed to parse dataset JSON")?;
    if let Some(entries) = value.as_array() {
        return entries
            .iter()
            .cloned()
            .map(normalize_conversation)
            .collect();
    }
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("dataset JSON must be an array or split-keyed object"))?;
    let split_value = object
        .get(split)
        .ok_or_else(|| anyhow!("split not found in dataset file: {split}"))?;
    split_value
        .as_array()
        .ok_or_else(|| anyhow!("split {split} must be an array"))?
        .iter()
        .cloned()
        .map(normalize_conversation)
        .collect()
}

fn parse_jsonl(raw: &str) -> Result<Vec<BeamConversation>> {
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let value: Value =
                serde_json::from_str(line).with_context(|| "failed to parse dataset JSONL row")?;
            normalize_conversation(value)
        })
        .collect()
}

fn normalize_conversation(value: Value) -> Result<BeamConversation> {
    let raw: BeamConversationRaw =
        serde_json::from_value(value).with_context(|| "invalid BEAM conversation shape")?;
    Ok(BeamConversation {
        conversation_id: value_to_identifier(&raw.conversation_id),
        conversation_seed: raw.conversation_seed,
        narratives: raw.narratives.unwrap_or_default(),
        user_profile: raw.user_profile,
        conversation_plan: raw.conversation_plan.unwrap_or_default(),
        user_questions: raw.user_questions,
        chat: raw.chat,
        probing_questions: raw.probing_questions,
    })
}

fn value_to_identifier(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_questions, load_dataset};
    use std::fs;

    #[test]
    fn load_dataset_reads_split_keyed_json() {
        let dir = tempfile::tempdir().expect("tempdir should exist");
        let path = dir.path().join("beam.json");
        fs::write(
            &path,
            r#"{
              "100K": [{
                "conversation_id": "conv-1",
                "conversation_seed": {"category":"General"},
                "narratives": "narrative",
                "user_profile": {"user_info":"info"},
                "conversation_plan": "plan",
                "user_questions": [{"messages":["q1"]}],
                "chat": [[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"}]],
                "probing_questions": "{\"abstention\":[{\"question\":\"What was said?\",\"answer\":\"hi\"}]}"
              }]
            }"#,
        )
        .expect("fixture should write");
        let dataset = load_dataset(&path, "100K", 1).expect("dataset should load");
        assert_eq!(dataset.len(), 1);
        assert_eq!(dataset[0].conversation_id, "conv-1");
    }

    #[test]
    fn extract_questions_parses_json5_literal() {
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/beam/beam_sample.json");
        let conversation = load_dataset(fixture_path.as_path(), "100K", 1)
            .expect("sample fixture should load")
            .pop()
            .expect("sample fixture should contain one conversation");
        let questions = extract_questions(&conversation).expect("questions should parse");
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].question_type, "abstention");
        assert_eq!(
            questions[1].reference_answer.as_deref(),
            Some("March 15, 2024")
        );
    }
}

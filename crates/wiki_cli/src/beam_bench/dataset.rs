// Where: crates/wiki_cli/src/beam_bench/dataset.rs
// What: BEAM dataset loading plus question normalization for deterministic RAG evaluation.
// Why: The benchmark needs stable question classes and optional gold evidence without depending on one raw dataset shape.
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;

use super::question_types::question_type_tags;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeamQuestionClass {
    Factoid,
    Reasoning,
    Abstention,
}

impl BeamQuestionClass {
    pub fn is_scorable(self) -> bool {
        !matches!(self, Self::Abstention)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BeamQuestion {
    pub question_id: String,
    pub question_type: String,
    pub question_class: BeamQuestionClass,
    pub query: String,
    pub as_of: Option<String>,
    pub reference_answer: Option<String>,
    pub gold_answers: Vec<String>,
    pub gold_paths: Vec<String>,
    pub gold_spans: Vec<String>,
    pub expects_abstention: bool,
    pub tags: Vec<String>,
    pub rubric_items: Vec<String>,
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
            let question_class = extract_question_class(question_type, item);
            let gold_answers = extract_gold_answers(item);
            let rubric_items = extract_string_list(item, &["rubric"]);
            let as_of = extract_optional_string(item, &["as_of"]);
            if is_temporal_question(question_type) && as_of.is_none() {
                return Err(anyhow!(
                    "temporal question {question_type}-{index:03} is missing as_of"
                ));
            }
            questions.push(BeamQuestion {
                question_id: format!("{question_type}-{index:03}"),
                question_type: question_type.clone(),
                question_class,
                query: question.to_string(),
                as_of,
                reference_answer: gold_answers.first().cloned(),
                gold_answers,
                gold_paths: extract_string_list(
                    item,
                    &["gold_paths", "gold_path", "evidence_paths"],
                ),
                gold_spans: extract_string_list(
                    item,
                    &["gold_spans", "gold_span", "evidence_spans"],
                ),
                expects_abstention: extract_expects_abstention(question_type, item, question_class),
                tags: extract_tags(question_type, item, question_class),
                rubric_items,
                raw: item.clone(),
            });
        }
    }
    Ok(questions)
}

fn extract_reference_answer(item: &Value) -> Option<String> {
    [
        "answer",
        "ideal_answer",
        "ideal_summary",
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

fn extract_gold_answers(item: &Value) -> Vec<String> {
    let explicit = extract_string_list(
        item,
        &[
            "gold_answers",
            "gold_answer",
            "reference_answers",
            "expected_answers",
        ],
    );
    if !explicit.is_empty() {
        return explicit;
    }
    let mut answers = extract_reference_answer(item)
        .into_iter()
        .collect::<Vec<_>>();
    answers.extend(
        extract_string_list(item, &["rubric"])
            .into_iter()
            .map(|item| clean_rubric_item(&item))
            .filter(|item| !item.is_empty()),
    );
    answers.sort();
    answers.dedup();
    answers
}

fn extract_question_class(question_type: &str, item: &Value) -> BeamQuestionClass {
    if let Some(value) = ["question_class", "class", "category"]
        .iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))
    {
        return parse_question_class(value).unwrap_or_else(|| infer_question_class(question_type));
    }
    infer_question_class(question_type)
}

fn infer_question_class(question_type: &str) -> BeamQuestionClass {
    let normalized = question_type.trim().to_ascii_lowercase();
    if normalized.contains("abstention") {
        return BeamQuestionClass::Abstention;
    }
    if normalized.contains("reason") || normalized.contains("temporal") {
        return BeamQuestionClass::Reasoning;
    }
    BeamQuestionClass::Factoid
}

fn parse_question_class(value: &str) -> Option<BeamQuestionClass> {
    match value.trim().to_ascii_lowercase().as_str() {
        "factoid" | "fact" => Some(BeamQuestionClass::Factoid),
        "reasoning" | "temporal_reasoning" | "temporal" => Some(BeamQuestionClass::Reasoning),
        "abstention" => Some(BeamQuestionClass::Abstention),
        _ => None,
    }
}

fn is_temporal_question(question_type: &str) -> bool {
    question_type
        .trim()
        .to_ascii_lowercase()
        .contains("temporal")
}

fn extract_expects_abstention(
    question_type: &str,
    item: &Value,
    question_class: BeamQuestionClass,
) -> bool {
    if let Some(value) = item.get("expects_abstention").and_then(Value::as_bool) {
        return value;
    }
    if matches!(question_class, BeamQuestionClass::Abstention) {
        return true;
    }
    extract_reference_answer(item)
        .map(|answer| normalize_marker(&answer) == "insufficient evidence")
        .unwrap_or_else(|| question_type.trim().eq_ignore_ascii_case("abstention"))
}

fn extract_tags(
    question_type: &str,
    item: &Value,
    question_class: BeamQuestionClass,
) -> Vec<String> {
    let explicit = extract_string_list(item, &["tags"]);
    let mut tags = if explicit.is_empty() {
        question_type_tags(question_type)
    } else {
        explicit
    };
    match question_class {
        BeamQuestionClass::Factoid => tags.push("factoid".to_string()),
        BeamQuestionClass::Reasoning => tags.push("reasoning".to_string()),
        BeamQuestionClass::Abstention => tags.push("abstention".to_string()),
    }
    tags.sort();
    tags.dedup();
    tags
}

fn extract_optional_string(item: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_marker(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn clean_rubric_item(value: &str) -> String {
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

fn extract_string_list(item: &Value, keys: &[&str]) -> Vec<String> {
    keys.iter()
        .find_map(|key| item.get(*key))
        .map(value_to_string_list)
        .unwrap_or_default()
}

fn value_to_string_list(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
        _ => Vec::new(),
    }
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
    use super::{BeamQuestionClass, extract_questions, load_dataset};
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
                "probing_questions": "{\"factoid\":[{\"question\":\"What was said?\",\"answer\":\"hi\"}]}"
              }]
            }"#,
        )
        .expect("fixture should write");
        let dataset = load_dataset(&path, "100K", 1).expect("dataset should load");
        assert_eq!(dataset.len(), 1);
        assert_eq!(dataset[0].conversation_id, "conv-1");
    }

    #[test]
    fn extract_questions_parses_evidence_fields() {
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
                "probing_questions": "{'factoid':[{'question':'What date?','answer':'March 15, 2024','gold_paths':['facts.md'],'gold_spans':['March 15, 2024'],'tags':['factoid','facts']}],'temporal_reasoning':[{'question':'Why?','answer':'Because','as_of':'2026-04-16T00:00:00+09:00','gold_paths':['events.md']}]}"
              }]
            }"#,
        )
        .expect("fixture should write");
        let conversation = load_dataset(&path, "100K", 1)
            .expect("dataset should load")
            .pop()
            .expect("conversation should exist");
        let questions = extract_questions(&conversation).expect("questions should parse");
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].question_class, BeamQuestionClass::Factoid);
        assert_eq!(questions[0].gold_paths, vec!["facts.md"]);
        assert_eq!(questions[0].gold_spans, vec!["March 15, 2024"]);
        assert_eq!(questions[0].gold_answers, vec!["March 15, 2024"]);
        assert_eq!(
            questions[1].as_of.as_deref(),
            Some("2026-04-16T00:00:00+09:00")
        );
        assert_eq!(questions[1].question_class, BeamQuestionClass::Reasoning);
    }

    #[test]
    fn extract_questions_keeps_old_answer_only_shape() {
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/beam/beam_sample.json");
        let conversation = load_dataset(fixture_path.as_path(), "100K", 1)
            .expect("sample fixture should load")
            .pop()
            .expect("sample fixture should contain one conversation");
        let questions = extract_questions(&conversation).expect("questions should parse");
        assert_eq!(questions.len(), 4);
        assert_eq!(questions[0].question_class, BeamQuestionClass::Abstention);
        assert_eq!(questions[1].question_class, BeamQuestionClass::Factoid);
        assert_eq!(
            questions[1].reference_answer.as_deref(),
            Some("March 15, 2024")
        );
    }

    #[test]
    fn extract_questions_requires_as_of_for_temporal_items() {
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
                "probing_questions": "{'temporal_reasoning':[{'question':'When next?','answer':'Soon','gold_paths':['events.md']}]}"}]
            }"#,
        )
        .expect("fixture should write");
        let conversation = load_dataset(&path, "100K", 1)
            .expect("dataset should load")
            .pop()
            .expect("conversation should exist");
        let error = extract_questions(&conversation).expect_err("temporal question should fail");
        assert!(error.to_string().contains("missing as_of"));
    }
}

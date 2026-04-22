// Where: crates/wiki_cli/src/beam_bench/manifest.rs
// What: Deterministic BEAM prepare manifest generation and validation helpers.
// Why: Read-only eval must prove the prepared namespace matches the current dataset exactly.
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use super::dataset::BeamConversation;
use super::import::ImportedConversation;
use super::navigation::manifest_path;

pub const BEAM_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrepareManifest {
    pub namespace: String,
    pub split: String,
    pub conversation_ids: Vec<String>,
    pub prepared_conversation_count: usize,
    pub written_note_count: usize,
    pub conversation_note_paths: BTreeMap<String, Vec<String>>,
    pub conversation_note_hashes: BTreeMap<String, BTreeMap<String, String>>,
    pub dataset_fingerprint: String,
    pub schema_version: u32,
}

pub fn build_prepare_manifest(
    namespace: &str,
    split: &str,
    dataset: &[BeamConversation],
    imported: &[ImportedConversation],
) -> PrepareManifest {
    let mut conversation_ids = dataset
        .iter()
        .map(|conversation| conversation.conversation_id.clone())
        .collect::<Vec<_>>();
    conversation_ids.sort();

    let mut conversation_note_paths = BTreeMap::new();
    let mut conversation_note_hashes = BTreeMap::new();
    let mut written_note_count = 0usize;
    for conversation in imported {
        let mut note_paths = conversation.note_paths.clone();
        note_paths.sort();
        written_note_count += note_paths.len();
        conversation_note_paths.insert(conversation.conversation_id.clone(), note_paths);
        conversation_note_hashes.insert(
            conversation.conversation_id.clone(),
            conversation
                .notes
                .iter()
                .map(|note| {
                    (
                        note.path.clone(),
                        note_fingerprint(&note.path, &note.content),
                    )
                })
                .collect(),
        );
    }

    PrepareManifest {
        namespace: namespace.to_string(),
        split: split.to_string(),
        conversation_ids,
        prepared_conversation_count: imported.len(),
        written_note_count,
        conversation_note_paths,
        conversation_note_hashes,
        dataset_fingerprint: dataset_fingerprint(dataset),
        schema_version: BEAM_SCHEMA_VERSION,
    }
}

pub fn manifest_path_for_namespace(namespace: &str) -> String {
    manifest_path(namespace)
}

pub fn note_fingerprint(path: &str, content: &str) -> String {
    sha256_hex(&format!("{path}\0{content}"))
}

pub fn dataset_fingerprint(dataset: &[BeamConversation]) -> String {
    let payload = dataset
        .iter()
        .map(conversation_fingerprint_payload)
        .collect::<Vec<_>>()
        .join("\n");
    sha256_hex(&payload)
}

pub fn parse_prepare_manifest(content: &str) -> Result<PrepareManifest> {
    serde_json::from_str(content)
        .map_err(|error| anyhow!("missing prepare: invalid manifest: {error}"))
}

pub fn validate_manifest_identity(
    manifest: &PrepareManifest,
    namespace: &str,
    split: &str,
    dataset: &[BeamConversation],
) -> Result<()> {
    if manifest.namespace != namespace {
        return Err(anyhow!(
            "stale namespace: manifest namespace {} does not match {}",
            manifest.namespace,
            namespace
        ));
    }
    if manifest.split != split {
        return Err(anyhow!(
            "dataset mismatch: manifest split {} does not match {}",
            manifest.split,
            split
        ));
    }
    if manifest.schema_version != BEAM_SCHEMA_VERSION {
        return Err(anyhow!(
            "stale namespace: manifest schema {} does not match {}",
            manifest.schema_version,
            BEAM_SCHEMA_VERSION
        ));
    }
    let mut expected_ids = dataset
        .iter()
        .map(|conversation| conversation.conversation_id.clone())
        .collect::<Vec<_>>();
    expected_ids.sort();
    if manifest.conversation_ids != expected_ids {
        return Err(anyhow!(
            "dataset mismatch: manifest conversations do not match current dataset"
        ));
    }
    let fingerprint = dataset_fingerprint(dataset);
    if manifest.dataset_fingerprint != fingerprint {
        return Err(anyhow!(
            "dataset mismatch: manifest fingerprint does not match current dataset"
        ));
    }
    if manifest.prepared_conversation_count != dataset.len() {
        return Err(anyhow!(
            "stale namespace: manifest conversation count {} does not match {}",
            manifest.prepared_conversation_count,
            dataset.len()
        ));
    }
    Ok(())
}

fn conversation_fingerprint_payload(conversation: &BeamConversation) -> String {
    let mut out = String::new();
    out.push_str(&json_string(&conversation.conversation_id));
    out.push('\n');
    out.push_str(&canonical_json(&conversation.conversation_seed));
    out.push('\n');
    out.push_str(&json_string(&conversation.narratives));
    out.push('\n');
    out.push_str(&canonical_json(&conversation.user_profile));
    out.push('\n');
    out.push_str(&json_string(&conversation.conversation_plan));
    out.push('\n');
    out.push_str(&canonical_json(&conversation.user_questions));
    out.push('\n');
    out.push_str(&canonical_json(&conversation.chat));
    out.push('\n');
    out.push_str(&json_string(&conversation.probing_questions));
    out
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => json_string(value),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| format!("{}:{}", json_string(key), canonical_json(&map[key])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization should not fail")
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::{
        BEAM_SCHEMA_VERSION, build_prepare_manifest, dataset_fingerprint,
        manifest_path_for_namespace, note_fingerprint, parse_prepare_manifest,
        validate_manifest_identity,
    };
    use crate::beam_bench::dataset::BeamConversation;
    use crate::beam_bench::import::plan_imported_conversation;
    use serde_json::json;

    fn sample_conversation() -> BeamConversation {
        BeamConversation {
            conversation_id: "Conv 1".to_string(),
            conversation_seed: json!({"title":"Calendar planning","category":"General"}),
            narratives: "A short planning conversation.".to_string(),
            user_profile: json!({"user_info":"Sample profile"}),
            conversation_plan: "Confirm the meeting date.".to_string(),
            user_questions: json!([{"messages":["When is the meeting?"]}]),
            chat: json!([[{"role":"user","content":"Meeting is on March 15, 2024."}]]),
            probing_questions: "{}".to_string(),
        }
    }

    #[test]
    fn manifest_path_uses_namespace_root() {
        assert_eq!(
            manifest_path_for_namespace("Run A"),
            "/Wiki/run-a/_beam_prepare_manifest.json"
        );
    }

    #[test]
    fn dataset_fingerprint_is_deterministic() {
        let dataset = vec![sample_conversation()];
        assert_eq!(dataset_fingerprint(&dataset), dataset_fingerprint(&dataset));
    }

    #[test]
    fn note_fingerprint_changes_when_content_changes() {
        let left = note_fingerprint("/Wiki/run-a/conv-1/facts.md", "alpha");
        let right = note_fingerprint("/Wiki/run-a/conv-1/facts.md", "beta");
        assert_ne!(left, right);
    }

    #[test]
    fn manifest_round_trip_and_identity_validation_work() {
        let dataset = vec![sample_conversation()];
        let imported = vec![plan_imported_conversation("Run A", &dataset[0])];
        let manifest = build_prepare_manifest("Run A", "100K", &dataset, &imported);
        let decoded = parse_prepare_manifest(
            &serde_json::to_string(&manifest).expect("manifest should serialize"),
        )
        .expect("manifest should parse");

        assert_eq!(decoded.schema_version, BEAM_SCHEMA_VERSION);
        validate_manifest_identity(&decoded, "Run A", "100K", &dataset)
            .expect("matching manifest should validate");
    }

    #[test]
    fn manifest_identity_rejects_dataset_mismatch() {
        let dataset = vec![sample_conversation()];
        let imported = vec![plan_imported_conversation("Run A", &dataset[0])];
        let mut manifest = build_prepare_manifest("Run A", "100K", &dataset, &imported);
        manifest.dataset_fingerprint = "stale".to_string();

        let error = validate_manifest_identity(&manifest, "Run A", "100K", &dataset)
            .expect_err("stale manifest should fail");
        assert!(error.to_string().contains("dataset mismatch"));
    }

    #[test]
    fn manifest_identity_rejects_subset_of_prepared_conversations() {
        let first = sample_conversation();
        let second = BeamConversation {
            conversation_id: "Conv 2".to_string(),
            ..sample_conversation()
        };
        let dataset = vec![first.clone(), second.clone()];
        let imported = vec![
            plan_imported_conversation("Run A", &first),
            plan_imported_conversation("Run A", &second),
        ];
        let manifest = build_prepare_manifest("Run A", "100K", &dataset, &imported);

        let error = validate_manifest_identity(&manifest, "Run A", "100K", &[first])
            .expect_err("prepared superset should not allow subset eval");
        assert!(error.to_string().contains("dataset mismatch"));
    }
}

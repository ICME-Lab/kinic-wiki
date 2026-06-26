// Where: crates/wiki_domain/src/lib.rs
// What: Wiki-specific path validation and OKF metadata helpers layered on top of the reusable VFS.
// Why: `/Wiki`, `/Sources/...`, and OKF concept semantics must stay centralized outside generic VFS crates.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use vfs_types::NodeKind;

pub const WIKI_ROOT_PATH: &str = "/Wiki";
pub const WIKI_INDEX_PATH: &str = "/Wiki/index.md";
pub const WIKI_SOURCES_PREFIX: &str = "/Wiki/sources";
pub const WIKI_ENTITIES_PREFIX: &str = "/Wiki/entities";
pub const WIKI_CONCEPTS_PREFIX: &str = "/Wiki/concepts";
pub const SKILL_REGISTRY_ROOT: &str = "/Wiki/skills";
pub const PUBLIC_SKILL_REGISTRY_ROOT: &str = SKILL_REGISTRY_ROOT;
pub const EVIDENCE_SOURCES_PREFIX: &str = "/Sources/evidence";
pub const SESSION_SOURCES_PREFIX: &str = "/Sources/sessions";
pub const SKILL_RUNS_PREFIX: &str = "/Sources/skill-runs";
const MAX_SOURCE_PROVIDER_LEN: usize = 32;
const MAX_SOURCE_ID_LEN: usize = 128;
const DEFAULT_TRUST_LEVEL: &str = "unreviewed";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum OkfType {
    Fact,
    Task,
    Decision,
    Policy,
    Note,
    Reference,
}

impl OkfType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fact => "Fact",
            Self::Task => "Task",
            Self::Decision => "Decision",
            Self::Policy => "Policy",
            Self::Note => "Note",
            Self::Reference => "Reference",
        }
    }
}

impl std::str::FromStr for OkfType {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "Fact" => Ok(Self::Fact),
            "Task" => Ok(Self::Task),
            "Decision" => Ok(Self::Decision),
            "Policy" => Ok(Self::Policy),
            "Note" => Ok(Self::Note),
            "Reference" => Ok(Self::Reference),
            _ => Err(format!("unsupported okf_type: {value}")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OkfSourceRef {
    pub path: String,
}

pub fn apply_okf_metadata(
    database_id: &str,
    path: &str,
    kind: &NodeKind,
    content: &str,
    metadata_json: &str,
) -> Result<String, String> {
    let mut metadata = parse_metadata_object(metadata_json)?;
    let existing_type = okf_type_from_map(&metadata)?;
    if existing_type.is_none() && !okf_managed_path(path, kind) {
        validate_optional_okf_fields(&metadata)?;
        return serialize_metadata(metadata);
    }

    let okf_type = existing_type.unwrap_or_else(|| infer_okf_type(path, kind));
    metadata.insert(
        "okf_type".to_string(),
        Value::String(okf_type.as_str().to_string()),
    );
    metadata.insert(
        "resource".to_string(),
        Value::String(kinic_resource(database_id, path)),
    );
    if !metadata.contains_key("trust_level") {
        metadata.insert(
            "trust_level".to_string(),
            Value::String(DEFAULT_TRUST_LEVEL.to_string()),
        );
    }
    validate_optional_okf_fields(&metadata)?;
    let refs = extract_evidence_source_paths(content)
        .into_iter()
        .map(|source_path| {
            let mut item = Map::new();
            item.insert("path".to_string(), Value::String(source_path));
            Value::Object(item)
        })
        .collect::<Vec<_>>();
    metadata.insert("source_refs".to_string(), Value::Array(refs));
    serialize_metadata(metadata)
}

pub fn metadata_okf_type(metadata_json: &str) -> Result<Option<OkfType>, String> {
    let metadata = parse_metadata_object(metadata_json)?;
    okf_type_from_map(&metadata)
}

pub fn metadata_resource(metadata_json: &str) -> Result<Option<String>, String> {
    optional_string_field(metadata_json, "resource")
}

pub fn metadata_trust_level(metadata_json: &str) -> Result<Option<String>, String> {
    optional_string_field(metadata_json, "trust_level")
}

pub fn metadata_expires_at(metadata_json: &str) -> Result<Option<String>, String> {
    optional_string_field(metadata_json, "expires_at")
}

pub fn metadata_source_ref_paths(metadata_json: &str) -> Result<Option<Vec<String>>, String> {
    let metadata = parse_metadata_object(metadata_json)?;
    if !metadata.contains_key("source_refs") {
        return Ok(None);
    }
    metadata_source_ref_paths_from_map(&metadata).map(Some)
}

pub fn infer_okf_type(path: &str, kind: &NodeKind) -> OkfType {
    if *kind == NodeKind::Source && path_matches_prefix_boundary(path, EVIDENCE_SOURCES_PREFIX) {
        return OkfType::Reference;
    }
    let lower = path.to_ascii_lowercase();
    let file_name = lower.rsplit('/').next().unwrap_or("");
    if file_name == "facts.md" {
        OkfType::Fact
    } else if file_name == "decisions.md"
        || file_name == "decision.md"
        || lower.contains("/decisions/")
    {
        OkfType::Decision
    } else if file_name == "tasks.md" || file_name == "plans.md" {
        OkfType::Task
    } else if file_name == "style-guide.md"
        || file_name == "style_guide.md"
        || file_name == "preferences.md"
        || file_name == "do-not-do.md"
        || file_name == "do_not_do.md"
    {
        OkfType::Policy
    } else {
        OkfType::Note
    }
}

pub fn kinic_resource(database_id: &str, path: &str) -> String {
    format!("kinic://{database_id}{path}")
}

pub fn validate_source_path_for_kind(path: &str, kind: &NodeKind) -> Result<(), String> {
    let is_source_path = path_matches_prefix_boundary(path, EVIDENCE_SOURCES_PREFIX)
        || path_matches_prefix_boundary(path, SESSION_SOURCES_PREFIX)
        || path_matches_prefix_boundary(path, SKILL_RUNS_PREFIX);
    if *kind == NodeKind::Folder {
        return Ok(());
    }
    if *kind != NodeKind::Source {
        if is_source_path {
            return Err(format!(
                "source path must use source kind under {EVIDENCE_SOURCES_PREFIX}, {SESSION_SOURCES_PREFIX}, or {SKILL_RUNS_PREFIX}: {path}"
            ));
        }
        return Ok(());
    }
    validate_canonical_source_path(path)
}

pub fn validate_canonical_source_path(path: &str) -> Result<(), String> {
    if path_matches_prefix_boundary(path, EVIDENCE_SOURCES_PREFIX) {
        return validate_evidence_source_path(path);
    }
    if path_matches_prefix_boundary(path, SESSION_SOURCES_PREFIX) {
        return validate_source_path_under_prefix(path, SESSION_SOURCES_PREFIX);
    }
    if path_matches_prefix_boundary(path, SKILL_RUNS_PREFIX) {
        return validate_skill_run_source_path(path);
    }
    Err(format!(
        "source path must stay under {EVIDENCE_SOURCES_PREFIX}, {SESSION_SOURCES_PREFIX}, or {SKILL_RUNS_PREFIX}: {path}"
    ))
}

pub fn wiki_relative_path(path: &str) -> Result<&str, String> {
    if path == WIKI_ROOT_PATH {
        return Ok("");
    }
    path.strip_prefix(&format!("{WIKI_ROOT_PATH}/"))
        .ok_or_else(|| format!("unsupported remote path outside {WIKI_ROOT_PATH}: {path}"))
}

pub fn normalize_wiki_remote_path(path: &str) -> Result<String, String> {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.first().copied() != Some(&WIKI_ROOT_PATH[1..]) {
        return Err(format!(
            "unsupported remote path outside {WIKI_ROOT_PATH}: {path}"
        ));
    }
    Ok(format!("/{}", segments.join("/")))
}

pub fn wiki_child_path(segment: &str) -> String {
    format!("{WIKI_ROOT_PATH}/{}", segment.trim_start_matches('/'))
}

fn parse_metadata_object(metadata_json: &str) -> Result<Map<String, Value>, String> {
    let trimmed = metadata_json.trim();
    let value = if trimmed.is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(trimmed)
            .map_err(|error| format!("metadata_json is invalid: {error}"))?
    };
    match value {
        Value::Object(map) => Ok(map),
        _ => Err("metadata_json must be a JSON object".to_string()),
    }
}

fn serialize_metadata(metadata: Map<String, Value>) -> Result<String, String> {
    serde_json::to_string(&Value::Object(metadata)).map_err(|error| error.to_string())
}

fn okf_type_from_map(metadata: &Map<String, Value>) -> Result<Option<OkfType>, String> {
    let Some(value) = metadata.get("okf_type") else {
        return Ok(None);
    };
    let Some(raw_type) = value.as_str() else {
        return Err("okf_type must be a string".to_string());
    };
    raw_type.parse::<OkfType>().map(Some)
}

fn optional_string_field(metadata_json: &str, key: &str) -> Result<Option<String>, String> {
    let metadata = parse_metadata_object(metadata_json)?;
    let Some(value) = metadata.get(key) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(|text| Some(text.to_string()))
        .ok_or_else(|| format!("{key} must be a string"))
}

fn validate_optional_okf_fields(metadata: &Map<String, Value>) -> Result<(), String> {
    for key in ["resource", "trust_level", "expires_at"] {
        if let Some(value) = metadata.get(key)
            && !value.is_string()
        {
            return Err(format!("{key} must be a string"));
        }
    }
    Ok(())
}

fn metadata_source_ref_paths_from_map(
    metadata: &Map<String, Value>,
) -> Result<Vec<String>, String> {
    let Some(value) = metadata.get("source_refs") else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err("source_refs must be an array".to_string());
    };
    let mut paths = Vec::with_capacity(items.len());
    for item in items {
        let Some(object) = item.as_object() else {
            return Err("source_refs items must be objects".to_string());
        };
        let Some(path) = object.get("path").and_then(Value::as_str) else {
            return Err("source_refs items require string path".to_string());
        };
        validate_evidence_source_ref(path)?;
        paths.push(path.to_string());
    }
    Ok(paths)
}

fn validate_evidence_source_ref(path: &str) -> Result<(), String> {
    if path_matches_prefix_boundary(path, EVIDENCE_SOURCES_PREFIX) {
        Ok(())
    } else {
        Err(format!(
            "source_refs path must stay under {EVIDENCE_SOURCES_PREFIX}: {path}"
        ))
    }
}

fn okf_managed_path(path: &str, kind: &NodeKind) -> bool {
    if *kind == NodeKind::Folder {
        return false;
    }
    path_matches_prefix_boundary(path, WIKI_ROOT_PATH)
        || (*kind == NodeKind::Source
            && path_matches_prefix_boundary(path, EVIDENCE_SOURCES_PREFIX))
}

fn extract_evidence_source_paths(content: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut offset = 0;
    while let Some(relative_start) = content[offset..].find(EVIDENCE_SOURCES_PREFIX) {
        let start = offset + relative_start;
        let tail = &content[start..];
        let end = tail
            .char_indices()
            .find_map(|(index, ch)| source_path_terminator(ch).then_some(index))
            .unwrap_or(tail.len());
        let candidate = tail[..end].trim_end_matches(['.', ',', ';', ':']);
        if !candidate.is_empty() {
            paths.push(candidate.to_string());
        }
        offset = start + end;
    }
    paths
}

fn source_path_terminator(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, ')' | ']' | '"' | '\'' | '<' | '>' | '`')
}

fn path_matches_prefix_boundary(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn validate_source_path_under_prefix(path: &str, prefix: &str) -> Result<(), String> {
    let relative = path
        .strip_prefix(&format!("{prefix}/"))
        .ok_or_else(|| format!("source path must stay under {prefix}: {path}"))?;
    let segments = relative.split('/').collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err(format!(
            "source path must use canonical form {prefix}/<id>/<id>.md: {path}"
        ));
    }
    let [directory_name, file_name] = segments.as_slice() else {
        unreachable!();
    };
    let Some(file_stem) = file_name.strip_suffix(".md") else {
        return Err(format!(
            "source path must use canonical form {prefix}/<id>/<id>.md: {path}"
        ));
    };
    if !is_safe_source_segment(directory_name) || file_stem != *directory_name {
        return Err(format!(
            "source path must use canonical form {prefix}/<id>/<id>.md: {path}"
        ));
    }
    Ok(())
}

fn validate_evidence_source_path(path: &str) -> Result<(), String> {
    let relative = path
        .strip_prefix(&format!("{EVIDENCE_SOURCES_PREFIX}/"))
        .ok_or_else(|| format!("source path must stay under {EVIDENCE_SOURCES_PREFIX}: {path}"))?;
    let segments = relative.split('/').collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err(format!(
            "source path must use canonical form {EVIDENCE_SOURCES_PREFIX}/<provider>/<id>.md: {path}"
        ));
    }
    let [provider, file_name] = segments.as_slice() else {
        unreachable!();
    };
    if !is_safe_provider_segment(provider)
        || !file_name.ends_with(".md")
        || !is_safe_source_segment(file_name.trim_end_matches(".md"))
    {
        return Err(format!(
            "source path must use canonical form {EVIDENCE_SOURCES_PREFIX}/<provider>/<id>.md: {path}"
        ));
    }
    Ok(())
}

fn is_safe_source_segment(value: &str) -> bool {
    if value.len() > MAX_SOURCE_ID_LEN || value.contains("..") {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    is_source_segment_char(first)
        && first.is_ascii_alphanumeric()
        && chars.all(is_source_segment_char)
}

fn is_safe_provider_segment(value: &str) -> bool {
    if value.len() > MAX_SOURCE_PROVIDER_LEN {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && chars.all(|value| value.is_ascii_lowercase() || value.is_ascii_digit())
}

fn is_source_segment_char(value: char) -> bool {
    value.is_ascii_alphanumeric() || value == '.' || value == '_' || value == '-'
}

fn validate_skill_run_source_path(path: &str) -> Result<(), String> {
    let relative = path
        .strip_prefix(&format!("{SKILL_RUNS_PREFIX}/"))
        .ok_or_else(|| format!("source path must stay under {SKILL_RUNS_PREFIX}: {path}"))?;
    let segments = relative.split('/').collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err(format!(
            "skill run source path must use canonical form {SKILL_RUNS_PREFIX}/<name>/<timestamp>.md: {path}"
        ));
    }
    let [name, file_name] = segments.as_slice() else {
        unreachable!();
    };
    let Some(file_stem) = file_name.strip_suffix(".md") else {
        return Err(format!(
            "skill run source path must use canonical form {SKILL_RUNS_PREFIX}/<name>/<timestamp>.md: {path}"
        ));
    };
    if !is_safe_source_segment(name) || !is_safe_source_segment(file_stem) {
        return Err(format!(
            "skill run source path must use canonical form {SKILL_RUNS_PREFIX}/<name>/<timestamp>.md: {path}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use vfs_types::NodeKind;

    use super::{
        EVIDENCE_SOURCES_PREFIX, SKILL_RUNS_PREFIX, WIKI_ROOT_PATH, apply_okf_metadata,
        metadata_source_ref_paths, normalize_wiki_remote_path, validate_canonical_source_path,
        validate_source_path_for_kind, wiki_relative_path,
    };

    #[test]
    fn canonical_source_path_accepts_expected_shape() {
        let path = format!("{EVIDENCE_SOURCES_PREFIX}/chatgpt/alpha.md");
        assert!(validate_canonical_source_path(&path).is_ok());
    }

    #[test]
    fn canonical_source_path_rejects_wrong_file_name() {
        let error = validate_canonical_source_path("/Sources/evidence/alpha/beta.txt")
            .expect_err("non-canonical path should fail");
        assert!(error.contains("canonical form"));
    }

    #[test]
    fn canonical_source_path_rejects_old_raw_directory_ids() {
        let error = validate_canonical_source_path("/Sources/evidence/web-abc/web-abc.md")
            .expect_err("old evidence source layout should fail");
        assert!(error.contains("canonical form"));
    }

    #[test]
    fn canonical_source_path_rejects_prefix_lookalikes() {
        let error = validate_canonical_source_path("/Sources/evidencefoo/alpha.md")
            .expect_err("prefix lookalike should fail");
        assert!(error.contains("source path must stay under"));
    }

    #[test]
    fn canonical_source_path_rejects_provider_and_id_over_limits() {
        let long_provider = "a".repeat(33);
        let long_id = "a".repeat(129);

        for path in [
            format!("{EVIDENCE_SOURCES_PREFIX}/{long_provider}/ok.md"),
            format!("{EVIDENCE_SOURCES_PREFIX}/chatgpt/{long_id}.md"),
        ] {
            let error = validate_canonical_source_path(&path)
                .expect_err("overlong provider or id should fail");
            assert!(error.contains("canonical form"));
        }
    }

    #[test]
    fn canonical_source_path_rejects_dotdot_inside_source_id() {
        let error = validate_canonical_source_path("/Sources/evidence/chatgpt/a..b.md")
            .expect_err("dotdot inside evidence source id should fail");
        assert!(error.contains("canonical form"));
    }

    #[test]
    fn canonical_source_path_accepts_skill_runs() {
        let path = format!("{SKILL_RUNS_PREFIX}/legal-review/1700000000000.md");
        assert!(validate_canonical_source_path(&path).is_ok());
    }

    #[test]
    fn canonical_source_path_accepts_sessions() {
        assert!(validate_canonical_source_path("/Sources/sessions/session-1/session-1.md").is_ok());
    }

    #[test]
    fn skill_runs_prefix_requires_source_kind() {
        let path = format!("{SKILL_RUNS_PREFIX}/legal-review/1700000000000.md");
        let error = validate_source_path_for_kind(&path, &NodeKind::File)
            .expect_err("skill run source path should reject file kind");
        assert!(error.contains("source kind"));
        assert!(validate_source_path_for_kind(&path, &NodeKind::Source).is_ok());
    }

    #[test]
    fn canonical_source_path_rejects_malformed_skill_runs() {
        for path in [
            "/Sources/skill-runs/legal-review",
            "/Sources/skill-runs/legal-review/",
            "/Sources/skill-runs/legal-review/run.txt",
            "/Sources/skill-runs/../...md",
            "/Sources/skill-runs/legal-review/run..1.md",
            "/Sources/skill-runsfoo/legal-review/run.md",
        ] {
            assert!(validate_canonical_source_path(path).is_err());
        }
    }

    #[test]
    fn canonical_source_path_rejects_empty_and_dotdot_segments() {
        for path in [
            "/Sources/evidence//chatgpt/alpha.md",
            "/Sources/evidence/chatgpt//alpha.md",
            "/Sources/sessions//session.md",
            "/Sources/sessions/../...md",
            "/Sources/sessions/session-1/session..1.md",
        ] {
            assert!(validate_canonical_source_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn wiki_relative_path_strips_wiki_root() {
        assert_eq!(
            wiki_relative_path("/Wiki/nested/file.md").expect("path should strip"),
            "nested/file.md"
        );
        assert_eq!(
            wiki_relative_path(WIKI_ROOT_PATH).expect("root should strip"),
            ""
        );
    }

    #[test]
    fn wiki_relative_path_rejects_prefix_lookalikes() {
        for path in [
            "/Wikix/foo.md",
            "/Wikifoo/bar.md",
            "Wiki/foo.md",
            "/Sources/evidence/foo.md",
        ] {
            let error = wiki_relative_path(path).expect_err("lookalike path should fail");
            assert!(error.contains(WIKI_ROOT_PATH));
        }
    }

    #[test]
    fn normalize_wiki_remote_path_rejects_non_wiki_path() {
        let error = normalize_wiki_remote_path("/Sources/evidence/file.md")
            .expect_err("non-wiki path should fail");
        assert!(error.contains(WIKI_ROOT_PATH));
    }

    #[test]
    fn okf_metadata_recomputes_existing_source_refs_from_content() {
        let metadata = apply_okf_metadata(
            "alpha",
            "/Wiki/project/facts.md",
            &NodeKind::File,
            "Fact from /Sources/evidence/web/new.md",
            r#"{"source_refs":[{"path":"/Sources/evidence/web/old.md"}]}"#,
        )
        .expect("metadata should apply");

        assert_eq!(
            metadata_source_ref_paths(&metadata).expect("source refs should parse"),
            Some(vec!["/Sources/evidence/web/new.md".to_string()])
        );
        assert!(!metadata.contains("/Sources/evidence/web/old.md"));
    }

    #[test]
    fn okf_metadata_clears_source_refs_when_content_has_none() {
        let metadata = apply_okf_metadata(
            "alpha",
            "/Wiki/project/facts.md",
            &NodeKind::File,
            "Fact without evidence path",
            r#"{"source_refs":[{"path":"/Sources/evidence/web/old.md"}]}"#,
        )
        .expect("metadata should apply");

        assert_eq!(
            metadata_source_ref_paths(&metadata).expect("source refs should parse"),
            Some(Vec::new())
        );
    }

    #[test]
    fn okf_metadata_leaves_unmanaged_non_okf_metadata_unfilled() {
        let metadata = apply_okf_metadata(
            "alpha",
            "/Other/project/facts.md",
            &NodeKind::File,
            "Fact from /Sources/evidence/web/new.md",
            r#"{"custom":1}"#,
        )
        .expect("metadata should apply");

        assert!(metadata.contains("\"custom\":1"));
        assert!(!metadata.contains("okf_type"));
        assert!(!metadata.contains("source_refs"));
    }
}

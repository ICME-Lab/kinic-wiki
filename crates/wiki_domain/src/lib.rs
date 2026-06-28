// Where: crates/wiki_domain/src/lib.rs
// What: Wiki-specific path validation layered on top of the reusable VFS.
// Why: `/Knowledge` and `/Sources/...` semantics must stay centralized outside the generic VFS crates.
use vfs_types::NodeKind;

pub const WIKI_ROOT_PATH: &str = "/Knowledge";
pub const WIKI_INDEX_PATH: &str = "/Knowledge/index.md";
pub const WIKI_SOURCES_PREFIX: &str = "/Knowledge/sources";
pub const WIKI_ENTITIES_PREFIX: &str = "/Knowledge/entities";
pub const WIKI_CONCEPTS_PREFIX: &str = "/Knowledge/concepts";
pub const SKILL_REGISTRY_ROOT: &str = "/Skills";
pub const PUBLIC_SKILL_REGISTRY_ROOT: &str = SKILL_REGISTRY_ROOT;
pub const KNOWLEDGE_SOURCES_PREFIX: &str = "/Sources";
pub const SESSION_SOURCES_PREFIX: &str = "/Sources/sessions";
pub const SKILL_RUNS_PREFIX: &str = "/Sources/skill-runs";
const MAX_SOURCE_PROVIDER_LEN: usize = 32;
const MAX_SOURCE_ID_LEN: usize = 128;
const RESERVED_SOURCE_PROVIDERS: &[&str] = &[
    "raw",
    "sessions",
    "skill-runs",
    "source-capture-requests",
    "ingest-requests",
];

pub fn validate_source_path_for_kind(path: &str, kind: &NodeKind) -> Result<(), String> {
    let is_source_path = is_knowledge_source_path_candidate(path)
        || path_matches_prefix_boundary(path, SESSION_SOURCES_PREFIX)
        || path_matches_prefix_boundary(path, SKILL_RUNS_PREFIX);
    if *kind == NodeKind::Folder {
        return Ok(());
    }
    if *kind != NodeKind::Source {
        if is_source_path {
            return Err(format!(
                "source path must use source kind under {KNOWLEDGE_SOURCES_PREFIX}/<provider>, {SESSION_SOURCES_PREFIX}, or {SKILL_RUNS_PREFIX}: {path}"
            ));
        }
        return Ok(());
    }
    validate_canonical_source_path(path)
}

pub fn validate_canonical_source_path(path: &str) -> Result<(), String> {
    if path_matches_prefix_boundary(path, SESSION_SOURCES_PREFIX) {
        return validate_session_source_path(path);
    }
    if path_matches_prefix_boundary(path, SKILL_RUNS_PREFIX) {
        return validate_skill_run_source_path(path);
    }
    if path_matches_prefix_boundary(path, KNOWLEDGE_SOURCES_PREFIX) {
        return validate_knowledge_source_path(path);
    }
    Err(format!(
        "source path must stay under {KNOWLEDGE_SOURCES_PREFIX}, {SESSION_SOURCES_PREFIX}, or {SKILL_RUNS_PREFIX}: {path}"
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

fn path_matches_prefix_boundary(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn validate_session_source_path(path: &str) -> Result<(), String> {
    let relative = path
        .strip_prefix(&format!("{SESSION_SOURCES_PREFIX}/"))
        .ok_or_else(|| format!("source path must stay under {SESSION_SOURCES_PREFIX}: {path}"))?;
    let segments = relative.split('/').collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err(format!(
            "source path must use canonical form {SESSION_SOURCES_PREFIX}/<provider>/<id>.md: {path}"
        ));
    }
    let [provider, file_name] = segments.as_slice() else {
        unreachable!();
    };
    let Some(source_id) = file_name.strip_suffix(".md") else {
        return Err(format!(
            "source path must use canonical form {SESSION_SOURCES_PREFIX}/<provider>/<id>.md: {path}"
        ));
    };
    if !is_safe_provider_segment(provider) || !is_safe_source_segment(source_id) {
        return Err(format!(
            "source path must use canonical form {SESSION_SOURCES_PREFIX}/<provider>/<id>.md: {path}"
        ));
    }
    Ok(())
}

pub fn validate_knowledge_source_path(path: &str) -> Result<(), String> {
    let relative = path
        .strip_prefix(&format!("{KNOWLEDGE_SOURCES_PREFIX}/"))
        .ok_or_else(|| format!("source path must stay under {KNOWLEDGE_SOURCES_PREFIX}: {path}"))?;
    let segments = relative.split('/').collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err(format!(
            "source path must use canonical form {KNOWLEDGE_SOURCES_PREFIX}/<provider>/<id>.md: {path}"
        ));
    }
    let [provider, file_name] = segments.as_slice() else {
        unreachable!();
    };
    if !is_safe_provider_segment(provider)
        || RESERVED_SOURCE_PROVIDERS.contains(provider)
        || !file_name.ends_with(".md")
        || !is_safe_source_segment(file_name.trim_end_matches(".md"))
    {
        return Err(format!(
            "source path must use canonical form {KNOWLEDGE_SOURCES_PREFIX}/<provider>/<id>.md: {path}"
        ));
    }
    Ok(())
}

fn is_knowledge_source_path_candidate(path: &str) -> bool {
    let Some(relative) = path.strip_prefix(&format!("{KNOWLEDGE_SOURCES_PREFIX}/")) else {
        return false;
    };
    let Some(provider) = relative.split('/').next() else {
        return false;
    };
    !matches!(
        provider,
        "sessions" | "skill-runs" | "source-capture-requests" | "ingest-requests"
    )
}

fn is_safe_source_segment(value: &str) -> bool {
    if value.len() > MAX_SOURCE_ID_LEN || value.contains("..") {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    is_source_segment_char(first) && first.is_alphanumeric() && chars.all(is_source_segment_char)
}

fn is_safe_provider_segment(value: &str) -> bool {
    if value.len() > MAX_SOURCE_PROVIDER_LEN {
        return false;
    }
    !value.is_empty()
        && value
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit())
}

fn is_source_segment_char(value: char) -> bool {
    value.is_alphanumeric() || value == '.' || value == '_' || value == '-'
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
        KNOWLEDGE_SOURCES_PREFIX, SKILL_RUNS_PREFIX, WIKI_ROOT_PATH, normalize_wiki_remote_path,
        validate_canonical_source_path, validate_knowledge_source_path,
        validate_source_path_for_kind, wiki_relative_path,
    };

    #[test]
    fn canonical_source_path_accepts_expected_shape() {
        let path = format!("{KNOWLEDGE_SOURCES_PREFIX}/chatgpt/alpha.md");
        assert!(validate_canonical_source_path(&path).is_ok());
        assert!(validate_canonical_source_path("/Sources/123/alpha.md").is_ok());
        assert!(validate_canonical_source_path("/Sources/web/会議-メモ-1a2b3c4d.md").is_ok());
    }

    #[test]
    fn canonical_source_path_rejects_wrong_file_name() {
        let error = validate_canonical_source_path("/Sources/chatgpt/beta.txt")
            .expect_err("non-canonical path should fail");
        assert!(error.contains("canonical form"));
    }

    #[test]
    fn canonical_source_path_rejects_old_raw_root() {
        let error = validate_canonical_source_path("/Sources/raw/web-abc.md")
            .expect_err("old raw source root should fail");
        assert!(error.contains("canonical form"));
    }

    #[test]
    fn canonical_source_path_rejects_prefix_lookalikes() {
        let error = validate_canonical_source_path("/SourcesBackup/alpha.md")
            .expect_err("prefix lookalike should fail");
        assert!(error.contains("source path must stay under"));
    }

    #[test]
    fn canonical_source_path_rejects_provider_and_id_over_limits() {
        let long_provider = "a".repeat(33);
        let long_id = "a".repeat(129);

        for path in [
            format!("{KNOWLEDGE_SOURCES_PREFIX}/{long_provider}/ok.md"),
            format!("{KNOWLEDGE_SOURCES_PREFIX}/chatgpt/{long_id}.md"),
        ] {
            let error = validate_canonical_source_path(&path)
                .expect_err("overlong provider or id should fail");
            assert!(error.contains("canonical form"));
        }
    }

    #[test]
    fn canonical_source_path_rejects_dotdot_inside_source_id() {
        let error = validate_canonical_source_path("/Sources/chatgpt/a..b.md")
            .expect_err("dotdot inside raw source id should fail");
        assert!(error.contains("canonical form"));
    }

    #[test]
    fn canonical_source_path_rejects_unsafe_unicode_source_id_shapes() {
        for path in [
            "/Sources/chatgpt/-alpha.md",
            "/Sources/chatgpt/_alpha.md",
            "/Sources/chatgpt/.alpha.md",
            "/Sources/chatgpt/alpha beta.md",
            "/Sources/chatgpt/alpha/ beta.md",
        ] {
            assert!(validate_canonical_source_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn canonical_source_path_rejects_reserved_knowledge_providers() {
        for path in [
            "/Sources/raw/alpha.md",
            "/Sources/sessions/alpha.md",
            "/Sources/skill-runs/alpha.md",
            "/Sources/source-capture-requests/alpha.md",
            "/Sources/ingest-requests/alpha.md",
        ] {
            assert!(validate_knowledge_source_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn canonical_source_path_accepts_skill_runs() {
        let path = format!("{SKILL_RUNS_PREFIX}/legal-review/1700000000000.md");
        assert!(validate_canonical_source_path(&path).is_ok());
    }

    #[test]
    fn canonical_source_path_accepts_sessions() {
        assert!(
            validate_canonical_source_path("/Sources/sessions/claudecode/session-1.md").is_ok()
        );
        assert!(validate_canonical_source_path("/Sources/sessions/codex/run_123.md").is_ok());
        assert!(validate_canonical_source_path("/Sources/sessions/raw/a.md").is_ok());
    }

    #[test]
    fn canonical_source_path_rejects_old_session_shape() {
        let error = validate_canonical_source_path("/Sources/sessions/session-1/session-1.md")
            .expect_err("old session source shape should fail");
        assert!(error.contains("canonical form"));
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
            "/Sources//chatgpt/alpha.md",
            "/Sources/chatgpt//alpha.md",
            "/Sources/sessions//session.md",
            "/Sources/sessions/../...md",
            "/Sources/sessions/claude/a..b.md",
            "/Sources/sessions/claude/a.txt",
        ] {
            assert!(validate_canonical_source_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn wiki_relative_path_strips_wiki_root() {
        assert_eq!(
            wiki_relative_path("/Knowledge/nested/file.md").expect("path should strip"),
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
            "/Sources/chatgpt/foo.md",
        ] {
            let error = wiki_relative_path(path).expect_err("lookalike path should fail");
            assert!(error.contains(WIKI_ROOT_PATH));
        }
    }

    #[test]
    fn normalize_wiki_remote_path_rejects_non_wiki_path() {
        let error = normalize_wiki_remote_path("/Sources/chatgpt/file.md")
            .expect_err("non-wiki path should fail");
        assert!(error.contains(WIKI_ROOT_PATH));
    }
}

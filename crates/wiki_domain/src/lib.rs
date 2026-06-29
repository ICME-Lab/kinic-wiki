// Where: crates/wiki_domain/src/lib.rs
// What: Wiki-specific path validation layered on top of the reusable VFS.
// Why: `/Knowledge` and `/Sources/...` semantics must stay centralized outside the generic VFS crates.
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

pub fn validate_canonical_source_path(path: &str) -> Result<(), String> {
    validate_knowledge_source_path(path)
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

pub fn validate_knowledge_source_path(path: &str) -> Result<(), String> {
    let relative = path
        .strip_prefix(&format!("{KNOWLEDGE_SOURCES_PREFIX}/"))
        .ok_or_else(|| format!("source path must stay under {KNOWLEDGE_SOURCES_PREFIX}: {path}"))?;
    let segments = relative.split('/').collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(format!("source path contains unsafe segment: {path}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        WIKI_ROOT_PATH, normalize_wiki_remote_path, validate_canonical_source_path,
        validate_knowledge_source_path, wiki_relative_path,
    };

    #[test]
    fn source_path_accepts_safe_sources_children() {
        for path in [
            "/Sources/not-raw.md",
            "/Sources/raw/a.md",
            "/Sources/web/fetched-title-12345678-2.md",
            "/Sources/sessions/codex/run_123.md",
            "/Sources/skill-runs/legal-review/1700000000000.md",
            "/Sources/web/会議-メモ-1a2b3c4d.md",
        ] {
            assert!(validate_canonical_source_path(path).is_ok(), "{path}");
            assert!(validate_knowledge_source_path(path).is_ok(), "{path}");
        }
    }

    #[test]
    fn source_path_rejects_non_sources_paths() {
        let error = validate_canonical_source_path("/Knowledge/source.md")
            .expect_err("knowledge path should fail");
        assert!(error.contains("source path must stay under"));
        let error = validate_canonical_source_path("/SourcesBackup/alpha.md")
            .expect_err("prefix lookalike should fail");
        assert!(error.contains("source path must stay under"));
    }

    #[test]
    fn source_path_rejects_empty_and_dot_segments() {
        for path in [
            "/Sources/",
            "/Sources//chatgpt/alpha.md",
            "/Sources/chatgpt//alpha.md",
            "/Sources/./alpha.md",
            "/Sources/chatgpt/../alpha.md",
        ] {
            let error =
                validate_canonical_source_path(path).expect_err("unsafe source path should fail");
            assert!(
                error.contains("source path must stay under")
                    || error.contains("source path contains unsafe segment")
            );
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

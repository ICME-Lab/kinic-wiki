// Where: crates/wiki_domain/src/lib.rs
// What: Wiki-specific path validation layered on top of the reusable VFS.
// Why: `/Wiki` and `/Sources/...` semantics must stay centralized outside the generic VFS crates.
use vfs_types::NodeKind;

pub const WIKI_ROOT_PATH: &str = "/Wiki";
pub const WIKI_INDEX_PATH: &str = "/Wiki/index.md";
pub const WIKI_SOURCES_PREFIX: &str = "/Wiki/sources";
pub const WIKI_ENTITIES_PREFIX: &str = "/Wiki/entities";
pub const WIKI_CONCEPTS_PREFIX: &str = "/Wiki/concepts";
pub const SKILL_REGISTRY_ROOT: &str = "/Wiki/skills";
pub const PUBLIC_SKILL_REGISTRY_ROOT: &str = SKILL_REGISTRY_ROOT;
pub const WIKI_BEAM_SECTION_TITLE: &str = "Benchmarks";
pub const RAW_SOURCES_PREFIX: &str = "/Sources/raw";
pub const SESSION_SOURCES_PREFIX: &str = "/Sources/sessions";
pub const SKILL_RUNS_PREFIX: &str = "/Sources/skill-runs";

pub fn validate_source_path_for_kind(path: &str, kind: &NodeKind) -> Result<(), String> {
    let is_source_path = path_matches_prefix_boundary(path, RAW_SOURCES_PREFIX)
        || path_matches_prefix_boundary(path, SESSION_SOURCES_PREFIX);
    if *kind == NodeKind::Folder {
        return Ok(());
    }
    if *kind != NodeKind::Source {
        if is_source_path {
            return Err(format!(
                "source path must use source kind under {RAW_SOURCES_PREFIX} or {SESSION_SOURCES_PREFIX}: {path}"
            ));
        }
        return Ok(());
    }
    validate_canonical_source_path(path)
}

pub fn validate_canonical_source_path(path: &str) -> Result<(), String> {
    if path_matches_prefix_boundary(path, RAW_SOURCES_PREFIX) {
        return validate_raw_source_path(path);
    }
    if path_matches_prefix_boundary(path, SESSION_SOURCES_PREFIX) {
        return validate_source_path_under_prefix(path, SESSION_SOURCES_PREFIX);
    }
    if path_matches_prefix_boundary(path, SKILL_RUNS_PREFIX) {
        return validate_skill_run_source_path(path);
    }
    Err(format!(
        "source path must stay under {RAW_SOURCES_PREFIX}, {SESSION_SOURCES_PREFIX}, or {SKILL_RUNS_PREFIX}: {path}"
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

fn validate_source_path_under_prefix(path: &str, prefix: &str) -> Result<(), String> {
    let relative = path
        .strip_prefix(prefix)
        .ok_or_else(|| format!("source path must stay under {prefix}: {path}"))?;
    let segments = relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err(format!(
            "source path must use canonical form {prefix}/<id>/<id>.md: {path}"
        ));
    }
    let [directory_name, file_name] = segments.as_slice() else {
        unreachable!();
    };
    if directory_name.is_empty() || *file_name != format!("{directory_name}.md") {
        return Err(format!(
            "source path must use canonical form {prefix}/<id>/<id>.md: {path}"
        ));
    }
    Ok(())
}

fn validate_raw_source_path(path: &str) -> Result<(), String> {
    let relative = path
        .strip_prefix(RAW_SOURCES_PREFIX)
        .ok_or_else(|| format!("source path must stay under {RAW_SOURCES_PREFIX}: {path}"))?;
    let segments = relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err(format!(
            "source path must use canonical form {RAW_SOURCES_PREFIX}/<provider>/<id>.md: {path}"
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
            "source path must use canonical form {RAW_SOURCES_PREFIX}/<provider>/<id>.md: {path}"
        ));
    }
    Ok(())
}

fn is_safe_source_segment(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    is_source_segment_char(first)
        && first.is_ascii_alphanumeric()
        && chars.all(is_source_segment_char)
}

fn is_safe_provider_segment(value: &str) -> bool {
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
        .strip_prefix(SKILL_RUNS_PREFIX)
        .ok_or_else(|| format!("source path must stay under {SKILL_RUNS_PREFIX}: {path}"))?;
    let segments = relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err(format!(
            "skill run source path must use canonical form {SKILL_RUNS_PREFIX}/<name>/<timestamp>.md: {path}"
        ));
    }
    let [name, file_name] = segments.as_slice() else {
        unreachable!();
    };
    if name.is_empty()
        || !file_name.ends_with(".md")
        || file_name.trim_end_matches(".md").is_empty()
    {
        return Err(format!(
            "skill run source path must use canonical form {SKILL_RUNS_PREFIX}/<name>/<timestamp>.md: {path}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        RAW_SOURCES_PREFIX, SKILL_RUNS_PREFIX, WIKI_ROOT_PATH, normalize_wiki_remote_path,
        validate_canonical_source_path, wiki_relative_path,
    };

    #[test]
    fn canonical_source_path_accepts_expected_shape() {
        let path = format!("{RAW_SOURCES_PREFIX}/chatgpt/alpha.md");
        assert!(validate_canonical_source_path(&path).is_ok());
    }

    #[test]
    fn canonical_source_path_rejects_wrong_file_name() {
        let error = validate_canonical_source_path("/Sources/raw/alpha/beta.txt")
            .expect_err("non-canonical path should fail");
        assert!(error.contains("canonical form"));
    }

    #[test]
    fn canonical_source_path_rejects_old_raw_directory_ids() {
        let error = validate_canonical_source_path("/Sources/raw/web-abc/web-abc.md")
            .expect_err("old raw source layout should fail");
        assert!(error.contains("canonical form"));
    }

    #[test]
    fn canonical_source_path_rejects_prefix_lookalikes() {
        let error = validate_canonical_source_path("/Sources/rawfoo/alpha.md")
            .expect_err("prefix lookalike should fail");
        assert!(error.contains("source path must stay under"));
    }

    #[test]
    fn canonical_source_path_accepts_skill_runs() {
        let path = format!("{SKILL_RUNS_PREFIX}/legal-review/1700000000000.md");
        assert!(validate_canonical_source_path(&path).is_ok());
    }

    #[test]
    fn canonical_source_path_rejects_malformed_skill_runs() {
        for path in [
            "/Sources/skill-runs/legal-review",
            "/Sources/skill-runs/legal-review/",
            "/Sources/skill-runs/legal-review/run.txt",
            "/Sources/skill-runsfoo/legal-review/run.md",
        ] {
            assert!(validate_canonical_source_path(path).is_err());
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
            "/Sources/raw/foo.md",
        ] {
            let error = wiki_relative_path(path).expect_err("lookalike path should fail");
            assert!(error.contains(WIKI_ROOT_PATH));
        }
    }

    #[test]
    fn normalize_wiki_remote_path_rejects_non_wiki_path() {
        let error = normalize_wiki_remote_path("/Sources/raw/file.md")
            .expect_err("non-wiki path should fail");
        assert!(error.contains(WIKI_ROOT_PATH));
    }
}

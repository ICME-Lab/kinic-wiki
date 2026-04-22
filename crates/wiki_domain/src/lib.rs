// Where: crates/wiki_domain/src/lib.rs
// What: Wiki-specific path policy and mirror defaults layered on top of the reusable VFS.
// Why: `/Wiki` and `/Sources/...` semantics must stay centralized outside the generic VFS crates.
use vfs_types::NodeKind;

pub const WIKI_ROOT_PATH: &str = "/Wiki";
pub const WIKI_INDEX_PATH: &str = "/Wiki/index.md";
pub const WIKI_SOURCES_PREFIX: &str = "/Wiki/sources";
pub const WIKI_ENTITIES_PREFIX: &str = "/Wiki/entities";
pub const WIKI_CONCEPTS_PREFIX: &str = "/Wiki/concepts";
pub const WIKI_BEAM_SECTION_TITLE: &str = "Benchmarks";
pub const DEFAULT_MIRROR_ROOT: &str = "Wiki";
pub const RAW_SOURCES_PREFIX: &str = "/Sources/raw";
pub const SESSION_SOURCES_PREFIX: &str = "/Sources/sessions";

pub fn validate_source_path_for_kind(path: &str, kind: &NodeKind) -> Result<(), String> {
    if *kind != NodeKind::Source {
        return Ok(());
    }
    validate_canonical_source_path(path)
}

pub fn validate_canonical_source_path(path: &str) -> Result<(), String> {
    if path_matches_prefix_boundary(path, RAW_SOURCES_PREFIX) {
        return validate_source_path_under_prefix(path, RAW_SOURCES_PREFIX);
    }
    if path_matches_prefix_boundary(path, SESSION_SOURCES_PREFIX) {
        return validate_source_path_under_prefix(path, SESSION_SOURCES_PREFIX);
    }
    Err(format!(
        "source path must stay under {RAW_SOURCES_PREFIX} or {SESSION_SOURCES_PREFIX}: {path}"
    ))
}

pub fn wiki_relative_path(path: &str) -> Result<&str, String> {
    path.strip_prefix(&format!("{WIKI_ROOT_PATH}/"))
        .or_else(|| path.strip_prefix(WIKI_ROOT_PATH))
        .map(|value| value.trim_start_matches('/'))
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

#[cfg(test)]
mod tests {
    use super::{
        RAW_SOURCES_PREFIX, WIKI_ROOT_PATH, normalize_wiki_remote_path,
        validate_canonical_source_path, wiki_relative_path,
    };

    #[test]
    fn canonical_source_path_accepts_expected_shape() {
        let path = format!("{RAW_SOURCES_PREFIX}/alpha/alpha.md");
        assert!(validate_canonical_source_path(&path).is_ok());
    }

    #[test]
    fn canonical_source_path_rejects_wrong_file_name() {
        let error = validate_canonical_source_path("/Sources/raw/alpha/beta.md")
            .expect_err("non-canonical path should fail");
        assert!(error.contains("canonical form"));
    }

    #[test]
    fn canonical_source_path_rejects_prefix_lookalikes() {
        let error = validate_canonical_source_path("/Sources/rawfoo/alpha.md")
            .expect_err("prefix lookalike should fail");
        assert!(error.contains("source path must stay under"));
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
    fn normalize_wiki_remote_path_rejects_non_wiki_path() {
        let error = normalize_wiki_remote_path("/Sources/raw/file.md")
            .expect_err("non-wiki path should fail");
        assert!(error.contains(WIKI_ROOT_PATH));
    }
}

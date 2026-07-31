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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrontmatterScalarError;

impl std::fmt::Display for FrontmatterScalarError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("invalid quoted frontmatter scalar")
    }
}

impl std::error::Error for FrontmatterScalarError {}

pub fn extract_frontmatter_block(content: &str) -> Option<&str> {
    let rest = content.strip_prefix("---\n")?;
    let end = rest.find("\n---\n").or_else(|| {
        rest.ends_with("\n---")
            .then_some(rest.len() - "\n---".len())
    })?;
    Some(&rest[..end])
}

pub fn decode_frontmatter_scalar(value: &str) -> Result<Option<String>, FrontmatterScalarError> {
    let value = value.trim();
    if value == "null" || value == "~" {
        return Ok(None);
    }
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return decode_json_string_literal(value).map(Some);
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return Ok(Some(value[1..value.len() - 1].replace("''", "'")));
    }
    Ok(Some(value.to_string()))
}

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

fn decode_json_string_literal(value: &str) -> Result<String, FrontmatterScalarError> {
    let body = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .ok_or(FrontmatterScalarError)?;
    let mut chars = body.chars();
    let mut decoded = String::new();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let escaped = chars.next().ok_or(FrontmatterScalarError)?;
            decode_json_escape(escaped, &mut chars, &mut decoded)?;
        } else if ch.is_control() {
            return Err(FrontmatterScalarError);
        } else {
            decoded.push(ch);
        }
    }
    Ok(decoded)
}

fn decode_json_escape(
    escaped: char,
    chars: &mut std::str::Chars<'_>,
    decoded: &mut String,
) -> Result<(), FrontmatterScalarError> {
    match escaped {
        '"' => decoded.push('"'),
        '\\' => decoded.push('\\'),
        '/' => decoded.push('/'),
        'b' => decoded.push('\u{0008}'),
        'f' => decoded.push('\u{000c}'),
        'n' => decoded.push('\n'),
        'r' => decoded.push('\r'),
        't' => decoded.push('\t'),
        'u' => {
            let code = decode_json_hex4(chars)?;
            if (0xD800..=0xDBFF).contains(&code) {
                if chars.next() != Some('\\') || chars.next() != Some('u') {
                    return Err(FrontmatterScalarError);
                }
                let low = decode_json_hex4(chars)?;
                if !(0xDC00..=0xDFFF).contains(&low) {
                    return Err(FrontmatterScalarError);
                }
                let scalar = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                decoded.push(char::from_u32(scalar).ok_or(FrontmatterScalarError)?);
            } else if (0xDC00..=0xDFFF).contains(&code) {
                return Err(FrontmatterScalarError);
            } else {
                decoded.push(char::from_u32(code).ok_or(FrontmatterScalarError)?);
            }
        }
        _ => return Err(FrontmatterScalarError),
    }
    Ok(())
}

fn decode_json_hex4(chars: &mut std::str::Chars<'_>) -> Result<u32, FrontmatterScalarError> {
    let mut code = 0u32;
    for _ in 0..4 {
        code = code * 16
            + chars
                .next()
                .and_then(|ch| ch.to_digit(16))
                .ok_or(FrontmatterScalarError)?;
    }
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::{
        WIKI_ROOT_PATH, decode_frontmatter_scalar, extract_frontmatter_block,
        normalize_wiki_remote_path, validate_canonical_source_path, validate_knowledge_source_path,
        wiki_relative_path,
    };

    #[test]
    fn frontmatter_block_requires_whole_line_delimiters() {
        let content = "---\nkind: note\nvalue: ---not-a-delimiter\n---\nbody\n";
        assert_eq!(
            extract_frontmatter_block(content),
            Some("kind: note\nvalue: ---not-a-delimiter")
        );
        assert_eq!(extract_frontmatter_block("---\nkind: note"), None);
    }

    #[test]
    fn frontmatter_scalar_decodes_yaml_string_forms() {
        assert_eq!(
            decode_frontmatter_scalar("\"a\\n\\uD83D\\uDE00\""),
            Ok(Some("a\n😀".to_string()))
        );
        assert_eq!(
            decode_frontmatter_scalar("'it''s'"),
            Ok(Some("it's".to_string()))
        );
        assert_eq!(decode_frontmatter_scalar("~"), Ok(None));
        assert!(decode_frontmatter_scalar("\"bad\\q\"").is_err());
    }

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

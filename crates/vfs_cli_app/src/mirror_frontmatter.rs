// Where: crates/wiki_cli/src/mirror_frontmatter.rs
// What: Frontmatter parsing for managed FS-first mirror files.
// Why: The local mirror must track remote path and etag without page-specific metadata.
use vfs_types::NodeKind;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MirrorFrontmatter {
    pub path: String,
    pub kind: NodeKind,
    pub etag: String,
    pub updated_at: i64,
    pub mirror: bool,
}

pub fn parse_mirror_frontmatter(content: &str) -> Option<MirrorFrontmatter> {
    if !content.starts_with("---\n") {
        return None;
    }
    let end = content.find("\n---\n")?;
    let mut path = None;
    let mut kind = None;
    let mut etag = None;
    let mut updated_at = None;
    let mut mirror = None;
    for line in content[4..end].lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"');
        match key.trim() {
            "path" => path = Some(value.to_string()),
            "kind" => {
                kind = match value {
                    "file" => Some(NodeKind::File),
                    "source" => Some(NodeKind::Source),
                    _ => None,
                }
            }
            "etag" => etag = Some(value.to_string()),
            "updated_at" => updated_at = value.parse::<i64>().ok(),
            "mirror" => mirror = Some(value == "true"),
            _ => {}
        }
    }
    Some(MirrorFrontmatter {
        path: path?,
        kind: kind?,
        etag: etag?,
        updated_at: updated_at?,
        mirror: mirror?,
    })
    .filter(|metadata| metadata.mirror)
}

pub fn serialize_mirror_file(frontmatter: &MirrorFrontmatter, body: &str) -> String {
    [
        "---".to_string(),
        format!("path: {}", frontmatter.path),
        format!("kind: {}", kind_as_str(&frontmatter.kind)),
        format!("etag: {}", frontmatter.etag),
        format!("updated_at: {}", frontmatter.updated_at),
        "mirror: true".to_string(),
        "---".to_string(),
        String::new(),
        body.trim_start().to_string(),
    ]
    .join("\n")
}

pub fn strip_managed_frontmatter(content: &str) -> String {
    match content
        .strip_prefix("---\n")
        .and_then(|rest| rest.find("\n---\n").map(|end| end + 8))
    {
        Some(end) => content[end..].to_string(),
        None => content.to_string(),
    }
}

pub fn strip_any_frontmatter(content: &str) -> String {
    strip_managed_frontmatter(content)
}

fn kind_as_str(kind: &NodeKind) -> &'static str {
    match kind {
        NodeKind::File => "file",
        NodeKind::Source => "source",
    }
}

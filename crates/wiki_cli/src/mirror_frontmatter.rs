// Where: crates/wiki_cli/src/mirror_frontmatter.rs
// What: Frontmatter parsing and serialization for managed mirror files.
// Why: The CLI needs a stable local file contract that matches the Obsidian plugin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MirrorFrontmatter {
    pub page_id: String,
    pub slug: String,
    pub page_type: String,
    pub revision_id: String,
    pub updated_at: i64,
    pub mirror: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftFrontmatter {
    pub slug: String,
    pub title: String,
    pub page_type: String,
    pub draft: bool,
}

pub fn parse_mirror_frontmatter(content: &str) -> Option<MirrorFrontmatter> {
    if !content.starts_with("---\n") {
        return None;
    }
    let end = content.find("\n---\n")?;
    let mut page_id = None;
    let mut slug = None;
    let mut page_type = None;
    let mut revision_id = None;
    let mut updated_at = None;
    let mut mirror = None;
    for line in content[4..end].lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"');
        match key.trim() {
            "page_id" => page_id = Some(value.to_string()),
            "slug" => slug = Some(value.to_string()),
            "page_type" => page_type = Some(value.to_string()),
            "revision_id" => revision_id = Some(value.to_string()),
            "updated_at" => updated_at = value.parse::<i64>().ok(),
            "mirror" => mirror = Some(value == "true"),
            _ => {}
        }
    }
    Some(MirrorFrontmatter {
        page_id: page_id?,
        slug: slug?,
        page_type: page_type?,
        revision_id: revision_id?,
        updated_at: updated_at?,
        mirror: mirror?,
    })
    .filter(|metadata| metadata.mirror)
}

pub fn parse_draft_frontmatter(content: &str) -> Option<DraftFrontmatter> {
    if !content.starts_with("---\n") {
        return None;
    }
    let end = content.find("\n---\n")?;
    let mut slug = None;
    let mut title = None;
    let mut page_type = None;
    let mut draft = None;
    for line in content[4..end].lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"');
        match key.trim() {
            "slug" => slug = Some(value.to_string()),
            "title" => title = Some(value.to_string()),
            "page_type" => page_type = Some(value.to_string()),
            "draft" => draft = Some(value == "true"),
            _ => {}
        }
    }
    Some(DraftFrontmatter {
        slug: slug?,
        title: title?,
        page_type: page_type?,
        draft: draft?,
    })
    .filter(|metadata| metadata.draft)
}

pub fn serialize_mirror_file(frontmatter: &MirrorFrontmatter, body: &str) -> String {
    [
        "---".to_string(),
        format!("page_id: {}", frontmatter.page_id),
        format!("slug: {}", frontmatter.slug),
        format!("page_type: {}", frontmatter.page_type),
        format!("revision_id: {}", frontmatter.revision_id),
        format!("updated_at: {}", frontmatter.updated_at),
        "mirror: true".to_string(),
        "---".to_string(),
        String::new(),
        body.trim_start().to_string(),
    ]
    .join("\n")
}

pub fn serialize_draft_file(frontmatter: &DraftFrontmatter, body: &str) -> String {
    [
        "---".to_string(),
        format!("slug: {}", frontmatter.slug),
        format!("title: {}", frontmatter.title),
        format!("page_type: {}", frontmatter.page_type),
        "draft: true".to_string(),
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

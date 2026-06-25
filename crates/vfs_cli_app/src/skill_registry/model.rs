// Where: crates/vfs_cli_app/src/skill_registry/model.rs
// What: Skill Knowledge Base path, manifest, and ranking helpers.
// Why: The CLI workflow stays thin while manifest handling remains testable and schema-free.
use anyhow::{Result, anyhow};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const PRIVATE_ROOT: &str = "/Skills";
pub(super) const RUN_ROOT: &str = "/Sources/skill-runs";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SkillManifest {
    pub(super) kind: String,
    pub(super) schema_version: u32,
    pub(super) id: String,
    pub(super) version: String,
    pub(super) entry: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) use_cases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) promoted_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) promoted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) deprecated_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) deprecated_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) deprecated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) last_evidence_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) replaces: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) related: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) knowledge: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(super) permissions: BTreeMap<String, bool>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(super) provenance: BTreeMap<String, String>,
}

impl SkillManifest {
    pub(super) fn default_for(id: &SkillId) -> Self {
        Self {
            kind: "kinic.skill".to_string(),
            schema_version: 1,
            id: id.to_string(),
            version: "0.1.0".to_string(),
            entry: "SKILL.md".to_string(),
            title: None,
            summary: None,
            tags: Vec::new(),
            use_cases: Vec::new(),
            status: Some("draft".to_string()),
            promoted_by: None,
            promoted_at: None,
            deprecated_reason: None,
            deprecated_by: None,
            deprecated_at: None,
            last_evidence_at: None,
            replaces: Vec::new(),
            related: Vec::new(),
            knowledge: Vec::new(),
            permissions: BTreeMap::new(),
            provenance: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct SkillSourceFrontmatter {
    pub(super) description: Option<String>,
    pub(super) license: Option<String>,
    #[serde(default)]
    pub(super) metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct SkillId {
    pub(super) name: String,
}

impl SkillId {
    pub(super) fn parse(value: &str) -> Result<Self> {
        if !valid_segment(value) {
            return Err(anyhow!("skill id must use a single path-safe name"));
        }
        Ok(Self {
            name: value.to_string(),
        })
    }
}

impl std::fmt::Display for SkillId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name)
    }
}

pub(super) fn parse_skill_source_frontmatter(content: &str) -> Result<SkillSourceFrontmatter> {
    let Ok(frontmatter) = extract_frontmatter(content) else {
        return Ok(SkillSourceFrontmatter::default());
    };
    Ok(serde_yaml::from_str(frontmatter)?)
}

pub(super) fn normalize_manifest(
    content: &str,
    id: &SkillId,
    source: &SkillSourceFrontmatter,
) -> Result<String> {
    let mut manifest = parse_manifest(content)?;
    if manifest.id != id.to_string() {
        return Err(anyhow!("manifest id must match --id"));
    }
    if manifest.status.is_none() {
        manifest.status = Some("draft".to_string());
    }
    apply_source_frontmatter_defaults(&mut manifest, id, source)?;
    Ok(render_manifest(&manifest))
}

pub(super) fn manifest_for_source(id: &SkillId, source: &SkillSourceFrontmatter) -> Result<String> {
    let mut manifest = SkillManifest::default_for(id);
    apply_source_frontmatter_defaults(&mut manifest, id, source)?;
    Ok(render_manifest(&manifest))
}

pub(super) fn parse_manifest(content: &str) -> Result<SkillManifest> {
    let manifest: SkillManifest = serde_yaml::from_str(extract_frontmatter(content)?)?;
    if manifest.kind != "kinic.skill" || manifest.schema_version != 1 {
        return Err(anyhow!("manifest must be kinic.skill schema_version 1"));
    }
    if manifest.entry != "SKILL.md" {
        return Err(anyhow!("manifest entry must be SKILL.md"));
    }
    if !valid_package_version(&manifest.version) {
        return Err(anyhow!("manifest version must use MAJOR.MINOR.PATCH"));
    }
    SkillId::parse(&manifest.id)?;
    Ok(manifest)
}

pub(super) fn render_manifest(manifest: &SkillManifest) -> String {
    let yaml = serde_yaml::to_string(manifest).expect("manifest should serialize");
    format!("---\n{}---\n# Skill Manifest\n", yaml)
}

fn apply_source_frontmatter_defaults(
    manifest: &mut SkillManifest,
    _id: &SkillId,
    source: &SkillSourceFrontmatter,
) -> Result<()> {
    if manifest.title.is_none() {
        manifest.title = source
            .metadata
            .get("title")
            .filter(|value| !value.is_empty())
            .cloned();
    }
    if manifest.summary.is_none() {
        manifest.summary = source
            .description
            .as_ref()
            .filter(|value| !value.is_empty())
            .cloned();
    }
    if manifest.tags.is_empty()
        && let Some(category) = source
            .metadata
            .get("category")
            .filter(|value| !value.is_empty())
    {
        manifest.tags.push(category.clone());
    }
    if !manifest.provenance.contains_key("license")
        && let Some(license) = source.license.as_ref().filter(|value| !value.is_empty())
    {
        manifest
            .provenance
            .insert("license".to_string(), license.clone());
    }
    Ok(())
}

pub(super) fn set_manifest_status_preserving_content(
    content: &str,
    status: &str,
) -> Result<String> {
    parse_manifest(content)?;
    set_root_frontmatter_field_preserving_content(content, "status", status)
}

pub(super) fn set_root_frontmatter_field_preserving_content(
    content: &str,
    key: &str,
    value: &str,
) -> Result<String> {
    let frontmatter = extract_frontmatter(content)?;
    let frontmatter_start = "---\n".len();
    let frontmatter_end = frontmatter_start + frontmatter.len();
    let mut replaced = false;
    let mut updated = String::new();
    for line in frontmatter.split_inclusive('\n') {
        let line_without_newline = line.strip_suffix('\n').unwrap_or(line);
        let newline = if line.ends_with('\n') { "\n" } else { "" };
        if !line.starts_with(' ')
            && line_without_newline
                .trim_start()
                .starts_with(&format!("{key}:"))
        {
            updated.push_str(&format!("{key}: {}{newline}", yaml_scalar(value)));
            replaced = true;
        } else {
            updated.push_str(line);
        }
    }
    if !replaced {
        if !updated.is_empty() && !updated.ends_with('\n') {
            updated.push('\n');
        }
        updated.push_str(&format!("{key}: {}", yaml_scalar(value)));
    }
    Ok(format!(
        "{}{}{}",
        &content[..frontmatter_start],
        updated,
        &content[frontmatter_end..]
    ))
}

pub(super) fn remove_root_frontmatter_fields_preserving_content(
    content: &str,
    keys: &[&str],
) -> Result<String> {
    let frontmatter = extract_frontmatter(content)?;
    let frontmatter_start = "---\n".len();
    let frontmatter_end = frontmatter_start + frontmatter.len();
    let mut updated = String::new();
    let mut skipping_removed_block = false;
    for line in frontmatter.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let is_root_key =
            !line.starts_with(' ') && !line.starts_with('\t') && trimmed.contains(':');
        if is_root_key
            && keys
                .iter()
                .any(|key| trimmed.starts_with(&format!("{key}:")))
        {
            skipping_removed_block = true;
            continue;
        }
        if skipping_removed_block {
            if line.starts_with(' ') || line.starts_with('\t') || line.trim().is_empty() {
                continue;
            }
            skipping_removed_block = false;
        }
        updated.push_str(line);
    }
    Ok(format!(
        "{}{}{}",
        &content[..frontmatter_start],
        updated,
        &content[frontmatter_end..]
    ))
}

pub(super) fn set_manifest_provenance_field(
    content: &str,
    key: &str,
    value: &str,
) -> Result<String> {
    let mut manifest = parse_manifest(content)?;
    manifest
        .provenance
        .insert(key.to_string(), value.to_string());
    Ok(render_manifest(&manifest))
}

fn yaml_scalar(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '/'))
    {
        value.to_string()
    } else {
        serde_json::to_string(value).expect("string should serialize")
    }
}

pub(super) fn skill_base_path(id: &SkillId) -> String {
    format!("{}/{}", PRIVATE_ROOT, id.name)
}

pub(super) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock should be after unix epoch")
        .as_millis() as i64
}

pub(super) fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub(super) fn print(value: serde_json::Value, _json_output: bool) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

pub(super) fn extract_frontmatter(content: &str) -> Result<&str> {
    let rest = content
        .strip_prefix("---\n")
        .ok_or_else(|| anyhow!("manifest must start with YAML frontmatter"))?;
    let end = rest
        .lines()
        .scan(0_usize, |offset, line| {
            let start = *offset;
            *offset += line.len() + 1;
            Some((start, line))
        })
        .find_map(|(offset, line)| (line == "---").then_some(offset.saturating_sub(1)))
        .ok_or_else(|| anyhow!("manifest frontmatter is not closed"))?;
    Ok(&rest[..end])
}

fn valid_segment(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(ch) if ch.is_ascii_alphanumeric())
        && value.len() <= 128
        && !value.contains("..")
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn valid_package_version(value: &str) -> bool {
    let mut parts = value.split('.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    let Some(patch) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && valid_version_number(major)
        && valid_version_number(minor)
        && valid_version_number(patch)
}

fn valid_version_number(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit())
}

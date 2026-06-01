// Where: crates/vfs_cli_core/src/skill_kb.rs
// What: Read-only Skill Knowledge Base helpers shared by CLI and agent tools.
// Why: Human CLI and agent runtime must rank and inspect skill packages identically.
use anyhow::{Result, anyhow};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use vfs_client::VfsApi;
use vfs_types::{
    ListNodesRequest, MkdirNodeRequest, NodeEntryKind, NodeKind, SearchNodesRequest,
    SearchPreviewMode, WriteNodeRequest,
};

const PRIVATE_SKILL_ROOT: &str = "/Wiki/skills";
const SKILL_RUN_ROOT: &str = "/Sources/skill-runs";

#[derive(Default)]
struct SkillHitAccumulator {
    best_score: Option<f64>,
    matched_paths: BTreeSet<String>,
    why: BTreeSet<String>,
}

impl SkillHitAccumulator {
    fn add(&mut self, hit: vfs_types::SearchNodeHit) {
        let score = f64::from(hit.score);
        self.best_score = Some(
            self.best_score
                .map(|current| current.min(score))
                .unwrap_or(score),
        );
        self.matched_paths.insert(hit.path);
        self.why.extend(hit.match_reasons);
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct SkillManifestView {
    pub id: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub status: Option<String>,
    pub tags: Vec<String>,
    pub use_cases: Vec<String>,
    pub deprecated_reason: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct SkillRunSummary {
    pub runs: u32,
    pub success: u32,
    pub partial: u32,
    pub fail: u32,
    pub last_used_at: Option<String>,
    pub last_outcome: Option<String>,
}

#[derive(Clone, Copy)]
pub enum SkillRunOutcome {
    Success,
    Partial,
    Fail,
}

pub struct SkillRunRecord<'a> {
    pub database_id: &'a str,
    pub id: &'a str,
    pub task: &'a str,
    pub outcome: SkillRunOutcome,
    pub notes: &'a str,
    pub agent: &'a str,
}

impl SkillRunOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Partial => "partial",
            Self::Fail => "fail",
        }
    }
}

pub async fn find_skills(
    client: &impl VfsApi,
    database_id: &str,
    query_text: &str,
    include_deprecated: bool,
    top_k: u32,
) -> Result<Value> {
    let top_k = top_k.clamp(1, 20);
    let mut grouped: BTreeMap<String, SkillHitAccumulator> = BTreeMap::new();
    for prefix in [PRIVATE_SKILL_ROOT, SKILL_RUN_ROOT] {
        for hit in client
            .search_nodes(SearchNodesRequest {
                database_id: database_id.to_string(),
                query_text: query_text.to_string(),
                prefix: Some(prefix.to_string()),
                top_k,
                preview_mode: Some(SearchPreviewMode::Light),
            })
            .await?
        {
            if let Some(id) = skill_id_from_path(&hit.path) {
                grouped.entry(id).or_default().add(hit);
            }
        }
    }

    let mut hits = Vec::new();
    for (id, acc) in grouped {
        let manifest = read_skill_manifest(client, database_id, &id).await?;
        let status = manifest
            .status
            .clone()
            .unwrap_or_else(|| "draft".to_string());
        if status == "deprecated" && !include_deprecated {
            continue;
        }
        hits.push(json!({
            "id": id,
            "status": status,
            "deprecated_reason": manifest.deprecated_reason,
            "title": manifest.title.unwrap_or_default(),
            "summary": manifest.summary.unwrap_or_default(),
            "run_summary": run_summary(client, database_id, &id).await?,
            "score": acc.best_score.unwrap_or_default(),
            "matched_paths": acc.matched_paths.into_iter().collect::<Vec<_>>(),
            "why": acc.why.into_iter().collect::<Vec<_>>()
        }));
    }
    hits.sort_by(|left, right| {
        left["score"]
            .as_f64()
            .unwrap_or_default()
            .total_cmp(&right["score"].as_f64().unwrap_or_default())
    });
    hits.truncate(top_k as usize);
    Ok(json!({ "query": query_text, "hits": hits }))
}

pub async fn inspect_skill(client: &impl VfsApi, database_id: &str, id: &str) -> Result<Value> {
    validate_skill_id(id)?;
    let base_path = skill_base_path(id);
    let manifest = read_skill_manifest(client, database_id, id).await?;
    let mut files = BTreeMap::new();
    for name in ["manifest.md", "SKILL.md", "provenance.md", "evals.md"] {
        files.insert(name.to_string(), false);
    }
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: base_path.clone(),
            recursive: true,
        })
        .await?
    {
        if entry.kind != NodeEntryKind::File {
            continue;
        }
        if let Some(relative_path) = entry.path.strip_prefix(&format!("{base_path}/")) {
            files.insert(relative_path.to_string(), true);
        }
    }
    let run_summary = run_summary(client, database_id, id).await?;
    Ok(json!({
        "id": id,
        "base_path": base_path,
        "manifest": manifest,
        "files": files,
        "run_summary": run_summary
    }))
}

pub async fn record_skill_run(client: &impl VfsApi, record: SkillRunRecord<'_>) -> Result<Value> {
    let SkillRunRecord {
        database_id,
        id,
        task,
        outcome,
        notes,
        agent,
    } = record;
    validate_skill_id(id)?;
    let base_path = skill_base_path(id);
    let skill = client
        .read_node(database_id, &format!("{base_path}/SKILL.md"))
        .await?
        .ok_or_else(|| anyhow!("SKILL.md not found for skill: {id}"))?;
    let manifest = client
        .read_node(database_id, &format!("{base_path}/manifest.md"))
        .await?
        .ok_or_else(|| anyhow!("manifest.md not found for skill: {id}"))?;
    let run_id = now_millis().to_string();
    let recorded_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let run_path = format!("{SKILL_RUN_ROOT}/{id}/{run_id}.md");
    let outcome = outcome.as_str();
    let content = format!(
        "---\nkind: kinic.skill_run\nschema_version: 1\nskill_id: {id}\nskill_hash: {}\nmanifest_hash: {}\ntask: {}\ntask_hash: {}\noutcome: {outcome}\nagent: {}\nrecorded_by: cli\nrecorded_at: {recorded_at}\n---\n# Skill Run\n\n## Task\n\n{task}\n\n## Notes\n\n{notes}\n",
        sha256_hex(&skill.content),
        sha256_hex(&manifest.content),
        yaml_quote(task),
        sha256_hex(task),
        yaml_quote(agent),
    );
    ensure_parent_folders(client, database_id, &run_path).await?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: run_path.clone(),
            kind: NodeKind::Source,
            content,
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    Ok(json!({ "id": id, "run_path": run_path, "outcome": outcome }))
}

async fn ensure_parent_folders(client: &impl VfsApi, database_id: &str, path: &str) -> Result<()> {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut current = String::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        current.push('/');
        current.push_str(segment);
        client
            .mkdir_node(MkdirNodeRequest {
                database_id: database_id.to_string(),
                path: current.clone(),
            })
            .await?;
    }
    Ok(())
}

pub async fn read_skill_file(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    file: &str,
) -> Result<Value> {
    validate_skill_id(id)?;
    let file = validate_package_file(file)?;
    let path = format!("{}/{}", skill_base_path(id), file);
    Ok(json!({ "node": client.read_node(database_id, &path).await? }))
}

async fn read_skill_manifest(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
) -> Result<SkillManifestView> {
    validate_skill_id(id)?;
    let Some(node) = client
        .read_node(database_id, &format!("{}/manifest.md", skill_base_path(id)))
        .await?
    else {
        return Ok(SkillManifestView::default());
    };
    Ok(parse_manifest_view(&node.content))
}

fn parse_manifest_view(content: &str) -> SkillManifestView {
    let Some(frontmatter) = extract_frontmatter(content) else {
        return SkillManifestView::default();
    };
    let mut manifest = SkillManifestView::default();
    let mut current_list: Option<&str> = None;
    for line in frontmatter.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(key) = current_list
            && (line.starts_with("  - ") || line.starts_with("- "))
        {
            let value = clean_yaml_value(line.trim_start_matches("  - ").trim_start_matches("- "));
            if key == "tags" {
                manifest.tags.push(value);
            } else if key == "use_cases" {
                manifest.use_cases.push(value);
            }
            continue;
        }
        current_list = None;
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = clean_yaml_value(value);
        match key {
            "id" => manifest.id = non_empty(value),
            "title" => manifest.title = non_empty(value),
            "summary" => manifest.summary = non_empty(value),
            "status" => manifest.status = non_empty(value),
            "deprecated_reason" => manifest.deprecated_reason = non_empty(value),
            "tags" | "use_cases" if value.is_empty() => current_list = Some(key),
            _ => {}
        }
    }
    manifest
}

async fn run_summary(client: &impl VfsApi, database_id: &str, id: &str) -> Result<SkillRunSummary> {
    let mut summary = SkillRunSummary::default();
    let mut last_seen: Option<(String, String)> = None;
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: format!("{SKILL_RUN_ROOT}/{id}"),
            recursive: true,
        })
        .await?
    {
        if entry.kind != NodeEntryKind::Source && entry.kind != NodeEntryKind::File {
            continue;
        }
        let Some(node) = client.read_node(database_id, &entry.path).await? else {
            continue;
        };
        let Some(run) = parse_run_frontmatter(&node.content) else {
            continue;
        };
        if run.skill_id.as_deref() != Some(id) {
            continue;
        }
        summary.runs += 1;
        let outcome = run.summary_outcome().unwrap_or("").to_string();
        match outcome.as_str() {
            "success" => summary.success += 1,
            "partial" => summary.partial += 1,
            "fail" => summary.fail += 1,
            _ => {}
        }
        if let Some(recorded_at) = run.recorded_at {
            let replace = last_seen
                .as_ref()
                .map(|(current, _)| recorded_at > *current)
                .unwrap_or(true);
            if replace {
                last_seen = Some((recorded_at, outcome));
            }
        }
    }
    if let Some((recorded_at, outcome)) = last_seen {
        summary.last_used_at = Some(recorded_at);
        summary.last_outcome = Some(outcome);
    }
    Ok(summary)
}

#[derive(Default)]
struct RunFrontmatter {
    schema_version: Option<String>,
    skill_id: Option<String>,
    outcome: Option<String>,
    agent_outcome: Option<String>,
    recorded_at: Option<String>,
}

impl RunFrontmatter {
    fn summary_outcome(&self) -> Option<&str> {
        match self.schema_version.as_deref() {
            Some("2") => self.agent_outcome.as_deref(),
            _ => self.outcome.as_deref(),
        }
    }
}

fn parse_run_frontmatter(content: &str) -> Option<RunFrontmatter> {
    let frontmatter = extract_frontmatter(content)?;
    let mut run = RunFrontmatter::default();
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = clean_yaml_value(value);
        match key.trim() {
            "schema_version" => run.schema_version = non_empty(value),
            "skill_id" => run.skill_id = non_empty(value),
            "outcome" => run.outcome = non_empty(value),
            "agent_outcome" => run.agent_outcome = non_empty(value),
            "recorded_at" => run.recorded_at = non_empty(value),
            _ => {}
        }
    }
    Some(run)
}

fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn yaml_quote(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '/'))
    {
        value.to_string()
    } else {
        serde_json::to_string(value).expect("string should serialize")
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock should be after unix epoch")
        .as_millis() as i64
}

fn extract_frontmatter(content: &str) -> Option<&str> {
    let rest = content.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

fn clean_yaml_value(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string()
}

fn non_empty(value: String) -> Option<String> {
    if value.is_empty() { None } else { Some(value) }
}

fn skill_id_from_path(path: &str) -> Option<String> {
    if let Some(rest) = path.strip_prefix(&format!("{PRIVATE_SKILL_ROOT}/")) {
        return first_skill_segment(rest);
    }
    path.strip_prefix(&format!("{SKILL_RUN_ROOT}/"))
        .and_then(first_skill_segment)
}

fn first_skill_segment(rest: &str) -> Option<String> {
    let id = rest.split('/').next()?;
    validate_skill_id(id).ok()?;
    Some(id.to_string())
}

fn skill_base_path(id: &str) -> String {
    format!("{PRIVATE_SKILL_ROOT}/{id}")
}

fn validate_skill_id(id: &str) -> Result<()> {
    if id.is_empty()
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        anyhow::bail!("skill id must use a single path-safe name");
    }
    Ok(())
}

fn validate_package_file(file: &str) -> Result<String> {
    let file = file.trim();
    if file.is_empty()
        || file.starts_with('/')
        || file.contains("://")
        || file
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        anyhow::bail!("skill file must be a package-local relative path");
    }
    Ok(file.to_string())
}

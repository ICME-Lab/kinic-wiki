use crate::cli::{SkillCommand, SkillImportCommand, SkillRunOutcomeArg, SkillStatusArg};
use crate::github_source::{
    fetch_github_optional_package_file, fetch_github_skill_package, github_source_string,
    github_source_url, parse_github_skill_source,
};
mod model;
use anyhow::{Context, Result, anyhow};
use model::{
    RUN_ROOT, SkillId, manifest_for_source, normalize_manifest, now_millis, now_rfc3339,
    parse_manifest, parse_skill_source_frontmatter, print,
    remove_root_frontmatter_fields_preserving_content, set_manifest_provenance_field,
    set_manifest_status_preserving_content, set_root_frontmatter_field_preserving_content,
    skill_base_path,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
pub(crate) use vfs_cli::skill_kb::{find_skills, inspect_skill};
use vfs_client::VfsApi;
use vfs_types::{
    DeleteNodeRequest, ListNodesRequest, MkdirNodeRequest, NodeEntryKind, NodeKind, WriteNodeItem,
    WriteNodeRequest, WriteNodesRequest,
};

const SKILL_PACKAGE_FILE_LIMIT_MAX: usize = 100;

pub async fn run_skill_command(
    client: &impl VfsApi,
    database_id: &str,
    command: SkillCommand,
) -> Result<()> {
    match command {
        SkillCommand::Upsert {
            source_dir,
            id,
            prune,
            json,
        } => print(
            upsert_skill(client, database_id, &source_dir, &id, prune).await?,
            json,
        )?,
        SkillCommand::Find {
            query,
            include_deprecated,
            top_k,
            json,
        } => print(
            find_skills(client, database_id, &query, include_deprecated, top_k).await?,
            json,
        )?,
        SkillCommand::List { status, json } => print(
            list_skill_packages(client, database_id, &status).await?,
            json,
        )?,
        SkillCommand::Inspect { id, json } => {
            print(inspect_skill(client, database_id, &id).await?, json)?
        }
        SkillCommand::RecordRun {
            id,
            evidence_json,
            task,
            outcome,
            notes_file,
            agent,
            json,
        } => {
            let result = if let Some(evidence_json) = evidence_json {
                record_skill_run_evidence(
                    client,
                    SkillRunEvidenceInput {
                        database_id,
                        id: &id,
                        evidence_json: &evidence_json,
                    },
                )
                .await?
            } else {
                record_skill_run(
                    client,
                    SkillRunInput {
                        database_id,
                        id: &id,
                        task: task
                            .as_deref()
                            .ok_or_else(|| anyhow!("--task is required without --evidence-json"))?,
                        outcome: outcome.ok_or_else(|| {
                            anyhow!("--outcome is required without --evidence-json")
                        })?,
                        notes_file: notes_file.as_deref().ok_or_else(|| {
                            anyhow!("--notes-file is required without --evidence-json")
                        })?,
                        agent: &agent,
                    },
                )
                .await?
            };
            print(result, json)?
        }
        SkillCommand::SetStatus {
            id,
            status,
            reason,
            json,
        } => print(
            set_skill_status(client, database_id, &id, status, reason.as_deref()).await?,
            json,
        )?,
        SkillCommand::Import { source } => match source {
            SkillImportCommand::Github {
                source,
                id,
                reference,
                prune,
                json,
            } => print(
                import_github_skill(client, database_id, &source, &id, &reference, prune).await?,
                json,
            )?,
        },
        SkillCommand::RecordCorrection {
            id,
            run_id,
            notes_file,
            json,
        } => print(
            record_correction(client, database_id, &id, &run_id, &notes_file).await?,
            json,
        )?,
        SkillCommand::Rollback {
            id,
            version_id,
            projection_dir,
            json,
        } => print(
            rollback_skill_version(
                client,
                database_id,
                &id,
                &version_id,
                projection_dir.as_deref(),
            )
            .await?,
            json,
        )?,
        SkillCommand::Export { id, out, json } => {
            print(export_skill(client, database_id, &id, &out).await?, json)?
        }
        SkillCommand::ExportGithub {
            id,
            target,
            branch,
            message,
            json,
        } => print(
            export_skill_github(client, database_id, &id, &target, &branch, &message).await?,
            json,
        )?,
        SkillCommand::History { id, json } => {
            print(skill_history(client, database_id, &id).await?, json)?
        }
        SkillCommand::Install { id, lockfile, json } => print(
            install_skill_lockfile(client, database_id, &id, &lockfile).await?,
            json,
        )?,
        SkillCommand::Sync {
            target,
            status,
            prune,
            dry_run,
            json,
        } => print(
            sync_skill_packages(client, database_id, &target, &status, prune, dry_run).await?,
            json,
        )?,
    }
    Ok(())
}

pub(crate) async fn upsert_skill(
    client: &impl VfsApi,
    database_id: &str,
    source_dir: &Path,
    id: &str,
    prune: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let skill = std::fs::read_to_string(source_dir.join("SKILL.md"))
        .with_context(|| format!("missing SKILL.md in {}", source_dir.display()))?;
    let source_frontmatter = parse_skill_source_frontmatter(&skill)?;
    let files = discover_skill_package_files(source_dir, &skill, &skill_id, &source_frontmatter)?;
    write_skill_package(client, database_id, &skill_id, prune, files).await
}

async fn write_skill_package(
    client: &impl VfsApi,
    database_id: &str,
    skill_id: &SkillId,
    prune: bool,
    files: BTreeMap<String, String>,
) -> Result<serde_json::Value> {
    validate_skill_package_file_count(files.len())?;
    let base_path = skill_base_path(skill_id);
    let file_names = files.keys().cloned().collect::<BTreeSet<_>>();
    let entries = files.into_iter().collect::<Vec<_>>();
    let paths = entries
        .iter()
        .map(|(name, _)| format!("{base_path}/{name}"))
        .collect::<Vec<_>>();
    let snapshot_version_id =
        snapshot_existing_skill_version(client, database_id, &base_path).await?;
    ensure_parent_folders_for_paths(client, database_id, &paths).await?;
    let mut written_paths = Vec::new();
    let mut nodes = Vec::new();
    for ((_, content), path) in entries.into_iter().zip(paths) {
        let current = client.read_node(database_id, &path).await?;
        nodes.push(WriteNodeItem {
            path: path.clone(),
            kind: NodeKind::File,
            content,
            metadata_json: "{}".to_string(),
            expected_etag: current.map(|node| node.etag),
        });
        written_paths.push(path);
    }
    client
        .write_nodes(WriteNodesRequest {
            database_id: database_id.to_string(),
            nodes,
        })
        .await?;
    let pruned_paths = if prune {
        prune_package_files(client, database_id, &base_path, &file_names).await?
    } else {
        Vec::new()
    };
    Ok(
        json!({ "id": skill_id.to_string(), "base_path": base_path, "written_paths": written_paths, "pruned_paths": pruned_paths, "snapshot_version_id": snapshot_version_id }),
    )
}

pub(crate) async fn record_skill_run(
    client: &impl VfsApi,
    input: SkillRunInput<'_>,
) -> Result<serde_json::Value> {
    let SkillRunInput {
        database_id,
        id,
        task,
        outcome,
        notes_file,
        agent,
    } = input;
    let notes = std::fs::read_to_string(notes_file)
        .with_context(|| format!("failed to read {}", notes_file.display()))?;
    vfs_cli::skill_kb::record_skill_run(
        client,
        vfs_cli::skill_kb::SkillRunRecord {
            database_id,
            id,
            task,
            outcome: outcome.into(),
            notes: &notes,
            agent,
        },
    )
    .await
}

pub(crate) struct SkillRunInput<'a> {
    pub(crate) database_id: &'a str,
    pub(crate) id: &'a str,
    pub(crate) task: &'a str,
    pub(crate) outcome: SkillRunOutcomeArg,
    pub(crate) notes_file: &'a Path,
    pub(crate) agent: &'a str,
}

pub(crate) struct SkillRunEvidenceInput<'a> {
    pub(crate) database_id: &'a str,
    pub(crate) id: &'a str,
    pub(crate) evidence_json: &'a Path,
}

#[derive(Debug, Deserialize, Serialize)]
struct SkillRunEvidence {
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    recorded_by: Option<String>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    task: Option<String>,
    #[serde(default)]
    task_outcome: Option<String>,
    #[serde(default)]
    agent_outcome: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    raw_evidence_excerpt: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

pub(crate) async fn record_skill_run_evidence(
    client: &impl VfsApi,
    input: SkillRunEvidenceInput<'_>,
) -> Result<serde_json::Value> {
    record_skill_run_evidence_with_override(client, input, None).await
}

pub(crate) async fn record_skill_run_evidence_with_override(
    client: &impl VfsApi,
    input: SkillRunEvidenceInput<'_>,
    run_id_override: Option<&str>,
) -> Result<serde_json::Value> {
    let SkillRunEvidenceInput {
        database_id,
        id,
        evidence_json,
    } = input;
    let skill_id = SkillId::parse(id)?;
    let evidence_text = std::fs::read_to_string(evidence_json)
        .with_context(|| format!("failed to read {}", evidence_json.display()))?;
    let evidence: SkillRunEvidence = serde_json::from_str(&evidence_text)
        .with_context(|| format!("invalid evidence JSON: {}", evidence_json.display()))?;
    validate_outcome(evidence.task_outcome.as_deref(), "task_outcome")?;
    validate_outcome(evidence.agent_outcome.as_deref(), "agent_outcome")?;
    let base_path = skill_base_path(&skill_id);
    let skill_path = format!("{base_path}/SKILL.md");
    let manifest_path = format!("{base_path}/manifest.md");
    let skill = client
        .read_node(database_id, &skill_path)
        .await?
        .ok_or_else(|| anyhow!("SKILL.md not found for skill: {id}"))?;
    let manifest = client
        .read_node(database_id, &manifest_path)
        .await?
        .ok_or_else(|| anyhow!("manifest.md not found for skill: {id}"))?;
    let run_id = resolve_run_id(run_id_override, evidence.run_id.as_deref())?;
    let recorded_by = evidence.recorded_by.as_deref().unwrap_or("cli");
    if !valid_id_segment(recorded_by) {
        return Err(anyhow!("recorded_by must use a single path-safe name"));
    }
    let recorded_at = now_rfc3339();
    let run_path = format!("{RUN_ROOT}/{skill_id}/{run_id}.md");
    if client.read_node(database_id, &run_path).await?.is_some() {
        return Err(anyhow!("run already exists: {run_path}"));
    }
    let evidence_block = markdown_code_block("json", &serde_json::to_string_pretty(&evidence)?);
    let content = format!(
        concat!(
            "---\n",
            "kind: kinic.skill_run\n",
            "schema_version: 2\n",
            "skill_id: {id}\n",
            "skill_etag: {skill_etag}\n",
            "skill_hash: {skill_hash}\n",
            "manifest_hash: {manifest_hash}\n",
            "task_id: {task_id}\n",
            "task: {task}\n",
            "task_outcome: {task_outcome}\n",
            "agent_outcome: {agent_outcome}\n",
            "agent: {agent}\n",
            "recorded_by: {recorded_by}\n",
            "recorded_at: {recorded_at}\n",
            "---\n",
            "# Skill Run\n\n",
            "## Summary\n\n{summary}\n\n",
            "## Raw Evidence Excerpt\n\n{raw_evidence_excerpt}\n\n",
            "## Evidence JSON\n\n{evidence_block}\n"
        ),
        id = skill_id,
        skill_etag = yaml_quote(&skill.etag),
        skill_hash = sha256_hex(&skill.content),
        manifest_hash = sha256_hex(&manifest.content),
        task_id = yaml_quote(evidence.task_id.as_deref().unwrap_or("")),
        task = yaml_quote(evidence.task.as_deref().unwrap_or("")),
        task_outcome = yaml_quote(evidence.task_outcome.as_deref().unwrap_or("")),
        agent_outcome = yaml_quote(evidence.agent_outcome.as_deref().unwrap_or("")),
        agent = yaml_quote(evidence.agent.as_deref().unwrap_or("hermes")),
        recorded_by = recorded_by,
        recorded_at = recorded_at,
        summary = evidence.summary.as_deref().unwrap_or(""),
        raw_evidence_excerpt = evidence.raw_evidence_excerpt.as_deref().unwrap_or(""),
        evidence_block = evidence_block,
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
    Ok(json!({ "id": skill_id.to_string(), "run_id": run_id, "run_path": run_path }))
}

pub(crate) async fn set_skill_status(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    status: SkillStatusArg,
    reason: Option<&str>,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let path = format!("{}/manifest.md", skill_base_path(&skill_id));
    let node = client
        .read_node(database_id, &path)
        .await?
        .ok_or_else(|| anyhow!("manifest not found: {path}"))?;
    let mut content = set_manifest_status_preserving_content(&node.content, status.as_str())?;
    let timestamp = now_rfc3339();
    match status {
        SkillStatusArg::Promoted => {
            content = remove_root_frontmatter_fields_preserving_content(
                &content,
                &["deprecated_at", "deprecated_reason"],
            )?;
            content =
                set_root_frontmatter_field_preserving_content(&content, "promoted_at", &timestamp)?;
        }
        SkillStatusArg::Deprecated => {
            content =
                remove_root_frontmatter_fields_preserving_content(&content, &["promoted_at"])?;
            if let Some(reason) = reason {
                content = set_root_frontmatter_field_preserving_content(
                    &content,
                    "deprecated_reason",
                    reason,
                )?;
            }
            content = set_root_frontmatter_field_preserving_content(
                &content,
                "deprecated_at",
                &timestamp,
            )?;
        }
        SkillStatusArg::Draft | SkillStatusArg::Reviewed => {
            content = remove_root_frontmatter_fields_preserving_content(
                &content,
                &["deprecated_at", "deprecated_reason", "promoted_at"],
            )?;
        }
    }
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: path.clone(),
            kind: NodeKind::File,
            content,
            metadata_json: node.metadata_json,
            expected_etag: Some(node.etag),
        })
        .await?;
    Ok(json!({ "id": id, "status": status.as_str(), "path": path }))
}

async fn import_github_skill(
    client: &impl VfsApi,
    database_id: &str,
    source: &str,
    id: &str,
    reference: &str,
    prune: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let source = parse_github_skill_source(source, None)?;
    let package = fetch_github_skill_package(source, reference).await?;
    let source_frontmatter = parse_skill_source_frontmatter(&package.skill)?;
    let mut files = BTreeMap::new();
    files.insert("SKILL.md".to_string(), package.skill);
    let mut manifest = match package.manifest {
        Some(content) => normalize_manifest(&content, &skill_id, &source_frontmatter)?,
        None => manifest_for_source(&skill_id, &source_frontmatter)?,
    };
    manifest =
        set_manifest_provenance_field(&manifest, "source", &github_source_string(&package.source))?;
    manifest = set_manifest_provenance_field(
        &manifest,
        "source_url",
        &github_source_url(&package.source, &package.resolved_ref),
    )?;
    manifest = set_manifest_provenance_field(&manifest, "revision", &package.resolved_ref)?;
    files.insert("manifest.md".to_string(), manifest);
    if let Some(provenance) = package.provenance {
        files.insert("provenance.md".to_string(), provenance);
    }
    if let Some(evals) = package.evals {
        files.insert("evals.md".to_string(), evals);
    }
    for target in markdown_link_targets(files.get("SKILL.md").expect("SKILL.md should exist")) {
        let Some(relative_path) = markdown_target_package_key(&target) else {
            continue;
        };
        if files.contains_key(&relative_path) {
            continue;
        }
        if let Some(content) = fetch_github_optional_package_file(
            &package.source,
            &package.resolved_ref,
            &relative_path,
        )
        .await?
        {
            files.insert(relative_path, content);
        }
    }
    write_skill_package(client, database_id, &skill_id, prune, files).await
}

pub(crate) async fn install_skill_lockfile(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    lockfile: &Path,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let base_path = skill_base_path(&skill_id);
    let manifest_path = format!("{base_path}/manifest.md");
    let entry_path = format!("{base_path}/SKILL.md");
    let manifest = client
        .read_node(database_id, &manifest_path)
        .await?
        .ok_or_else(|| anyhow!("manifest not found: {manifest_path}"))?;
    let entry = client
        .read_node(database_id, &entry_path)
        .await?
        .ok_or_else(|| anyhow!("SKILL.md not found: {entry_path}"))?;
    let value = json!({
        "schema_version": 1,
        "database_id": database_id,
        "id": skill_id.to_string(),
        "manifest_path": manifest_path,
        "entry_path": entry_path,
        "manifest_etag": manifest.etag.clone(),
        "entry_etag": entry.etag.clone(),
        "manifest_hash": sha256_hex(&manifest.content),
        "entry_hash": sha256_hex(&entry.content),
        "installed_at": now_rfc3339()
    });
    std::fs::write(lockfile, serde_json::to_string_pretty(&value)?)
        .with_context(|| format!("failed to write {}", lockfile.display()))?;
    Ok(json!({
        "id": skill_id.to_string(),
        "lockfile": lockfile.display().to_string(),
        "manifest_path": value["manifest_path"],
        "entry_path": value["entry_path"]
    }))
}

#[derive(Debug, Clone)]
struct SkillPackageRecord {
    id: String,
    status: String,
    title: Option<String>,
    version: String,
    manifest_path: String,
    entry_path: String,
    manifest_etag: String,
    entry_etag: String,
    manifest_hash: String,
    entry_hash: String,
}

#[derive(Debug, Default)]
struct SkillPackageScan {
    records: Vec<SkillPackageRecord>,
    skipped: Vec<serde_json::Value>,
    protected_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SkillSyncLock {
    schema_version: u32,
    database_id: String,
    managed_skills: BTreeMap<String, SkillSyncLockEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SkillSyncLockEntry {
    entry_etag: String,
    manifest_etag: String,
    entry_hash: String,
    manifest_hash: String,
    files: BTreeMap<String, String>,
    synced_at: String,
}

pub(crate) async fn list_skill_packages(
    client: &impl VfsApi,
    database_id: &str,
    statuses: &[SkillStatusArg],
) -> Result<serde_json::Value> {
    let filter = skill_status_filter(statuses);
    let scan = scan_skill_packages(client, database_id, &filter).await?;
    Ok(json!({
        "database_id": database_id,
        "status": filter.iter().cloned().collect::<Vec<_>>(),
        "skills": scan.records.iter().map(skill_package_record_json).collect::<Vec<_>>(),
        "skipped": scan.skipped
    }))
}

pub(crate) async fn sync_skill_packages(
    client: &impl VfsApi,
    database_id: &str,
    target: &Path,
    statuses: &[SkillStatusArg],
    prune: bool,
    dry_run: bool,
) -> Result<serde_json::Value> {
    let filter = skill_status_filter(statuses);
    let scan = scan_skill_packages(client, database_id, &filter).await?;
    let selected_ids = scan
        .records
        .iter()
        .map(|record| record.id.clone())
        .collect::<BTreeSet<_>>();
    let existing_lock = read_skill_sync_lock(target, database_id)?;
    let lock_was_present = existing_lock.is_some();
    let locked = existing_lock
        .as_ref()
        .map(|lock| lock.managed_skills.clone())
        .unwrap_or_default();
    let mut next_locked = if prune {
        BTreeMap::new()
    } else {
        locked.clone()
    };
    for protected_id in &scan.protected_ids {
        if let Some(entry) = locked.get(protected_id) {
            next_locked.insert(protected_id.clone(), entry.clone());
        }
    }

    let mut added = Vec::new();
    let mut updated = Vec::new();
    let mut removed = Vec::new();
    let mut unchanged = Vec::new();
    let mut skipped = scan.skipped;
    let mut conflicts = Vec::new();
    let mut conflict_ids = BTreeSet::new();
    if !dry_run {
        fs::create_dir_all(target)
            .with_context(|| format!("failed to create {}", target.display()))?;
    }

    for record in scan.records {
        let target_dir = target.join(&record.id);
        let locked_entry = locked.get(&record.id);
        let item = sync_item_json(&record, &target_dir);
        if let Some(conflict) = sync_local_conflict(&record.id, &target_dir, locked_entry)? {
            conflict_ids.insert(record.id.clone());
            if let Some(entry) = locked_entry {
                next_locked.insert(record.id.clone(), entry.clone());
            }
            conflicts.push(conflict);
            continue;
        }
        let changed = locked_entry
            .map(|entry| {
                entry.entry_etag != record.entry_etag
                    || entry.manifest_etag != record.manifest_etag
                    || entry.entry_hash != record.entry_hash
                    || entry.manifest_hash != record.manifest_hash
                    || !target_dir.join("SKILL.md").is_file()
            })
            .unwrap_or(true);
        if !changed {
            unchanged.push(item);
            if let Some(entry) = locked_entry {
                next_locked.insert(record.id.clone(), entry.clone());
            }
            continue;
        }
        if dry_run {
            if locked_entry.is_some() {
                updated.push(item);
            } else {
                added.push(item);
            }
            continue;
        }
        match sync_one_skill_package(client, database_id, target, &record).await {
            Ok(files) => {
                next_locked.insert(
                    record.id.clone(),
                    SkillSyncLockEntry {
                        entry_etag: record.entry_etag.clone(),
                        manifest_etag: record.manifest_etag.clone(),
                        entry_hash: record.entry_hash.clone(),
                        manifest_hash: record.manifest_hash.clone(),
                        files,
                        synced_at: now_rfc3339(),
                    },
                );
                if locked_entry.is_some() {
                    updated.push(item);
                } else {
                    added.push(item);
                }
            }
            Err(error) => skipped.push(json!({
                "id": record.id,
                "path": target_dir.display().to_string(),
                "reason": "export_failed",
                "error": error.to_string()
            })),
        }
    }

    if prune {
        for id in locked.keys() {
            if selected_ids.contains(id)
                || scan.protected_ids.contains(id)
                || conflict_ids.contains(id)
            {
                continue;
            }
            let target_dir = target.join(id);
            let Some(locked_entry) = locked.get(id) else {
                continue;
            };
            if let Some(conflict) = sync_local_conflict(id, &target_dir, Some(locked_entry))? {
                next_locked.insert(id.clone(), locked_entry.clone());
                conflicts.push(conflict);
                continue;
            }
            let item = json!({
                "id": id,
                "path": target_dir.display().to_string(),
                "existed": target_dir.exists()
            });
            if !dry_run && target_dir.exists() {
                fs::remove_dir_all(&target_dir)
                    .with_context(|| format!("failed to remove {}", target_dir.display()))?;
            }
            next_locked.remove(id);
            removed.push(item);
        }
    }

    if !dry_run && (lock_was_present || !next_locked.is_empty()) {
        write_skill_sync_lock(target, database_id, next_locked)?;
    }

    Ok(json!({
        "target": target.display().to_string(),
        "dry_run": dry_run,
        "status": filter.iter().cloned().collect::<Vec<_>>(),
        "added": added,
        "updated": updated,
        "removed": removed,
        "unchanged": unchanged,
        "skipped": skipped,
        "conflicts": conflicts
    }))
}

async fn scan_skill_packages(
    client: &impl VfsApi,
    database_id: &str,
    filter: &BTreeSet<String>,
) -> Result<SkillPackageScan> {
    let mut scan = SkillPackageScan::default();
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: "/Skills".to_string(),
            recursive: true,
        })
        .await?
    {
        if entry.kind != NodeEntryKind::File {
            continue;
        }
        let Some(skill_id) = skill_id_from_manifest_path(&entry.path) else {
            continue;
        };
        let manifest_path = entry.path.clone();
        let Some(manifest_node) = client.read_node(database_id, &manifest_path).await? else {
            scan.protected_ids.insert(skill_id.clone());
            scan.skipped.push(json!({
                "id": skill_id,
                "path": manifest_path,
                "reason": "manifest_disappeared"
            }));
            continue;
        };
        let manifest = match parse_manifest(&manifest_node.content) {
            Ok(manifest) => manifest,
            Err(error) => {
                scan.protected_ids.insert(skill_id.clone());
                scan.skipped.push(json!({
                    "id": skill_id,
                    "path": manifest_path,
                    "reason": "invalid_manifest",
                    "error": error.to_string()
                }));
                continue;
            }
        };
        if manifest.id != skill_id {
            scan.protected_ids.insert(skill_id.clone());
            scan.skipped.push(json!({
                "id": skill_id,
                "path": manifest_path,
                "reason": "manifest_id_mismatch",
                "manifest_id": manifest.id
            }));
            continue;
        }
        let status = manifest
            .status
            .clone()
            .unwrap_or_else(|| "draft".to_string());
        if !filter.contains(&status) {
            continue;
        }
        let base_path = skill_base_path(&SkillId::parse(&skill_id)?);
        let entry_path = format!("{base_path}/SKILL.md");
        let Some(entry_node) = client.read_node(database_id, &entry_path).await? else {
            scan.protected_ids.insert(skill_id.clone());
            scan.skipped.push(json!({
                "id": skill_id,
                "path": entry_path,
                "reason": "missing_skill"
            }));
            continue;
        };
        scan.records.push(SkillPackageRecord {
            id: skill_id,
            status,
            title: manifest.title,
            version: manifest.version,
            manifest_path,
            entry_path,
            manifest_etag: manifest_node.etag,
            entry_etag: entry_node.etag,
            manifest_hash: sha256_hex(&manifest_node.content),
            entry_hash: sha256_hex(&entry_node.content),
        });
    }
    scan.records.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(scan)
}

fn skill_status_filter(statuses: &[SkillStatusArg]) -> BTreeSet<String> {
    let selected = if statuses.is_empty() {
        vec![SkillStatusArg::Reviewed, SkillStatusArg::Promoted]
    } else {
        statuses.to_vec()
    };
    selected
        .into_iter()
        .map(|status| status.as_str().to_string())
        .collect()
}

fn skill_package_record_json(record: &SkillPackageRecord) -> serde_json::Value {
    json!({
        "id": record.id,
        "status": record.status,
        "title": record.title,
        "version": record.version,
        "manifest_path": record.manifest_path,
        "entry_path": record.entry_path,
        "manifest_etag": record.manifest_etag,
        "entry_etag": record.entry_etag
    })
}

fn sync_item_json(record: &SkillPackageRecord, target_dir: &Path) -> serde_json::Value {
    json!({
        "id": record.id,
        "status": record.status,
        "version": record.version,
        "path": target_dir.display().to_string(),
        "manifest_etag": record.manifest_etag,
        "entry_etag": record.entry_etag
    })
}

fn sync_local_conflict(
    id: &str,
    target_dir: &Path,
    locked_entry: Option<&SkillSyncLockEntry>,
) -> Result<Option<serde_json::Value>> {
    let Some(locked_entry) = locked_entry else {
        if target_dir.exists() {
            return Ok(Some(json!({
                "id": id,
                "path": target_dir.display().to_string(),
                "reason": "unmanaged_existing_dir"
            })));
        }
        return Ok(None);
    };
    if !target_dir.is_dir() {
        return Ok(Some(json!({
            "id": id,
            "path": target_dir.display().to_string(),
            "reason": "managed_file_missing",
            "file": "SKILL.md"
        })));
    }
    for (file, expected_hash) in &locked_entry.files {
        let local_file = target_dir.join(file);
        if !local_file.is_file() {
            return Ok(Some(json!({
                "id": id,
                "path": target_dir.display().to_string(),
                "reason": "managed_file_missing",
                "file": file
            })));
        }
        let content = fs::read_to_string(&local_file)
            .with_context(|| format!("failed to read {}", local_file.display()))?;
        let local_hash = sha256_hex(&content);
        if &local_hash != expected_hash {
            return Ok(Some(json!({
                "id": id,
                "path": target_dir.display().to_string(),
                "reason": "managed_local_dirty",
                "file": file,
                "expected_hash": expected_hash,
                "actual_hash": local_hash
            })));
        }
    }
    let expected_files = locked_entry.files.keys().cloned().collect::<BTreeSet<_>>();
    let local_files = collect_sync_local_files(target_dir)?;
    if let Some(extra_file) = local_files
        .iter()
        .find(|local_file| !expected_files.contains(*local_file))
    {
        return Ok(Some(json!({
            "id": id,
            "path": target_dir.display().to_string(),
            "reason": "managed_extra_file",
            "file": extra_file
        })));
    }
    Ok(None)
}

fn collect_sync_local_files(root: &Path) -> Result<BTreeSet<String>> {
    let mut files = BTreeSet::new();
    collect_sync_local_files_inner(root, root, &mut files)?;
    Ok(files)
}

fn collect_sync_local_files_inner(
    root: &Path,
    current: &Path,
    files: &mut BTreeSet<String>,
) -> Result<()> {
    for entry in
        fs::read_dir(current).with_context(|| format!("failed to read {}", current.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_sync_local_files_inner(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .with_context(|| format!("invalid local sync path {}", path.display()))?;
            files.insert(path_to_sync_relative(relative)?);
        }
    }
    Ok(())
}

fn path_to_sync_relative(path: &Path) -> Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => {
                let part = part
                    .to_str()
                    .ok_or_else(|| anyhow!("sync path must be valid UTF-8"))?;
                parts.push(part.to_string());
            }
            _ => return Err(anyhow!("sync path must stay inside the skill directory")),
        }
    }
    Ok(parts.join("/"))
}

fn skill_id_from_manifest_path(path: &str) -> Option<String> {
    let relative = path.strip_prefix("/Skills/")?;
    let id = relative.strip_suffix("/manifest.md")?;
    if id.contains('/') || SkillId::parse(id).is_err() {
        return None;
    }
    Some(id.to_string())
}

fn skill_sync_lock_path(target: &Path) -> PathBuf {
    target.join(".kinic-skill-sync.json")
}

fn read_skill_sync_lock(target: &Path, database_id: &str) -> Result<Option<SkillSyncLock>> {
    let path = skill_sync_lock_path(target);
    if !path.is_file() {
        return Ok(None);
    }
    let lock: SkillSyncLock = serde_json::from_str(
        &fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?,
    )
    .with_context(|| format!("invalid sync lock JSON: {}", path.display()))?;
    if lock.schema_version != 1 {
        return Err(anyhow!(
            "unsupported sync lock schema_version {}: {}",
            lock.schema_version,
            path.display()
        ));
    }
    if lock.database_id != database_id {
        return Err(anyhow!(
            "sync lock belongs to database {}, not {}",
            lock.database_id,
            database_id
        ));
    }
    Ok(Some(lock))
}

fn write_skill_sync_lock(
    target: &Path,
    database_id: &str,
    managed_skills: BTreeMap<String, SkillSyncLockEntry>,
) -> Result<()> {
    let path = skill_sync_lock_path(target);
    let lock = SkillSyncLock {
        schema_version: 1,
        database_id: database_id.to_string(),
        managed_skills,
        last_synced_at: Some(now_rfc3339()),
    };
    fs::write(&path, serde_json::to_string_pretty(&lock)?)
        .with_context(|| format!("failed to write {}", path.display()))
}

async fn sync_one_skill_package(
    client: &impl VfsApi,
    database_id: &str,
    target: &Path,
    record: &SkillPackageRecord,
) -> Result<BTreeMap<String, String>> {
    let target_dir = target.join(&record.id);
    let temp = unique_sync_work_dir(target, "tmp")?;
    let result = match export_skill(client, database_id, &record.id, &temp).await {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&temp);
            return Err(error);
        }
    };
    let files = sync_export_file_hashes(&temp, &result)?;
    replace_sync_dir(&temp, &target_dir)?;
    Ok(files)
}

fn sync_export_file_hashes(
    export_dir: &Path,
    export_result: &serde_json::Value,
) -> Result<BTreeMap<String, String>> {
    let mut files = BTreeMap::new();
    let Some(items) = export_result["files"].as_array() else {
        return Ok(files);
    };
    for item in items {
        let Some(relative_path) = item.as_str() else {
            continue;
        };
        let path = export_dir.join(relative_path);
        let content = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        files.insert(relative_path.to_string(), sha256_hex(&content));
    }
    Ok(files)
}

fn replace_sync_dir(source: &Path, target: &Path) -> Result<()> {
    if !target.exists() {
        fs::rename(source, target).with_context(|| {
            format!(
                "failed to move {} to {}",
                source.display(),
                target.display()
            )
        })?;
        return Ok(());
    }
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("invalid sync target: {}", target.display()))?;
    let backup = unique_sync_work_dir(parent, "old")?;
    fs::remove_dir(&backup)
        .with_context(|| format!("failed to reserve backup path {}", backup.display()))?;
    fs::rename(target, &backup).with_context(|| {
        format!(
            "failed to move {} to {}",
            target.display(),
            backup.display()
        )
    })?;
    if let Err(error) = fs::rename(source, target).with_context(|| {
        format!(
            "failed to move {} to {}",
            source.display(),
            target.display()
        )
    }) {
        let _ = fs::rename(&backup, target);
        return Err(error);
    }
    fs::remove_dir_all(&backup)
        .with_context(|| format!("failed to remove old sync dir {}", backup.display()))?;
    Ok(())
}

fn unique_sync_work_dir(parent: &Path, label: &str) -> Result<PathBuf> {
    for attempt in 0..100 {
        let path = parent.join(format!(
            ".kinic-skill-sync-{label}-{}-{}-{attempt}",
            std::process::id(),
            now_millis()
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("failed to create {}", path.display()));
            }
        }
    }
    Err(anyhow!(
        "failed to create unique sync work dir under {}",
        parent.display()
    ))
}

pub(crate) async fn record_correction(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    run_id: &str,
    notes_file: &Path,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    if !valid_id_segment(run_id) {
        return Err(anyhow!("run id must use a single path-safe name"));
    }
    let run_path = format!("{RUN_ROOT}/{skill_id}/{run_id}.md");
    client
        .read_node(database_id, &run_path)
        .await?
        .ok_or_else(|| anyhow!("run not found: {run_path}"))?;
    let notes = std::fs::read_to_string(notes_file)
        .with_context(|| format!("failed to read {}", notes_file.display()))?;
    let timestamp = now_millis();
    let recorded_at = now_rfc3339();
    let correction_path = format!("{RUN_ROOT}/{skill_id}/{run_id}.correction.{timestamp}.md");
    let content = format!(
        "---\nkind: kinic.skill_run_correction\nschema_version: 1\nskill_id: {skill_id}\nrun_id: {run_id}\nrecorded_at: {recorded_at}\n---\n# Skill Run Correction\n\n{notes}\n"
    );
    ensure_parent_folders(client, database_id, &correction_path).await?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: correction_path.clone(),
            kind: NodeKind::Source,
            content,
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    Ok(json!({ "id": skill_id.to_string(), "run_id": run_id, "correction_path": correction_path }))
}

pub(crate) async fn export_skill(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    out: &Path,
) -> Result<serde_json::Value> {
    const EXPORT_LIST_LIMIT: u32 = 100;
    let skill_id = SkillId::parse(id)?;
    let base_path = skill_base_path(&skill_id);
    let mut exported = Vec::new();
    std::fs::create_dir_all(out).with_context(|| format!("failed to create {}", out.display()))?;
    let entries = client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: base_path.clone(),
            recursive: true,
            limit: EXPORT_LIST_LIMIT,
        })
        .await?;
    if entries.len() >= EXPORT_LIST_LIMIT as usize {
        return Err(anyhow!(
            "export may be truncated; list_nodes pagination is required before exporting skill: {id}"
        ));
    }
    for entry in entries {
        if entry.kind != NodeEntryKind::File {
            continue;
        }
        let Some(relative_path) = entry.path.strip_prefix(&format!("{base_path}/")) else {
            continue;
        };
        if !is_runtime_export_file(relative_path) {
            continue;
        }
        let node = client
            .read_node(database_id, &entry.path)
            .await?
            .ok_or_else(|| anyhow!("listed node disappeared: {}", entry.path))?;
        let target = out.join(relative_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        std::fs::write(&target, node.content)
            .with_context(|| format!("failed to write {}", target.display()))?;
        exported.push(relative_path.to_string());
    }
    if !exported.iter().any(|path| path == "SKILL.md") {
        return Err(anyhow!("SKILL.md not found for skill: {id}"));
    }
    exported.sort();
    Ok(json!({ "id": skill_id.to_string(), "out": out.display().to_string(), "files": exported }))
}

async fn snapshot_current_skill_version(
    client: &impl VfsApi,
    database_id: &str,
    base_path: &str,
    current: &vfs_types::Node,
    manifest: Option<&vfs_types::Node>,
) -> Result<String> {
    let version_id = format!("{}-{}", now_millis(), &sha256_hex(&current.content)[..12]);
    let version_base = format!("{base_path}/versions/{version_id}");
    let mut nodes = vec![WriteNodeItem {
        path: format!("{version_base}/SKILL.md"),
        kind: NodeKind::File,
        content: current.content.clone(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    }];
    if let Some(manifest) = manifest {
        nodes.push(WriteNodeItem {
            path: format!("{version_base}/manifest.md"),
            kind: NodeKind::File,
            content: manifest.content.clone(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        });
    }
    let paths = nodes
        .iter()
        .map(|node| node.path.clone())
        .collect::<Vec<_>>();
    ensure_parent_folders_for_paths(client, database_id, &paths).await?;
    client
        .write_nodes(WriteNodesRequest {
            database_id: database_id.to_string(),
            nodes,
        })
        .await?;
    Ok(version_id)
}

async fn snapshot_existing_skill_version(
    client: &impl VfsApi,
    database_id: &str,
    base_path: &str,
) -> Result<Option<String>> {
    let current_path = format!("{base_path}/SKILL.md");
    let manifest_path = format!("{base_path}/manifest.md");
    let Some(current) = client.read_node(database_id, &current_path).await? else {
        return Ok(None);
    };
    let manifest = client.read_node(database_id, &manifest_path).await?;
    snapshot_current_skill_version(client, database_id, base_path, &current, manifest.as_ref())
        .await
        .map(Some)
}

pub(crate) async fn rollback_skill_version(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    version_id: &str,
    projection_dir: Option<&Path>,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    if !valid_version_id(version_id) {
        return Err(anyhow!(
            "version id must be a path-safe version directory name"
        ));
    }
    let base_path = skill_base_path(&skill_id);
    let current_path = format!("{base_path}/SKILL.md");
    let manifest_path = format!("{base_path}/manifest.md");
    let version_base = format!("{base_path}/versions/{version_id}");
    let version_skill_path = format!("{version_base}/SKILL.md");
    let version_manifest_path = format!("{version_base}/manifest.md");
    let current = client
        .read_node(database_id, &current_path)
        .await?
        .ok_or_else(|| anyhow!("current SKILL.md not found: {current_path}"))?;
    let current_manifest = client.read_node(database_id, &manifest_path).await?;
    let version_skill = client
        .read_node(database_id, &version_skill_path)
        .await?
        .ok_or_else(|| anyhow!("version SKILL.md not found: {version_skill_path}"))?;
    let version_manifest = client
        .read_node(database_id, &version_manifest_path)
        .await?;
    let rollback_snapshot_id = snapshot_current_skill_version(
        client,
        database_id,
        &base_path,
        &current,
        current_manifest.as_ref(),
    )
    .await?;
    let mut nodes = vec![WriteNodeItem {
        path: current_path.clone(),
        kind: NodeKind::File,
        content: version_skill.content.clone(),
        metadata_json: current.metadata_json.clone(),
        expected_etag: Some(current.etag.clone()),
    }];
    if let (Some(current_manifest), Some(version_manifest)) =
        (current_manifest.as_ref(), version_manifest.as_ref())
    {
        nodes.push(WriteNodeItem {
            path: manifest_path.clone(),
            kind: NodeKind::File,
            content: version_manifest.content.clone(),
            metadata_json: current_manifest.metadata_json.clone(),
            expected_etag: Some(current_manifest.etag.clone()),
        });
    }
    client
        .write_nodes(WriteNodesRequest {
            database_id: database_id.to_string(),
            nodes,
        })
        .await?;
    let sync_error = sync_projection_skill(&skill_id, &version_skill.content, projection_dir);
    Ok(json!({
        "id": skill_id.to_string(),
        "status": if sync_error.is_some() { "rolled_back_sync_failed" } else { "rolled_back" },
        "version_id": version_id,
        "rollback_snapshot_id": rollback_snapshot_id,
        "current_path": current_path,
        "sync_error": sync_error
    }))
}

pub(crate) async fn skill_history(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let base_path = skill_base_path(&skill_id);
    let versions_prefix = format!("{base_path}/versions");
    let mut version_groups: BTreeMap<String, (String, i64, Vec<String>, bool)> = BTreeMap::new();
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: versions_prefix.clone(),
            recursive: true,
            limit: 100,
        })
        .await?
    {
        if entry.kind == NodeEntryKind::Folder {
            continue;
        }
        let Some(relative_path) = entry.path.strip_prefix(&format!("{versions_prefix}/")) else {
            continue;
        };
        let Some((version_id, version_file)) = relative_path.split_once('/') else {
            continue;
        };
        if !valid_version_id(version_id) {
            continue;
        }
        let has_skill_file = version_file == "SKILL.md";
        let version_path = format!("{versions_prefix}/{version_id}");
        let group = version_groups.entry(version_id.to_string()).or_insert((
            version_path,
            entry.updated_at,
            Vec::new(),
            false,
        ));
        group.1 = group.1.max(entry.updated_at);
        group.2.push(entry.path);
        if has_skill_file {
            group.3 = true;
        }
    }
    let mut versions: Vec<_> = version_groups
        .into_iter()
        .filter_map(
            |(version_id, (version_path, updated_at, mut files, has_skill))| {
                if !has_skill {
                    return None;
                }
                files.sort();
                Some(json!({
                    "id": version_id,
                    "path": version_path,
                    "updated_at": updated_at,
                    "files": files
                }))
            },
        )
        .collect();
    sort_history_items(&mut versions);

    let runs_prefix = format!("{RUN_ROOT}/{skill_id}");
    let mut runs = Vec::new();
    let mut corrections = Vec::new();
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: runs_prefix,
            recursive: true,
            limit: 100,
        })
        .await?
    {
        if entry.kind == NodeEntryKind::Folder {
            continue;
        }
        let item = json!({
            "path": entry.path,
            "updated_at": entry.updated_at,
            "etag": entry.etag
        });
        if item["path"]
            .as_str()
            .is_some_and(|path| path.contains(".correction."))
        {
            corrections.push(item);
        } else {
            runs.push(item);
        }
    }
    sort_history_items(&mut runs);
    sort_history_items(&mut corrections);

    Ok(json!({
        "id": skill_id.to_string(),
        "versions": versions,
        "runs": runs,
        "corrections": corrections
    }))
}

fn sort_history_items(items: &mut [serde_json::Value]) {
    items.sort_by(|left, right| {
        right["updated_at"]
            .as_i64()
            .cmp(&left["updated_at"].as_i64())
            .then_with(|| left["path"].as_str().cmp(&right["path"].as_str()))
    });
}

pub(crate) async fn export_skill_github(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    target: &str,
    branch: &str,
    message: &str,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let (repo, target_prefix) = parse_github_export_target(target)?;
    let files = github_export_files(client, database_id, &skill_id).await?;
    if files.is_empty() {
        return Err(anyhow!("no exportable files found for skill: {id}"));
    }
    let mut exported = Vec::new();
    for (relative_path, content) in files {
        let target_path = join_github_path(&target_prefix, &relative_path);
        let sha = github_existing_file_sha(&repo, &target_path, branch)?;
        let response = github_put_file(
            &repo,
            &target_path,
            branch,
            message,
            &content,
            sha.as_deref(),
        )?;
        let commit_sha = response
            .get("commit")
            .and_then(|value| value.get("sha"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        exported
            .push(json!({ "path": target_path, "source": relative_path, "commit": commit_sha }));
    }
    Ok(json!({ "id": skill_id.to_string(), "repo": repo, "branch": branch, "files": exported }))
}

fn process_error(runner: &Path, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    truncate_error(&format!(
        "{} exited with status {}; stderr: {}; stdout: {}",
        runner.display(),
        output.status,
        stderr.trim(),
        stdout.trim()
    ))
}

fn truncate_error(error: &str) -> String {
    let mut value = error.replace('\n', " ");
    if value.len() > 800 {
        value.truncate(800);
    }
    value
}

async fn ensure_parent_folders(client: &impl VfsApi, database_id: &str, path: &str) -> Result<()> {
    ensure_parent_folders_for_paths(client, database_id, &[path.to_string()]).await
}

async fn ensure_parent_folders_for_paths(
    client: &impl VfsApi,
    database_id: &str,
    paths: &[String],
) -> Result<()> {
    let mut folders = BTreeSet::new();
    for path in paths {
        collect_parent_folders(path, &mut folders);
    }
    for folder in folders {
        client
            .mkdir_node(MkdirNodeRequest {
                database_id: database_id.to_string(),
                path: folder,
            })
            .await?;
    }
    Ok(())
}

fn validate_skill_package_file_count(count: usize) -> Result<()> {
    if count == 0 || count > SKILL_PACKAGE_FILE_LIMIT_MAX {
        return Err(anyhow!(
            "skill package file count must be between 1 and {SKILL_PACKAGE_FILE_LIMIT_MAX}"
        ));
    }
    Ok(())
}

fn collect_parent_folders(path: &str, folders: &mut BTreeSet<String>) {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut current = String::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        current.push('/');
        current.push_str(segment);
        folders.insert(current.clone());
    }
}

async fn prune_package_files(
    client: &impl VfsApi,
    database_id: &str,
    base_path: &str,
    keep_files: &BTreeSet<String>,
) -> Result<Vec<String>> {
    let mut pruned_paths = Vec::new();
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: base_path.to_string(),
            recursive: true,
            limit: 100,
        })
        .await?
    {
        if entry.kind != NodeEntryKind::File {
            continue;
        }
        let Some(relative_path) = entry.path.strip_prefix(&format!("{base_path}/")) else {
            continue;
        };
        if relative_path.starts_with("versions/") || relative_path.starts_with("proposals/") {
            continue;
        }
        if keep_files.contains(relative_path) {
            continue;
        }
        client
            .delete_node(DeleteNodeRequest {
                database_id: database_id.to_string(),
                path: entry.path.clone(),
                expected_etag: Some(entry.etag),
                expected_folder_index_etag: None,
            })
            .await?;
        pruned_paths.push(entry.path);
    }
    Ok(pruned_paths)
}

fn discover_skill_package_files(
    source_dir: &Path,
    skill: &str,
    id: &SkillId,
    source_frontmatter: &model::SkillSourceFrontmatter,
) -> Result<BTreeMap<String, String>> {
    let mut files = BTreeMap::new();
    files.insert("SKILL.md".to_string(), skill.to_string());
    let manifest = match read_optional(source_dir, "manifest.md") {
        Some(content) => normalize_manifest(&content, id, source_frontmatter)?,
        None => manifest_for_source(id, source_frontmatter)?,
    };
    files.insert("manifest.md".to_string(), manifest);
    for name in ["provenance.md", "evals.md"] {
        if let Some(content) = read_optional(source_dir, name) {
            files.insert(name.to_string(), content);
        }
    }
    for relative_path in referenced_markdown_files(source_dir, skill)? {
        if files.contains_key(&relative_path) {
            continue;
        }
        if let Some(content) = read_optional(source_dir, &relative_path) {
            files.insert(relative_path, content);
        }
    }
    Ok(files)
}

fn referenced_markdown_files(source_dir: &Path, skill: &str) -> Result<Vec<String>> {
    let canonical_source_dir = source_dir
        .canonicalize()
        .with_context(|| format!("failed to read {}", source_dir.display()))?;
    let mut files = Vec::new();
    for target in markdown_link_targets(skill) {
        if let Some(relative_path) = package_relative_markdown_path(&canonical_source_dir, &target)?
        {
            files.push(relative_path);
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn markdown_link_targets(content: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let bytes = content.as_bytes();
    let mut index = 0;
    while let Some(start) = content[index..].find("](").map(|found| index + found + 2) {
        let mut cursor = start;
        if bytes.get(cursor) == Some(&b'<')
            && let Some(close) = content[cursor + 1..]
                .find('>')
                .map(|found| cursor + 1 + found)
            && bytes.get(close + 1) == Some(&b')')
        {
            targets.push(content[cursor..=close].to_string());
            index = close + 2;
            continue;
        }
        let mut depth = 0_usize;
        while cursor < content.len() {
            match bytes[cursor] {
                b'(' => depth += 1,
                b')' if depth == 0 => break,
                b')' => depth -= 1,
                _ => {}
            }
            cursor += 1;
        }
        if cursor < content.len() {
            targets.push(content[start..cursor].to_string());
        }
        index = cursor.saturating_add(1);
    }
    targets
}

fn package_relative_markdown_path(
    canonical_source_dir: &Path,
    raw_target: &str,
) -> Result<Option<String>> {
    let Some(target) = clean_markdown_link_target(raw_target) else {
        return Ok(None);
    };
    let path = PathBuf::from(target);
    if path.is_absolute() {
        return Ok(None);
    }
    let candidate = canonical_source_dir.join(path);
    if !candidate.is_file() {
        return Ok(None);
    }
    let canonical_candidate = candidate
        .canonicalize()
        .with_context(|| format!("failed to read {}", candidate.display()))?;
    let Ok(relative_path) = canonical_candidate.strip_prefix(canonical_source_dir) else {
        return Ok(None);
    };
    Ok(path_to_package_key(relative_path))
}

pub(crate) fn markdown_target_package_key(raw_target: &str) -> Option<String> {
    let target = clean_markdown_link_target(raw_target)?;
    path_to_package_key(Path::new(&target))
}

fn clean_markdown_link_target(raw_target: &str) -> Option<String> {
    let target = markdown_destination_without_title(raw_target.trim());
    let target = target
        .strip_prefix('<')
        .and_then(|inner| inner.strip_suffix('>'))
        .unwrap_or(target);
    let target = target.split(['#', '?']).next()?.trim();
    if target.is_empty()
        || target.starts_with('#')
        || target.starts_with('/')
        || target.contains("://")
        || !target.ends_with(".md")
    {
        return None;
    }
    Some(target.to_string())
}

fn markdown_destination_without_title(target: &str) -> &str {
    let target = target.trim();
    if let Some(inner) = target.strip_prefix('<')
        && let Some(close) = inner.find('>')
    {
        let destination = &inner[..close];
        let suffix = inner[close + 1..].trim();
        if suffix.is_empty() || is_markdown_title_suffix(suffix) {
            return destination;
        }
    }
    strip_quoted_markdown_title(target, b'"')
        .or_else(|| strip_quoted_markdown_title(target, b'\''))
        .or_else(|| strip_parenthesized_markdown_title(target))
        .unwrap_or(target)
}

fn strip_quoted_markdown_title(target: &str, quote: u8) -> Option<&str> {
    let bytes = target.as_bytes();
    if bytes.last().copied() != Some(quote) {
        return None;
    }
    for index in (0..bytes.len().saturating_sub(1)).rev() {
        if bytes[index] == quote && index > 0 && bytes[index - 1].is_ascii_whitespace() {
            let destination = target[..index - 1].trim_end();
            if is_markdown_destination_candidate(destination) {
                return Some(destination);
            }
        }
    }
    None
}

fn strip_parenthesized_markdown_title(target: &str) -> Option<&str> {
    if !target.ends_with(')') {
        return None;
    }
    let title_start = target.rfind(" (")?;
    let destination = target[..title_start].trim_end();
    if is_markdown_destination_candidate(destination) {
        return Some(destination);
    }
    None
}

fn is_markdown_title_suffix(value: &str) -> bool {
    (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
        || (value.starts_with('(') && value.ends_with(')'))
}

fn is_markdown_destination_candidate(value: &str) -> bool {
    let target = value
        .strip_prefix('<')
        .and_then(|inner| inner.strip_suffix('>'))
        .unwrap_or(value)
        .split(['#', '?'])
        .next()
        .unwrap_or("")
        .trim();
    !target.is_empty()
        && !target.starts_with('#')
        && !target.starts_with('/')
        && !target.contains("://")
        && target.ends_with(".md")
}

fn path_to_package_key(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn read_optional(source_dir: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(source_dir.join(name)).ok()
}

fn validate_outcome(value: Option<&str>, field: &str) -> Result<()> {
    match value {
        None | Some("") | Some("success" | "partial" | "fail" | "unknown") => Ok(()),
        Some(value) => Err(anyhow!(
            "{field} must be success, partial, fail, or unknown when present; got {value}"
        )),
    }
}

fn resolve_run_id(run_id_override: Option<&str>, evidence_run_id: Option<&str>) -> Result<String> {
    if let Some(value) = run_id_override
        && !valid_id_segment(value)
    {
        return Err(anyhow!("run_id must use a single path-safe name"));
    }
    if let Some(value) = evidence_run_id
        && !valid_id_segment(value)
    {
        return Err(anyhow!("run_id must use a single path-safe name"));
    }
    Ok(run_id_override
        .or(evidence_run_id)
        .map(str::to_string)
        .unwrap_or_else(|| now_millis().to_string()))
}

fn valid_id_segment(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(ch) if ch.is_ascii_alphanumeric())
        && value.len() <= 128
        && !value.contains("..")
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn markdown_code_block(info: &str, content: &str) -> String {
    let fence = markdown_fence_delimiter(content);
    format!("{fence}{info}\n{content}\n{fence}")
}

fn markdown_fence_delimiter(content: &str) -> String {
    let mut fence = "```".to_string();
    while content.contains(&fence) {
        fence.push('`');
    }
    fence
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

fn is_runtime_export_file(relative_path: &str) -> bool {
    if matches!(relative_path, "manifest.md" | "provenance.md" | "evals.md") {
        return false;
    }
    !relative_path.starts_with("proposals/") && !relative_path.starts_with("versions/")
}

fn is_github_export_file(relative_path: &str) -> bool {
    !relative_path.starts_with("proposals/") && !relative_path.starts_with("versions/")
}

async fn github_export_files(
    client: &impl VfsApi,
    database_id: &str,
    skill_id: &SkillId,
) -> Result<BTreeMap<String, String>> {
    let base_path = skill_base_path(skill_id);
    let mut files = BTreeMap::new();
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: base_path.clone(),
            recursive: true,
            limit: 100,
        })
        .await?
    {
        if entry.kind != NodeEntryKind::File {
            continue;
        }
        let Some(relative_path) = entry.path.strip_prefix(&format!("{base_path}/")) else {
            continue;
        };
        if !is_github_export_file(relative_path) {
            continue;
        }
        let Some(node) = client.read_node(database_id, &entry.path).await? else {
            continue;
        };
        files.insert(relative_path.to_string(), node.content);
    }
    Ok(files)
}

fn sync_projection_skill(
    skill_id: &SkillId,
    content: &str,
    projection_dir: Option<&Path>,
) -> Option<String> {
    let projection_dir = projection_dir?;
    let target = projection_dir.join(skill_id.to_string()).join("SKILL.md");
    if let Some(parent) = target.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        return Some(error.to_string());
    }
    std::fs::write(&target, content)
        .err()
        .map(|error| error.to_string())
}

fn valid_version_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn parse_github_export_target(target: &str) -> Result<(String, String)> {
    let (repo, path) = target
        .split_once(':')
        .ok_or_else(|| anyhow!("target must be owner/repo:path"))?;
    let mut repo_parts = repo.split('/');
    let owner = repo_parts.next().unwrap_or("");
    let name = repo_parts.next().unwrap_or("");
    if owner.is_empty() || name.is_empty() || repo_parts.next().is_some() {
        return Err(anyhow!("target repo must be owner/repo"));
    }
    Ok((repo.to_string(), path.trim_matches('/').to_string()))
}

fn join_github_path(prefix: &str, relative: &str) -> String {
    if prefix.is_empty() {
        relative.to_string()
    } else {
        format!("{}/{}", prefix.trim_matches('/'), relative)
    }
}

fn github_existing_file_sha(repo: &str, path: &str, branch: &str) -> Result<Option<String>> {
    let output = Command::new("gh")
        .args([
            "api",
            &format!("repos/{repo}/contents/{path}"),
            "-f",
            &format!("ref={branch}"),
        ])
        .output()
        .with_context(|| "failed to execute gh")?;
    if !output.status.success() {
        return Ok(None);
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .with_context(|| "gh contents response was not JSON")?;
    Ok(value
        .get("sha")
        .and_then(|value| value.as_str())
        .map(str::to_string))
}

fn github_put_file(
    repo: &str,
    path: &str,
    branch: &str,
    message: &str,
    content: &str,
    sha: Option<&str>,
) -> Result<serde_json::Value> {
    let mut body = json!({
        "message": message,
        "branch": branch,
        "content": base64_encode(content.as_bytes()),
    });
    if let Some(sha) = sha {
        body["sha"] = serde_json::Value::String(sha.to_string());
    }
    let mut child = Command::new("gh")
        .args([
            "api",
            &format!("repos/{repo}/contents/{path}"),
            "-X",
            "PUT",
            "--input",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| "failed to execute gh")?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| anyhow!("failed to open gh stdin"))?
        .write_all(serde_json::to_string(&body)?.as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(anyhow!("{}", process_error(Path::new("gh"), &output)));
    }
    serde_json::from_slice(&output.stdout).with_context(|| "gh put response was not JSON")
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn sha256_hex(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl SkillStatusArg {
    fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Reviewed => "reviewed",
            Self::Promoted => "promoted",
            Self::Deprecated => "deprecated",
        }
    }
}

impl From<SkillRunOutcomeArg> for vfs_cli::skill_kb::SkillRunOutcome {
    fn from(value: SkillRunOutcomeArg) -> Self {
        match value {
            SkillRunOutcomeArg::Success => Self::Success,
            SkillRunOutcomeArg::Partial => Self::Partial,
            SkillRunOutcomeArg::Fail => Self::Fail,
        }
    }
}

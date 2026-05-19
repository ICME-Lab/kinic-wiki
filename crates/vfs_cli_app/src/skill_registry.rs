use crate::cli::{
    SkillCommand, SkillEvolveJobsCommand, SkillImportCommand, SkillRunOutcomeArg, SkillStatusArg,
};
use crate::github_source::{
    fetch_github_optional_package_file, fetch_github_skill_package, github_source_string,
    github_source_url, parse_github_skill_source,
};
mod model;
use anyhow::{Context, Result, anyhow};
use model::{
    PRIVATE_ROOT, PUBLIC_ROOT, RUN_ROOT, SkillId, catalog, extract_frontmatter,
    manifest_for_source, normalize_manifest, now_millis, now_rfc3339,
    parse_skill_source_frontmatter, print, run_base_path, set_manifest_provenance_field,
    set_manifest_status_preserving_content, set_root_frontmatter_field_preserving_content,
    skill_base_path,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
pub(crate) use vfs_cli::skill_kb::{find_skills, inspect_skill};
use vfs_client::VfsApi;
use vfs_types::{
    DeleteNodeRequest, ListNodesRequest, MkdirNodeRequest, NodeEntryKind, NodeKind,
    RecentNodesRequest, WriteNodeItem, WriteNodeRequest, WriteNodesRequest,
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
            public,
            prune,
            json,
        } => print(
            upsert_skill(client, database_id, &source_dir, &id, public, prune).await?,
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
        SkillCommand::Inspect { id, public, json } => {
            print(inspect_skill(client, database_id, &id, public).await?, json)?
        }
        SkillCommand::RecordRun {
            id,
            evidence_json,
            task,
            outcome,
            notes_file,
            agent,
            public,
            json,
        } => {
            let result = if let Some(evidence_json) = evidence_json {
                record_skill_run_evidence(
                    client,
                    SkillRunEvidenceInput {
                        database_id,
                        id: &id,
                        evidence_json: &evidence_json,
                        public,
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
                        public,
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
            public,
            json,
        } => print(
            set_skill_status(client, database_id, &id, status, reason.as_deref(), public).await?,
            json,
        )?,
        SkillCommand::Import { source } => match source {
            SkillImportCommand::Github {
                source,
                id,
                reference,
                public,
                prune,
                json,
            } => print(
                import_github_skill(client, database_id, &source, &id, &reference, public, prune)
                    .await?,
                json,
            )?,
        },
        SkillCommand::ProposeImprovement {
            id,
            runs,
            summary,
            diff_file,
            public,
            json,
        } => print(
            propose_improvement(
                client,
                database_id,
                &id,
                &runs,
                &summary,
                &diff_file,
                public,
            )
            .await?,
            json,
        )?,
        SkillCommand::ApproveProposal {
            id,
            proposal_path,
            json,
        } => print(
            approve_proposal(client, database_id, &id, &proposal_path).await?,
            json,
        )?,
        SkillCommand::RecordCorrection {
            id,
            run_id,
            notes_file,
            json,
        } => print(
            record_correction(client, database_id, &id, &run_id, &notes_file).await?,
            json,
        )?,
        SkillCommand::ApplyProposal {
            id,
            proposal_id,
            projection_dir,
            public,
            json,
        } => print(
            apply_evolution_proposal(
                client,
                database_id,
                &id,
                &proposal_id,
                projection_dir.as_deref(),
                public,
            )
            .await?,
            json,
        )?,
        SkillCommand::Export {
            id,
            out,
            public,
            json,
        } => print(
            export_skill(client, database_id, &id, &out, public).await?,
            json,
        )?,
        SkillCommand::EvolveJobs { command } => match command {
            SkillEvolveJobsCommand::CreateReady {
                min_new_runs,
                cooldown_hours,
                json,
            } => print(
                create_ready_evolution_jobs(client, database_id, min_new_runs, cooldown_hours)
                    .await?,
                json,
            )?,
        },
        SkillCommand::Install {
            id,
            lockfile,
            public,
            json,
        } => print(
            install_skill_lockfile(client, database_id, &id, &lockfile, public).await?,
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
    public: bool,
    prune: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let skill = std::fs::read_to_string(source_dir.join("SKILL.md"))
        .with_context(|| format!("missing SKILL.md in {}", source_dir.display()))?;
    let source_frontmatter = parse_skill_source_frontmatter(&skill)?;
    let files = discover_skill_package_files(source_dir, &skill, &skill_id, &source_frontmatter)?;
    write_skill_package(client, database_id, &skill_id, public, prune, files).await
}

async fn write_skill_package(
    client: &impl VfsApi,
    database_id: &str,
    skill_id: &SkillId,
    public: bool,
    prune: bool,
    files: BTreeMap<String, String>,
) -> Result<serde_json::Value> {
    validate_skill_package_file_count(files.len())?;
    let base_path = skill_base_path(skill_id, public);
    let file_names = files.keys().cloned().collect::<BTreeSet<_>>();
    let entries = files.into_iter().collect::<Vec<_>>();
    let paths = entries
        .iter()
        .map(|(name, _)| format!("{base_path}/{name}"))
        .collect::<Vec<_>>();
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
        json!({ "id": skill_id.to_string(), "catalog": catalog(public), "base_path": base_path, "written_paths": written_paths, "pruned_paths": pruned_paths }),
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
        public,
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
            public,
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
    pub(crate) public: bool,
}

pub(crate) struct SkillRunEvidenceInput<'a> {
    pub(crate) database_id: &'a str,
    pub(crate) id: &'a str,
    pub(crate) evidence_json: &'a Path,
    pub(crate) public: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct SkillRunEvidence {
    #[serde(default)]
    run_id: Option<String>,
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
    let SkillRunEvidenceInput {
        database_id,
        id,
        evidence_json,
        public,
    } = input;
    let skill_id = SkillId::parse(id)?;
    let evidence_text = std::fs::read_to_string(evidence_json)
        .with_context(|| format!("failed to read {}", evidence_json.display()))?;
    let evidence: SkillRunEvidence = serde_json::from_str(&evidence_text)
        .with_context(|| format!("invalid evidence JSON: {}", evidence_json.display()))?;
    validate_outcome(evidence.task_outcome.as_deref(), "task_outcome")?;
    validate_outcome(evidence.agent_outcome.as_deref(), "agent_outcome")?;
    let base_path = skill_base_path(&skill_id, public);
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
    let run_id = evidence
        .run_id
        .as_deref()
        .filter(|value| valid_id_segment(value))
        .map(str::to_string)
        .unwrap_or_else(|| now_millis().to_string());
    let recorded_at = now_rfc3339();
    let run_path = format!("{RUN_ROOT}/{skill_id}/{run_id}.md");
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
            "recorded_by: hermes-plugin\n",
            "recorded_at: {recorded_at}\n",
            "---\n",
            "# Skill Run\n\n",
            "## Summary\n\n{summary}\n\n",
            "## Raw Evidence Excerpt\n\n{raw_evidence_excerpt}\n\n",
            "## Evidence JSON\n\n```json\n{pretty_evidence}\n```\n"
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
        recorded_at = recorded_at,
        summary = evidence.summary.as_deref().unwrap_or(""),
        raw_evidence_excerpt = evidence.raw_evidence_excerpt.as_deref().unwrap_or(""),
        pretty_evidence = serde_json::to_string_pretty(&evidence)?,
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
    public: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let path = format!("{}/manifest.md", skill_base_path(&skill_id, public));
    let node = client
        .read_node(database_id, &path)
        .await?
        .ok_or_else(|| anyhow!("manifest not found: {path}"))?;
    let mut content = set_manifest_status_preserving_content(&node.content, status.as_str())?;
    let timestamp = now_rfc3339();
    match status {
        SkillStatusArg::Promoted => {
            content =
                set_root_frontmatter_field_preserving_content(&content, "promoted_at", &timestamp)?;
        }
        SkillStatusArg::Deprecated => {
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
        SkillStatusArg::Draft | SkillStatusArg::Reviewed => {}
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
    Ok(json!({ "id": id, "catalog": catalog(public), "status": status.as_str(), "path": path }))
}

async fn import_github_skill(
    client: &impl VfsApi,
    database_id: &str,
    source: &str,
    id: &str,
    reference: &str,
    public: bool,
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
    write_skill_package(client, database_id, &skill_id, public, prune, files).await
}

pub(crate) async fn propose_improvement(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    runs: &[String],
    summary: &str,
    diff_file: &Path,
    public: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    for run in runs {
        if !run.starts_with(&format!("{}/", run_base_path(&skill_id))) {
            return Err(anyhow!(
                "proposal run path must belong to skill {id}: {run}"
            ));
        }
    }
    let diff = std::fs::read_to_string(diff_file)
        .with_context(|| format!("failed to read {}", diff_file.display()))?;
    let path_timestamp = now_millis();
    let created_at = now_rfc3339();
    let proposal_path = format!(
        "{}/improvement-proposals/{path_timestamp}.md",
        skill_base_path(&skill_id, public)
    );
    let source_runs = runs
        .iter()
        .map(|run| format!("  - {run}"))
        .collect::<Vec<_>>()
        .join("\n");
    let evidence_links = runs
        .iter()
        .map(|run| format!("- [{run}]({run})"))
        .collect::<Vec<_>>()
        .join("\n");
    let content = format!(
        "---\nkind: kinic.skill_improvement_proposal\nschema_version: 1\nskill_id: {id}\nstatus: proposed\nsource_runs:\n{source_runs}\ncreated_at: {created_at}\ncreated_by: cli\n---\n# Skill Improvement Proposal\n\n## Summary\n\n{summary}\n\n## Evidence\n\n{evidence_links}\n\n## Proposed Diff\n\n```diff\n{diff}\n```\n"
    );
    ensure_parent_folders(client, database_id, &proposal_path).await?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: proposal_path.clone(),
            kind: NodeKind::File,
            content,
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    Ok(json!({ "id": id, "proposal_path": proposal_path, "status": "proposed" }))
}

pub(crate) async fn approve_proposal(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    proposal_path: &str,
) -> Result<serde_json::Value> {
    validate_proposal_target(id, proposal_path)?;
    let node = client
        .read_node(database_id, proposal_path)
        .await?
        .ok_or_else(|| anyhow!("proposal not found: {proposal_path}"))?;
    validate_proposal_frontmatter(id, &node.content)?;
    let content =
        set_root_frontmatter_field_preserving_content(&node.content, "status", "approved")?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: proposal_path.to_string(),
            kind: NodeKind::File,
            content,
            metadata_json: node.metadata_json,
            expected_etag: Some(node.etag),
        })
        .await?;
    Ok(json!({ "id": id, "proposal_path": proposal_path, "status": "approved" }))
}

pub(crate) async fn install_skill_lockfile(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    lockfile: &Path,
    public: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let base_path = skill_base_path(&skill_id, public);
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
        "public": public,
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
        "catalog": catalog(public),
        "lockfile": lockfile.display().to_string(),
        "manifest_path": value["manifest_path"],
        "entry_path": value["entry_path"]
    }))
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
    public: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let base_path = skill_base_path(&skill_id, public);
    let mut exported = Vec::new();
    std::fs::create_dir_all(out).with_context(|| format!("failed to create {}", out.display()))?;
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
    Ok(
        json!({ "id": skill_id.to_string(), "catalog": catalog(public), "out": out.display().to_string(), "files": exported }),
    )
}

pub(crate) async fn apply_evolution_proposal(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    proposal_id: &str,
    projection_dir: Option<&Path>,
    public: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    if !valid_id_segment(proposal_id) {
        return Err(anyhow!("proposal id must use a single path-safe name"));
    }
    let base_path = skill_base_path(&skill_id, public);
    let current_path = format!("{base_path}/SKILL.md");
    let candidate_path = format!("{base_path}/proposals/{proposal_id}/candidate/SKILL.md");
    let metrics_path = format!("{base_path}/proposals/{proposal_id}/metrics.json");
    let current = client
        .read_node(database_id, &current_path)
        .await?
        .ok_or_else(|| anyhow!("current SKILL.md not found: {current_path}"))?;
    let candidate = client
        .read_node(database_id, &candidate_path)
        .await?
        .ok_or_else(|| anyhow!("candidate SKILL.md not found: {candidate_path}"))?;
    let metrics = client
        .read_node(database_id, &metrics_path)
        .await?
        .ok_or_else(|| anyhow!("metrics.json not found: {metrics_path}"))?;
    let metrics_json: serde_json::Value = serde_json::from_str(&metrics.content)
        .with_context(|| format!("invalid metrics JSON: {metrics_path}"))?;
    let base_etag = metrics_json
        .get("base_etag")
        .and_then(|value| value.as_str())
        .ok_or_else(|| anyhow!("metrics.json must contain base_etag"))?;
    if base_etag != current.etag {
        let status_path = format!("{base_path}/proposals/{proposal_id}/status.md");
        let content =
            proposal_status_content(&skill_id, proposal_id, "conflict", Some(&current.etag));
        ensure_parent_folders(client, database_id, &status_path).await?;
        client
            .write_node(WriteNodeRequest {
                database_id: database_id.to_string(),
                path: status_path.clone(),
                kind: NodeKind::File,
                content,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            })
            .await?;
        return Ok(
            json!({ "id": skill_id.to_string(), "proposal_id": proposal_id, "status": "conflict", "current_etag": current.etag, "base_etag": base_etag }),
        );
    }
    let version_path = format!(
        "{base_path}/versions/{}-{}.md",
        now_millis(),
        &sha256_hex(&current.content)[..12]
    );
    ensure_parent_folders_for_paths(
        client,
        database_id,
        &[version_path.clone(), current_path.clone()],
    )
    .await?;
    client
        .write_nodes(WriteNodesRequest {
            database_id: database_id.to_string(),
            nodes: vec![
                WriteNodeItem {
                    path: version_path.clone(),
                    kind: NodeKind::File,
                    content: current.content.clone(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                WriteNodeItem {
                    path: current_path.clone(),
                    kind: NodeKind::File,
                    content: candidate.content.clone(),
                    metadata_json: current.metadata_json.clone(),
                    expected_etag: Some(current.etag.clone()),
                },
            ],
        })
        .await?;
    let mut status = "auto_applied";
    let mut sync_error = None;
    if let Some(projection_dir) = projection_dir {
        let target = projection_dir.join(skill_id.to_string()).join("SKILL.md");
        if let Some(parent) = target.parent()
            && let Err(error) = std::fs::create_dir_all(parent)
        {
            status = "auto_applied_sync_failed";
            sync_error = Some(error.to_string());
        }
        if sync_error.is_none()
            && let Err(error) = std::fs::write(&target, candidate.content)
        {
            status = "auto_applied_sync_failed";
            sync_error = Some(error.to_string());
        }
    }
    let status_path = format!("{base_path}/proposals/{proposal_id}/status.md");
    let content = proposal_status_content(&skill_id, proposal_id, status, sync_error.as_deref());
    ensure_parent_folders(client, database_id, &status_path).await?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: status_path.clone(),
            kind: NodeKind::File,
            content,
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    Ok(
        json!({ "id": skill_id.to_string(), "proposal_id": proposal_id, "status": status, "version_path": version_path, "current_path": current_path, "sync_error": sync_error }),
    )
}

pub(crate) async fn create_ready_evolution_jobs(
    client: &impl VfsApi,
    database_id: &str,
    min_new_runs: u32,
    cooldown_hours: u32,
) -> Result<serde_json::Value> {
    let mut created = Vec::new();
    let min_new_runs = min_new_runs.max(1);
    let latest_jobs = latest_evolution_jobs(client, database_id).await?;
    let cooldown_ms = i64::from(cooldown_hours) * 60 * 60 * 1000;
    let now_ms = now_millis();
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: RUN_ROOT.to_string(),
            recursive: true,
        })
        .await?
    {
        if entry.kind != NodeEntryKind::Source || !entry.path.ends_with(".md") {
            continue;
        }
        let Some(skill_id) = skill_id_from_run_path(&entry.path) else {
            continue;
        };
        let existing = created
            .iter()
            .any(|value: &serde_json::Value| value["skill_id"] == skill_id);
        if existing {
            continue;
        }
        let latest_job_at = latest_jobs.get(&skill_id).copied().unwrap_or(0);
        if latest_job_at > 0 && now_ms.saturating_sub(latest_job_at) < cooldown_ms {
            continue;
        }
        let runs = client
            .recent_nodes(RecentNodesRequest {
                database_id: database_id.to_string(),
                path: Some(format!("{RUN_ROOT}/{skill_id}")),
                limit: min_new_runs,
            })
            .await?
            .into_iter()
            .filter(|run| {
                run.path.ends_with(".md")
                    && !run.path.contains(".correction.")
                    && run.updated_at > latest_job_at
            })
            .collect::<Vec<_>>();
        if runs.len() < min_new_runs as usize {
            continue;
        }
        let job_id = format!("{}-{}", skill_id, now_millis());
        let job_path = format!("/Wiki/skill-evolution-jobs/{job_id}.md");
        let source_runs = runs
            .iter()
            .map(|run| format!("  - {}", run.path))
            .collect::<Vec<_>>()
            .join("\n");
        let content = format!(
            "---\nkind: kinic.skill_evolution_job\nschema_version: 1\njob_id: {job_id}\nskill_id: {skill_id}\nstatus: pending\nmin_new_runs: {min_new_runs}\ncooldown_hours: {cooldown_hours}\nsource_runs:\n{source_runs}\ncreated_at: {}\n---\n# Skill Evolution Job\n",
            now_rfc3339()
        );
        ensure_parent_folders(client, database_id, &job_path).await?;
        client
            .write_node(WriteNodeRequest {
                database_id: database_id.to_string(),
                path: job_path.clone(),
                kind: NodeKind::File,
                content,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            })
            .await?;
        created.push(json!({ "job_id": job_id, "skill_id": skill_id, "job_path": job_path }));
    }
    Ok(json!({ "created": created }))
}

async fn latest_evolution_jobs(
    client: &impl VfsApi,
    database_id: &str,
) -> Result<BTreeMap<String, i64>> {
    let mut latest = BTreeMap::new();
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: "/Wiki/skill-evolution-jobs".to_string(),
            recursive: true,
        })
        .await?
    {
        if entry.kind != NodeEntryKind::File || !entry.path.ends_with(".md") {
            continue;
        }
        let Some(node) = client.read_node(database_id, &entry.path).await? else {
            continue;
        };
        let Some(skill_id) = skill_id_from_job_content(&node.content) else {
            continue;
        };
        latest
            .entry(skill_id)
            .and_modify(|value: &mut i64| *value = (*value).max(entry.updated_at))
            .or_insert(entry.updated_at);
    }
    Ok(latest)
}

#[derive(Deserialize)]
struct ProposalFrontmatter {
    kind: String,
    schema_version: u32,
    skill_id: String,
    status: String,
}

fn validate_proposal_target(id: &str, proposal_path: &str) -> Result<()> {
    let skill_id = SkillId::parse(id)?;
    let private_prefix = format!("{}/{}/improvement-proposals/", PRIVATE_ROOT, skill_id);
    let public_prefix = format!("{}/{}/improvement-proposals/", PUBLIC_ROOT, skill_id);
    if proposal_path.starts_with(&private_prefix) || proposal_path.starts_with(&public_prefix) {
        return Ok(());
    }
    Err(anyhow!(
        "proposal path must belong to skill {id} improvement-proposals"
    ))
}

fn validate_proposal_frontmatter(id: &str, content: &str) -> Result<()> {
    let frontmatter: ProposalFrontmatter = serde_yaml::from_str(extract_frontmatter(content)?)?;
    if frontmatter.kind != "kinic.skill_improvement_proposal" {
        return Err(anyhow!(
            "proposal kind must be kinic.skill_improvement_proposal"
        ));
    }
    if frontmatter.schema_version != 1 {
        return Err(anyhow!("proposal schema_version must be 1"));
    }
    if frontmatter.skill_id != id {
        return Err(anyhow!("proposal skill_id must match id"));
    }
    if frontmatter.status != "proposed" {
        return Err(anyhow!("proposal status must be proposed"));
    }
    Ok(())
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
        })
        .await?
    {
        if entry.kind != NodeEntryKind::File {
            continue;
        }
        let Some(relative_path) = entry.path.strip_prefix(&format!("{base_path}/")) else {
            continue;
        };
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
    let mut rest = content;
    while let Some(start) = rest.find("](") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find(')') else {
            break;
        };
        targets.push(rest[..end].to_string());
        rest = &rest[end + 1..];
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
    let target = raw_target.split_whitespace().next()?.trim();
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
        None | Some("") | Some("success" | "partial" | "fail") => Ok(()),
        Some(value) => Err(anyhow!(
            "{field} must be success, partial, or fail when present; got {value}"
        )),
    }
}

fn valid_id_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
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
    !relative_path.starts_with("proposals/")
        && !relative_path.starts_with("versions/")
        && !relative_path.starts_with("improvement-proposals/")
}

fn skill_id_from_run_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix(&format!("{RUN_ROOT}/"))?;
    let (id, _) = rest.split_once('/')?;
    if valid_id_segment(id) {
        Some(id.to_string())
    } else {
        None
    }
}

fn skill_id_from_job_content(content: &str) -> Option<String> {
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("skill_id:") {
            let value = value.trim();
            if valid_id_segment(value) {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn proposal_status_content(
    skill_id: &SkillId,
    proposal_id: &str,
    status: &str,
    detail: Option<&str>,
) -> String {
    let detail = detail.unwrap_or("");
    format!(
        "---\nkind: kinic.skill_evolution_proposal_status\nschema_version: 1\nskill_id: {skill_id}\nproposal_id: {proposal_id}\nstatus: {status}\nrecorded_at: {}\n---\n# Proposal Status\n\n{detail}\n",
        now_rfc3339()
    )
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

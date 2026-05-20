use crate::cli::{
    SkillCommand, SkillEvolutionJobStatusArg, SkillEvolveJobsCommand, SkillImportCommand,
    SkillRunOutcomeArg, SkillStatusArg,
};
use crate::github_source::{
    fetch_github_optional_package_file, fetch_github_skill_package, github_source_string,
    github_source_url, parse_github_skill_source,
};
mod model;
use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use model::{
    PRIVATE_ROOT, RUN_ROOT, SkillId, catalog, extract_frontmatter, manifest_for_source,
    normalize_manifest, now_millis, now_rfc3339, parse_skill_source_frontmatter, print,
    run_base_path, set_manifest_provenance_field, set_manifest_status_preserving_content,
    set_root_frontmatter_field_preserving_content, skill_base_path,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
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
            create_ready_jobs,
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
            let result =
                with_ready_evolution_jobs(client, database_id, result, create_ready_jobs).await?;
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
            job_id,
            projection_dir,
            public,
            json,
        } => print(
            apply_evolution_proposal(
                client,
                database_id,
                &id,
                &proposal_id,
                job_id.as_deref(),
                projection_dir.as_deref(),
                public,
            )
            .await?,
            json,
        )?,
        SkillCommand::Rollback {
            id,
            version_id,
            projection_dir,
            public,
            json,
        } => print(
            rollback_skill_version(
                client,
                database_id,
                &id,
                &version_id,
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
        SkillCommand::ExportGithub {
            id,
            target,
            branch,
            message,
            public,
            json,
        } => print(
            export_skill_github(client, database_id, &id, &target, &branch, &message, public)
                .await?,
            json,
        )?,
        SkillCommand::History { id, public, json } => {
            print(skill_history(client, database_id, &id, public).await?, json)?
        }
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
            SkillEvolveJobsCommand::List { status, json } => print(
                list_evolution_jobs(client, database_id, status.map(|value| value.as_str()))
                    .await?,
                json,
            )?,
            SkillEvolveJobsCommand::Claim {
                job_id,
                lease_seconds,
                json,
            } => print(
                claim_evolution_job(client, database_id, &job_id, lease_seconds).await?,
                json,
            )?,
            SkillEvolveJobsCommand::Complete {
                job_id,
                status,
                summary,
                json,
            } => print(
                complete_evolution_job(client, database_id, &job_id, status.as_str(), &summary)
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

pub(crate) async fn with_ready_evolution_jobs(
    client: &impl VfsApi,
    database_id: &str,
    mut result: serde_json::Value,
    create_ready_jobs: bool,
) -> Result<serde_json::Value> {
    if create_ready_jobs {
        let jobs = create_ready_evolution_jobs(client, database_id, 5, 24).await?;
        let object = result
            .as_object_mut()
            .ok_or_else(|| anyhow!("record-run result must be a JSON object"))?;
        object.insert("evolution_jobs".to_string(), jobs);
    }
    Ok(result)
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
    let run_id = run_id_override
        .filter(|value| valid_id_segment(value))
        .map(str::to_string)
        .or_else(|| {
            evidence
                .run_id
                .as_deref()
                .filter(|value| valid_id_segment(value))
                .map(str::to_string)
        })
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

pub(crate) async fn apply_evolution_proposal(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    proposal_id: &str,
    job_id: Option<&str>,
    projection_dir: Option<&Path>,
    public: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    if !valid_id_segment(proposal_id) {
        return Err(anyhow!("proposal id must use a single path-safe name"));
    }
    if let Some(job_id) = job_id {
        validate_evolution_job_for_apply(client, database_id, job_id, &skill_id).await?;
    }
    let base_path = skill_base_path(&skill_id, public);
    let current_path = format!("{base_path}/SKILL.md");
    let manifest_path = format!("{base_path}/manifest.md");
    let candidate_path = format!("{base_path}/proposals/{proposal_id}/candidate/SKILL.md");
    let metrics_path = format!("{base_path}/proposals/{proposal_id}/metrics.json");
    let current = client
        .read_node(database_id, &current_path)
        .await?
        .ok_or_else(|| anyhow!("current SKILL.md not found: {current_path}"))?;
    let manifest = client.read_node(database_id, &manifest_path).await?;
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
    let gate_failure = proposal_gate_failure(&metrics_json);
    if let Some(gate_failure) = gate_failure {
        let status_path = format!("{base_path}/proposals/{proposal_id}/status.md");
        let content =
            proposal_status_content(&skill_id, proposal_id, "gate_failed", Some(gate_failure));
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
            json!({ "id": skill_id.to_string(), "proposal_id": proposal_id, "status": "gate_failed", "error": gate_failure }),
        );
    }
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
    let version_id = snapshot_current_skill_version(
        client,
        database_id,
        &base_path,
        &current,
        manifest.as_ref(),
    )
    .await?;
    let version_path = format!("{base_path}/versions/{version_id}");
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: current_path.clone(),
            kind: NodeKind::File,
            content: candidate.content.clone(),
            metadata_json: current.metadata_json.clone(),
            expected_etag: Some(current.etag.clone()),
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

pub(crate) async fn rollback_skill_version(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    version_id: &str,
    projection_dir: Option<&Path>,
    public: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    if !valid_version_id(version_id) {
        return Err(anyhow!(
            "version id must be a path-safe version directory name"
        ));
    }
    let base_path = skill_base_path(&skill_id, public);
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
    public: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let base_path = skill_base_path(&skill_id, public);
    let prefixes = [
        format!("{base_path}/versions"),
        format!("{base_path}/proposals"),
        format!("{RUN_ROOT}/{skill_id}"),
        "/Wiki/skill-evolution-jobs".to_string(),
    ];
    let mut events = Vec::new();
    for prefix in prefixes {
        for entry in client
            .list_nodes(ListNodesRequest {
                database_id: database_id.to_string(),
                prefix,
                recursive: true,
            })
            .await?
        {
            if entry.kind == NodeEntryKind::Folder {
                continue;
            }
            if entry.path.starts_with("/Wiki/skill-evolution-jobs") {
                let Some(node) = client.read_node(database_id, &entry.path).await? else {
                    continue;
                };
                if skill_id_from_job_content(&node.content).as_deref() != Some(id) {
                    continue;
                }
            }
            let kind = if entry.path.contains("/versions/") {
                "version"
            } else if entry.path.contains("/proposals/") {
                "proposal"
            } else if entry.path.contains(".correction.") {
                "correction"
            } else if entry.path.starts_with(RUN_ROOT) {
                "run"
            } else {
                "job"
            };
            events.push(json!({
                "kind": kind,
                "path": entry.path,
                "updated_at": entry.updated_at,
                "etag": entry.etag
            }));
        }
    }
    events.sort_by(|left, right| {
        right["updated_at"]
            .as_i64()
            .cmp(&left["updated_at"].as_i64())
            .then_with(|| left["path"].as_str().cmp(&right["path"].as_str()))
    });
    Ok(json!({ "id": skill_id.to_string(), "events": events }))
}

pub(crate) async fn export_skill_github(
    client: &impl VfsApi,
    database_id: &str,
    id: &str,
    target: &str,
    branch: &str,
    message: &str,
    public: bool,
) -> Result<serde_json::Value> {
    let skill_id = SkillId::parse(id)?;
    let (repo, target_prefix) = parse_github_export_target(target)?;
    let files = github_export_files(client, database_id, &skill_id, public).await?;
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

pub(crate) async fn create_ready_evolution_jobs(
    client: &impl VfsApi,
    database_id: &str,
    min_new_runs: u32,
    cooldown_hours: u32,
) -> Result<serde_json::Value> {
    let mut created = Vec::new();
    for spec in ready_evolution_job_specs(client, database_id, min_new_runs, cooldown_hours).await?
    {
        let job_id = format!("{}-{}", spec.skill_id, now_millis());
        let job_path = format!("/Wiki/skill-evolution-jobs/{job_id}.md");
        let source_runs = spec
            .source_runs
            .iter()
            .map(|run| format!("  - {run}"))
            .collect::<Vec<_>>()
            .join("\n");
        let content = format!(
            "---\nkind: kinic.skill_evolution_job\nschema_version: 1\njob_id: {job_id}\nskill_id: {}\nstatus: queued\nmin_new_runs: {}\ncooldown_hours: {}\nsource_runs:\n{source_runs}\ncreated_at: {}\n---\n# Skill Evolution Job\n",
            spec.skill_id,
            spec.min_new_runs,
            spec.cooldown_hours,
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
        created.push(json!({ "job_id": job_id, "skill_id": spec.skill_id, "job_path": job_path }));
    }
    Ok(json!({ "created": created }))
}

#[derive(Clone)]
struct ReadyEvolutionJobSpec {
    skill_id: String,
    source_runs: Vec<String>,
    min_new_runs: u32,
    cooldown_hours: u32,
}

async fn ready_evolution_job_specs(
    client: &impl VfsApi,
    database_id: &str,
    min_new_runs: u32,
    cooldown_hours: u32,
) -> Result<Vec<ReadyEvolutionJobSpec>> {
    let mut specs = Vec::new();
    let min_new_runs = min_new_runs.max(1);
    let latest_jobs = latest_evolution_jobs(client, database_id).await?;
    let cooldown_ms = i64::from(cooldown_hours) * 60 * 60 * 1000;
    let now_ms = now_millis();
    let mut runs_by_skill: BTreeMap<String, Vec<vfs_types::NodeEntry>> = BTreeMap::new();
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: RUN_ROOT.to_string(),
            recursive: true,
        })
        .await?
    {
        if entry.kind != NodeEntryKind::Source
            || !entry.path.ends_with(".md")
            || entry.path.contains(".correction.")
        {
            continue;
        }
        let Some(skill_id) = skill_id_from_run_path(&entry.path) else {
            continue;
        };
        runs_by_skill.entry(skill_id).or_default().push(entry);
    }
    for (skill_id, mut runs) in runs_by_skill {
        let latest_job_at = latest_jobs.get(&skill_id).copied().unwrap_or(0);
        if latest_job_at > 0 && now_ms.saturating_sub(latest_job_at) < cooldown_ms {
            continue;
        }
        runs.retain(|run| run.updated_at > latest_job_at);
        runs.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.path.cmp(&right.path))
        });
        if runs.len() < min_new_runs as usize {
            continue;
        }
        runs.truncate(min_new_runs as usize);
        specs.push(ReadyEvolutionJobSpec {
            skill_id,
            source_runs: runs.into_iter().map(|run| run.path).collect(),
            min_new_runs,
            cooldown_hours,
        });
    }
    Ok(specs)
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

struct PendingEvolutionJob {
    path: String,
    content: String,
    etag: String,
    skill_id: String,
}

pub(crate) async fn list_evolution_jobs(
    client: &impl VfsApi,
    database_id: &str,
    status: Option<&str>,
) -> Result<serde_json::Value> {
    let mut jobs = Vec::new();
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
        let job_status =
            frontmatter_scalar(&node.content, "status").unwrap_or_else(|| "queued".to_string());
        if status.is_some_and(|status| status != job_status) {
            continue;
        }
        let job_id = frontmatter_scalar(&node.content, "job_id")
            .or_else(|| {
                entry
                    .path
                    .rsplit('/')
                    .next()
                    .map(|name| name.trim_end_matches(".md").to_string())
            })
            .unwrap_or_default();
        jobs.push(json!({
            "job_id": job_id,
            "path": entry.path,
            "status": job_status,
            "skill_id": skill_id_from_job_content(&node.content),
            "claimed_by": frontmatter_scalar(&node.content, "claimed_by"),
            "claim_expires_at": frontmatter_scalar(&node.content, "claim_expires_at"),
            "proposal_id": frontmatter_scalar(&node.content, "proposal_id"),
            "updated_at": entry.updated_at,
            "etag": node.etag
        }));
    }
    jobs.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    Ok(json!({ "jobs": jobs }))
}

pub(crate) async fn claim_evolution_job(
    client: &impl VfsApi,
    database_id: &str,
    job_id: &str,
    lease_seconds: u32,
) -> Result<serde_json::Value> {
    let job = read_evolution_job(client, database_id, job_id).await?;
    let claimed_by = current_identity_principal(client)?;
    let status = frontmatter_scalar(&job.content, "status").unwrap_or_else(|| "queued".to_string());
    let expired = frontmatter_scalar(&job.content, "claim_expires_at")
        .as_deref()
        .is_some_and(is_claim_expired);
    if status != "queued" && !(status == "running" && expired) {
        return Ok(json!({ "job_id": job_id, "status": "not_claimed", "current_status": status }));
    }
    let claim_expires_at = (Utc::now() + chrono::Duration::seconds(i64::from(lease_seconds)))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut content =
        set_root_frontmatter_field_preserving_content(&job.content, "status", "running")?;
    content = set_root_frontmatter_field_preserving_content(&content, "claimed_by", &claimed_by)?;
    content = set_root_frontmatter_field_preserving_content(
        &content,
        "claim_expires_at",
        &claim_expires_at,
    )?;
    content =
        set_root_frontmatter_field_preserving_content(&content, "updated_at", &now_rfc3339())?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: job.path.clone(),
            kind: NodeKind::File,
            content,
            metadata_json: "{}".to_string(),
            expected_etag: Some(job.etag),
        })
        .await?;
    Ok(
        json!({ "job_id": job_id, "path": job.path, "status": "running", "claimed_by": claimed_by, "claim_expires_at": claim_expires_at, "skill_id": job.skill_id }),
    )
}

pub(crate) async fn complete_evolution_job(
    client: &impl VfsApi,
    database_id: &str,
    job_id: &str,
    status: &str,
    summary: &str,
) -> Result<serde_json::Value> {
    if !matches!(status, "done" | "conflict" | "failed") {
        return Err(anyhow!(
            "completion status must be done, conflict, or failed"
        ));
    }
    let job = read_evolution_job(client, database_id, job_id).await?;
    validate_evolution_job_claim(client, &job)?;
    let mut content =
        set_root_frontmatter_field_preserving_content(&job.content, "status", status)?;
    content = set_root_frontmatter_field_preserving_content(&content, "result_summary", summary)?;
    content =
        set_root_frontmatter_field_preserving_content(&content, "updated_at", &now_rfc3339())?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: job.path.clone(),
            kind: NodeKind::File,
            content,
            metadata_json: "{}".to_string(),
            expected_etag: Some(job.etag),
        })
        .await?;
    Ok(json!({ "job_id": job_id, "path": job.path, "skill_id": job.skill_id, "status": status }))
}

fn validate_evolution_job_claim(client: &impl VfsApi, job: &PendingEvolutionJob) -> Result<()> {
    let status = frontmatter_scalar(&job.content, "status").unwrap_or_else(|| "queued".to_string());
    if status != "running" {
        return Err(anyhow!("evolution job must be running to complete"));
    }
    let claimed_by = frontmatter_scalar(&job.content, "claimed_by")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("evolution job is missing claimed_by"))?;
    let caller = current_identity_principal(client)?;
    if claimed_by != caller {
        return Err(anyhow!(
            "evolution job claim is held by {claimed_by}, current identity is {caller}"
        ));
    }
    let claim_expires_at = frontmatter_scalar(&job.content, "claim_expires_at")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("evolution job is missing claim_expires_at"))?;
    if is_claim_expired(&claim_expires_at) {
        return Err(anyhow!("evolution job claim has expired"));
    }
    Ok(())
}

async fn validate_evolution_job_for_apply(
    client: &impl VfsApi,
    database_id: &str,
    job_id: &str,
    skill_id: &SkillId,
) -> Result<()> {
    let job = read_evolution_job(client, database_id, job_id).await?;
    if job.skill_id != skill_id.to_string() {
        return Err(anyhow!(
            "evolution job skill_id {} does not match proposal skill {}",
            job.skill_id,
            skill_id
        ));
    }
    validate_evolution_job_claim(client, &job)
}

fn current_identity_principal(client: &impl VfsApi) -> Result<String> {
    client
        .caller_principal()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("current identity principal is not available"))
}

async fn read_evolution_job(
    client: &impl VfsApi,
    database_id: &str,
    job_id: &str,
) -> Result<PendingEvolutionJob> {
    if !valid_id_segment(job_id) {
        return Err(anyhow!("job id must use a single path-safe name"));
    }
    let path = format!("/Wiki/skill-evolution-jobs/{job_id}.md");
    let node = client
        .read_node(database_id, &path)
        .await?
        .ok_or_else(|| anyhow!("evolution job not found: {path}"))?;
    let skill_id = skill_id_from_job_content(&node.content)
        .ok_or_else(|| anyhow!("evolution job missing skill_id: {path}"))?;
    Ok(PendingEvolutionJob {
        path,
        content: node.content,
        etag: node.etag,
        skill_id,
    })
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

fn frontmatter_scalar(content: &str, key: &str) -> Option<String> {
    let frontmatter = extract_frontmatter(content).ok()?;
    for line in frontmatter.lines() {
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        if field.trim() == key {
            return Some(value.trim().trim_matches('"').to_string());
        }
    }
    None
}

fn is_claim_expired(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value)
        .map(|expires| expires.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(true)
}

#[cfg(test)]
mod skill_evolve_jobs_tests {
    use super::*;

    #[test]
    fn frontmatter_scalar_reads_plain_value() {
        let content =
            "---\nkind: kinic.skill_evolution_job\nstatus: queued\nskill_id: legal\n---\n# Job\n";

        assert_eq!(
            frontmatter_scalar(content, "status"),
            Some("queued".to_string())
        );
        assert_eq!(
            frontmatter_scalar(content, "skill_id"),
            Some("legal".to_string())
        );
    }

    #[test]
    fn truncate_error_removes_newlines_and_caps_length() {
        let value = truncate_error(&format!("a\n{}", "b".repeat(1000)));

        assert!(!value.contains('\n'));
        assert_eq!(value.len(), 800);
    }
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
    if proposal_path.starts_with(&private_prefix) {
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
        None | Some("") | Some("success" | "partial" | "fail" | "unknown") => Ok(()),
        Some(value) => Err(anyhow!(
            "{field} must be success, partial, fail, or unknown when present; got {value}"
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

fn is_github_export_file(relative_path: &str) -> bool {
    !relative_path.starts_with("proposals/")
        && !relative_path.starts_with("versions/")
        && !relative_path.starts_with("improvement-proposals/")
}

async fn github_export_files(
    client: &impl VfsApi,
    database_id: &str,
    skill_id: &SkillId,
    public: bool,
) -> Result<BTreeMap<String, String>> {
    let base_path = skill_base_path(skill_id, public);
    let mut files = BTreeMap::new();
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

fn proposal_gate_failure(metrics: &serde_json::Value) -> Option<&'static str> {
    [
        "candidate_score_gate",
        "semantic_drift_gate",
        "permission_gate",
    ]
    .into_iter()
    .find(|gate| gate_status(metrics, gate) != Some("pass"))
}

fn gate_status<'a>(metrics: &'a serde_json::Value, gate: &str) -> Option<&'a str> {
    metrics
        .get(gate)
        .and_then(|value| value.as_str())
        .or_else(|| {
            metrics
                .get("gates")
                .and_then(|value| value.get(gate))
                .and_then(|value| value.as_str())
        })
        .or_else(|| {
            metrics
                .get("gates")
                .and_then(|value| value.get(gate))
                .and_then(|value| value.get("status"))
                .and_then(|value| value.as_str())
        })
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

impl SkillEvolutionJobStatusArg {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Conflict => "conflict",
            Self::Failed => "failed",
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

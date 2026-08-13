// Where: crates/vfs_cli_app/src/curator.rs
// What: Four-store Curator scan, proposal validation, and atomic reviewed apply.
// Why: Knowledge maintenance must remain inspectable and require explicit etag-guarded approval.
use crate::cli::CuratorCommand;
use anyhow::{Context, Result, anyhow, bail};
use candid::Principal;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use vfs_client::VfsApi;
use vfs_types::{
    ExportSnapshotRequest, LinkEdge, MutateNodesBatchRequest, Node, NodeKind, NodeMutation,
    NodeMutationError, OutgoingLinksRequest, SourceEvidenceRef, SourceEvidenceRequest,
    WriteNodeItem,
};
use wiki_domain::decode_frontmatter_scalar;

const SCAN_SCHEMA: &str = "kinic.curator.scan.v1";
const PLAN_SCHEMA: &str = "kinic.curator.plan.v1";
const SNAPSHOT_PAGE_SIZE: u32 = 100;
const LINK_LIMIT: u32 = 100;
const MAX_BATCH_OPERATIONS: usize = 100;
const MUTABLE_ROOTS: [&str; 4] = ["/Memory", "/Knowledge", "/Skills", "/Sessions"];

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CuratorStore {
    Memory,
    Knowledge,
    Skill,
    Session,
    SourceEvidence,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CuratorStatus {
    Active,
    Stale,
    Archived,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorScanV1 {
    pub schema_version: String,
    pub database_id: String,
    pub canister_id: String,
    pub snapshot_revision: String,
    pub generated_at: String,
    pub stale_after_days: u32,
    pub nodes: Vec<CuratorScanNode>,
    pub findings: Vec<DeterministicFinding>,
    pub coverage: CuratorCoverage,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorScanNode {
    pub path: String,
    pub store: CuratorStore,
    pub kind: NodeKind,
    pub content: String,
    pub body: String,
    pub metadata_json: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub etag: String,
    pub curator_status: CuratorStatus,
    pub outgoing_links: Vec<CuratorLink>,
    pub source_evidence: Vec<CuratorEvidenceRef>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorLink {
    pub target_path: String,
    pub raw_href: String,
    pub link_text: String,
    pub link_kind: String,
}

impl From<LinkEdge> for CuratorLink {
    fn from(value: LinkEdge) -> Self {
        Self {
            target_path: value.target_path,
            raw_href: value.raw_href,
            link_text: value.link_text,
            link_kind: value.link_kind,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorEvidenceRef {
    pub source_path: String,
    pub via_path: String,
    pub source_etag: Option<String>,
    pub source_updated_at: Option<i64>,
}

impl From<SourceEvidenceRef> for CuratorEvidenceRef {
    fn from(value: SourceEvidenceRef) -> Self {
        Self {
            source_path: value.source_path,
            via_path: value.via_path,
            source_etag: value.source_etag,
            source_updated_at: value.source_updated_at,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeterministicFinding {
    pub id: String,
    pub kind: String,
    pub severity: FindingSeverity,
    pub store: CuratorStore,
    pub paths: Vec<String>,
    pub detail: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorCoverage {
    pub entry_roots: Vec<String>,
    pub node_count: usize,
    pub inspected_node_count: usize,
    pub truncated_link_paths: Vec<String>,
    pub inspection_errors: Vec<String>,
    pub complete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorPlanV1 {
    pub schema_version: String,
    pub database_id: String,
    pub canister_id: String,
    pub snapshot_revision: String,
    pub agent: String,
    pub findings: Vec<SemanticFinding>,
    pub proposals: Vec<CuratorProposal>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingConfidence {
    High,
    Medium,
    Low,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticFinding {
    pub id: String,
    pub kind: String,
    pub confidence: FindingConfidence,
    pub store: CuratorStore,
    pub summary: String,
    pub paths: Vec<String>,
    pub evidence: Vec<SemanticEvidence>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticEvidence {
    pub path: String,
    pub excerpt: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorProposal {
    pub id: String,
    pub finding_ids: Vec<String>,
    pub summary: String,
    pub rationale: String,
    pub confidence: FindingConfidence,
    pub changes: Vec<CuratorChange>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorChange {
    pub path: String,
    pub expected_etag: String,
    pub replacement_body: Option<String>,
    pub target_status: Option<CuratorStatus>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ApplyPreview {
    pub(crate) dry_run: bool,
    pub(crate) selected_proposals: Vec<String>,
    pub(crate) changes: Vec<ApplyPreviewChange>,
    pub(crate) applied_operations: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct ApplyPreviewChange {
    pub(crate) path: String,
    pub(crate) expected_etag: String,
    pub(crate) current_status: CuratorStatus,
    pub(crate) target_status: Option<CuratorStatus>,
    pub(crate) current_body: String,
    pub(crate) replacement_body: String,
    pub(crate) content_changed: bool,
}

pub async fn run_curator_command(
    client: &impl VfsApi,
    database_id: &str,
    canister_id: &str,
    command: CuratorCommand,
) -> Result<()> {
    match command {
        CuratorCommand::Scan {
            out,
            stale_after_days,
            overwrite,
            json,
        } => {
            let scan = scan_curator(
                client,
                database_id,
                canister_id,
                stale_after_days,
                Utc::now().timestamp_millis(),
            )
            .await?;
            write_private_json(&out, &scan, overwrite)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "out": out,
                        "snapshot_revision": scan.snapshot_revision,
                        "node_count": scan.coverage.node_count,
                        "finding_count": scan.findings.len(),
                        "coverage_complete": scan.coverage.complete,
                    }))?
                );
            } else {
                println!(
                    "curator scan written: {} (nodes={}, findings={}, complete={})",
                    out.display(),
                    scan.coverage.node_count,
                    scan.findings.len(),
                    scan.coverage.complete
                );
            }
        }
        CuratorCommand::Validate { plan, json } => {
            validate_plan_file(&plan, json)?;
        }
        CuratorCommand::Apply {
            plan,
            proposals,
            all,
            confirm,
            json,
        } => {
            let plan = read_plan(&plan)?;
            let result = apply_curator_plan(
                client,
                database_id,
                canister_id,
                &plan,
                &proposals,
                all,
                confirm,
            )
            .await;
            match result {
                Ok(preview) => print_apply_preview(&preview, json)?,
                Err(error) => {
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&curator_error_json(&error))?
                        );
                    } else if let Some(mutation) = error.downcast_ref::<NodeMutationError>() {
                        eprintln!(
                            "curator batch failed: code={:?} failed_index={:?} conflict_path={:?} message={}",
                            mutation.code,
                            mutation.failed_index,
                            mutation.conflict_path,
                            mutation.message
                        );
                    }
                    return Err(error);
                }
            }
        }
    }
    Ok(())
}

pub fn validate_plan_file(path: &Path, json: bool) -> Result<()> {
    let plan = read_plan(path)?;
    validate_plan(&plan)?;
    let operation_count = plan
        .proposals
        .iter()
        .map(|proposal| proposal.changes.len())
        .sum::<usize>();
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "valid": true,
                "proposal_count": plan.proposals.len(),
                "operation_count": operation_count,
            }))?
        );
    } else {
        println!(
            "curator plan valid: proposals={} operations={operation_count}",
            plan.proposals.len(),
        );
    }
    Ok(())
}

pub(crate) async fn scan_curator(
    client: &impl VfsApi,
    database_id: &str,
    canister_id: &str,
    stale_after_days: u32,
    now_ms: i64,
) -> Result<CuratorScanV1> {
    if stale_after_days == 0 {
        bail!("stale-after-days must be greater than zero");
    }
    let manifest = client.memory_manifest(database_id).await?;
    let entry_roots = manifest
        .entry_roots
        .iter()
        .map(|root| root.path.clone())
        .collect::<Vec<_>>();
    for required in MUTABLE_ROOTS {
        if !entry_roots.iter().any(|root| root == required) {
            bail!("memory manifest is missing required entry root: {required}");
        }
    }

    let (snapshot_revision, nodes) = export_complete_snapshot(client, database_id).await?;
    let all_paths = nodes
        .iter()
        .map(|node| node.path.clone())
        .collect::<BTreeSet<_>>();
    let mut scan_nodes = Vec::with_capacity(nodes.len());
    let mut coverage = CuratorCoverage {
        entry_roots,
        node_count: nodes.len(),
        ..CuratorCoverage::default()
    };

    for node in nodes {
        let store = store_for_path(&node.path);
        let mut outgoing_links = Vec::new();
        let mut evidence = Vec::new();
        if node.kind != NodeKind::Folder {
            match client
                .outgoing_links(OutgoingLinksRequest {
                    database_id: database_id.to_string(),
                    path: node.path.clone(),
                    limit: LINK_LIMIT,
                })
                .await
            {
                Ok(links) => {
                    if links.len() == LINK_LIMIT as usize {
                        coverage.truncated_link_paths.push(node.path.clone());
                    }
                    outgoing_links = links.into_iter().map(CuratorLink::from).collect();
                }
                Err(error) => coverage
                    .inspection_errors
                    .push(format!("outgoing_links {}: {error}", node.path)),
            }
            if is_mutable_store(store) {
                match client
                    .source_evidence(SourceEvidenceRequest {
                        database_id: database_id.to_string(),
                        node_path: node.path.clone(),
                    })
                    .await
                {
                    Ok(result) => {
                        evidence = result
                            .refs
                            .into_iter()
                            .map(CuratorEvidenceRef::from)
                            .collect()
                    }
                    Err(error) => coverage
                        .inspection_errors
                        .push(format!("source_evidence {}: {error}", node.path)),
                }
            }
            coverage.inspected_node_count += 1;
        }
        let curator_status = parse_curator_status(&node.content).unwrap_or(CuratorStatus::Active);
        scan_nodes.push(CuratorScanNode {
            path: node.path,
            store,
            kind: node.kind,
            body: markdown_body(&node.content).to_string(),
            content: node.content,
            metadata_json: node.metadata_json,
            created_at: node.created_at,
            updated_at: node.updated_at,
            etag: node.etag,
            curator_status,
            outgoing_links,
            source_evidence: evidence,
        });
    }

    let findings =
        collect_deterministic_findings(&scan_nodes, &all_paths, stale_after_days, now_ms);
    coverage.complete =
        coverage.truncated_link_paths.is_empty() && coverage.inspection_errors.is_empty();

    Ok(CuratorScanV1 {
        schema_version: SCAN_SCHEMA.to_string(),
        database_id: database_id.to_string(),
        canister_id: canister_id.to_string(),
        snapshot_revision,
        generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        stale_after_days,
        nodes: scan_nodes,
        findings,
        coverage,
    })
}

async fn export_complete_snapshot(
    client: &impl VfsApi,
    database_id: &str,
) -> Result<(String, Vec<Node>)> {
    let mut cursor = None;
    let mut revision = None;
    let mut nodes = Vec::new();
    loop {
        let page = client
            .export_snapshot(ExportSnapshotRequest {
                database_id: database_id.to_string(),
                prefix: Some("/".to_string()),
                limit: SNAPSHOT_PAGE_SIZE,
                cursor: cursor.clone(),
                snapshot_revision: revision.clone(),
                snapshot_session_id: None,
            })
            .await
            .context("curator snapshot changed or could not be read; rerun curator scan")?;
        match &revision {
            Some(expected) if expected != &page.snapshot_revision => {
                bail!("curator snapshot revision changed between pages; rerun curator scan")
            }
            None => revision = Some(page.snapshot_revision.clone()),
            _ => {}
        }
        nodes.extend(page.nodes);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok((
        revision.ok_or_else(|| anyhow!("curator snapshot did not return a revision"))?,
        nodes,
    ))
}

fn collect_deterministic_findings(
    nodes: &[CuratorScanNode],
    all_paths: &BTreeSet<String>,
    stale_after_days: u32,
    now_ms: i64,
) -> Vec<DeterministicFinding> {
    let mut findings = Vec::new();
    let mut incoming_counts = BTreeMap::<String, usize>::new();
    for node in nodes {
        for link in &node.outgoing_links {
            *incoming_counts.entry(link.target_path.clone()).or_default() += 1;
        }
    }
    let stale_ms = i64::from(stale_after_days) * 24 * 60 * 60 * 1_000;
    for node in nodes {
        if node.kind == NodeKind::Folder {
            continue;
        }
        if let Err(error) = parse_curator_status_checked(&node.content) {
            push_finding(
                &mut findings,
                "invalid_curator_status",
                FindingSeverity::Error,
                node.store,
                vec![node.path.clone()],
                error,
            );
        }
        for link in &node.outgoing_links {
            if !all_paths.contains(&link.target_path) {
                push_finding(
                    &mut findings,
                    "broken_internal_link",
                    FindingSeverity::Warning,
                    node.store,
                    vec![node.path.clone(), link.target_path.clone()],
                    format!("internal link target does not exist: {}", link.target_path),
                );
            }
        }
        if is_mutable_store(node.store)
            && !is_entry_document(&node.path)
            && node.outgoing_links.is_empty()
            && incoming_counts.get(&node.path).copied().unwrap_or(0) == 0
        {
            push_finding(
                &mut findings,
                "isolated_node",
                FindingSeverity::Warning,
                node.store,
                vec![node.path.clone()],
                "organized node has no incoming or outgoing internal links".to_string(),
            );
        }
        if is_mutable_store(node.store) && now_ms.saturating_sub(node.updated_at) >= stale_ms {
            push_finding(
                &mut findings,
                "age_review_due",
                FindingSeverity::Info,
                node.store,
                vec![node.path.clone()],
                format!("node has not been updated for at least {stale_after_days} days"),
            );
        }
        if is_mutable_store(node.store) && node.source_evidence.is_empty() {
            push_finding(
                &mut findings,
                "source_evidence_missing",
                FindingSeverity::Info,
                node.store,
                vec![node.path.clone()],
                "organized node has no discoverable source evidence".to_string(),
            );
        }
        for source in &node.source_evidence {
            if source
                .source_updated_at
                .is_some_and(|updated| updated > node.updated_at)
            {
                push_finding(
                    &mut findings,
                    "source_newer_than_node",
                    FindingSeverity::Warning,
                    node.store,
                    vec![node.path.clone(), source.source_path.clone()],
                    "source evidence is newer than the organized node".to_string(),
                );
            }
        }
        if is_mutable_store(node.store) {
            for (kind, detail) in note_role_findings(&node.path, &node.content) {
                push_finding(
                    &mut findings,
                    kind,
                    FindingSeverity::Warning,
                    node.store,
                    vec![node.path.clone()],
                    detail,
                );
            }
        }
    }
    collect_skill_findings(nodes, all_paths, &mut findings);
    collect_session_findings(nodes, &mut findings);
    for node in nodes
        .iter()
        .filter(|node| node.store == CuratorStore::SourceEvidence && node.kind != NodeKind::Folder)
    {
        if incoming_counts.get(&node.path).copied().unwrap_or(0) == 0 {
            push_finding(
                &mut findings,
                "orphan_source_evidence",
                FindingSeverity::Info,
                node.store,
                vec![node.path.clone()],
                "source evidence has no incoming internal reference".to_string(),
            );
        }
    }
    findings
}

/// Evaluate the deterministic Curator rules against an already materialized snapshot.
///
/// This is public so the accuracy benchmark can exercise the same rule engine as `curator scan`
/// without introducing transport latency or a second implementation of the rules.
pub fn deterministic_findings_for_nodes(
    nodes: &[CuratorScanNode],
    stale_after_days: u32,
    now_ms: i64,
) -> Vec<DeterministicFinding> {
    let all_paths = nodes
        .iter()
        .map(|node| node.path.clone())
        .collect::<BTreeSet<_>>();
    collect_deterministic_findings(nodes, &all_paths, stale_after_days, now_ms)
}

fn collect_skill_findings(
    nodes: &[CuratorScanNode],
    all_paths: &BTreeSet<String>,
    findings: &mut Vec<DeterministicFinding>,
) {
    for skill in nodes
        .iter()
        .filter(|node| node.store == CuratorStore::Skill && node.path.ends_with("/SKILL.md"))
    {
        let Some(base) = skill.path.strip_suffix("/SKILL.md") else {
            continue;
        };
        for (name, kind) in [
            ("manifest.md", "skill_manifest_missing"),
            ("provenance.md", "skill_provenance_missing"),
        ] {
            let expected = format!("{base}/{name}");
            if !all_paths.contains(&expected) {
                push_finding(
                    findings,
                    kind,
                    FindingSeverity::Warning,
                    CuratorStore::Skill,
                    vec![skill.path.clone(), expected.clone()],
                    format!("skill package is missing {name}"),
                );
            }
        }
        let skill_id = base.rsplit('/').next().unwrap_or_default();
        let run_prefix = format!("/Sources/skill-runs/{skill_id}/");
        if !nodes.iter().any(|node| node.path.starts_with(&run_prefix)) {
            push_finding(
                findings,
                "skill_run_evidence_missing",
                FindingSeverity::Info,
                CuratorStore::Skill,
                vec![skill.path.clone(), run_prefix],
                "skill package has no recorded run evidence".to_string(),
            );
        }
    }
}

fn collect_session_findings(nodes: &[CuratorScanNode], findings: &mut Vec<DeterministicFinding>) {
    let session_sources = nodes
        .iter()
        .filter(|node| node.path.starts_with("/Sources/sessions/"))
        .map(|node| node.path.as_str())
        .collect::<Vec<_>>();
    for session in nodes
        .iter()
        .filter(|node| node.store == CuratorStore::Session && node.kind != NodeKind::Folder)
    {
        let linked = session
            .source_evidence
            .iter()
            .any(|source| source.source_path.starts_with("/Sources/sessions/"))
            || session_sources
                .iter()
                .any(|path| session.content.contains(*path));
        if !linked {
            push_finding(
                findings,
                "session_evidence_missing",
                FindingSeverity::Warning,
                CuratorStore::Session,
                vec![session.path.clone()],
                "session node has no reference to /Sources/sessions evidence".to_string(),
            );
        }
    }
}

fn push_finding(
    findings: &mut Vec<DeterministicFinding>,
    kind: &str,
    severity: FindingSeverity,
    store: CuratorStore,
    paths: Vec<String>,
    detail: String,
) {
    findings.push(DeterministicFinding {
        id: format!("D{:06}", findings.len() + 1),
        kind: kind.to_string(),
        severity,
        store,
        paths,
        detail,
    });
}

fn note_role_findings(path: &str, content: &str) -> Vec<(&'static str, String)> {
    let name = path.rsplit('/').next().unwrap_or_default();
    let lower = content.to_lowercase();
    let mut findings = Vec::new();
    if name == "facts.md"
        && lower.lines().any(|line| {
            contains_unnegated_cue(
                line,
                &[
                    "meeting",
                    "check-in",
                    "pending",
                    "tomorrow",
                    "plan to",
                    "scheduled",
                ],
            ) || contains_unnegated_japanese_cue(line, &["明日", "予定", "保留中"])
        })
    {
        findings.push((
            "facts_future_item",
            "facts.md appears to contain future, pending, or scheduled work".to_string(),
        ));
    }
    if name == "summary.md" && contains_exact_evidence(content) {
        findings.push((
            "summary_exact_evidence",
            "summary.md appears to contain exact dated, financial, or version evidence".to_string(),
        ));
    }
    if name == "open_questions.md"
        && (["done", "resolved", "decided", "completed"]
            .iter()
            .any(|word| contains_ascii_word(&lower, word))
            || (lower.contains("解決済み") && !lower.contains("未解決")))
    {
        findings.push((
            "open_question_resolved",
            "open_questions.md appears to contain a resolved item".to_string(),
        ));
    }
    if name == "preferences.md"
        && lower.lines().any(|line| {
            let line = line.trim_start_matches([' ', '-', '*']);
            line.starts_with("[ ]")
                || line.starts_with("todo:")
                || line.starts_with("todo ")
                || line.starts_with("next action:")
                || line.starts_with("次のアクション:")
                || line.starts_with("deadline:")
                || line.starts_with("期限:")
                || line.starts_with("scheduled:")
                || line.starts_with("予定:")
        })
    {
        findings.push((
            "preference_action_item",
            "preferences.md appears to contain a pending action".to_string(),
        ));
    }
    if name == "provenance.md" && !content.contains("/Sources/") {
        findings.push((
            "provenance_source_missing",
            "provenance.md does not reference a /Sources path".to_string(),
        ));
    }
    findings
}

fn contains_unnegated_cue(line: &str, cues: &[&str]) -> bool {
    cues.iter().any(|cue| {
        line.match_indices(cue).any(|(index, _)| {
            let prefix = &line[..index];
            let previous = prefix
                .split(|character: char| !character.is_ascii_alphabetic())
                .rfind(|word| !word.is_empty());
            !matches!(previous, Some("no" | "not" | "without"))
        })
    })
}

fn contains_unnegated_japanese_cue(line: &str, cues: &[&str]) -> bool {
    cues.iter().any(|cue| {
        line.match_indices(cue).any(|(index, matched)| {
            let suffix = &line[index + matched.len()..];
            !suffix.contains("ありません")
                && !suffix.contains("ではない")
                && !suffix.contains("はない")
                && !suffix.contains("なし")
        })
    })
}

fn contains_ascii_word(content: &str, word: &str) -> bool {
    content.match_indices(word).any(|(index, matched)| {
        let before = content[..index].chars().next_back();
        let after = content[index + matched.len()..].chars().next();
        before.is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_')
            && after.is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_')
    })
}

fn contains_exact_evidence(content: &str) -> bool {
    content.lines().any(|line| {
        let bytes = line.as_bytes();
        line.contains('$')
            || line.contains('¥')
            || ((line.to_ascii_lowercase().contains("version") || line.contains("バージョン"))
                && bytes.windows(3).any(|window| {
                    window[0].is_ascii_digit() && window[1] == b'.' && window[2].is_ascii_digit()
                }))
            || bytes.windows(10).any(|window| {
                window[4] == b'-'
                    && window[7] == b'-'
                    && window[..4].iter().all(u8::is_ascii_digit)
                    && window[5..7].iter().all(u8::is_ascii_digit)
                    && window[8..].iter().all(u8::is_ascii_digit)
            })
    })
}

pub(crate) fn store_for_path(path: &str) -> CuratorStore {
    if path_is_under(path, "/Memory") {
        CuratorStore::Memory
    } else if path_is_under(path, "/Knowledge") {
        CuratorStore::Knowledge
    } else if path_is_under(path, "/Skills") {
        CuratorStore::Skill
    } else if path_is_under(path, "/Sessions") {
        CuratorStore::Session
    } else if path_is_under(path, "/Sources") {
        CuratorStore::SourceEvidence
    } else {
        CuratorStore::Other
    }
}

fn path_is_under(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&format!("{root}/"))
}

fn validate_artifact_path(path: &str) -> Result<()> {
    if path.trim() != path || !path.starts_with('/') || path == "/" || path.ends_with('/') {
        bail!("Curator artifact path must be a canonical absolute node path: {path}");
    }
    if path.contains("//")
        || path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
        || path.contains('\\')
        || path.chars().any(char::is_control)
    {
        bail!("Curator artifact path is not canonical: {path}");
    }
    Ok(())
}

fn validate_artifact_id(kind: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        bail!("Curator {kind} id is invalid: {value}");
    }
    Ok(())
}

fn is_mutable_store(store: CuratorStore) -> bool {
    matches!(
        store,
        CuratorStore::Memory
            | CuratorStore::Knowledge
            | CuratorStore::Skill
            | CuratorStore::Session
    )
}

fn is_entry_document(path: &str) -> bool {
    path.ends_with("/index.md") || path.ends_with("/manifest.md") || path.ends_with("/SKILL.md")
}

fn parse_curator_status(content: &str) -> Option<CuratorStatus> {
    parse_curator_status_checked(content).ok().flatten()
}

pub(crate) fn parse_curator_status_checked(content: &str) -> Result<Option<CuratorStatus>, String> {
    let Some((header, _body, _body_start)) = frontmatter_parts(content) else {
        return Ok(None);
    };
    let lines = header.lines().collect::<Vec<_>>();
    let mut status = None;
    let mut curator_blocks = 0;
    let mut index = 0;
    while index < lines.len() {
        if lines[index] == "curator:" {
            curator_blocks += 1;
            index += 1;
            while index < lines.len() && (lines[index].starts_with("  ") || lines[index].is_empty())
            {
                let trimmed = lines[index].trim();
                if let Some(raw) = trimmed.strip_prefix("status:") {
                    if status.is_some() {
                        return Err("curator.status appears more than once".to_string());
                    }
                    let decoded = decode_frontmatter_scalar(raw)
                        .map_err(|_| "curator.status is not a valid scalar".to_string())?
                        .ok_or_else(|| "curator.status must not be null".to_string())?;
                    status = Some(match decoded.as_str() {
                        "active" => CuratorStatus::Active,
                        "stale" => CuratorStatus::Stale,
                        "archived" => CuratorStatus::Archived,
                        _ => return Err(format!("unsupported curator.status: {decoded}")),
                    });
                }
                index += 1;
            }
            continue;
        }
        index += 1;
    }
    if curator_blocks > 1 {
        return Err("curator frontmatter block appears more than once".to_string());
    }
    if curator_blocks == 1 && status.is_none() {
        return Err("curator frontmatter block is missing status".to_string());
    }
    Ok(status)
}

fn frontmatter_parts(content: &str) -> Option<(&str, &str, usize)> {
    let rest = content.strip_prefix("---\n")?;
    let relative_end = rest.find("\n---\n").or_else(|| {
        rest.ends_with("\n---")
            .then_some(rest.len() - "\n---".len())
    })?;
    let header = &rest[..relative_end];
    let delimiter_start = 4 + relative_end;
    let body_start = if content[delimiter_start..].starts_with("\n---\n") {
        delimiter_start + 5
    } else {
        content.len()
    };
    Some((header, &content[body_start..], body_start))
}

pub(crate) fn markdown_body(content: &str) -> &str {
    frontmatter_parts(content)
        .map(|(_, body, _)| body)
        .unwrap_or(content)
}

pub(crate) fn render_curated_content(
    current: &str,
    replacement_body: Option<&str>,
    target_status: Option<CuratorStatus>,
    updated_by: &str,
    updated_at: &str,
) -> Result<String> {
    parse_curator_status_checked(current).map_err(anyhow::Error::msg)?;
    let body = replacement_body.unwrap_or_else(|| markdown_body(current));
    let Some(status) = target_status else {
        if let Some((_, _, body_start)) = frontmatter_parts(current) {
            let body_separator = if replacement_body.is_some() && body_start == current.len() {
                "\n"
            } else {
                ""
            };
            return Ok(format!(
                "{}{}{}",
                &current[..body_start],
                body_separator,
                body
            ));
        }
        return Ok(body.to_string());
    };
    let status = match status {
        CuratorStatus::Active => "active",
        CuratorStatus::Stale => "stale",
        CuratorStatus::Archived => "archived",
    };
    let block = format!(
        "curator:\n  status: {status}\n  updated_at: {}\n  updated_by: {}",
        serde_json::to_string(updated_at)?,
        serde_json::to_string(updated_by)?
    );
    let next_header = frontmatter_parts(current)
        .map(|(header, _, _)| upsert_curator_block(header, &block))
        .transpose()?
        .unwrap_or(block);
    Ok(format!("---\n{next_header}\n---\n{body}"))
}

fn upsert_curator_block(header: &str, block: &str) -> Result<String> {
    let mut block_start = None;
    let mut block_end = header.len();
    let mut offset = 0;
    for line in header.split_inclusive('\n') {
        let value = line.strip_suffix('\n').unwrap_or(line);
        if block_start.is_none() {
            if value == "curator:" {
                block_start = Some(offset);
            }
        } else if !value.starts_with("  ") && !value.is_empty() {
            block_end = offset;
            break;
        }
        offset += line.len();
    }
    let Some(start) = block_start else {
        return Ok(if header.is_empty() {
            block.to_string()
        } else {
            format!("{header}\n{block}")
        });
    };
    let mut next = String::with_capacity(header.len() + block.len());
    next.push_str(&header[..start]);
    next.push_str(block);
    if block_end < header.len() {
        next.push('\n');
        next.push_str(&header[block_end..]);
    }
    Ok(next)
}

fn read_plan(path: &Path) -> Result<CuratorPlanV1> {
    require_private_file(path)?;
    let bytes = std::fs::read(path)
        .with_context(|| format!("failed to read Curator plan: {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid Curator plan JSON: {}", path.display()))
}

#[cfg(test)]
pub(crate) fn parse_and_validate_plan(bytes: &[u8]) -> Result<CuratorPlanV1> {
    let plan: CuratorPlanV1 = serde_json::from_slice(bytes).context("invalid Curator plan JSON")?;
    validate_plan(&plan)?;
    Ok(plan)
}

fn validate_plan(plan: &CuratorPlanV1) -> Result<()> {
    if plan.schema_version != PLAN_SCHEMA {
        bail!("unsupported Curator plan schema: {}", plan.schema_version);
    }
    for (name, value) in [
        ("database_id", plan.database_id.as_str()),
        ("canister_id", plan.canister_id.as_str()),
        ("snapshot_revision", plan.snapshot_revision.as_str()),
        ("agent", plan.agent.as_str()),
    ] {
        if value.trim().is_empty() {
            bail!("Curator plan {name} must not be empty");
        }
    }
    if plan.database_id.len() > 64
        || !plan
            .database_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("Curator plan database_id is invalid");
    }
    Principal::from_text(&plan.canister_id)
        .map_err(|_| anyhow!("Curator plan canister_id is invalid"))?;
    let mut finding_ids = BTreeSet::new();
    for finding in &plan.findings {
        validate_artifact_id("finding", &finding.id)?;
        if finding.kind.trim().is_empty() || finding.summary.trim().is_empty() {
            bail!(
                "semantic finding {} requires a kind and summary",
                finding.id
            );
        }
        if !finding_ids.insert(finding.id.as_str()) {
            bail!("duplicate Curator finding id: {}", finding.id);
        }
        let evidence_paths = finding
            .evidence
            .iter()
            .map(|item| item.path.as_str())
            .collect::<BTreeSet<_>>();
        if finding.paths.iter().collect::<BTreeSet<_>>().len() < 2 || evidence_paths.len() < 2 {
            bail!(
                "semantic finding {} requires at least two evidence paths and excerpts",
                finding.id
            );
        }
        if finding
            .evidence
            .iter()
            .any(|item| item.path.trim().is_empty() || item.excerpt.trim().is_empty())
        {
            bail!("semantic finding {} contains empty evidence", finding.id);
        }
        if !is_mutable_store(finding.store) {
            bail!(
                "semantic finding {} must belong to one of the four stores",
                finding.id
            );
        }
        for path in finding
            .paths
            .iter()
            .map(String::as_str)
            .chain(evidence_paths)
        {
            validate_artifact_path(path)?;
        }
    }
    let mut proposal_ids = BTreeSet::new();
    let mut change_paths = BTreeSet::new();
    let mut operation_count = 0;
    for proposal in &plan.proposals {
        validate_artifact_id("proposal", &proposal.id)?;
        if !proposal_ids.insert(proposal.id.as_str()) {
            bail!("duplicate Curator proposal id: {}", proposal.id);
        }
        if proposal.confidence == FindingConfidence::Low {
            bail!(
                "low-confidence proposal {} must remain report-only",
                proposal.id
            );
        }
        if proposal.finding_ids.is_empty() || proposal.changes.is_empty() {
            bail!(
                "Curator proposal {} must reference findings and changes",
                proposal.id
            );
        }
        if proposal.summary.trim().is_empty() || proposal.rationale.trim().is_empty() {
            bail!(
                "Curator proposal {} requires a summary and rationale",
                proposal.id
            );
        }
        for finding_id in &proposal.finding_ids {
            if !finding_ids.contains(finding_id.as_str()) {
                bail!(
                    "Curator proposal {} references unknown finding {finding_id}",
                    proposal.id
                );
            }
            let finding = plan
                .findings
                .iter()
                .find(|item| &item.id == finding_id)
                .expect("finding id was checked");
            if finding.confidence == FindingConfidence::Low {
                bail!(
                    "Curator proposal {} references low-confidence finding {finding_id}",
                    proposal.id
                );
            }
        }
        for change in &proposal.changes {
            operation_count += 1;
            if !change_paths.insert(change.path.as_str()) {
                bail!(
                    "Curator plan changes the same path more than once: {}",
                    change.path
                );
            }
            validate_artifact_path(&change.path)?;
            if path_is_under(&change.path, "/Sources") {
                bail!("Curator must not mutate source evidence: {}", change.path);
            }
            if !MUTABLE_ROOTS
                .iter()
                .any(|root| path_is_under(&change.path, root))
            {
                bail!(
                    "Curator change path is outside mutable store roots: {}",
                    change.path
                );
            }
            if change.expected_etag.trim().is_empty() {
                bail!(
                    "Curator change expected_etag must not be empty: {}",
                    change.path
                );
            }
            if change.replacement_body.is_none() && change.target_status.is_none() {
                bail!(
                    "Curator change must replace the body or change status: {}",
                    change.path
                );
            }
        }
    }
    if operation_count > MAX_BATCH_OPERATIONS {
        bail!("Curator plan has {operation_count} operations; maximum is {MAX_BATCH_OPERATIONS}");
    }
    Ok(())
}

pub(crate) async fn apply_curator_plan(
    client: &impl VfsApi,
    database_id: &str,
    canister_id: &str,
    plan: &CuratorPlanV1,
    requested: &[String],
    all: bool,
    confirm: bool,
) -> Result<ApplyPreview> {
    validate_plan(plan)?;
    if plan.database_id != database_id {
        bail!("Curator plan database_id does not match selected database");
    }
    if plan.canister_id != canister_id {
        bail!("Curator plan canister_id does not match selected canister");
    }
    let requested_set = requested
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if !all {
        for id in &requested_set {
            if !plan.proposals.iter().any(|proposal| proposal.id == *id) {
                bail!("unknown Curator proposal id: {id}");
            }
        }
    }
    let selected = plan
        .proposals
        .iter()
        .filter(|proposal| all || requested_set.contains(proposal.id.as_str()))
        .collect::<Vec<_>>();
    if selected.is_empty() {
        bail!("no Curator proposals were selected");
    }
    let operation_count = selected
        .iter()
        .map(|proposal| proposal.changes.len())
        .sum::<usize>();
    if operation_count > MAX_BATCH_OPERATIONS {
        bail!(
            "selected Curator proposals have {operation_count} operations; maximum is {MAX_BATCH_OPERATIONS}"
        );
    }
    let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let mut operations = Vec::with_capacity(operation_count);
    let mut previews = Vec::with_capacity(operation_count);
    for proposal in &selected {
        for change in &proposal.changes {
            let current = client
                .read_node(database_id, &change.path)
                .await?
                .ok_or_else(|| anyhow!("Curator target no longer exists: {}", change.path))?;
            if current.kind != NodeKind::File {
                bail!("Curator target must be a file node: {}", change.path);
            }
            if current.etag != change.expected_etag {
                bail!(
                    "Curator etag conflict at {}: expected {}, current {}",
                    change.path,
                    change.expected_etag,
                    current.etag
                );
            }
            let current_status = parse_curator_status_checked(&current.content)
                .map_err(anyhow::Error::msg)?
                .unwrap_or(CuratorStatus::Active);
            let content = render_curated_content(
                &current.content,
                change.replacement_body.as_deref(),
                change.target_status,
                &plan.agent,
                &updated_at,
            )?;
            previews.push(ApplyPreviewChange {
                path: change.path.clone(),
                expected_etag: change.expected_etag.clone(),
                current_status,
                target_status: change.target_status,
                current_body: markdown_body(&current.content).to_string(),
                replacement_body: markdown_body(&content).to_string(),
                content_changed: content != current.content,
            });
            operations.push(NodeMutation::Write(WriteNodeItem {
                path: current.path,
                kind: current.kind,
                content,
                metadata_json: current.metadata_json,
                expected_etag: Some(current.etag),
            }));
        }
    }
    if confirm {
        client
            .mutate_nodes_batch(MutateNodesBatchRequest {
                database_id: database_id.to_string(),
                operations,
            })
            .await?;
    }
    Ok(ApplyPreview {
        dry_run: !confirm,
        selected_proposals: selected
            .iter()
            .map(|proposal| proposal.id.clone())
            .collect(),
        changes: previews,
        applied_operations: if confirm { operation_count } else { 0 },
    })
}

fn print_apply_preview(preview: &ApplyPreview, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(preview)?);
        return Ok(());
    }
    println!(
        "curator {}: proposals={} changes={}",
        if preview.dry_run {
            "dry-run"
        } else {
            "applied"
        },
        preview.selected_proposals.join(","),
        preview.changes.len()
    );
    for change in &preview.changes {
        println!(
            "{} etag={} status={:?}->{:?} content_changed={}\n--- current body ---\n{}\n--- replacement body ---\n{}",
            change.path,
            change.expected_etag,
            change.current_status,
            change.target_status,
            change.content_changed,
            change.current_body,
            change.replacement_body,
        );
    }
    if preview.dry_run {
        println!("no writes performed; rerun with --confirm after reviewing the plan artifact");
    }
    Ok(())
}

pub(crate) fn curator_error_json(error: &anyhow::Error) -> serde_json::Value {
    if let Some(mutation) = error.downcast_ref::<NodeMutationError>() {
        return serde_json::json!({
            "ok": false,
            "error": {
                "code": mutation.code,
                "message": mutation.message,
                "failed_index": mutation.failed_index,
                "conflict_path": mutation.conflict_path,
            }
        });
    }
    serde_json::json!({
        "ok": false,
        "error": { "code": "curator_error", "message": error.to_string() }
    })
}

pub(crate) fn write_private_json(
    path: &Path,
    value: &impl Serialize,
    overwrite: bool,
) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut options = OpenOptions::new();
    options.write(true);
    if overwrite {
        options.create(true);
    } else {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).with_context(|| {
        format!(
            "failed to create private Curator artifact: {}",
            path.display()
        )
    })?;
    if !file.metadata()?.is_file() {
        bail!("Curator artifact is not a regular file: {}", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    if overwrite {
        file.set_len(0)?;
    }
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    Ok(())
}

fn require_private_file(path: &Path) -> Result<()> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("failed to inspect Curator artifact: {}", path.display()))?;
    if !metadata.is_file() {
        bail!("Curator artifact is not a regular file: {}", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!(
                "Curator artifact permissions must be 0600; run chmod 600 {}",
                path.display()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    pub(crate) use super::{
        CuratorStatus, apply_curator_plan, curator_error_json, markdown_body,
        parse_and_validate_plan, parse_curator_status_checked, render_curated_content,
        scan_curator, store_for_path, write_private_json,
    };
}

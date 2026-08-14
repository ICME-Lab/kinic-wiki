// Where: Curator staging accuracy evaluation support.
// What: Build answer-masked labeling inputs and score strict AI-authored labels against scans and plans.
// Why: Synthetic regression cases do not establish accuracy on representative wiki content.
use crate::curator::{
    CuratorEvidenceRef, CuratorLink, CuratorPlanV1, CuratorScanV1, CuratorStore, FindingConfidence,
    require_private_file, store_for_path, validate_plan, write_private_json,
};
use anyhow::{Context, Result, anyhow, bail};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use vfs_types::NodeKind;

pub const INPUT_SCHEMA: &str = "kinic.curator.accuracy-input.v2";
pub const LABELS_SCHEMA: &str = "kinic.curator.accuracy-labels.v1";
pub const REPORT_SCHEMA: &str = "kinic.curator.accuracy-report.v2";
pub const ANNOTATION_SCHEMA: &str = "kinic.curator.accuracy-annotation.v1";
pub const DISPUTES_SCHEMA: &str = "kinic.curator.accuracy-disputes.v1";
pub const ADJUDICATION_SCHEMA: &str = "kinic.curator.accuracy-adjudication.v1";
pub const DETERMINISTIC_RULES: [&str; 16] = [
    "age_review_due",
    "broken_internal_link",
    "facts_future_item",
    "invalid_curator_status",
    "isolated_node",
    "open_question_resolved",
    "orphan_source_evidence",
    "preference_action_item",
    "provenance_source_missing",
    "session_evidence_missing",
    "skill_manifest_missing",
    "skill_provenance_missing",
    "skill_run_evidence_missing",
    "source_evidence_missing",
    "source_newer_than_node",
    "summary_exact_evidence",
];
const SEMANTIC_KINDS: [&str; 2] = ["contradiction", "duplicate"];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorAccuracyInputV2 {
    pub schema_version: String,
    pub database_id: String,
    pub canister_id: String,
    pub snapshot_revision: String,
    pub snapshot_generated_at: String,
    pub stale_after_days: u32,
    pub rules: Vec<DeterministicRuleDefinition>,
    pub nodes: Vec<CuratorAccuracyInputNodeV2>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeterministicRuleDefinition {
    pub kind: String,
    pub definition: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorAccuracyInputNodeV2 {
    pub path: String,
    pub store: CuratorStore,
    pub kind: NodeKind,
    pub raw_content: String,
    pub body_without_frontmatter: String,
    pub updated_at: i64,
    pub etag: String,
    pub outgoing_links: Vec<CuratorLink>,
    pub source_evidence: Vec<CuratorEvidenceRef>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorAccuracyLabelsV1 {
    pub schema_version: String,
    pub database_id: String,
    pub canister_id: String,
    pub snapshot_revision: String,
    pub annotators: Vec<String>,
    pub adjudicator: Option<String>,
    pub adjudicated_disagreements: usize,
    pub evaluated_paths: Vec<String>,
    pub deterministic_positives: Vec<DeterministicPositiveLabel>,
    pub semantic_findings: Vec<SemanticGoldFinding>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeterministicPositiveLabel {
    pub kind: String,
    pub focus_path: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticGoldFinding {
    pub id: String,
    pub kind: String,
    pub confidence: FindingConfidence,
    pub store: CuratorStore,
    pub paths: Vec<String>,
    pub summary: String,
    pub proposal_expected: bool,
    pub allowed_change_paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorAccuracyAnnotationV1 {
    pub schema_version: String,
    pub run_id: String,
    pub deterministic_positives: Vec<DeterministicPositiveLabel>,
    pub semantic_findings: Vec<SemanticAnnotationFinding>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticAnnotationFinding {
    pub kind: String,
    pub confidence: FindingConfidence,
    pub store: CuratorStore,
    pub paths: Vec<String>,
    pub summary: String,
    pub proposal_expected: bool,
    pub allowed_change_paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorAccuracyDisputesV1 {
    pub schema_version: String,
    pub database_id: String,
    pub canister_id: String,
    pub snapshot_revision: String,
    pub annotators: Vec<String>,
    pub deterministic: Vec<DeterministicDispute>,
    pub semantic: Vec<SemanticDispute>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorAccuracyAdjudicationV1 {
    pub schema_version: String,
    pub run_id: String,
    pub deterministic_positives: Vec<DeterministicPositiveLabel>,
    pub deterministic_negatives: Vec<FindingKey>,
    pub semantic_findings: Vec<SemanticAnnotationFinding>,
    pub semantic_negatives: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeterministicDispute {
    pub kind: String,
    pub focus_path: String,
    pub annotation_a: Option<DeterministicPositiveLabel>,
    pub annotation_b: Option<DeterministicPositiveLabel>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticDispute {
    pub key: String,
    pub annotation_a: Option<SemanticAnnotationFinding>,
    pub annotation_b: Option<SemanticAnnotationFinding>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AccuracyCounts {
    pub true_positive: usize,
    pub true_negative: usize,
    pub false_positive: usize,
    pub false_negative: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AccuracyMetrics {
    pub counts: AccuracyCounts,
    pub precision: f64,
    pub recall: f64,
    pub specificity: f64,
    pub f1: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationVerdict {
    Passed,
    Failed,
    InsufficientSample,
    NotEvaluated,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeterministicAccuracyReport {
    pub verdict: EvaluationVerdict,
    pub metrics: AccuracyMetrics,
    pub by_rule: BTreeMap<String, AccuracyMetrics>,
    pub evaluated_node_count: usize,
    pub expected_positive_count: usize,
    pub expected_positive_rule_count: usize,
    pub false_positives: Vec<FindingKey>,
    pub false_negatives: Vec<FindingKey>,
    pub insufficient_sample_reasons: Vec<String>,
    pub threshold_failures: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FindingKey {
    pub kind: String,
    pub focus_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticAccuracyReport {
    pub verdict: EvaluationVerdict,
    pub metrics: Option<AccuracyMetrics>,
    pub correct_proposals: usize,
    pub proposal_count: usize,
    pub proposal_precision: Option<f64>,
    pub expected_proposal_count: usize,
    pub covered_expected_proposal_count: usize,
    pub proposal_recall: Option<f64>,
    pub uncovered_expected_proposals: Vec<String>,
    pub unsafe_proposal_count: usize,
    pub unmatched_expected: Vec<String>,
    pub unmatched_actual: Vec<String>,
    pub violations: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorAccuracyReportV2 {
    pub schema_version: String,
    pub database_id: String,
    pub canister_id: String,
    pub snapshot_revision: String,
    pub generated_at: String,
    pub provisional_ai_evaluation: bool,
    pub annotators: Vec<String>,
    pub adjudicator: Option<String>,
    pub deterministic: DeterministicAccuracyReport,
    pub semantic: SemanticAccuracyReport,
    pub cohorts: Option<BTreeMap<String, AccuracyCohortReport>>,
    pub cohort_violations: Vec<String>,
    pub overall_verdict: EvaluationVerdict,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AccuracyCohortReport {
    pub deterministic: DeterministicAccuracyReport,
    pub semantic: SemanticCohortReport,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticCohortReport {
    pub verdict: EvaluationVerdict,
    pub metrics: Option<AccuracyMetrics>,
    pub expected_proposal_count: usize,
    pub covered_expected_proposal_count: usize,
    pub proposal_recall: Option<f64>,
}

pub fn prepare_file(scan_path: &Path, out_path: &Path, overwrite: bool) -> Result<()> {
    let scan = read_private_json::<CuratorScanV1>(scan_path, "Curator scan")?;
    validate_complete_scan(&scan)?;
    let input = CuratorAccuracyInputV2 {
        schema_version: INPUT_SCHEMA.to_string(),
        database_id: scan.database_id,
        canister_id: scan.canister_id,
        snapshot_revision: scan.snapshot_revision,
        snapshot_generated_at: scan.generated_at,
        stale_after_days: scan.stale_after_days,
        rules: deterministic_rule_definitions(),
        nodes: scan
            .nodes
            .into_iter()
            .map(|node| CuratorAccuracyInputNodeV2 {
                path: node.path,
                store: node.store,
                kind: node.kind,
                raw_content: node.content,
                body_without_frontmatter: node.body,
                updated_at: node.updated_at,
                etag: node.etag,
                outgoing_links: node.outgoing_links,
                source_evidence: node.source_evidence,
            })
            .collect(),
    };
    write_private_json(out_path, &input, overwrite)
}

pub fn compare_annotation_files(
    input_path: &Path,
    annotation_a_path: &Path,
    annotation_b_path: &Path,
    out_path: &Path,
    overwrite: bool,
) -> Result<CuratorAccuracyDisputesV1> {
    let input = read_private_json::<CuratorAccuracyInputV2>(input_path, "accuracy input")?;
    let a = read_private_json::<CuratorAccuracyAnnotationV1>(annotation_a_path, "annotation A")?;
    let b = read_private_json::<CuratorAccuracyAnnotationV1>(annotation_b_path, "annotation B")?;
    validate_annotation_pair(&input, &a, &b)?;
    let disputes = build_disputes(&input, &a, &b)?;
    write_private_json(out_path, &disputes, overwrite)?;
    Ok(disputes)
}

pub fn finalize_labels_file(
    input_path: &Path,
    annotation_a_path: &Path,
    annotation_b_path: &Path,
    adjudication_path: Option<&Path>,
    out_path: &Path,
    overwrite: bool,
) -> Result<CuratorAccuracyLabelsV1> {
    let input = read_private_json::<CuratorAccuracyInputV2>(input_path, "accuracy input")?;
    let a = read_private_json::<CuratorAccuracyAnnotationV1>(annotation_a_path, "annotation A")?;
    let b = read_private_json::<CuratorAccuracyAnnotationV1>(annotation_b_path, "annotation B")?;
    validate_annotation_pair(&input, &a, &b)?;
    let disputes = build_disputes(&input, &a, &b)?;
    let disagreement_count = disputes.deterministic.len() + disputes.semantic.len();
    let adjudication = adjudication_path
        .map(|path| read_private_json::<CuratorAccuracyAdjudicationV1>(path, "adjudication"))
        .transpose()?;
    if disagreement_count == 0 && adjudication.is_some() {
        bail!("adjudication must be absent when annotations agree");
    }
    if disagreement_count > 0 && adjudication.is_none() {
        bail!("adjudication is required when annotations disagree");
    }
    if let Some(adjudication) = &adjudication {
        validate_adjudication(&input, adjudication)?;
        if adjudication.run_id == a.run_id || adjudication.run_id == b.run_id {
            bail!("adjudicator must be distinct from both annotators");
        }
    }

    let a_deterministic = deterministic_annotation_map(&a.deterministic_positives);
    let b_deterministic = deterministic_annotation_map(&b.deterministic_positives);
    let disputed_deterministic = disputes
        .deterministic
        .iter()
        .map(|item| (item.kind.as_str(), item.focus_path.as_str()))
        .collect::<BTreeSet<_>>();
    let mut deterministic_positives = a_deterministic
        .iter()
        .filter(|(key, _)| {
            b_deterministic.contains_key(*key) && !disputed_deterministic.contains(key)
        })
        .map(|(_, label)| (*label).clone())
        .collect::<Vec<_>>();
    if let Some(adjudication) = &adjudication {
        let positive_keys = adjudication
            .deterministic_positives
            .iter()
            .map(|label| (label.kind.as_str(), label.focus_path.as_str()))
            .collect::<BTreeSet<_>>();
        let negative_keys = adjudication
            .deterministic_negatives
            .iter()
            .map(|label| (label.kind.as_str(), label.focus_path.as_str()))
            .collect::<BTreeSet<_>>();
        if !positive_keys.is_disjoint(&negative_keys)
            || positive_keys
                .union(&negative_keys)
                .copied()
                .collect::<BTreeSet<_>>()
                != disputed_deterministic
        {
            bail!("adjudication must resolve every deterministic dispute exactly once");
        }
        for label in &adjudication.deterministic_positives {
            let key = (label.kind.as_str(), label.focus_path.as_str());
            if !disputed_deterministic.contains(&key) {
                bail!("adjudication contains a deterministic result outside the disputes");
            }
            deterministic_positives.push(label.clone());
        }
    }

    let a_semantic = semantic_annotation_map(&a.semantic_findings)?;
    let b_semantic = semantic_annotation_map(&b.semantic_findings)?;
    let disputed_semantic = disputes
        .semantic
        .iter()
        .map(|item| item.key.as_str())
        .collect::<BTreeSet<_>>();
    let mut semantic = a_semantic
        .iter()
        .filter(|(key, value)| {
            b_semantic.get(*key).is_some_and(|other| *value == other)
                && !disputed_semantic.contains(key.as_str())
        })
        .map(|(_, finding)| (*finding).clone())
        .collect::<Vec<_>>();
    if let Some(adjudication) = &adjudication {
        let mut positive_keys = BTreeSet::new();
        for finding in &adjudication.semantic_findings {
            let key = semantic_annotation_key(finding)?;
            if !disputed_semantic.contains(key.as_str()) {
                bail!("adjudication contains a semantic result outside the disputes");
            }
            let is_candidate = a_semantic
                .get(&key)
                .is_some_and(|candidate| *candidate == finding)
                || b_semantic
                    .get(&key)
                    .is_some_and(|candidate| *candidate == finding);
            if !is_candidate {
                bail!("semantic adjudication must select one disputed candidate exactly");
            }
            positive_keys.insert(key);
            semantic.push(finding.clone());
        }
        let negative_keys = adjudication
            .semantic_negatives
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        if negative_keys.len() != adjudication.semantic_negatives.len()
            || !positive_keys.is_disjoint(&negative_keys)
            || positive_keys
                .union(&negative_keys)
                .cloned()
                .collect::<BTreeSet<_>>()
                != disputed_semantic
                    .iter()
                    .map(|key| (*key).to_string())
                    .collect()
        {
            bail!("adjudication must resolve every semantic dispute exactly once");
        }
    }
    deterministic_positives.sort_by(|left, right| {
        (&left.kind, &left.focus_path).cmp(&(&right.kind, &right.focus_path))
    });
    semantic.sort_by(|left, right| {
        semantic_annotation_key(left)
            .expect("validated semantic annotation")
            .cmp(&semantic_annotation_key(right).expect("validated semantic annotation"))
    });
    let semantic_findings = semantic
        .into_iter()
        .enumerate()
        .map(|(index, finding)| SemanticGoldFinding {
            id: format!("AI-G{:03}", index + 1),
            kind: finding.kind,
            confidence: finding.confidence,
            store: finding.store,
            paths: finding.paths,
            summary: finding.summary,
            proposal_expected: finding.proposal_expected,
            allowed_change_paths: finding.allowed_change_paths,
        })
        .collect();
    let labels = CuratorAccuracyLabelsV1 {
        schema_version: LABELS_SCHEMA.to_string(),
        database_id: input.database_id,
        canister_id: input.canister_id,
        snapshot_revision: input.snapshot_revision,
        annotators: vec![a.run_id, b.run_id],
        adjudicator: adjudication.as_ref().map(|item| item.run_id.clone()),
        adjudicated_disagreements: disagreement_count,
        evaluated_paths: input
            .nodes
            .iter()
            .filter(|node| node.kind != NodeKind::Folder)
            .map(|node| node.path.clone())
            .collect(),
        deterministic_positives,
        semantic_findings,
    };
    write_private_json(out_path, &labels, overwrite)?;
    Ok(labels)
}

fn validate_annotation_pair(
    input: &CuratorAccuracyInputV2,
    a: &CuratorAccuracyAnnotationV1,
    b: &CuratorAccuracyAnnotationV1,
) -> Result<()> {
    validate_annotation(input, a)?;
    validate_annotation(input, b)?;
    if a.run_id == b.run_id {
        bail!("accuracy annotations require two distinct run identifiers");
    }
    Ok(())
}

fn validate_annotation(
    input: &CuratorAccuracyInputV2,
    annotation: &CuratorAccuracyAnnotationV1,
) -> Result<()> {
    if input.schema_version != INPUT_SCHEMA || annotation.schema_version != ANNOTATION_SCHEMA {
        bail!("unsupported accuracy input or annotation schema");
    }
    if annotation.run_id.trim().is_empty() {
        bail!("accuracy annotation run_id must be non-empty");
    }
    let paths = input
        .nodes
        .iter()
        .filter(|node| node.kind != NodeKind::Folder)
        .map(|node| node.path.as_str())
        .collect::<BTreeSet<_>>();
    let known_rules = DETERMINISTIC_RULES.into_iter().collect::<BTreeSet<_>>();
    let mut deterministic = BTreeSet::new();
    for label in &annotation.deterministic_positives {
        if !known_rules.contains(label.kind.as_str())
            || !paths.contains(label.focus_path.as_str())
            || label.reason.trim().is_empty()
            || !deterministic.insert((label.kind.as_str(), label.focus_path.as_str()))
        {
            bail!("accuracy annotation contains an invalid deterministic result");
        }
    }
    semantic_annotation_map(&annotation.semantic_findings)?;
    for finding in &annotation.semantic_findings {
        let finding_paths = normalized_paths(&finding.paths)?;
        let allowed = normalized_paths(&finding.allowed_change_paths)?;
        if finding.summary.trim().is_empty()
            || !SEMANTIC_KINDS.contains(&finding.kind.as_str())
            || finding_paths.len() < 2
            || finding_paths
                .iter()
                .any(|path| !paths.contains(path.as_str()))
            || finding_paths
                .iter()
                .any(|path| mutable_store_for_path(path) != Some(finding.store))
            || allowed.iter().any(|path| !finding_paths.contains(path))
            || finding.proposal_expected == allowed.is_empty()
            || (finding.confidence == FindingConfidence::Low && finding.proposal_expected)
        {
            bail!("accuracy annotation contains an invalid semantic result");
        }
    }
    Ok(())
}

fn validate_adjudication(
    input: &CuratorAccuracyInputV2,
    adjudication: &CuratorAccuracyAdjudicationV1,
) -> Result<()> {
    if adjudication.schema_version != ADJUDICATION_SCHEMA || adjudication.run_id.trim().is_empty() {
        bail!("unsupported or empty accuracy adjudication");
    }
    let projection = CuratorAccuracyAnnotationV1 {
        schema_version: ANNOTATION_SCHEMA.to_string(),
        run_id: adjudication.run_id.clone(),
        deterministic_positives: adjudication.deterministic_positives.clone(),
        semantic_findings: adjudication.semantic_findings.clone(),
    };
    validate_annotation(input, &projection)?;
    let known_rules = DETERMINISTIC_RULES.into_iter().collect::<BTreeSet<_>>();
    let paths = input
        .nodes
        .iter()
        .map(|node| node.path.as_str())
        .collect::<BTreeSet<_>>();
    let mut negatives = BTreeSet::new();
    for negative in &adjudication.deterministic_negatives {
        if !known_rules.contains(negative.kind.as_str())
            || !paths.contains(negative.focus_path.as_str())
            || !negatives.insert((negative.kind.as_str(), negative.focus_path.as_str()))
        {
            bail!("accuracy adjudication contains an invalid deterministic negative");
        }
    }
    Ok(())
}

fn deterministic_annotation_map(
    labels: &[DeterministicPositiveLabel],
) -> BTreeMap<(&str, &str), &DeterministicPositiveLabel> {
    labels
        .iter()
        .map(|label| ((label.kind.as_str(), label.focus_path.as_str()), label))
        .collect()
}

fn semantic_annotation_key(finding: &SemanticAnnotationFinding) -> Result<String> {
    Ok(semantic_key(
        &finding.kind,
        finding.store,
        &normalized_paths(&finding.paths)?,
    ))
}

fn semantic_annotation_map(
    findings: &[SemanticAnnotationFinding],
) -> Result<BTreeMap<String, &SemanticAnnotationFinding>> {
    let mut output = BTreeMap::new();
    for finding in findings {
        let key = semantic_annotation_key(finding)?;
        if output.insert(key, finding).is_some() {
            bail!("accuracy annotation contains duplicate semantic findings");
        }
    }
    Ok(output)
}

fn build_disputes(
    input: &CuratorAccuracyInputV2,
    a: &CuratorAccuracyAnnotationV1,
    b: &CuratorAccuracyAnnotationV1,
) -> Result<CuratorAccuracyDisputesV1> {
    let a_deterministic = deterministic_annotation_map(&a.deterministic_positives);
    let b_deterministic = deterministic_annotation_map(&b.deterministic_positives);
    let deterministic_keys = a_deterministic
        .keys()
        .chain(b_deterministic.keys())
        .copied()
        .collect::<BTreeSet<_>>();
    let deterministic = deterministic_keys
        .into_iter()
        .filter(|key| a_deterministic.contains_key(key) != b_deterministic.contains_key(key))
        .map(|(kind, focus_path)| DeterministicDispute {
            kind: kind.to_string(),
            focus_path: focus_path.to_string(),
            annotation_a: a_deterministic
                .get(&(kind, focus_path))
                .map(|label| (*label).clone()),
            annotation_b: b_deterministic
                .get(&(kind, focus_path))
                .map(|label| (*label).clone()),
        })
        .collect();
    let a_semantic = semantic_annotation_map(&a.semantic_findings)?;
    let b_semantic = semantic_annotation_map(&b.semantic_findings)?;
    let semantic_keys = a_semantic
        .keys()
        .chain(b_semantic.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let semantic = semantic_keys
        .into_iter()
        .filter(|key| a_semantic.get(key) != b_semantic.get(key))
        .map(|key| SemanticDispute {
            annotation_a: a_semantic.get(&key).map(|finding| (*finding).clone()),
            annotation_b: b_semantic.get(&key).map(|finding| (*finding).clone()),
            key,
        })
        .collect();
    Ok(CuratorAccuracyDisputesV1 {
        schema_version: DISPUTES_SCHEMA.to_string(),
        database_id: input.database_id.clone(),
        canister_id: input.canister_id.clone(),
        snapshot_revision: input.snapshot_revision.clone(),
        annotators: vec![a.run_id.clone(), b.run_id.clone()],
        deterministic,
        semantic,
    })
}

fn deterministic_rule_definitions() -> Vec<DeterministicRuleDefinition> {
    [
        (
            "age_review_due",
            "The node is older than stale_after_days at snapshot_generated_at.",
        ),
        (
            "broken_internal_link",
            "An outgoing internal wiki link targets a path absent from this snapshot.",
        ),
        (
            "facts_future_item",
            "A facts.md note contains a future or pending action instead of a durable fact.",
        ),
        (
            "invalid_curator_status",
            "Raw YAML frontmatter has curator.status other than active, stale, or archived.",
        ),
        (
            "isolated_node",
            "An organized mutable node has neither incoming nor outgoing internal links.",
        ),
        (
            "open_question_resolved",
            "An open_questions.md note states that a question or decision is resolved.",
        ),
        (
            "orphan_source_evidence",
            "A /Sources evidence node has no incoming reference from an organized node.",
        ),
        (
            "preference_action_item",
            "A preferences.md note contains an unresolved action item rather than a preference.",
        ),
        (
            "provenance_source_missing",
            "A provenance.md note has no /Sources evidence reference.",
        ),
        (
            "session_evidence_missing",
            "A /Sessions note has no valid session evidence reference under /Sources.",
        ),
        (
            "skill_manifest_missing",
            "A Skill root containing SKILL.md has no manifest.md sibling.",
        ),
        (
            "skill_provenance_missing",
            "A Skill root containing SKILL.md has no provenance.md sibling.",
        ),
        (
            "skill_run_evidence_missing",
            "A Skill has no valid run-evidence reference under /Sources/skill-runs.",
        ),
        (
            "source_evidence_missing",
            "An organized mutable node has no /Sources evidence reference.",
        ),
        (
            "source_newer_than_node",
            "Referenced source evidence was updated after the organized node.",
        ),
        (
            "summary_exact_evidence",
            "A summary.md note repeats exact evidence-level facts instead of summarizing them.",
        ),
    ]
    .into_iter()
    .map(|(kind, definition)| DeterministicRuleDefinition {
        kind: kind.to_string(),
        definition: definition.to_string(),
    })
    .collect()
}

pub fn score_file(
    scan_path: &Path,
    labels_path: &Path,
    plan_path: Option<&Path>,
    out_path: &Path,
    overwrite: bool,
) -> Result<CuratorAccuracyReportV2> {
    let scan = read_private_json::<CuratorScanV1>(scan_path, "Curator scan")?;
    let labels = read_private_json::<CuratorAccuracyLabelsV1>(labels_path, "accuracy labels")?;
    let plan = plan_path
        .map(|path| read_private_json::<CuratorPlanV1>(path, "Curator plan"))
        .transpose()?;
    let report = score(&scan, &labels, plan.as_ref())?;
    write_private_json(out_path, &report, overwrite)?;
    Ok(report)
}

pub fn score_file_with_seed_manifest(
    scan_path: &Path,
    labels_path: &Path,
    plan_path: Option<&Path>,
    seed_manifest_path: &Path,
    out_path: &Path,
    overwrite: bool,
) -> Result<CuratorAccuracyReportV2> {
    let scan = read_private_json::<CuratorScanV1>(scan_path, "Curator scan")?;
    let labels = read_private_json::<CuratorAccuracyLabelsV1>(labels_path, "accuracy labels")?;
    let plan = plan_path
        .map(|path| read_private_json::<CuratorPlanV1>(path, "Curator plan"))
        .transpose()?;
    let seed_manifest: crate::curator_accuracy_seed::CuratorAccuracySeedManifestV1 =
        read_private_json(seed_manifest_path, "seed manifest")?;
    crate::curator_accuracy_seed::validate_seed_manifest(&seed_manifest)?;
    let seed_paths = seed_manifest
        .nodes
        .iter()
        .filter(|node| node.kind != NodeKind::Folder)
        .map(|node| node.path.clone())
        .collect::<BTreeSet<_>>();
    let report = score_with_cohorts(&scan, &labels, plan.as_ref(), &seed_paths)?;
    write_private_json(out_path, &report, overwrite)?;
    Ok(report)
}

pub fn score(
    scan: &CuratorScanV1,
    labels: &CuratorAccuracyLabelsV1,
    plan: Option<&CuratorPlanV1>,
) -> Result<CuratorAccuracyReportV2> {
    validate_complete_scan(scan)?;
    validate_labels(scan, labels)?;
    let deterministic = score_deterministic(scan, labels)?;
    let semantic = match plan {
        Some(plan) => score_semantic(scan, labels, plan)?,
        None => SemanticAccuracyReport {
            verdict: EvaluationVerdict::NotEvaluated,
            metrics: None,
            correct_proposals: 0,
            proposal_count: 0,
            proposal_precision: None,
            expected_proposal_count: 0,
            covered_expected_proposal_count: 0,
            proposal_recall: None,
            uncovered_expected_proposals: Vec::new(),
            unsafe_proposal_count: 0,
            unmatched_expected: Vec::new(),
            unmatched_actual: Vec::new(),
            violations: Vec::new(),
        },
    };
    let overall_verdict = combine_verdicts(deterministic.verdict, semantic.verdict);
    Ok(CuratorAccuracyReportV2 {
        schema_version: REPORT_SCHEMA.to_string(),
        database_id: scan.database_id.clone(),
        canister_id: scan.canister_id.clone(),
        snapshot_revision: scan.snapshot_revision.clone(),
        generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        provisional_ai_evaluation: true,
        annotators: labels.annotators.clone(),
        adjudicator: labels.adjudicator.clone(),
        deterministic,
        semantic,
        cohorts: None,
        cohort_violations: Vec::new(),
        overall_verdict,
    })
}

pub(crate) fn score_with_cohorts(
    scan: &CuratorScanV1,
    labels: &CuratorAccuracyLabelsV1,
    plan: Option<&CuratorPlanV1>,
    seed_paths: &BTreeSet<String>,
) -> Result<CuratorAccuracyReportV2> {
    let evaluated = labels
        .evaluated_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if !seed_paths.is_subset(&evaluated) {
        bail!("seed manifest contains paths outside the evaluated scan");
    }
    let controlled = seed_paths
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let existing_owned = evaluated
        .difference(seed_paths)
        .cloned()
        .collect::<BTreeSet<_>>();
    let existing = existing_owned
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut report = score(scan, labels, plan)?;
    let mut violations = Vec::new();
    let controlled_report = score_cohort(
        scan,
        labels,
        plan,
        &report.semantic,
        &controlled,
        seed_paths,
        true,
        &mut violations,
    )?;
    let existing_report = score_cohort(
        scan,
        labels,
        plan,
        &report.semantic,
        &existing,
        seed_paths,
        false,
        &mut violations,
    )?;
    let mut cohorts = BTreeMap::new();
    cohorts.insert("controlled_seed".to_string(), controlled_report);
    cohorts.insert("staging_existing".to_string(), existing_report);
    let mut cohort_verdict = EvaluationVerdict::Passed;
    for cohort in cohorts.values() {
        cohort_verdict = combine_verdicts(cohort_verdict, cohort.deterministic.verdict);
        cohort_verdict = combine_verdicts(cohort_verdict, cohort.semantic.verdict);
    }
    if !violations.is_empty() {
        cohort_verdict = EvaluationVerdict::Failed;
    }
    report.overall_verdict = combine_verdicts(report.overall_verdict, cohort_verdict);
    report.cohorts = Some(cohorts);
    report.cohort_violations = violations;
    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn score_cohort(
    scan: &CuratorScanV1,
    labels: &CuratorAccuracyLabelsV1,
    plan: Option<&CuratorPlanV1>,
    overall_semantic: &SemanticAccuracyReport,
    paths: &BTreeSet<&str>,
    seed_paths: &BTreeSet<String>,
    seed_cohort: bool,
    violations: &mut Vec<String>,
) -> Result<AccuracyCohortReport> {
    let deterministic = score_deterministic_for_paths(scan, labels, paths)?;
    let Some(plan) = plan else {
        return Ok(AccuracyCohortReport {
            deterministic,
            semantic: SemanticCohortReport {
                verdict: EvaluationVerdict::NotEvaluated,
                metrics: None,
                expected_proposal_count: 0,
                covered_expected_proposal_count: 0,
                proposal_recall: None,
            },
        });
    };
    let belongs = |finding_paths: &[String]| {
        let seed_count = finding_paths
            .iter()
            .filter(|path| seed_paths.contains(*path))
            .count();
        if seed_count != 0 && seed_count != finding_paths.len() {
            None
        } else {
            Some((seed_count == finding_paths.len()) == seed_cohort)
        }
    };
    let mut expected = BTreeMap::new();
    for finding in labels
        .semantic_findings
        .iter()
        .filter(|finding| finding.confidence != FindingConfidence::Low)
    {
        match belongs(&finding.paths) {
            Some(true) => {
                let normalized = normalized_paths(&finding.paths)?;
                expected.insert(
                    semantic_key(&finding.kind, finding.store, &normalized),
                    finding,
                );
            }
            Some(false) => {}
            None => violations.push(format!(
                "semantic gold finding {} crosses accuracy cohorts",
                finding.id
            )),
        }
    }
    let mut actual = BTreeSet::new();
    for finding in plan
        .findings
        .iter()
        .filter(|finding| finding.confidence != FindingConfidence::Low)
    {
        match belongs(&finding.paths) {
            Some(true) => {
                let normalized = normalized_paths(&finding.paths)?;
                actual.insert(semantic_key(&finding.kind, finding.store, &normalized));
            }
            Some(false) => {}
            None => violations.push(format!(
                "plan finding {} crosses accuracy cohorts",
                finding.id
            )),
        }
    }
    let expected_keys = expected.keys().cloned().collect::<BTreeSet<_>>();
    let counts = AccuracyCounts {
        true_positive: expected_keys.intersection(&actual).count(),
        false_positive: actual.difference(&expected_keys).count(),
        false_negative: expected_keys.difference(&actual).count(),
        ..AccuracyCounts::default()
    };
    let metrics = metrics(counts);
    let expected_proposals = expected
        .iter()
        .filter(|(_, finding)| finding.proposal_expected)
        .map(|(key, _)| key.clone())
        .collect::<BTreeSet<_>>();
    let uncovered = overall_semantic
        .uncovered_expected_proposals
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let covered_expected_proposal_count = expected_proposals.difference(&uncovered).count();
    let expected_proposal_count = expected_proposals.len();
    let proposal_recall = (expected_proposal_count > 0)
        .then(|| covered_expected_proposal_count as f64 / expected_proposal_count as f64);
    let verdict = if expected_keys.is_empty() && actual.is_empty() {
        EvaluationVerdict::InsufficientSample
    } else if metrics.precision >= 0.80
        && metrics.recall >= 0.80
        && covered_expected_proposal_count == expected_proposal_count
    {
        EvaluationVerdict::Passed
    } else {
        EvaluationVerdict::Failed
    };
    Ok(AccuracyCohortReport {
        deterministic,
        semantic: SemanticCohortReport {
            verdict,
            metrics: Some(metrics),
            expected_proposal_count,
            covered_expected_proposal_count,
            proposal_recall,
        },
    })
}

fn validate_complete_scan(scan: &CuratorScanV1) -> Result<()> {
    if scan.schema_version != "kinic.curator.scan.v1" {
        bail!("unsupported Curator scan schema: {}", scan.schema_version);
    }
    if !scan.coverage.complete
        || !scan.coverage.inspection_errors.is_empty()
        || !scan.coverage.truncated_link_paths.is_empty()
    {
        bail!("accuracy evaluation requires complete, untruncated scan coverage");
    }
    if scan.coverage.node_count != scan.nodes.len() {
        bail!("Curator scan node count does not match coverage");
    }
    Ok(())
}

fn validate_labels(scan: &CuratorScanV1, labels: &CuratorAccuracyLabelsV1) -> Result<()> {
    if labels.schema_version != LABELS_SCHEMA {
        bail!(
            "unsupported Curator accuracy labels schema: {}",
            labels.schema_version
        );
    }
    for (name, expected, actual) in [
        (
            "database_id",
            scan.database_id.as_str(),
            labels.database_id.as_str(),
        ),
        (
            "canister_id",
            scan.canister_id.as_str(),
            labels.canister_id.as_str(),
        ),
        (
            "snapshot_revision",
            scan.snapshot_revision.as_str(),
            labels.snapshot_revision.as_str(),
        ),
    ] {
        if expected != actual {
            bail!("accuracy labels {name} does not match the scan");
        }
    }
    let annotators = labels
        .annotators
        .iter()
        .map(|value| value.trim())
        .collect::<BTreeSet<_>>();
    if labels.annotators.len() != 2 || annotators.len() != 2 || annotators.contains("") {
        bail!("accuracy labels require two distinct non-empty AI annotators");
    }
    if labels.adjudicated_disagreements > 0 {
        let adjudicator = labels
            .adjudicator
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow!("AI adjudicator is required when disagreements were adjudicated")
            })?;
        if annotators.contains(adjudicator) {
            bail!("AI adjudicator must be distinct from the two annotators");
        }
    } else if labels.adjudicator.is_some() {
        bail!("AI adjudicator must be absent when no disagreements were adjudicated");
    }

    let expected_paths = scan
        .nodes
        .iter()
        .filter(|node| node.kind != NodeKind::Folder)
        .map(|node| node.path.as_str())
        .collect::<BTreeSet<_>>();
    let evaluated_paths = labels
        .evaluated_paths
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if evaluated_paths.len() != labels.evaluated_paths.len() {
        bail!("accuracy labels contain duplicate evaluated paths");
    }
    if evaluated_paths != expected_paths {
        bail!("accuracy labels must cover every non-folder scan path exactly once");
    }

    let known_rules = DETERMINISTIC_RULES.into_iter().collect::<BTreeSet<_>>();
    let mut positive_keys = BTreeSet::new();
    for label in &labels.deterministic_positives {
        if !known_rules.contains(label.kind.as_str()) {
            bail!("unknown deterministic accuracy rule: {}", label.kind);
        }
        if !evaluated_paths.contains(label.focus_path.as_str()) {
            bail!(
                "deterministic label path is not evaluated: {}",
                label.focus_path
            );
        }
        if label.reason.trim().is_empty() {
            bail!("deterministic positive label requires a reason");
        }
        if !positive_keys.insert((label.kind.as_str(), label.focus_path.as_str())) {
            bail!(
                "duplicate deterministic positive label: {} {}",
                label.kind,
                label.focus_path
            );
        }
    }

    let mut semantic_ids = BTreeSet::new();
    let mut semantic_keys = BTreeSet::new();
    for finding in &labels.semantic_findings {
        if finding.id.trim().is_empty() || finding.summary.trim().is_empty() {
            bail!("semantic gold finding requires a non-empty id and summary");
        }
        if !semantic_ids.insert(finding.id.as_str()) {
            bail!("duplicate semantic gold finding id: {}", finding.id);
        }
        if !SEMANTIC_KINDS.contains(&finding.kind.as_str()) {
            bail!("semantic gold kind must be duplicate or contradiction");
        }
        let paths = normalized_paths(&finding.paths)?;
        if paths.len() < 2
            || paths
                .iter()
                .any(|path| !evaluated_paths.contains(path.as_str()))
        {
            bail!("semantic gold finding must use at least two evaluated paths");
        }
        if paths
            .iter()
            .any(|path| mutable_store_for_path(path) != Some(finding.store))
        {
            bail!("semantic gold finding must stay within its declared mutable store");
        }
        let key = semantic_key(&finding.kind, finding.store, &paths);
        if !semantic_keys.insert(key) {
            bail!("duplicate semantic gold finding");
        }
        let allowed = normalized_paths(&finding.allowed_change_paths)?;
        if allowed.iter().any(|path| !paths.contains(path)) {
            bail!("semantic gold allowed changes must be finding paths");
        }
        if finding.proposal_expected == allowed.is_empty() {
            bail!("proposal_expected must match whether allowed_change_paths is non-empty");
        }
        if finding.confidence == FindingConfidence::Low && finding.proposal_expected {
            bail!("low-confidence semantic gold findings cannot expect proposals");
        }
    }
    Ok(())
}

fn score_deterministic(
    scan: &CuratorScanV1,
    labels: &CuratorAccuracyLabelsV1,
) -> Result<DeterministicAccuracyReport> {
    let paths = labels
        .evaluated_paths
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    score_deterministic_for_paths(scan, labels, &paths)
}

fn score_deterministic_for_paths(
    scan: &CuratorScanV1,
    labels: &CuratorAccuracyLabelsV1,
    paths: &BTreeSet<&str>,
) -> Result<DeterministicAccuracyReport> {
    let expected = labels
        .deterministic_positives
        .iter()
        .map(|label| FindingKey {
            kind: label.kind.clone(),
            focus_path: label.focus_path.clone(),
        })
        .collect::<BTreeSet<_>>();
    let known_rules = DETERMINISTIC_RULES.into_iter().collect::<BTreeSet<_>>();
    let mut actual = BTreeSet::new();
    for finding in &scan.findings {
        if !known_rules.contains(finding.kind.as_str()) {
            bail!("scan contains unknown deterministic rule: {}", finding.kind);
        }
        let focus_path = finding
            .paths
            .first()
            .ok_or_else(|| anyhow!("scan finding {} has no focus path", finding.id))?;
        if !labels.evaluated_paths.iter().any(|path| path == focus_path) {
            bail!("scan finding focus path is not in the evaluation set: {focus_path}");
        }
        if !paths.contains(focus_path.as_str()) {
            continue;
        }
        actual.insert(FindingKey {
            kind: finding.kind.clone(),
            focus_path: focus_path.clone(),
        });
    }

    let mut overall = AccuracyCounts::default();
    let mut by_rule_counts = BTreeMap::<String, AccuracyCounts>::new();
    for rule in DETERMINISTIC_RULES {
        for path in paths {
            let key = FindingKey {
                kind: rule.to_string(),
                focus_path: (*path).to_string(),
            };
            record(&mut overall, expected.contains(&key), actual.contains(&key));
            record(
                by_rule_counts.entry(rule.to_string()).or_default(),
                expected.contains(&key),
                actual.contains(&key),
            );
        }
    }
    let overall_metrics = metrics(overall);
    let by_rule = by_rule_counts
        .into_iter()
        .map(|(rule, counts)| (rule, metrics(counts)))
        .collect::<BTreeMap<_, _>>();
    let mut insufficient_sample_reasons = Vec::new();
    if paths.len() < 100 {
        insufficient_sample_reasons.push("fewer than 100 evaluated non-folder nodes".to_string());
    }
    if expected.len() < 30 {
        insufficient_sample_reasons.push("fewer than 30 expected positive findings".to_string());
    }
    let expected_positive_rule_count = expected
        .iter()
        .map(|key| key.kind.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    if expected_positive_rule_count < 8 {
        insufficient_sample_reasons.push("expected positives cover fewer than 8 rules".to_string());
    }
    let mut threshold_failures = Vec::new();
    if overall_metrics.precision < 0.90 {
        threshold_failures.push("overall precision is below 0.90".to_string());
    }
    if overall_metrics.recall < 0.90 {
        threshold_failures.push("overall recall is below 0.90".to_string());
    }
    if overall_metrics.f1 < 0.90 {
        threshold_failures.push("overall F1 is below 0.90".to_string());
    }
    for (rule, rule_metrics) in &by_rule {
        let expected_positive =
            rule_metrics.counts.true_positive + rule_metrics.counts.false_negative;
        let predicted_positive =
            rule_metrics.counts.true_positive + rule_metrics.counts.false_positive;
        if expected_positive >= 5 && rule_metrics.recall < 0.80 {
            threshold_failures.push(format!("{rule} recall is below 0.80"));
        }
        if predicted_positive >= 5 && rule_metrics.precision < 0.80 {
            threshold_failures.push(format!("{rule} precision is below 0.80"));
        }
    }
    let verdict = if !insufficient_sample_reasons.is_empty() {
        EvaluationVerdict::InsufficientSample
    } else if threshold_failures.is_empty() {
        EvaluationVerdict::Passed
    } else {
        EvaluationVerdict::Failed
    };
    Ok(DeterministicAccuracyReport {
        verdict,
        metrics: overall_metrics,
        by_rule,
        evaluated_node_count: paths.len(),
        expected_positive_count: expected.len(),
        expected_positive_rule_count,
        false_positives: actual.difference(&expected).cloned().collect(),
        false_negatives: expected.difference(&actual).cloned().collect(),
        insufficient_sample_reasons,
        threshold_failures,
    })
}

fn score_semantic(
    scan: &CuratorScanV1,
    labels: &CuratorAccuracyLabelsV1,
    plan: &CuratorPlanV1,
) -> Result<SemanticAccuracyReport> {
    validate_plan(plan)?;
    for (name, expected, actual) in [
        (
            "database_id",
            scan.database_id.as_str(),
            plan.database_id.as_str(),
        ),
        (
            "canister_id",
            scan.canister_id.as_str(),
            plan.canister_id.as_str(),
        ),
        (
            "snapshot_revision",
            scan.snapshot_revision.as_str(),
            plan.snapshot_revision.as_str(),
        ),
    ] {
        if expected != actual {
            bail!("Curator plan {name} does not match the scored scan");
        }
    }
    let expected = labels
        .semantic_findings
        .iter()
        .filter(|finding| finding.confidence != FindingConfidence::Low)
        .map(|finding| {
            let paths = normalized_paths(&finding.paths).expect("validated semantic paths");
            (semantic_key(&finding.kind, finding.store, &paths), finding)
        })
        .collect::<BTreeMap<_, _>>();
    let mut actual = BTreeMap::new();
    let mut violations = Vec::new();
    for finding in &plan.findings {
        if !SEMANTIC_KINDS.contains(&finding.kind.as_str()) {
            violations.push(format!(
                "finding {} uses unsupported semantic kind {}",
                finding.id, finding.kind
            ));
            continue;
        }
        let paths = normalized_paths(&finding.paths)?;
        if paths
            .iter()
            .any(|path| mutable_store_for_path(path) != Some(finding.store))
        {
            violations.push(format!("finding {} mixes mutable stores", finding.id));
        }
        let finding_paths = paths.iter().map(String::as_str).collect::<BTreeSet<_>>();
        if finding.evidence.iter().any(|evidence| {
            let evidence_store = store_for_path(&evidence.path);
            evidence_store != CuratorStore::SourceEvidence
                && (evidence_store != finding.store
                    || !finding_paths.contains(evidence.path.as_str()))
        }) {
            violations.push(format!(
                "finding {} uses evidence outside its declared paths, store, or /Sources",
                finding.id
            ));
        }
        if finding.confidence != FindingConfidence::Low {
            let key = semantic_key(&finding.kind, finding.store, &paths);
            if actual.insert(key, finding).is_some() {
                violations.push(format!(
                    "duplicate semantic finding key in plan: {}",
                    finding.id
                ));
            }
        }
    }
    let expected_keys = expected.keys().cloned().collect::<BTreeSet<_>>();
    let actual_keys = actual.keys().cloned().collect::<BTreeSet<_>>();
    let counts = AccuracyCounts {
        true_positive: expected_keys.intersection(&actual_keys).count(),
        false_positive: actual_keys.difference(&expected_keys).count(),
        false_negative: expected_keys.difference(&actual_keys).count(),
        ..AccuracyCounts::default()
    };
    let semantic_metrics = metrics(counts);

    let findings_by_id = plan
        .findings
        .iter()
        .map(|finding| (finding.id.as_str(), finding))
        .collect::<BTreeMap<_, _>>();
    let expected_proposals = expected
        .iter()
        .filter(|(_, finding)| finding.proposal_expected)
        .map(|(key, _)| key.clone())
        .collect::<BTreeSet<_>>();
    let mut covered_expected_proposals = BTreeSet::new();
    let mut correct_proposals = 0;
    for proposal in &plan.proposals {
        let mut proposal_valid = true;
        let mut proposal_coverage = BTreeSet::new();
        let change_paths = proposal
            .changes
            .iter()
            .map(|change| change.path.as_str())
            .collect::<BTreeSet<_>>();
        for finding_id in &proposal.finding_ids {
            let finding = findings_by_id
                .get(finding_id.as_str())
                .expect("Curator plan validation checked finding references");
            if finding.confidence == FindingConfidence::Low {
                violations.push(format!(
                    "proposal {} references low-confidence finding",
                    proposal.id
                ));
                proposal_valid = false;
                continue;
            }
            let key = semantic_key(
                &finding.kind,
                finding.store,
                &normalized_paths(&finding.paths)?,
            );
            let Some(gold) = expected.get(&key) else {
                violations.push(format!(
                    "proposal {} references an unmatched finding",
                    proposal.id
                ));
                proposal_valid = false;
                continue;
            };
            let allowed = gold
                .allowed_change_paths
                .iter()
                .map(String::as_str)
                .collect::<BTreeSet<_>>();
            if !gold.proposal_expected || !change_paths.is_subset(&allowed) {
                violations.push(format!(
                    "proposal {} changes a path not allowed by labels",
                    proposal.id
                ));
                proposal_valid = false;
            } else {
                proposal_coverage.insert(key);
            }
        }
        if proposal_valid {
            correct_proposals += 1;
            covered_expected_proposals.extend(proposal_coverage);
        }
    }
    let proposal_count = plan.proposals.len();
    let proposal_precision =
        (proposal_count > 0).then(|| correct_proposals as f64 / proposal_count as f64);
    let expected_proposal_count = expected_proposals.len();
    let covered_expected_proposal_count = covered_expected_proposals.len();
    let proposal_recall = (expected_proposal_count > 0)
        .then(|| covered_expected_proposal_count as f64 / expected_proposal_count as f64);
    let uncovered_expected_proposals = expected_proposals
        .difference(&covered_expected_proposals)
        .cloned()
        .collect::<Vec<_>>();
    let unsafe_proposal_count = proposal_count.saturating_sub(correct_proposals);
    let verdict = if expected_keys.is_empty() && actual_keys.is_empty() {
        EvaluationVerdict::InsufficientSample
    } else if semantic_metrics.precision >= 0.80
        && semantic_metrics.recall >= 0.80
        && unsafe_proposal_count == 0
        && uncovered_expected_proposals.is_empty()
        && violations.is_empty()
    {
        EvaluationVerdict::Passed
    } else {
        EvaluationVerdict::Failed
    };
    Ok(SemanticAccuracyReport {
        verdict,
        metrics: Some(semantic_metrics),
        correct_proposals,
        proposal_count,
        proposal_precision,
        expected_proposal_count,
        covered_expected_proposal_count,
        proposal_recall,
        uncovered_expected_proposals,
        unsafe_proposal_count,
        unmatched_expected: expected_keys.difference(&actual_keys).cloned().collect(),
        unmatched_actual: actual_keys.difference(&expected_keys).cloned().collect(),
        violations,
    })
}

fn read_private_json<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<T> {
    require_private_file(path)?;
    let bytes = std::fs::read(path)
        .with_context(|| format!("failed to read {label}: {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid {label} JSON: {}", path.display()))
}

fn normalized_paths(paths: &[String]) -> Result<Vec<String>> {
    let normalized = paths.iter().cloned().collect::<BTreeSet<_>>();
    if normalized.len() != paths.len() || normalized.iter().any(|path| path.trim().is_empty()) {
        bail!("semantic finding paths must be unique and non-empty");
    }
    Ok(normalized.into_iter().collect())
}

fn semantic_key(kind: &str, store: CuratorStore, paths: &[String]) -> String {
    format!("{kind}|{store:?}|{}", paths.join("|"))
}

fn mutable_store_for_path(path: &str) -> Option<CuratorStore> {
    match store_for_path(path) {
        CuratorStore::Memory => Some(CuratorStore::Memory),
        CuratorStore::Knowledge => Some(CuratorStore::Knowledge),
        CuratorStore::Skill => Some(CuratorStore::Skill),
        CuratorStore::Session => Some(CuratorStore::Session),
        CuratorStore::SourceEvidence | CuratorStore::Other => None,
    }
}

fn record(counts: &mut AccuracyCounts, expected: bool, actual: bool) {
    match (expected, actual) {
        (true, true) => counts.true_positive += 1,
        (false, false) => counts.true_negative += 1,
        (false, true) => counts.false_positive += 1,
        (true, false) => counts.false_negative += 1,
    }
}

fn metrics(counts: AccuracyCounts) -> AccuracyMetrics {
    let precision = ratio(
        counts.true_positive,
        counts.true_positive + counts.false_positive,
    );
    let recall = ratio(
        counts.true_positive,
        counts.true_positive + counts.false_negative,
    );
    let specificity = ratio(
        counts.true_negative,
        counts.true_negative + counts.false_positive,
    );
    let f1 = if precision + recall == 0.0 {
        0.0
    } else {
        2.0 * precision * recall / (precision + recall)
    };
    AccuracyMetrics {
        counts,
        precision,
        recall,
        specificity,
        f1,
    }
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        1.0
    } else {
        numerator as f64 / denominator as f64
    }
}

pub(crate) fn combine_verdicts(
    deterministic: EvaluationVerdict,
    semantic: EvaluationVerdict,
) -> EvaluationVerdict {
    if deterministic == EvaluationVerdict::Failed || semantic == EvaluationVerdict::Failed {
        EvaluationVerdict::Failed
    } else if deterministic == EvaluationVerdict::InsufficientSample
        || semantic == EvaluationVerdict::InsufficientSample
    {
        EvaluationVerdict::InsufficientSample
    } else if semantic == EvaluationVerdict::NotEvaluated {
        EvaluationVerdict::NotEvaluated
    } else {
        EvaluationVerdict::Passed
    }
}

// Where: Deterministic Curator staging accuracy seed support.
// What: Generate private write batches with an independent oracle and verify a resulting scan.
// Why: Real staging accuracy needs a large, reproducible corpus without touching existing nodes.
use crate::curator::{
    CuratorScanV1, CuratorStore, FindingConfidence, require_private_file, store_for_path,
    write_private_json,
};
use crate::curator_accuracy::{DETERMINISTIC_RULES, FindingKey, SemanticGoldFinding};
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use vfs_types::NodeKind;

const SEED_SCHEMA: &str = "kinic.curator.accuracy-seed.v1";
const VERIFY_SCHEMA: &str = "kinic.curator.accuracy-seed-report.v1";
const BATCH_LIMIT: usize = 100;
const SEED_METADATA: &str = r#"{"curator_accuracy_seed":"v1"}"#;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CuratorAccuracySeedManifestV1 {
    pub schema_version: String,
    pub seed_id: String,
    pub roots: Vec<String>,
    pub non_folder_node_count: usize,
    pub nodes: Vec<SeedNodeManifest>,
    pub batches: Vec<SeedBatchManifest>,
    pub expected_findings: Vec<FindingKey>,
    pub semantic_findings: Vec<SemanticGoldFinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SeedNodeManifest {
    pub path: String,
    pub kind: NodeKind,
    pub content_sha256: String,
    pub batch: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SeedBatchManifest {
    pub index: usize,
    pub file: String,
    pub node_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SeedVerificationReportV1 {
    pub schema_version: String,
    pub seed_id: String,
    pub complete: bool,
    pub batch_statuses: Vec<SeedBatchStatus>,
    pub missing_paths: Vec<String>,
    pub unexpected_paths: Vec<String>,
    pub content_mismatches: Vec<String>,
    pub unexpected_findings: Vec<FindingKey>,
    pub missing_findings: Vec<FindingKey>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SeedBatchStatus {
    pub index: usize,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WriteNodeInput {
    path: String,
    kind: NodeKind,
    content: String,
    metadata_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_etag: Option<String>,
}

#[derive(Clone)]
struct SeedFile {
    path: String,
    content: String,
    expected: Vec<&'static str>,
    stage: SeedStage,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SeedStage {
    EarlySource,
    Mutable,
    FreshSource,
}

pub fn generate_seed_files(
    out_dir: &Path,
    seed_id: &str,
    overwrite: bool,
) -> Result<CuratorAccuracySeedManifestV1> {
    validate_seed_id(seed_id)?;
    if out_dir.exists() && !overwrite {
        bail!(
            "seed output directory already exists: {}",
            out_dir.display()
        );
    }
    fs::create_dir_all(out_dir)
        .with_context(|| format!("failed to create seed directory: {}", out_dir.display()))?;

    let (files, semantic_findings) = seed_files(seed_id);
    let non_folder_node_count = files.len();
    if non_folder_node_count != 128 {
        bail!("seed generator invariant failed: expected 128 files, got {non_folder_node_count}");
    }
    let folders = folder_inputs(&files);
    let mut early = folders;
    early.extend(
        files
            .iter()
            .filter(|file| file.stage == SeedStage::EarlySource)
            .map(write_input),
    );
    let mutable = files
        .iter()
        .filter(|file| file.stage == SeedStage::Mutable)
        .map(write_input)
        .collect::<Vec<_>>();
    let fresh = files
        .iter()
        .filter(|file| file.stage == SeedStage::FreshSource)
        .map(write_input)
        .collect::<Vec<_>>();
    if early.len() > BATCH_LIMIT || fresh.len() > BATCH_LIMIT {
        bail!("seed generator stage exceeds write_nodes batch limit");
    }
    let mut batches = vec![early];
    batches.extend(mutable.chunks(BATCH_LIMIT).map(<[WriteNodeInput]>::to_vec));
    batches.push(fresh);

    let mut node_batches = BTreeMap::<String, usize>::new();
    let mut batch_manifests = Vec::new();
    for (offset, batch) in batches.iter().enumerate() {
        let index = offset + 1;
        let file = format!("batch-{index:03}.json");
        write_private_json(&out_dir.join(&file), batch, overwrite)?;
        for node in batch {
            node_batches.insert(node.path.clone(), index);
        }
        batch_manifests.push(SeedBatchManifest {
            index,
            file,
            node_count: batch.len(),
        });
    }

    let mut expected_findings = files
        .iter()
        .flat_map(|file| {
            file.expected.iter().map(|kind| FindingKey {
                kind: (*kind).to_string(),
                focus_path: file.path.clone(),
            })
        })
        .collect::<Vec<_>>();
    expected_findings.sort();
    let expected_rule_count = expected_findings
        .iter()
        .map(|finding| finding.kind.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    if expected_findings.len() < 40 || expected_rule_count < 12 {
        bail!("seed oracle does not meet positive finding coverage invariants");
    }

    let mut nodes = batches
        .iter()
        .flatten()
        .map(|node| SeedNodeManifest {
            path: node.path.clone(),
            kind: node.kind.clone(),
            content_sha256: sha256(&node.content),
            batch: *node_batches
                .get(&node.path)
                .expect("batch was recorded for every node"),
        })
        .collect::<Vec<_>>();
    nodes.sort_by(|left, right| left.path.cmp(&right.path));
    let manifest = CuratorAccuracySeedManifestV1 {
        schema_version: SEED_SCHEMA.to_string(),
        seed_id: seed_id.to_string(),
        roots: seed_roots(seed_id),
        non_folder_node_count,
        nodes,
        batches: batch_manifests,
        expected_findings,
        semantic_findings,
    };
    write_private_json(&out_dir.join("seed-manifest.json"), &manifest, overwrite)?;
    Ok(manifest)
}

pub fn verify_seed_files(
    scan_path: &Path,
    manifest_path: &Path,
    out_path: &Path,
    allow_partial: bool,
    overwrite: bool,
) -> Result<SeedVerificationReportV1> {
    let scan = read_private::<CuratorScanV1>(scan_path, "Curator scan")?;
    let manifest = read_private::<CuratorAccuracySeedManifestV1>(manifest_path, "seed manifest")?;
    validate_seed_manifest(&manifest)?;
    if !scan.coverage.complete
        || !scan.coverage.inspection_errors.is_empty()
        || !scan.coverage.truncated_link_paths.is_empty()
    {
        bail!("seed verification requires complete, untruncated scan coverage");
    }
    let actual = scan
        .nodes
        .iter()
        .map(|node| (node.path.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let mut missing_paths = Vec::new();
    let mut content_mismatches = Vec::new();
    let mut batch_statuses = Vec::new();
    for batch in &manifest.batches {
        let nodes = manifest
            .nodes
            .iter()
            .filter(|node| node.batch == batch.index)
            .collect::<Vec<_>>();
        let present = nodes
            .iter()
            .filter(|node| actual.contains_key(node.path.as_str()))
            .count();
        for expected in &nodes {
            if let Some(node) = actual.get(expected.path.as_str()) {
                if node.kind != expected.kind || sha256(&node.content) != expected.content_sha256 {
                    content_mismatches.push(expected.path.clone());
                }
            } else {
                missing_paths.push(expected.path.clone());
            }
        }
        let status = if present == 0 {
            "missing"
        } else if present == nodes.len() {
            "complete"
        } else {
            "partial"
        };
        batch_statuses.push(SeedBatchStatus {
            index: batch.index,
            status: status.to_string(),
        });
    }
    let seed_paths = manifest
        .nodes
        .iter()
        .map(|node| node.path.as_str())
        .collect::<BTreeSet<_>>();
    let unexpected_paths = scan
        .nodes
        .iter()
        .filter(|node| {
            manifest
                .roots
                .iter()
                .any(|root| path_is_within_root(&node.path, root))
                && !seed_paths.contains(node.path.as_str())
        })
        .map(|node| node.path.clone())
        .collect::<Vec<_>>();
    let actual_findings = scan
        .findings
        .iter()
        .filter_map(|finding| {
            let focus = finding.paths.first()?;
            seed_paths.contains(focus.as_str()).then(|| FindingKey {
                kind: finding.kind.clone(),
                focus_path: focus.clone(),
            })
        })
        .collect::<BTreeSet<_>>();
    let expected_findings = manifest
        .expected_findings
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let complete = missing_paths.is_empty()
        && unexpected_paths.is_empty()
        && content_mismatches.is_empty()
        && actual_findings == expected_findings;
    let report = SeedVerificationReportV1 {
        schema_version: VERIFY_SCHEMA.to_string(),
        seed_id: manifest.seed_id,
        complete,
        batch_statuses,
        missing_paths,
        unexpected_paths,
        content_mismatches,
        unexpected_findings: actual_findings
            .difference(&expected_findings)
            .cloned()
            .collect(),
        missing_findings: expected_findings
            .difference(&actual_findings)
            .cloned()
            .collect(),
    };
    if !allow_partial && !report.complete {
        bail!("seed verification failed; rerun with --allow-partial to write a diagnostic report");
    }
    write_private_json(out_path, &report, overwrite)?;
    Ok(report)
}

pub fn prepare_seed_repair(
    scan_path: &Path,
    manifest_path: &Path,
    definition_dir: &Path,
    out_path: &Path,
    batch_index: Option<usize>,
    overwrite: bool,
) -> Result<usize> {
    let scan = read_private::<CuratorScanV1>(scan_path, "Curator scan")?;
    let manifest = read_private::<CuratorAccuracySeedManifestV1>(manifest_path, "seed manifest")?;
    validate_seed_manifest(&manifest)?;
    validate_seed_definition(manifest_path, definition_dir)?;
    if !scan.coverage.complete
        || !scan.coverage.inspection_errors.is_empty()
        || !scan.coverage.truncated_link_paths.is_empty()
    {
        bail!("seed repair requires complete, untruncated scan coverage");
    }

    let actual = scan
        .nodes
        .iter()
        .map(|node| (node.path.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let expected = manifest
        .nodes
        .iter()
        .map(|node| (node.path.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let mut desired = BTreeMap::<String, WriteNodeInput>::new();
    for batch in &manifest.batches {
        let path = definition_dir.join(&batch.file);
        let nodes = read_private::<Vec<WriteNodeInput>>(&path, "seed batch")?;
        if nodes.len() != batch.node_count {
            bail!(
                "seed batch node count does not match manifest: {}",
                path.display()
            );
        }
        for node in nodes {
            if desired.insert(node.path.clone(), node).is_some() {
                bail!("seed batches contain a duplicate path");
            }
        }
    }
    if desired.len() != manifest.nodes.len() {
        bail!("seed batches do not cover the manifest exactly");
    }

    let mut repairs = Vec::new();
    for (path, expected_node) in expected {
        let desired_node = desired
            .get(path)
            .ok_or_else(|| anyhow!("seed batch is missing manifest path: {path}"))?;
        if desired_node.kind != expected_node.kind
            || sha256(&desired_node.content) != expected_node.content_sha256
        {
            bail!("seed batch content does not match manifest: {path}");
        }
        let current = actual
            .get(path)
            .ok_or_else(|| anyhow!("cannot repair missing seed node: {path}"))?;
        if current.kind != expected_node.kind {
            bail!("cannot repair seed node with changed kind: {path}");
        }
        if sha256(&current.content) == expected_node.content_sha256 {
            continue;
        }
        if batch_index.is_some_and(|index| expected_node.batch != index) {
            continue;
        }
        let mut replacement = desired_node.clone();
        replacement.metadata_json = current.metadata_json.clone();
        replacement.expected_etag = Some(current.etag.clone());
        repairs.push(replacement);
    }
    if repairs.len() > BATCH_LIMIT {
        bail!("seed repair exceeds the atomic 100-node batch limit");
    }
    write_private_json(out_path, &repairs, overwrite)?;
    Ok(repairs.len())
}

pub fn validate_seed_definition(manifest_path: &Path, definition_dir: &Path) -> Result<usize> {
    let manifest = read_private::<CuratorAccuracySeedManifestV1>(manifest_path, "seed manifest")?;
    validate_seed_manifest(&manifest)?;
    let mut validated = 0;
    for batch in &manifest.batches {
        validated += validate_seed_batch_inner(
            &manifest,
            &definition_dir.join(&batch.file),
            batch.index,
            None,
        )?;
    }
    Ok(validated)
}

pub fn validate_seed_batch(
    manifest_path: &Path,
    input_path: &Path,
    batch_index: usize,
    repair_scan_path: Option<&Path>,
) -> Result<usize> {
    let manifest = read_private::<CuratorAccuracySeedManifestV1>(manifest_path, "seed manifest")?;
    validate_seed_manifest(&manifest)?;
    let scan = repair_scan_path
        .map(|path| read_private::<CuratorScanV1>(path, "Curator scan"))
        .transpose()?;
    validate_seed_batch_inner(&manifest, input_path, batch_index, scan.as_ref())
}

fn validate_seed_batch_inner(
    manifest: &CuratorAccuracySeedManifestV1,
    input_path: &Path,
    batch_index: usize,
    repair_scan: Option<&CuratorScanV1>,
) -> Result<usize> {
    let batch = manifest
        .batches
        .iter()
        .find(|batch| batch.index == batch_index)
        .ok_or_else(|| anyhow!("seed manifest does not declare batch {batch_index}"))?;
    let inputs = read_private::<Vec<WriteNodeInput>>(input_path, "seed batch")?;
    if inputs.len() > BATCH_LIMIT || (repair_scan.is_none() && inputs.len() != batch.node_count) {
        bail!("seed batch node count does not match manifest");
    }
    let expected = manifest
        .nodes
        .iter()
        .filter(|node| node.batch == batch_index)
        .map(|node| (node.path.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let current = repair_scan.map(|scan| {
        scan.nodes
            .iter()
            .map(|node| (node.path.as_str(), node))
            .collect::<BTreeMap<_, _>>()
    });
    let mut seen = BTreeSet::new();
    for input in &inputs {
        if !seen.insert(input.path.as_str()) {
            bail!("seed batch contains duplicate path: {}", input.path);
        }
        let node = expected.get(input.path.as_str()).ok_or_else(|| {
            anyhow!(
                "seed batch path is not assigned to batch {batch_index}: {}",
                input.path
            )
        })?;
        if input.kind != node.kind || sha256(&input.content) != node.content_sha256 {
            bail!(
                "seed batch content or kind does not match manifest: {}",
                input.path
            );
        }
        match &current {
            None => {
                let metadata = if input.kind == NodeKind::Folder {
                    "{}"
                } else {
                    SEED_METADATA
                };
                if input.metadata_json != metadata || input.expected_etag.is_some() {
                    bail!(
                        "initial seed batch has unsafe metadata or etag: {}",
                        input.path
                    );
                }
            }
            Some(current) => {
                let current = current.get(input.path.as_str()).ok_or_else(|| {
                    anyhow!("repair seed node is missing from scan: {}", input.path)
                })?;
                if input.metadata_json != current.metadata_json
                    || input.expected_etag.as_deref() != Some(current.etag.as_str())
                {
                    bail!(
                        "repair seed batch does not preserve metadata and current etag: {}",
                        input.path
                    );
                }
            }
        }
    }
    if repair_scan.is_none() && seen != expected.keys().copied().collect() {
        bail!("seed batch does not cover its manifest paths exactly");
    }
    Ok(inputs.len())
}

fn seed_files(seed_id: &str) -> (Vec<SeedFile>, Vec<SemanticGoldFinding>) {
    let common = format!("/Sources/{seed_id}/common/evidence.md");
    let session_source = format!("/Sources/sessions/{seed_id}/complete.md");
    let fresh_source = format!("/Sources/{seed_id}/fresh/latest.md");
    let hub = format!("/Knowledge/{seed_id}/neutral/hub.md");
    let mut files = Vec::new();
    let mut semantic_candidates = Vec::<String>::new();

    files.push(source(
        &common,
        "# Common evidence\n\nStable seed evidence.\n",
        vec![],
        SeedStage::EarlySource,
    ));
    files.push(source(
        &session_source,
        "# Session evidence\n",
        vec![],
        SeedStage::EarlySource,
    ));
    for index in 1..=5 {
        files.push(source(
            &format!("/Sources/{seed_id}/orphan/orphan-{index:02}.md"),
            &format!("# Intentionally orphaned evidence {index}\n"),
            vec!["orphan_source_evidence"],
            SeedStage::EarlySource,
        ));
        files.push(source(
            &format!("/Sources/skill-runs/{seed_id}-complete-{index:02}/run.md"),
            &format!("# Skill run evidence {index}\n"),
            vec![],
            SeedStage::EarlySource,
        ));
    }

    for index in 1..=5 {
        files.push(mutable(
            &format!("/Knowledge/{seed_id}/broken-{index:02}.md"),
            &format!("# Broken link\n\n[Missing](/Knowledge/{seed_id}/missing-{index:02}.md)\n\n[Evidence]({common})\n"),
            vec!["broken_internal_link"],
        ));
        files.push(mutable(
            &format!("/Knowledge/{seed_id}/isolated-{index:02}.md"),
            &format!("# Isolated node {index}\n\nThis isolated case {index} has no links.\n"),
            vec!["isolated_node", "source_evidence_missing"],
        ));
        files.push(mutable(
            &format!("/Knowledge/{seed_id}/missing-evidence-{index:02}.md"),
            &format!("# Missing evidence {index}\n\nCase {index} links only to [Hub]({hub}).\n"),
            vec!["source_evidence_missing"],
        ));
        files.push(mutable(
            &format!("/Knowledge/{seed_id}/invalid-status-{index:02}.md"),
            &format!(
                "---\ncurator:\n  status: promoted\n---\n# Invalid status {index}\n\nCase {index} cites [Evidence]({common}).\n"
            ),
            vec!["invalid_curator_status"],
        ));
    }

    for index in 1..=5 {
        let cases = [
            (
                "facts-positive",
                "facts.md",
                "The atlas-{index} review is scheduled for tomorrow.",
                "facts_future_item",
            ),
            (
                "summary-positive",
                "summary.md",
                "Component atlas-{index} selected exact version 2.{index}.",
                "summary_exact_evidence",
            ),
            (
                "questions-positive",
                "open_questions.md",
                "Resolved: atlas-{index} uses signed requests.",
                "open_question_resolved",
            ),
            (
                "preferences-positive",
                "preferences.md",
                "TODO: choose the final theme for atlas-{index}.",
                "preference_action_item",
            ),
        ];
        for (scope, name, statement, finding) in cases {
            let statement = statement.replace("{index}", &index.to_string());
            files.push(mutable(
                &format!("/Knowledge/{seed_id}/{scope}-{index:02}/{name}"),
                &format!("# Positive role case {index}\n\n{statement}\n\n[Evidence]({common})\n"),
                vec![finding],
            ));
        }
    }

    for index in 1..=5 {
        let negatives = [
            (
                "facts-negative",
                "facts.md",
                format!("There is no pending migration claim {index}."),
            ),
            (
                "summary-negative",
                "summary.md",
                format!("Section 2.1 explains architecture claim {index}."),
            ),
            (
                "questions-negative",
                "open_questions.md",
                format!("Unresolved: deployment claim {index}."),
            ),
            (
                "preferences-negative",
                "preferences.md",
                format!("We prefer TODO comments in examples claim {index}."),
            ),
        ];
        for (scope, name, statement) in negatives {
            let path = format!("/Knowledge/{seed_id}/{scope}-{index:02}/{name}");
            files.push(mutable(
                &path,
                &format!("# Adversarial negative\n\n{statement}\n\n[Evidence]({common})\n"),
                vec![],
            ));
            semantic_candidates.push(path);
        }
    }

    for index in 1..=5 {
        let freshness_path = format!("/Knowledge/{seed_id}/freshness-{index:02}.md");
        files.push(mutable(
            &freshness_path,
            &format!("# Freshness claim {index}\n\n[Latest evidence]({fresh_source})\n"),
            vec!["source_newer_than_node"],
        ));
        files.push(mutable(
            &format!("/Knowledge/{seed_id}/provenance-{index:02}/provenance.md"),
            &format!("# Provenance gap {index}\n\n[Hub]({hub})\n"),
            vec!["provenance_source_missing", "source_evidence_missing"],
        ));
        files.push(mutable(
            &format!("/Sessions/{seed_id}/missing-{index:02}.md"),
            &format!("# Session without evidence {index}\n\n[Hub]({hub})\n"),
            vec!["session_evidence_missing", "source_evidence_missing"],
        ));
        files.push(mutable(
            &format!("/Sessions/{seed_id}/complete-{index:02}.md"),
            &format!("# Complete session {index}\n\n[Transcript]({session_source})\n"),
            vec![],
        ));
    }

    for index in 1..=5 {
        let incomplete = format!("/Skills/{seed_id}/{seed_id}-incomplete-{index:02}/SKILL.md");
        files.push(mutable(
            &incomplete,
            &format!("# Incomplete skill {index}\n\n[Evidence]({common})\n"),
            vec![
                "skill_manifest_missing",
                "skill_provenance_missing",
                "skill_run_evidence_missing",
            ],
        ));
        let base = format!("/Skills/{seed_id}/{seed_id}-complete-{index:02}");
        let run = format!("/Sources/skill-runs/{seed_id}-complete-{index:02}/run.md");
        files.push(mutable(
            &format!("{base}/SKILL.md"),
            &format!("# Complete skill {index}\n\n[Evidence]({common})\n[Run]({run})\n"),
            vec![],
        ));
        files.push(mutable(
            &format!("{base}/manifest.md"),
            &format!("# Manifest {index}\n\n[Evidence]({common})\n"),
            vec![],
        ));
        files.push(mutable(
            &format!("{base}/provenance.md"),
            &format!("# Provenance {index}\n\n[Evidence]({common})\n"),
            vec![],
        ));
    }

    for index in 0..15 {
        let path = if index == 0 {
            hub.clone()
        } else {
            format!("/Knowledge/{seed_id}/neutral/node-{index:02}.md")
        };
        files.push(mutable(
            &path,
            &format!("# Neutral node {index}\n\n[Evidence]({common})\n"),
            vec![],
        ));
        if (1..=4).contains(&index) {
            semantic_candidates.push(path);
        }
    }
    files.push(source(
        &fresh_source,
        "# Newer evidence\n\nThis source is written after organized nodes. Semantic corpus revision 3.\n",
        vec![],
        SeedStage::FreshSource,
    ));

    for (index, pair) in semantic_candidates.chunks_exact(2).enumerate() {
        let first = files
            .iter_mut()
            .find(|file| file.path == pair[0])
            .expect("semantic candidate exists");
        if index % 2 == 0 {
            first.content.push_str(&format!(
                "\nSemantic gold claim: cohort {} begins processing at 09:00 UTC.\n",
                index + 1
            ));
        } else {
            first.content.push_str(&format!(
                "\nSemantic gold claim: cohort {} requires signed uploads.\n",
                index + 1
            ));
        }
        let second = files
            .iter_mut()
            .find(|file| file.path == pair[1])
            .expect("semantic candidate exists");
        if index % 2 == 0 {
            second.content.push_str(&format!(
                "\nSemantic gold claim: processing for cohort {} starts at 09:00 UTC.\n",
                index + 1
            ));
        } else {
            second.content.push_str(&format!(
                "\nSemantic gold claim: cohort {} accepts unsigned uploads.\n",
                index + 1
            ));
        }
    }

    let semantic_findings = semantic_candidates
        .chunks_exact(2)
        .enumerate()
        .map(|(index, pair)| {
            let kind = if index % 2 == 0 {
                "duplicate"
            } else {
                "contradiction"
            };
            SemanticGoldFinding {
                id: format!("G{:03}", index + 1),
                kind: kind.to_string(),
                confidence: if index % 3 == 0 {
                    FindingConfidence::Medium
                } else {
                    FindingConfidence::High
                },
                store: CuratorStore::Knowledge,
                paths: pair.to_vec(),
                summary: format!("controlled {kind} pair {}", index + 1),
                proposal_expected: true,
                allowed_change_paths: vec![pair[0].clone()],
            }
        })
        .collect::<Vec<_>>();
    debug_assert_eq!(semantic_findings.len(), 12);
    (files, semantic_findings)
}

fn mutable(path: &str, content: &str, expected: Vec<&'static str>) -> SeedFile {
    SeedFile {
        path: path.to_string(),
        content: content.to_string(),
        expected,
        stage: SeedStage::Mutable,
    }
}

fn source(path: &str, content: &str, expected: Vec<&'static str>, stage: SeedStage) -> SeedFile {
    SeedFile {
        path: path.to_string(),
        content: content.to_string(),
        expected,
        stage,
    }
}

fn write_input(file: &SeedFile) -> WriteNodeInput {
    WriteNodeInput {
        path: file.path.clone(),
        kind: if file.path.starts_with("/Sources/") {
            NodeKind::Source
        } else {
            NodeKind::File
        },
        content: file.content.clone(),
        metadata_json: SEED_METADATA.to_string(),
        expected_etag: None,
    }
}

fn folder_inputs(files: &[SeedFile]) -> Vec<WriteNodeInput> {
    let protected = [
        "/Memory",
        "/Knowledge",
        "/Skills",
        "/Sessions",
        "/Sources",
        "/Sources/sessions",
        "/Sources/skill-runs",
    ];
    let mut folders = BTreeSet::new();
    for file in files {
        let mut current = PathBuf::from(&file.path);
        while current.pop() {
            let path = current.to_string_lossy().to_string();
            if path.is_empty() || path == "/" || protected.contains(&path.as_str()) {
                break;
            }
            folders.insert(path);
        }
    }
    let mut folders = folders.into_iter().collect::<Vec<_>>();
    folders.sort_by(|left, right| {
        left.matches('/')
            .count()
            .cmp(&right.matches('/').count())
            .then_with(|| left.cmp(right))
    });
    folders
        .into_iter()
        .map(|path| WriteNodeInput {
            path,
            kind: NodeKind::Folder,
            content: String::new(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .collect()
}

fn seed_roots(seed_id: &str) -> Vec<String> {
    vec![
        format!("/Memory/{seed_id}"),
        format!("/Knowledge/{seed_id}"),
        format!("/Skills/{seed_id}"),
        format!("/Sessions/{seed_id}"),
        format!("/Sources/{seed_id}"),
        format!("/Sources/sessions/{seed_id}"),
        format!("/Sources/skill-runs/{seed_id}-"),
    ]
}

fn path_is_within_root(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| root.ends_with('-') || suffix.starts_with('/'))
}

fn validate_seed_id(seed_id: &str) -> Result<()> {
    if seed_id.is_empty()
        || seed_id.len() > 48
        || !seed_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        bail!("seed-id must use 1..48 lowercase ASCII letters, digits, or hyphens");
    }
    Ok(())
}

pub fn validate_seed_manifest(manifest: &CuratorAccuracySeedManifestV1) -> Result<()> {
    if manifest.schema_version != SEED_SCHEMA {
        bail!(
            "unsupported seed manifest schema: {}",
            manifest.schema_version
        );
    }
    validate_seed_id(&manifest.seed_id)?;
    if manifest.non_folder_node_count != 128
        || manifest
            .nodes
            .iter()
            .filter(|node| node.kind != NodeKind::Folder)
            .count()
            != manifest.non_folder_node_count
    {
        bail!("seed manifest must contain exactly 128 non-folder nodes");
    }
    if manifest.roots != seed_roots(&manifest.seed_id) {
        bail!("seed manifest roots do not match the canonical seed roots");
    }
    let mut batch_indexes = BTreeSet::new();
    let mut batch_files = BTreeSet::new();
    for (offset, batch) in manifest.batches.iter().enumerate() {
        let expected_index = offset + 1;
        if batch.index != expected_index
            || batch.file != format!("batch-{expected_index:03}.json")
            || batch.node_count == 0
            || batch.node_count > BATCH_LIMIT
            || !batch_indexes.insert(batch.index)
            || !batch_files.insert(batch.file.as_str())
        {
            bail!("seed manifest batches must be canonical, contiguous, unique, and within 1..100");
        }
    }
    if manifest
        .batches
        .iter()
        .map(|batch| batch.node_count)
        .sum::<usize>()
        != manifest.nodes.len()
    {
        bail!("seed manifest batch counts do not match its nodes");
    }
    let paths = manifest
        .nodes
        .iter()
        .map(|node| node.path.as_str())
        .collect::<BTreeSet<_>>();
    if paths.len() != manifest.nodes.len() {
        bail!("seed manifest contains duplicate node paths");
    }
    let batch_counts = manifest
        .nodes
        .iter()
        .fold(BTreeMap::new(), |mut counts, node| {
            *counts.entry(node.batch).or_insert(0usize) += 1;
            counts
        });
    for node in &manifest.nodes {
        if !canonical_seed_path(&node.path)
            || !manifest
                .roots
                .iter()
                .any(|root| path_is_within_root(&node.path, root))
            || !is_sha256(&node.content_sha256)
            || !batch_indexes.contains(&node.batch)
        {
            bail!("seed manifest contains an invalid node: {}", node.path);
        }
        let expected_kind = if node.kind == NodeKind::Folder {
            NodeKind::Folder
        } else if node.path.starts_with("/Sources/") {
            NodeKind::Source
        } else {
            NodeKind::File
        };
        if node.kind != expected_kind {
            bail!(
                "seed manifest node kind does not match its path: {}",
                node.path
            );
        }
    }
    for batch in &manifest.batches {
        if batch_counts.get(&batch.index).copied() != Some(batch.node_count) {
            bail!(
                "seed manifest batch node count is inconsistent: {}",
                batch.index
            );
        }
    }
    let known_rules = DETERMINISTIC_RULES.into_iter().collect::<BTreeSet<_>>();
    let mut finding_keys = BTreeSet::new();
    for finding in &manifest.expected_findings {
        if !known_rules.contains(finding.kind.as_str())
            || !paths.contains(finding.focus_path.as_str())
            || !finding_keys.insert((finding.kind.as_str(), finding.focus_path.as_str()))
        {
            bail!("seed manifest contains an invalid deterministic finding");
        }
    }
    let mut semantic_ids = BTreeSet::new();
    let mut semantic_keys = BTreeSet::new();
    for finding in &manifest.semantic_findings {
        let finding_paths = finding
            .paths
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        let allowed_paths = finding
            .allowed_change_paths
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if finding.id.trim().is_empty()
            || !semantic_ids.insert(finding.id.as_str())
            || !matches!(finding.kind.as_str(), "duplicate" | "contradiction")
            || finding_paths.len() != finding.paths.len()
            || finding_paths.len() < 2
            || finding_paths.iter().any(|path| !paths.contains(path))
            || finding_paths
                .iter()
                .any(|path| store_for_path(path) != finding.store)
            || !allowed_paths.is_subset(&finding_paths)
            || finding.proposal_expected == allowed_paths.is_empty()
            || (finding.confidence == FindingConfidence::Low && finding.proposal_expected)
        {
            bail!("seed manifest contains an invalid semantic finding");
        }
        let key = (finding.kind.as_str(), finding.store, finding_paths);
        if !semantic_keys.insert(key) {
            bail!("seed manifest contains a duplicate semantic finding");
        }
    }
    Ok(())
}

fn canonical_seed_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() > 1
        && !path.ends_with('/')
        && !path.contains("//")
        && !path.split('/').any(|segment| matches!(segment, "." | ".."))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256(content: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(content.as_bytes()))
}

fn read_private<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<T> {
    require_private_file(path)?;
    let bytes =
        fs::read(path).with_context(|| format!("failed to read {label}: {}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| anyhow!("invalid {label} JSON: {error}"))
}

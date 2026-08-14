use crate::curator::{
    CuratorChange, CuratorCoverage, CuratorPlanV1, CuratorProposal, CuratorScanNode, CuratorScanV1,
    CuratorStatus, CuratorStore, DeterministicFinding, FindingConfidence, FindingSeverity,
    SemanticEvidence, SemanticFinding, write_private_json,
};
use crate::curator_accuracy::{
    ADJUDICATION_SCHEMA, ANNOTATION_SCHEMA, CuratorAccuracyAdjudicationV1,
    CuratorAccuracyAnnotationV1, CuratorAccuracyInputV2, CuratorAccuracyLabelsV1,
    DeterministicPositiveLabel, EvaluationVerdict, SemanticGoldFinding, combine_verdicts,
    compare_annotation_files, finalize_labels_file, prepare_file, score, score_file,
    score_with_cohorts,
};
use std::collections::BTreeSet;
use vfs_types::NodeKind;

fn scan_with_nodes(node_count: usize) -> CuratorScanV1 {
    let nodes = (0..node_count)
        .map(|index| CuratorScanNode {
            path: format!("/Knowledge/node-{index:03}.md"),
            store: CuratorStore::Knowledge,
            kind: NodeKind::File,
            content: format!("# Node {index}"),
            body: format!("# Node {index}"),
            metadata_json: "{}".to_string(),
            created_at: 1,
            updated_at: 2,
            etag: format!("etag-{index}"),
            curator_status: CuratorStatus::Active,
            outgoing_links: Vec::new(),
            source_evidence: Vec::new(),
        })
        .collect::<Vec<_>>();
    CuratorScanV1 {
        schema_version: "kinic.curator.scan.v1".to_string(),
        database_id: "staging-test".to_string(),
        canister_id: "aaaaa-aa".to_string(),
        snapshot_revision: "v5:1:test".to_string(),
        generated_at: "2026-08-13T00:00:00Z".to_string(),
        stale_after_days: 90,
        coverage: CuratorCoverage {
            entry_roots: vec![
                "/Memory".to_string(),
                "/Knowledge".to_string(),
                "/Skills".to_string(),
                "/Sessions".to_string(),
            ],
            node_count,
            inspected_node_count: node_count,
            truncated_link_paths: Vec::new(),
            inspection_errors: Vec::new(),
            complete: true,
        },
        nodes,
        findings: Vec::new(),
    }
}

fn labels_for(scan: &CuratorScanV1) -> CuratorAccuracyLabelsV1 {
    CuratorAccuracyLabelsV1 {
        schema_version: "kinic.curator.accuracy-labels.v1".to_string(),
        database_id: scan.database_id.clone(),
        canister_id: scan.canister_id.clone(),
        snapshot_revision: scan.snapshot_revision.clone(),
        annotators: vec!["model-a".to_string(), "model-b".to_string()],
        adjudicator: None,
        adjudicated_disagreements: 0,
        evaluated_paths: scan.nodes.iter().map(|node| node.path.clone()).collect(),
        deterministic_positives: Vec::new(),
        semantic_findings: Vec::new(),
    }
}

fn add_finding(scan: &mut CuratorScanV1, kind: &str, path: &str) {
    scan.findings.push(DeterministicFinding {
        id: format!("D{:06}", scan.findings.len() + 1),
        kind: kind.to_string(),
        severity: FindingSeverity::Warning,
        store: CuratorStore::Knowledge,
        paths: vec![path.to_string()],
        detail: "test finding".to_string(),
    });
}

#[cfg(unix)]
#[test]
fn prepare_writes_private_answer_masked_input_without_findings() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().unwrap();
    let scan_path = directory.path().join("scan.curator-scan.json");
    let input_path = directory.path().join("input.json");
    let mut scan = scan_with_nodes(1);
    scan.nodes[0].content = "---\ncurator:\n  status: promoted\n---\n# Raw".to_string();
    scan.nodes[0].body = "# Raw".to_string();
    scan.nodes[0].metadata_json = r#"{"private":"implementation-only"}"#.to_string();
    let path = scan.nodes[0].path.clone();
    add_finding(&mut scan, "isolated_node", &path);
    write_private_json(&scan_path, &scan, false).unwrap();

    prepare_file(&scan_path, &input_path, false).unwrap();

    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&input_path).unwrap()).unwrap();
    assert!(value.get("findings").is_none());
    assert_eq!(value["schema_version"], "kinic.curator.accuracy-input.v2");
    assert_eq!(value["snapshot_generated_at"], scan.generated_at);
    assert!(value.get("generated_at").is_none());
    assert_eq!(value["nodes"].as_array().unwrap().len(), 1);
    let node = &value["nodes"][0];
    assert_eq!(node["raw_content"], scan.nodes[0].content);
    assert_eq!(node["body_without_frontmatter"], "# Raw");
    assert!(node.get("curator_status").is_none());
    assert!(node.get("metadata_json").is_none());
    assert!(node.get("created_at").is_none());
    assert!(value["rules"][0].get("definition").is_some());
    assert_eq!(
        std::fs::metadata(input_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn accuracy_input_v2_is_strict() {
    let directory = tempfile::tempdir().unwrap();
    let scan_path = directory.path().join("scan.json");
    let input_path = directory.path().join("input.json");
    let scan = scan_with_nodes(1);
    write_private_json(&scan_path, &scan, false).unwrap();
    prepare_file(&scan_path, &input_path, false).unwrap();

    let bytes = std::fs::read(&input_path).unwrap();
    let input: CuratorAccuracyInputV2 = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(input.snapshot_generated_at, scan.generated_at);

    let mut unknown: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    unknown["nodes"][0]["curator_status"] = serde_json::json!("active");
    assert!(serde_json::from_value::<CuratorAccuracyInputV2>(unknown).is_err());
}

#[test]
fn prepare_rejects_incomplete_or_truncated_scan() {
    let directory = tempfile::tempdir().unwrap();
    let scan_path = directory.path().join("scan.curator-scan.json");
    let input_path = directory.path().join("input.json");
    let mut scan = scan_with_nodes(1);
    scan.coverage.truncated_link_paths = vec![scan.nodes[0].path.clone()];
    write_private_json(&scan_path, &scan, false).unwrap();

    let error = prepare_file(&scan_path, &input_path, false).unwrap_err();
    assert!(error.to_string().contains("complete, untruncated"));
    assert!(!input_path.exists());
}

#[test]
fn score_rejects_revision_unknown_rule_duplicate_and_incomplete_paths() {
    let scan = scan_with_nodes(2);

    let mut revision = labels_for(&scan);
    revision.snapshot_revision = "other".to_string();
    assert!(score(&scan, &revision, None).is_err());

    let mut unknown = labels_for(&scan);
    unknown
        .deterministic_positives
        .push(DeterministicPositiveLabel {
            kind: "invented".to_string(),
            focus_path: scan.nodes[0].path.clone(),
            reason: "test".to_string(),
        });
    assert!(score(&scan, &unknown, None).is_err());

    let mut duplicate = labels_for(&scan);
    let label = DeterministicPositiveLabel {
        kind: "isolated_node".to_string(),
        focus_path: scan.nodes[0].path.clone(),
        reason: "test".to_string(),
    };
    duplicate.deterministic_positives = vec![label.clone(), label];
    assert!(score(&scan, &duplicate, None).is_err());

    let mut incomplete = labels_for(&scan);
    incomplete.evaluated_paths.pop();
    assert!(score(&scan, &incomplete, None).is_err());
}

#[cfg(unix)]
#[test]
fn score_file_rejects_unknown_label_fields_and_wide_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().unwrap();
    let scan_path = directory.path().join("scan.curator-scan.json");
    let labels_path = directory.path().join("labels.json");
    let report_path = directory.path().join("report.json");
    let scan = scan_with_nodes(1);
    write_private_json(&scan_path, &scan, false).unwrap();
    let mut value = serde_json::to_value(labels_for(&scan)).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .insert("unknown".to_string(), serde_json::json!(true));
    write_private_json(&labels_path, &value, false).unwrap();
    assert!(score_file(&scan_path, &labels_path, None, &report_path, false).is_err());

    std::fs::set_permissions(&labels_path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let error = score_file(&scan_path, &labels_path, None, &report_path, false).unwrap_err();
    assert!(error.to_string().contains("permissions must be 0600"));
}

#[test]
fn deterministic_score_passes_complete_threshold_corpus() {
    let mut scan = scan_with_nodes(100);
    let mut labels = labels_for(&scan);
    let rules = [
        "age_review_due",
        "broken_internal_link",
        "facts_future_item",
        "invalid_curator_status",
        "isolated_node",
        "open_question_resolved",
        "preference_action_item",
        "source_evidence_missing",
    ];
    for index in 0..32 {
        let kind = rules[index % rules.len()];
        let path = scan.nodes[index].path.clone();
        add_finding(&mut scan, kind, &path);
        labels
            .deterministic_positives
            .push(DeterministicPositiveLabel {
                kind: kind.to_string(),
                focus_path: path,
                reason: "independently labeled positive".to_string(),
            });
    }

    let report = score(&scan, &labels, None).unwrap();

    assert_eq!(report.deterministic.verdict, EvaluationVerdict::Passed);
    assert_eq!(report.deterministic.metrics.precision, 1.0);
    assert_eq!(report.deterministic.metrics.recall, 1.0);
    assert_eq!(report.overall_verdict, EvaluationVerdict::NotEvaluated);
}

#[test]
fn small_real_scan_is_reported_as_insufficient_not_passed() {
    let scan = scan_with_nodes(2);
    let labels = labels_for(&scan);
    let report = score(&scan, &labels, None).unwrap();
    assert_eq!(
        report.deterministic.verdict,
        EvaluationVerdict::InsufficientSample
    );
    assert!(!report.deterministic.insufficient_sample_reasons.is_empty());
}

#[test]
fn cohort_score_separates_controlled_seed_from_small_existing_sample() {
    let mut scan = scan_with_nodes(102);
    let mut labels = labels_for(&scan);
    let rules = [
        "age_review_due",
        "broken_internal_link",
        "facts_future_item",
        "invalid_curator_status",
        "isolated_node",
        "open_question_resolved",
        "preference_action_item",
        "source_evidence_missing",
    ];
    for index in 0..32 {
        let kind = rules[index % rules.len()];
        let path = scan.nodes[index].path.clone();
        add_finding(&mut scan, kind, &path);
        labels
            .deterministic_positives
            .push(DeterministicPositiveLabel {
                kind: kind.to_string(),
                focus_path: path,
                reason: "controlled positive".to_string(),
            });
    }
    let seed_paths = scan.nodes[..100]
        .iter()
        .map(|node| node.path.clone())
        .collect::<BTreeSet<_>>();

    let report = score_with_cohorts(&scan, &labels, None, &seed_paths).unwrap();
    let cohorts = report.cohorts.unwrap();
    assert_eq!(
        cohorts["controlled_seed"].deterministic.verdict,
        EvaluationVerdict::Passed
    );
    assert_eq!(
        cohorts["staging_existing"].deterministic.verdict,
        EvaluationVerdict::InsufficientSample
    );
    assert_eq!(
        report.overall_verdict,
        EvaluationVerdict::InsufficientSample
    );
}

#[test]
fn overall_verdict_preserves_failure_and_insufficient_sample_precedence() {
    use EvaluationVerdict::{Failed, InsufficientSample, NotEvaluated, Passed};

    for (deterministic, semantic, expected) in [
        (Passed, Passed, Passed),
        (Passed, NotEvaluated, NotEvaluated),
        (InsufficientSample, NotEvaluated, InsufficientSample),
        (Passed, InsufficientSample, InsufficientSample),
        (Failed, InsufficientSample, Failed),
        (Passed, Failed, Failed),
    ] {
        assert_eq!(combine_verdicts(deterministic, semantic), expected);
    }
}

#[test]
fn semantic_score_accepts_matched_safe_proposal_and_rejects_unmatched_change() {
    let scan = scan_with_nodes(100);
    let mut labels = labels_for(&scan);
    let first = scan.nodes[0].path.clone();
    let second = scan.nodes[1].path.clone();
    labels.semantic_findings.push(SemanticGoldFinding {
        id: "G001".to_string(),
        kind: "duplicate".to_string(),
        confidence: FindingConfidence::High,
        store: CuratorStore::Knowledge,
        paths: vec![first.clone(), second.clone()],
        summary: "same durable claim".to_string(),
        proposal_expected: true,
        allowed_change_paths: vec![first.clone()],
    });
    let mut plan = semantic_plan(&scan, &first, &second, &first);

    let matched = score(&scan, &labels, Some(&plan)).unwrap();
    assert_eq!(matched.semantic.verdict, EvaluationVerdict::Passed);
    assert_eq!(matched.semantic.correct_proposals, 1);

    plan.proposals[0].changes[0].path = second;
    let unsafe_report = score(&scan, &labels, Some(&plan)).unwrap();
    assert_eq!(unsafe_report.semantic.verdict, EvaluationVerdict::Failed);
    assert_eq!(unsafe_report.semantic.unsafe_proposal_count, 1);
}

#[test]
fn semantic_score_rejects_missing_expected_proposal() {
    let scan = scan_with_nodes(100);
    let mut labels = labels_for(&scan);
    let first = scan.nodes[0].path.clone();
    let second = scan.nodes[1].path.clone();
    labels.semantic_findings.push(SemanticGoldFinding {
        id: "G001".to_string(),
        kind: "duplicate".to_string(),
        confidence: FindingConfidence::High,
        store: CuratorStore::Knowledge,
        paths: vec![first.clone(), second.clone()],
        summary: "same durable claim".to_string(),
        proposal_expected: true,
        allowed_change_paths: vec![first.clone()],
    });
    let mut plan = semantic_plan(&scan, &first, &second, &first);
    plan.proposals.clear();

    let report = score(&scan, &labels, Some(&plan)).unwrap();
    assert_eq!(report.semantic.verdict, EvaluationVerdict::Failed);
    assert_eq!(report.semantic.expected_proposal_count, 1);
    assert_eq!(report.semantic.covered_expected_proposal_count, 0);
    assert_eq!(report.semantic.proposal_recall, Some(0.0));
    assert_eq!(report.semantic.uncovered_expected_proposals.len(), 1);
}

#[test]
fn semantic_score_rejects_low_confidence_proposal_and_flags_cross_store_finding() {
    let mut scan = scan_with_nodes(100);
    scan.nodes[1].path = "/Memory/other.md".to_string();
    scan.nodes[1].store = CuratorStore::Memory;
    let mut labels = labels_for(&scan);
    let first = scan.nodes[0].path.clone();
    let second = scan.nodes[2].path.clone();
    labels.semantic_findings.push(SemanticGoldFinding {
        id: "G001".to_string(),
        kind: "duplicate".to_string(),
        confidence: FindingConfidence::High,
        store: CuratorStore::Knowledge,
        paths: vec![first.clone(), second.clone()],
        summary: "same durable claim".to_string(),
        proposal_expected: true,
        allowed_change_paths: vec![first.clone()],
    });

    let mut low_plan = semantic_plan(&scan, &first, &second, &first);
    low_plan.findings[0].confidence = FindingConfidence::Low;
    assert!(score(&scan, &labels, Some(&low_plan)).is_err());

    let memory_path = scan.nodes[1].path.clone();
    let cross_store_plan = semantic_plan(&scan, &first, &memory_path, &first);
    let report = score(&scan, &labels, Some(&cross_store_plan)).unwrap();
    assert_eq!(report.semantic.verdict, EvaluationVerdict::Failed);
    assert!(
        report
            .semantic
            .violations
            .iter()
            .any(|violation| violation.contains("mixes mutable stores"))
    );

    let mut ungrounded_plan = semantic_plan(&scan, &first, &second, &first);
    ungrounded_plan.findings[0].evidence[1].path = memory_path;
    let report = score(&scan, &labels, Some(&ungrounded_plan)).unwrap();
    assert_eq!(report.semantic.verdict, EvaluationVerdict::Failed);
    assert!(
        report
            .semantic
            .violations
            .iter()
            .any(|violation| violation.contains("evidence outside"))
    );
}

#[test]
fn labels_require_distinct_ai_passes_and_adjudicator_for_disagreements() {
    let scan = scan_with_nodes(1);
    let mut labels = labels_for(&scan);
    labels.annotators = vec!["same".to_string(), "same".to_string()];
    assert!(score(&scan, &labels, None).is_err());

    let mut labels = labels_for(&scan);
    labels.adjudicated_disagreements = 1;
    assert!(score(&scan, &labels, None).is_err());

    labels.adjudicator = Some("model-c".to_string());
    assert!(score(&scan, &labels, None).is_ok());

    let mut labels = labels_for(&scan);
    labels.annotators.push("model-c".to_string());
    assert!(score(&scan, &labels, None).is_err());

    let mut labels = labels_for(&scan);
    labels.adjudicator = Some("model-c".to_string());
    assert!(score(&scan, &labels, None).is_err());
}

#[test]
fn annotation_comparison_and_finalization_enforce_exact_adjudication() {
    let directory = tempfile::tempdir().unwrap();
    let scan = scan_with_nodes(2);
    let scan_path = directory.path().join("scan.json");
    let input_path = directory.path().join("input.json");
    let a_path = directory.path().join("a.json");
    let b_path = directory.path().join("b.json");
    let c_path = directory.path().join("c.json");
    let disputes_path = directory.path().join("disputes.json");
    let labels_path = directory.path().join("labels.json");
    write_private_json(&scan_path, &scan, false).unwrap();
    prepare_file(&scan_path, &input_path, false).unwrap();
    let positive = DeterministicPositiveLabel {
        kind: "isolated_node".to_string(),
        focus_path: scan.nodes[0].path.clone(),
        reason: "no links".to_string(),
    };
    let a = CuratorAccuracyAnnotationV1 {
        schema_version: ANNOTATION_SCHEMA.to_string(),
        run_id: "model-a".to_string(),
        deterministic_positives: vec![positive.clone()],
        semantic_findings: vec![],
    };
    let b = CuratorAccuracyAnnotationV1 {
        schema_version: ANNOTATION_SCHEMA.to_string(),
        run_id: "model-b".to_string(),
        deterministic_positives: vec![],
        semantic_findings: vec![],
    };
    write_private_json(&a_path, &a, false).unwrap();
    write_private_json(&b_path, &b, false).unwrap();
    let disputes =
        compare_annotation_files(&input_path, &a_path, &b_path, &disputes_path, false).unwrap();
    assert_eq!(disputes.deterministic.len(), 1);
    assert!(
        finalize_labels_file(&input_path, &a_path, &b_path, None, &labels_path, false).is_err()
    );

    let c = CuratorAccuracyAdjudicationV1 {
        schema_version: ADJUDICATION_SCHEMA.to_string(),
        run_id: "model-c".to_string(),
        deterministic_positives: vec![positive],
        deterministic_negatives: vec![],
        semantic_findings: vec![],
        semantic_negatives: vec![],
    };
    write_private_json(&c_path, &c, false).unwrap();
    let labels = finalize_labels_file(
        &input_path,
        &a_path,
        &b_path,
        Some(&c_path),
        &labels_path,
        false,
    )
    .unwrap();
    assert_eq!(labels.adjudicated_disagreements, 1);
    assert_eq!(labels.adjudicator.as_deref(), Some("model-c"));
    assert_eq!(labels.deterministic_positives.len(), 1);

    let mut incomplete = c;
    incomplete.deterministic_positives.clear();
    write_private_json(&c_path, &incomplete, true).unwrap();
    assert!(
        finalize_labels_file(
            &input_path,
            &a_path,
            &b_path,
            Some(&c_path),
            &labels_path,
            true,
        )
        .is_err()
    );
}

fn semantic_plan(
    scan: &CuratorScanV1,
    first: &str,
    second: &str,
    change_path: &str,
) -> CuratorPlanV1 {
    CuratorPlanV1 {
        schema_version: "kinic.curator.plan.v1".to_string(),
        database_id: scan.database_id.clone(),
        canister_id: scan.canister_id.clone(),
        snapshot_revision: scan.snapshot_revision.clone(),
        agent: "proposal-agent".to_string(),
        findings: vec![SemanticFinding {
            id: "F001".to_string(),
            kind: "duplicate".to_string(),
            confidence: FindingConfidence::High,
            store: CuratorStore::Knowledge,
            summary: "duplicate".to_string(),
            paths: vec![first.to_string(), second.to_string()],
            evidence: vec![
                SemanticEvidence {
                    path: first.to_string(),
                    excerpt: "same claim one".to_string(),
                },
                SemanticEvidence {
                    path: second.to_string(),
                    excerpt: "same claim two".to_string(),
                },
            ],
        }],
        proposals: vec![CuratorProposal {
            id: "P001".to_string(),
            finding_ids: vec!["F001".to_string()],
            summary: "update duplicate".to_string(),
            rationale: "preserve one current claim".to_string(),
            confidence: FindingConfidence::High,
            changes: vec![CuratorChange {
                path: change_path.to_string(),
                expected_etag: "etag".to_string(),
                replacement_body: Some("replacement".to_string()),
                target_status: None,
            }],
        }],
    }
}

#[test]
fn rule_list_has_no_duplicates() {
    let rules = crate::curator_accuracy::DETERMINISTIC_RULES;
    assert_eq!(
        rules.len(),
        rules.into_iter().collect::<BTreeSet<_>>().len()
    );
}

use super::*;

pub(super) fn validate_annotation_pair(
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

pub(super) fn validate_annotation(
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

pub(super) fn validate_adjudication(
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

pub(super) fn deterministic_annotation_map(
    labels: &[DeterministicPositiveLabel],
) -> BTreeMap<(&str, &str), &DeterministicPositiveLabel> {
    labels
        .iter()
        .map(|label| ((label.kind.as_str(), label.focus_path.as_str()), label))
        .collect()
}

pub(super) fn semantic_annotation_key(finding: &SemanticAnnotationFinding) -> Result<String> {
    Ok(semantic_key(
        &finding.kind,
        finding.store,
        &normalized_paths(&finding.paths)?,
    ))
}

pub(super) fn semantic_annotation_map(
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

pub(super) fn build_disputes(
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

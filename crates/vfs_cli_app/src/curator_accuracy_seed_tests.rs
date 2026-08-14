use crate::curator::{
    CuratorCoverage, CuratorScanNode, CuratorScanV1, CuratorStatus, DeterministicFinding,
    FindingSeverity, store_for_path,
};
use crate::curator_accuracy_seed::{
    generate_seed_files, prepare_seed_repair, validate_seed_batch, validate_seed_definition,
    validate_seed_manifest, verify_seed_files,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use vfs_types::NodeKind;

#[test]
fn seed_generator_is_deterministic_and_meets_corpus_contract() {
    let first_dir = tempfile::tempdir().unwrap();
    let second_dir = tempfile::tempdir().unwrap();
    let first_out = first_dir.path().join("seed");
    let second_out = second_dir.path().join("seed");
    let first = generate_seed_files(&first_out, "curator-accuracy-v1", false).unwrap();
    let second = generate_seed_files(&second_out, "curator-accuracy-v1", false).unwrap();

    assert_eq!(first.non_folder_node_count, 128);
    assert_eq!(first.nodes.len(), second.nodes.len());
    assert_eq!(
        first.expected_findings.len(),
        second.expected_findings.len()
    );
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&second).unwrap()
    );
    assert!(first.batches.iter().all(|batch| batch.node_count <= 100));
    assert_eq!(first.semantic_findings.len(), 12);
    assert_eq!(
        first
            .semantic_findings
            .iter()
            .filter(|finding| finding.kind == "duplicate")
            .count(),
        6
    );
    let contents = seed_contents(&first_out, &first);
    let file_contents = first
        .nodes
        .iter()
        .filter(|node| node.kind != NodeKind::Folder)
        .map(|node| contents[&node.path].as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(file_contents.len(), first.non_folder_node_count);
    for finding in &first.semantic_findings {
        let left = &contents[&finding.paths[0]];
        let right = &contents[&finding.paths[1]];
        assert!(left.contains("Semantic gold claim:"));
        assert!(right.contains("Semantic gold claim:"));
        if finding.kind == "duplicate" {
            assert!(left.contains("09:00 UTC"));
            assert!(right.contains("09:00 UTC"));
        } else {
            assert!(left.contains("requires signed uploads"));
            assert!(right.contains("accepts unsigned uploads"));
        }
    }
    assert_eq!(
        first
            .semantic_findings
            .iter()
            .filter(|finding| finding.kind == "contradiction")
            .count(),
        6
    );
    let rules = first
        .expected_findings
        .iter()
        .map(|finding| finding.kind.as_str())
        .collect::<BTreeSet<_>>();
    assert!(first.expected_findings.len() >= 40);
    assert!(rules.len() >= 12);
}

#[test]
fn seed_batches_create_parents_before_files_and_use_unique_paths() {
    let directory = tempfile::tempdir().unwrap();
    let out = directory.path().join("seed");
    let manifest = generate_seed_files(&out, "curator-accuracy-v1", false).unwrap();
    let paths = manifest
        .nodes
        .iter()
        .map(|node| node.path.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(paths.len(), manifest.nodes.len());

    let batch_one: Vec<Value> =
        serde_json::from_slice(&std::fs::read(out.join("batch-001.json")).unwrap()).unwrap();
    let positions = batch_one
        .iter()
        .enumerate()
        .map(|(index, node)| (node["path"].as_str().unwrap(), index))
        .collect::<BTreeMap<_, _>>();
    for (path, index) in &positions {
        let node = &batch_one[*index];
        if node["kind"] == "folder" {
            continue;
        }
        let parent = path.rsplit_once('/').unwrap().0;
        if let Some(parent_index) = positions.get(parent) {
            assert!(parent_index < index, "parent must precede child: {path}");
        }
    }
}

#[test]
fn seed_generator_rejects_invalid_ids_and_existing_output() {
    let directory = tempfile::tempdir().unwrap();
    assert!(generate_seed_files(&directory.path().join("bad"), "Bad/Seed", false).is_err());
    let out = directory.path().join("seed");
    generate_seed_files(&out, "curator-accuracy-v1", false).unwrap();
    assert!(generate_seed_files(&out, "curator-accuracy-v1", false).is_err());
}

#[test]
fn seed_manifest_rejects_unassigned_nodes_and_inconsistent_counts() {
    let directory = tempfile::tempdir().unwrap();
    let out = directory.path().join("seed");
    let manifest = generate_seed_files(&out, "curator-accuracy-v1", false).unwrap();

    let mut invalid = manifest.clone();
    invalid.nodes[0].batch = 999;
    assert!(validate_seed_manifest(&invalid).is_err());

    let mut invalid = manifest;
    invalid.batches[0].node_count -= 1;
    assert!(validate_seed_manifest(&invalid).is_err());
}

#[test]
fn seed_batch_validation_rejects_tampered_path_content_metadata_and_etag() {
    let directory = tempfile::tempdir().unwrap();
    let out = directory.path().join("seed");
    let manifest = generate_seed_files(&out, "curator-accuracy-v1", false).unwrap();
    let manifest_path = out.join("seed-manifest.json");
    assert_eq!(
        validate_seed_definition(&manifest_path, &out).unwrap(),
        manifest.nodes.len()
    );
    let batch = &manifest.batches[0];
    let batch_path = out.join(&batch.file);
    let original: Vec<Value> =
        serde_json::from_slice(&std::fs::read(&batch_path).unwrap()).unwrap();
    for field in ["path", "content", "metadata_json", "expected_etag"] {
        let mut tampered = original.clone();
        let index = if field == "metadata_json" {
            tampered
                .iter()
                .position(|node| node["kind"] != "folder")
                .unwrap()
        } else {
            0
        };
        tampered[index][field] = match field {
            "path" => serde_json::json!("/Knowledge/not-the-seed/existing.md"),
            "content" => serde_json::json!("tampered"),
            "metadata_json" => serde_json::json!("{}"),
            _ => serde_json::json!("stale-etag"),
        };
        crate::curator::write_private_json(&batch_path, &tampered, true).unwrap();
        assert!(validate_seed_batch(&manifest_path, &batch_path, batch.index, None).is_err());
    }
    crate::curator::write_private_json(&batch_path, &original, true).unwrap();
    assert!(validate_seed_batch(&manifest_path, &batch_path, batch.index, None).is_ok());
}

#[test]
fn seed_verifier_reports_complete_and_detects_content_mismatch() {
    let directory = tempfile::tempdir().unwrap();
    let out = directory.path().join("seed");
    let manifest = generate_seed_files(&out, "curator-accuracy-v1", false).unwrap();
    let scan_path = directory.path().join("scan.json");
    let report_path = directory.path().join("report.json");
    let mut scan = scan_from_seed(&out, &manifest);
    crate::curator::write_private_json(&scan_path, &scan, false).unwrap();
    let report = verify_seed_files(
        &scan_path,
        &out.join("seed-manifest.json"),
        &report_path,
        false,
        false,
    )
    .unwrap();
    assert!(report.complete);

    scan.nodes[0].content.push_str("tampered");
    crate::curator::write_private_json(&scan_path, &scan, true).unwrap();
    let partial_path = directory.path().join("partial.json");
    let report = verify_seed_files(
        &scan_path,
        &out.join("seed-manifest.json"),
        &partial_path,
        true,
        false,
    )
    .unwrap();
    assert!(!report.complete);
    assert_eq!(report.content_mismatches.len(), 1);

    let repair_path = directory.path().join("repair.json");
    let repair_count = prepare_seed_repair(
        &scan_path,
        &out.join("seed-manifest.json"),
        &out,
        &repair_path,
        None,
        false,
    )
    .unwrap();
    assert_eq!(repair_count, 1);
    let repairs: Vec<Value> = serde_json::from_slice(&std::fs::read(repair_path).unwrap()).unwrap();
    assert_eq!(repairs[0]["expected_etag"], scan.nodes[0].etag);
    assert_eq!(repairs[0]["metadata_json"], scan.nodes[0].metadata_json);
}

#[test]
fn seed_verifier_detects_partial_batches_and_unexpected_seed_paths() {
    let directory = tempfile::tempdir().unwrap();
    let out = directory.path().join("seed");
    let manifest = generate_seed_files(&out, "curator-accuracy-v1", false).unwrap();
    let scan_path = directory.path().join("scan.json");
    let mut scan = scan_from_seed(&out, &manifest);
    let removed_path = manifest
        .nodes
        .iter()
        .find(|node| node.batch == 2)
        .unwrap()
        .path
        .clone();
    scan.nodes.retain(|node| node.path != removed_path);
    scan.nodes.push(CuratorScanNode {
        path: "/Knowledge/curator-accuracy-v1/unexpected.md".to_string(),
        store: store_for_path("/Knowledge/curator-accuracy-v1/unexpected.md"),
        kind: NodeKind::File,
        body: "unexpected".to_string(),
        content: "unexpected".to_string(),
        metadata_json: "{}".to_string(),
        created_at: 1,
        updated_at: 2,
        etag: "etag-unexpected".to_string(),
        curator_status: CuratorStatus::Active,
        outgoing_links: vec![],
        source_evidence: vec![],
    });
    crate::curator::write_private_json(&scan_path, &scan, false).unwrap();
    let report = verify_seed_files(
        &scan_path,
        &out.join("seed-manifest.json"),
        &directory.path().join("partial.json"),
        true,
        false,
    )
    .unwrap();
    assert!(!report.complete);
    assert_eq!(report.missing_paths, vec![removed_path]);
    assert_eq!(
        report.unexpected_paths,
        vec!["/Knowledge/curator-accuracy-v1/unexpected.md"]
    );
    assert!(
        report
            .batch_statuses
            .iter()
            .any(|batch| batch.index == 2 && batch.status == "partial")
    );
}

fn seed_contents(
    out: &std::path::Path,
    manifest: &crate::curator_accuracy_seed::CuratorAccuracySeedManifestV1,
) -> BTreeMap<String, String> {
    manifest
        .batches
        .iter()
        .flat_map(|batch| {
            let values: Vec<Value> =
                serde_json::from_slice(&std::fs::read(out.join(&batch.file)).unwrap()).unwrap();
            values.into_iter().map(|value| {
                (
                    value["path"].as_str().unwrap().to_string(),
                    value["content"].as_str().unwrap().to_string(),
                )
            })
        })
        .collect()
}

fn scan_from_seed(
    out: &std::path::Path,
    manifest: &crate::curator_accuracy_seed::CuratorAccuracySeedManifestV1,
) -> CuratorScanV1 {
    let mut nodes = Vec::new();
    for batch in &manifest.batches {
        let values: Vec<Value> =
            serde_json::from_slice(&std::fs::read(out.join(&batch.file)).unwrap()).unwrap();
        for value in values {
            let path = value["path"].as_str().unwrap().to_string();
            let kind: NodeKind = serde_json::from_value(value["kind"].clone()).unwrap();
            let content = value["content"].as_str().unwrap().to_string();
            nodes.push(CuratorScanNode {
                path: path.clone(),
                store: store_for_path(&path),
                kind,
                body: content.clone(),
                content,
                metadata_json: value["metadata_json"].as_str().unwrap().to_string(),
                created_at: 1,
                updated_at: 2,
                etag: format!("etag-{}", nodes.len()),
                curator_status: CuratorStatus::Active,
                outgoing_links: Vec::new(),
                source_evidence: Vec::new(),
            });
        }
    }
    let findings = manifest
        .expected_findings
        .iter()
        .enumerate()
        .map(|(index, expected)| DeterministicFinding {
            id: format!("D{:06}", index + 1),
            kind: expected.kind.clone(),
            severity: FindingSeverity::Warning,
            store: store_for_path(&expected.focus_path),
            paths: vec![expected.focus_path.clone()],
            detail: "oracle".to_string(),
        })
        .collect();
    CuratorScanV1 {
        schema_version: "kinic.curator.scan.v1".to_string(),
        database_id: "db".to_string(),
        canister_id: "aaaaa-aa".to_string(),
        snapshot_revision: "v5:1:test".to_string(),
        generated_at: "2026-08-13T00:00:00Z".to_string(),
        stale_after_days: 90,
        coverage: CuratorCoverage {
            entry_roots: vec![],
            node_count: nodes.len(),
            inspected_node_count: manifest.non_folder_node_count,
            truncated_link_paths: vec![],
            inspection_errors: vec![],
            complete: true,
        },
        nodes,
        findings,
    }
}

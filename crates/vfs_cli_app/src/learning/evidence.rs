//! Resolve immutable consumed revisions separately from guards on surviving identities.
use super::model::hash;
use anyhow::{Context, Result, ensure};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use vfs_client::VfsApi;
use vfs_types::{Node, NodeHistoryRequest, NodeRevisionRequest, RevisionRef};

const EVIDENCE_LIMIT: usize = 100;

#[derive(Clone, Debug)]
pub struct ResolvedEvidence {
    pub historical: Vec<Node>,
    pub guards: Vec<RevisionRef>,
    pub current_nodes: Vec<Node>,
}

fn enqueue(
    reference: RevisionRef,
    seen: &mut BTreeMap<(String, u64), RevisionRef>,
    pending: &mut VecDeque<RevisionRef>,
) -> Result<()> {
    let key = (reference.node_id.clone(), reference.revision);
    if let Some(previous) = seen.get(&key) {
        ensure!(
            previous == &reference,
            "conflicting references to one historical revision"
        );
        return Ok(());
    }
    ensure!(
        seen.len() < EVIDENCE_LIMIT,
        "historical evidence closure exceeds 100 revisions"
    );
    seen.insert(key, reference.clone());
    pending.push_back(reference);
    Ok(())
}

/// The original snapshots remain evidence after their nodes move, change or disappear.
/// Only guards describe current versions; a recreated path never substitutes for an old identity.
pub async fn resolve_evidence(
    client: &impl VfsApi,
    db: &str,
    refs: &[RevisionRef],
) -> Result<ResolvedEvidence> {
    ensure!(
        refs.len() <= EVIDENCE_LIMIT,
        "historical evidence requires at most 100 references"
    );
    let mut seen = BTreeMap::new();
    let mut pending = VecDeque::new();
    for reference in refs {
        enqueue(reference.clone(), &mut seen, &mut pending)?;
    }
    let mut historical = Vec::new();
    let mut identities = BTreeSet::new();
    while let Some(expected) = pending.pop_front() {
        let before = expected
            .revision
            .checked_add(1)
            .context("invalid historical revision")?;
        let mut page = client
            .node_history(NodeHistoryRequest {
                database_id: db.into(),
                node_id: expected.node_id.clone(),
                before_revision: Some(before),
                limit: 1,
            })
            .await?;
        ensure!(
            page.revisions.len() == 1,
            "historical evidence revision is unavailable: {}",
            expected.path
        );
        let revision = page.revisions.remove(0);
        ensure!(
            !revision.deleted
                && revision.node_id == expected.node_id
                && revision.revision == expected.revision
                && revision.node.path == expected.path
                && revision.node.etag == expected.etag
                && revision.content_hash == expected.content_hash
                && hash(&revision.node.content) == expected.content_hash,
            "historical evidence snapshot does not match reference: {}",
            expected.path,
        );
        let metadata: serde_json::Value = serde_json::from_str(&revision.node.metadata_json)
            .context("historical evidence metadata is not valid JSON")?;
        if let Some(value) = metadata.get("evidence") {
            let dependencies: Vec<RevisionRef> = serde_json::from_value(value.clone())
                .context("historical metadata evidence must contain revision references")?;
            ensure!(
                dependencies.len() <= EVIDENCE_LIMIT,
                "historical metadata evidence exceeds 100 references"
            );
            for dependency in dependencies {
                enqueue(dependency, &mut seen, &mut pending)?;
            }
        }
        identities.insert(expected.node_id);
        historical.push(revision.node);
    }
    let mut guards = Vec::new();
    let mut current_nodes = Vec::new();
    for node_id in identities {
        let mut latest_page = client
            .node_history(NodeHistoryRequest {
                database_id: db.into(),
                node_id: node_id.clone(),
                before_revision: None,
                limit: 1,
            })
            .await?;
        ensure!(
            latest_page.revisions.len() == 1,
            "latest evidence identity revision is unavailable"
        );
        let latest = latest_page.revisions.remove(0);
        ensure!(
            latest.node_id == node_id,
            "latest evidence history returned a different identity"
        );
        if latest.deleted {
            continue;
        }
        let current = client
            .current_node_revision(NodeRevisionRequest {
                database_id: db.into(),
                path: latest.node.path.clone(),
            })
            .await?
            .context(
                "evidence identity moved or disappeared while resolving current guards; retry",
            )?;
        ensure!(
            !current.deleted
                && current.node_id == node_id
                && current.revision >= latest.revision
                && current.node.path == latest.node.path
                && hash(&current.node.content) == current.content_hash,
            "evidence identity changed while resolving current guards; retry",
        );
        guards.push(RevisionRef {
            path: current.node.path.clone(),
            node_id: current.node_id,
            revision: current.revision,
            etag: current.node.etag.clone(),
            content_hash: current.content_hash,
        });
        current_nodes.push(current.node);
    }
    Ok(ResolvedEvidence {
        historical,
        guards,
        current_nodes,
    })
}

#[cfg(test)]
#[path = "evidence_tests.rs"]
mod tests;

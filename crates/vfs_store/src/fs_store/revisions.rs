//! Revision snapshots are recorded by SQL triggers in the same transaction as every mutation.
use super::*;
use vfs_types::{
    LearningPublicationRequest, LearningPublicationResult, NodeHistoryPage, NodeHistoryRequest,
    NodeRevision,
};

const REVISION_COLUMNS: &str = "r.node_id,r.revision,r.path,r.kind,r.content,r.created_at,r.updated_at,r.etag,r.metadata_json,r.deleted";
const HISTORY_BYTES_MAX: usize = 1_000_000;
const PUBLICATION_LOOKUP_SQL: &str =
    "SELECT request_json,result_json FROM learning_publication_commits WHERE operation_id=?1";
const PUBLICATION_COMMIT_SQL: &str = "INSERT INTO learning_publication_commits(operation_id,request_json,result_json) VALUES(?1,?2,?3)";

fn revision_from_row(row: &crate::sqlite::Row<'_>) -> crate::sqlite::Result<NodeRevision> {
    let content: String = crate::sqlite::row_get(row, 4)?;
    Ok(NodeRevision {
        node_id: crate::sqlite::row_get::<i64>(row, 0)?.to_string(),
        revision: crate::sqlite::row_get::<i64>(row, 1)? as u64,
        content_hash: sha256_hex(&content),
        node: Node {
            path: crate::sqlite::row_get(row, 2)?,
            kind: node_kind_from_db(&crate::sqlite::row_get::<String>(row, 3)?)?,
            content,
            created_at: crate::sqlite::row_get(row, 5)?,
            updated_at: crate::sqlite::row_get(row, 6)?,
            etag: crate::sqlite::row_get(row, 7)?,
            metadata_json: crate::sqlite::row_get(row, 8)?,
        },
        deleted: crate::sqlite::row_get::<i64>(row, 9)? != 0,
    })
}

fn current_revision(conn: &Connection, path: &str) -> Result<Option<NodeRevision>, String> {
    let sql = format!(
        "SELECT {REVISION_COLUMNS} FROM fs_node_revisions r
         JOIN fs_node_identities i ON i.node_id=r.node_id
         JOIN fs_nodes n ON n.id=i.current_row_id
         WHERE n.path=?1 ORDER BY r.revision DESC LIMIT 1"
    );
    conn.query_row(&sql, params![path], revision_from_row)
        .optional()
        .map_err(|error| error.to_string())
}

fn scope_revision_for_conn(conn: &Connection, prefix: &str) -> Result<u64, String> {
    let prefix = normalize_node_path(prefix, true)?;
    let revision = if prefix == "/" {
        conn.query_row(
            "SELECT COALESCE(MAX(last_change_revision),0) FROM fs_path_state",
            params![],
            |row| crate::sqlite::row_get::<i64>(row, 0),
        )
    } else {
        // Binary ranges preserve case and literal '%'/'_' characters. Incrementing
        // the final separator also includes every possible Unicode descendant.
        let descendants = format!("{prefix}/");
        let upper = format!("{prefix}0");
        conn.query_row(
            "SELECT COALESCE(MAX(last_change_revision),0) FROM fs_path_state
             WHERE path=?1 OR (path>=?2 AND path<?3)",
            params![prefix, descendants, upper],
            |row| crate::sqlite::row_get::<i64>(row, 0),
        )
    }
    .map_err(|error| error.to_string())?;
    u64::try_from(revision).map_err(|error| error.to_string())
}

fn guarded_learning_prefix(prefix: &str) -> Result<String, String> {
    let prefix = normalize_node_path(prefix, true)?;
    if !["/Knowledge", "/Memory", "/Skills"]
        .iter()
        .any(|root| prefix == *root || prefix.starts_with(&format!("{root}/")))
    {
        return Err("learning scope guards must be within /Knowledge, /Memory or /Skills".into());
    }
    Ok(prefix)
}

fn mutable_agent_node(path: &str, metadata: &str) -> Result<(), NodeMutationError> {
    let parsed: serde_json::Value = serde_json::from_str(metadata).map_err(|_| {
        NodeMutationError::invalid_operation("learning target metadata must be valid JSON")
    })?;
    let basename = path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let protected = parsed.get("protected").and_then(|value| value.as_bool()) == Some(true)
        || parsed.get("approved").and_then(|value| value.as_bool()) == Some(true)
        || parsed
            .get("approved_decision")
            .and_then(|value| value.as_bool())
            == Some(true)
        || parsed
            .get("kind")
            .and_then(|value| value.as_str())
            .is_some_and(|value| {
                matches!(
                    value,
                    "instruction" | "instructions" | "decision" | "approved_decision"
                )
            })
        || matches!(
            basename.as_str(),
            "agents.md" | "claude.md" | "instructions.md" | "decisions.md"
        );
    if parsed.get("authority").and_then(|value| value.as_str()) != Some("agent") || protected {
        return Err(NodeMutationError::forbidden(format!(
            "learning target is protected; explicit agent authority required: {path}"
        )));
    }
    Ok(())
}

impl FsStore {
    pub fn scope_revision(&self, prefix: &str) -> Result<u64, String> {
        self.read_conn(|conn| scope_revision_for_conn(conn, prefix))
    }

    pub fn current_node_revision(&self, path: &str) -> Result<Option<NodeRevision>, String> {
        let path = normalize_node_path(path, false)?;
        self.read_conn(|conn| current_revision(conn, &path))
    }

    pub fn node_history(&self, request: NodeHistoryRequest) -> Result<NodeHistoryPage, String> {
        let node_id = request
            .node_id
            .parse::<i64>()
            .map_err(|_| "invalid node identity".to_string())?;
        if node_id <= 0 {
            return Err("invalid node identity".into());
        }
        let before = request
            .before_revision
            .unwrap_or(i64::MAX as u64)
            .min(i64::MAX as u64) as i64;
        let limit = request.limit.clamp(1, 100) as usize;
        self.read_conn(|conn| {
            let sql = format!(
                "SELECT {REVISION_COLUMNS} FROM fs_node_revisions r
                 WHERE r.node_id=?1 AND r.revision<?2
                 ORDER BY r.revision DESC LIMIT ?3"
            );
            let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
            let mut bytes = 0;
            let mut revisions = Vec::new();
            // Stop reading rows when the response is full. Collecting all 100 full
            // snapshots first would make memory scale with the largest node size.
            let scan = crate::sqlite::query_try_map_limit(
                &mut stmt,
                params![node_id, before, (limit + 1) as i64],
                limit + 1,
                |row| -> Result<(), crate::sqlite::QueryTryMapError<()>> {
                    if revisions.len() == limit {
                        return Err(crate::sqlite::QueryTryMapError::Validation(()));
                    }
                    let revision = revision_from_row(row)?;
                    // Fixed overhead reserves the Candid record and scalar fields.
                    let size = 512
                        + revision.node_id.len()
                        + revision.content_hash.len()
                        + revision.node.path.len()
                        + revision.node.content.len()
                        + revision.node.etag.len()
                        + revision.node.metadata_json.len();
                    if bytes + size > HISTORY_BYTES_MAX {
                        return Err(crate::sqlite::QueryTryMapError::Validation(()));
                    }
                    bytes += size;
                    revisions.push(revision);
                    Ok(())
                },
            );
            let more = match scan {
                Ok(_) => false,
                Err(crate::sqlite::QueryTryMapError::Validation(())) => true,
                Err(crate::sqlite::QueryTryMapError::Sqlite(error)) => {
                    return Err(error.to_string());
                }
            };
            if more && revisions.is_empty() {
                return Err("node revision exceeds history byte limit".into());
            }
            let next_cursor = if more {
                revisions
                    .last()
                    .map(|revision: &NodeRevision| revision.revision)
            } else {
                None
            };
            Ok(NodeHistoryPage {
                revisions,
                next_cursor,
            })
        })
    }

    pub fn publish_learning(
        &self,
        request: LearningPublicationRequest,
        now: i64,
    ) -> Result<LearningPublicationResult, NodeMutationError> {
        self.publish_learning_with_publication_commit(request, now, None)
    }

    pub fn publish_learning_with_publication_commit(
        &self,
        request: LearningPublicationRequest,
        now: i64,
        publication_operation_id: Option<i64>,
    ) -> Result<LearningPublicationResult, NodeMutationError> {
        self.publish_learning_with_publication_outcome(request, now, publication_operation_id)
            .map(|(result, _)| result)
    }

    /// The boolean is true only when this transaction changed nodes. Replays must
    /// preserve later public URLs and must not mark a detach journal committed.
    pub fn publish_learning_with_publication_outcome(
        &self,
        request: LearningPublicationRequest,
        now: i64,
        publication_operation_id: Option<i64>,
    ) -> Result<(LearningPublicationResult, bool), NodeMutationError> {
        validate_write_nodes_count(request.targets.len())
            .map_err(NodeMutationError::invalid_operation)?;
        if request.operation_id.trim().is_empty()
            || request.operation_id.len() > 200
            || request.evidence.len() > 100
            || request.scope_guards.len() > 10
        {
            return Err(NodeMutationError::invalid_operation(
                "invalid operation id or evidence count",
            ));
        }
        let request_json = serde_json::to_string(&request)
            .map_err(|error| NodeMutationError::invalid_operation(error.to_string()))?;
        self.write_mutation_conn_with_publication_outcome(publication_operation_id, |tx| {
            let previous: Option<(String, String)> = tx
                .query_row(
                    PUBLICATION_LOOKUP_SQL,
                    params![request.operation_id],
                    |row| {
                        Ok((
                            crate::sqlite::row_get(row, 0)?,
                            crate::sqlite::row_get(row, 1)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| NodeMutationError::write_unavailable(error.to_string()))?;
            if let Some((previous, result)) = previous {
                if previous != request_json {
                    return Err(NodeMutationError::invalid_operation(
                        "operation id reused with different payload",
                    ));
                }
                return serde_json::from_str(&result)
                    .map(|result| ((result, false), false))
                    .map_err(|error| NodeMutationError::write_unavailable(error.to_string()));
            }
            for guard in &request.scope_guards {
                let prefix = guarded_learning_prefix(&guard.prefix)
                    .map_err(NodeMutationError::invalid_operation)?;
                let current = scope_revision_for_conn(tx, &prefix)
                    .map_err(NodeMutationError::write_unavailable)?;
                if current != guard.revision {
                    return Err(NodeMutationError::etag_conflict(
                        "learning retrieval scope changed",
                        prefix,
                    ));
                }
            }
            // All source guards and target writes share this transaction, including on Wasm.
            for evidence in &request.evidence {
                let path = normalize_node_path(&evidence.path, false)
                    .map_err(NodeMutationError::invalid_operation)?;
                let current = current_revision(tx, &path)
                    .map_err(NodeMutationError::write_unavailable)?
                    .ok_or_else(|| {
                        NodeMutationError::not_found_with_path(
                            "learning evidence no longer exists",
                            path.clone(),
                        )
                    })?;
                if current.node_id != evidence.node_id
                    || current.revision != evidence.revision
                    || current.node.etag != evidence.etag
                    || current.content_hash != evidence.content_hash
                {
                    return Err(NodeMutationError::etag_conflict(
                        "learning evidence snapshot changed",
                        path,
                    ));
                }
            }
            let mut paths = BTreeSet::new();
            for target in &request.targets {
                let path = normalize_node_path(&target.path, false)
                    .map_err(NodeMutationError::invalid_operation)?;
                if path.split('/').skip(1).count() > 64 {
                    return Err(NodeMutationError::invalid_operation(
                        "learning target depth exceeds 64 segments",
                    ));
                }
                if !paths.insert(path.clone()) {
                    return Err(NodeMutationError::invalid_operation(
                        "duplicate learning target",
                    ));
                }
                mutable_agent_node(&path, &target.metadata_json)?;
                if target.kind == NodeKind::Folder {
                    return Err(NodeMutationError::invalid_operation(
                        "learning targets cannot be folders",
                    ));
                }
                if let Some(current) =
                    load_node(tx, &path).map_err(NodeMutationError::write_unavailable)?
                {
                    mutable_agent_node(&path, &current.metadata_json)?;
                }
            }
            // Structural parents belong to this same guarded transaction. Creating
            // them before checking scopes would invalidate the evaluated corpus.
            for path in &paths {
                let segments = path.split('/').skip(1).collect::<Vec<_>>();
                let mut parent = String::new();
                for segment in segments.iter().take(segments.len().saturating_sub(1)) {
                    parent.push('/');
                    parent.push_str(segment);
                    mkdir_node_in_tx(
                        tx,
                        MkdirNodeRequest {
                            database_id: request.database_id.clone(),
                            path: parent.clone(),
                        },
                        now,
                    )?;
                }
            }
            let mut nodes = Vec::new();
            for (index, target) in request.targets.clone().into_iter().enumerate() {
                nodes.push(
                    write_node_item_in_tx(tx, &request.database_id, target, now)
                        .map_err(|error| error.with_failed_index(index))?,
                );
            }
            let result = LearningPublicationResult {
                operation_id: request.operation_id.clone(),
                nodes,
            };
            let result_json = serde_json::to_string(&result)
                .map_err(|error| NodeMutationError::write_unavailable(error.to_string()))?;
            tx.execute(
                PUBLICATION_COMMIT_SQL,
                params![request.operation_id, request_json, result_json],
            )
            .map_err(|error| NodeMutationError::write_unavailable(error.to_string()))?;
            Ok(((result, true), true))
        })
    }
}

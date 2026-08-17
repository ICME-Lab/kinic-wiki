use super::*;

impl FsStore {
    pub fn list_node_history(
        &self,
        request: ListNodeHistoryRequest,
    ) -> Result<ListNodeHistoryResponse, String> {
        let limit = request.limit.min(history::HISTORY_PAGE_LIMIT_MAX);
        if limit == 0 {
            return Err("limit must be greater than zero".to_string());
        }
        self.read_conn(|conn| {
            let page_id = match request.target {
                NodeHistoryTarget::CurrentPath(path) => {
                    let path = normalize_node_path(&path, false)?;
                    history::resolve_page_id_by_path(conn, &path)?
                        .ok_or_else(|| format!("history page does not exist: {path}"))?
                }
                NodeHistoryTarget::PageId(page_id) => {
                    let page_id = history_id(page_id, "page id")?;
                    if !history::page_exists(conn, page_id)? {
                        return Err(format!("history page does not exist: {page_id}"));
                    }
                    page_id
                }
            };
            history::list_history(
                conn,
                page_id,
                request
                    .cursor
                    .map(|cursor| history_id(cursor, "cursor"))
                    .transpose()?,
                limit,
            )
        })
    }

    pub fn read_node_version(
        &self,
        request: ReadNodeVersionRequest,
    ) -> Result<Option<NodeVersion>, String> {
        let page_id = history_id(request.page_id, "page id")?;
        let version_id = history_id(request.version_id, "version id")?;
        self.read_conn(|conn| history::read_version(conn, page_id, version_id))
    }

    pub fn node_history_live_path(&self, page_id: u64) -> Result<Option<String>, String> {
        let page_id = history_id(page_id, "page id")?;
        self.read_conn(|conn| history::live_path(conn, page_id))
    }

    pub fn list_deleted_nodes(
        &self,
        request: ListDeletedNodesRequest,
    ) -> Result<ListDeletedNodesResponse, String> {
        let limit = request.limit.min(history::HISTORY_PAGE_LIMIT_MAX);
        if limit == 0 {
            return Err("limit must be greater than zero".to_string());
        }
        let cursor = request
            .cursor
            .map(|cursor| history_id(cursor, "cursor"))
            .transpose()?;
        self.read_conn(|conn| history::list_deleted(conn, cursor, limit))
    }

    pub fn restore_node_version_as(
        &self,
        request: RestoreNodeVersionRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        let page_id =
            history_id(request.page_id, "page id").map_err(NodeMutationError::invalid_operation)?;
        let version_id = history_id(request.version_id, "version id")
            .map_err(NodeMutationError::invalid_operation)?;
        self.write_mutation_conn_with_publication_commit(publication_operation_id, |tx| {
            let selected = history::read_version(tx, page_id, version_id)
                .map_err(NodeMutationError::write_unavailable)?
                .ok_or_else(|| {
                    NodeMutationError::not_found_with_path(
                        format!("history version does not exist: {version_id}"),
                        request.page_id.to_string(),
                    )
                })?;
            let (current_node_id, current_path): (Option<i64>, String) = tx
                .query_row(
                    "SELECT current_node_id, current_path FROM fs_history_pages WHERE id = ?1",
                    params![page_id],
                    |row| {
                        Ok((
                            crate::sqlite::row_get(row, 0)?,
                            crate::sqlite::row_get(row, 1)?,
                        ))
                    },
                )
                .map_err(|error| NodeMutationError::write_unavailable(error.to_string()))?;
            let existing = match current_node_id {
                Some(current_node_id) => load_stored_node(tx, &current_path)
                    .map_err(NodeMutationError::write_unavailable)?
                    .filter(|stored| stored.row_id == current_node_id),
                None => None,
            };
            match (&existing, request.expected_current_etag.as_deref()) {
                (Some(current), Some(expected)) if current.node.etag == expected => {}
                (Some(current), _) => {
                    return Err(NodeMutationError::etag_conflict(
                        format!(
                            "expected_current_etag does not match current etag: {}",
                            current.node.path
                        ),
                        current.node.path.clone(),
                    ));
                }
                (None, Some(_)) => {
                    return Err(NodeMutationError::invalid_operation(
                        "expected_current_etag must be None when restoring a deleted node",
                    ));
                }
                (None, None) => {}
            }
            let path = existing
                .as_ref()
                .map(|stored| stored.node.path.clone())
                .unwrap_or_else(|| selected.summary.path.clone());
            if existing.is_none()
                && load_stored_node(tx, &path)
                    .map_err(NodeMutationError::write_unavailable)?
                    .is_some()
            {
                return Err(NodeMutationError::invalid_operation_with_path(
                    format!("restore path already exists: {path}"),
                    path,
                ));
            }
            let mut node = Node {
                path,
                kind: selected.summary.kind,
                content: selected.content,
                created_at: existing
                    .as_ref()
                    .map(|stored| stored.node.created_at)
                    .unwrap_or(selected.summary.node_created_at),
                updated_at: now,
                etag: String::new(),
                metadata_json: selected.metadata_json,
            };
            let changed_bytes = crate::git_repository::node_mutation_bytes(
                "restore",
                existing.as_ref().map(|stored| &stored.node),
                Some(&node),
            )
            .map_err(NodeMutationError::invalid_operation)?;
            crate::git_repository::validate_mutation_budget(1, changed_bytes)
                .map_err(NodeMutationError::invalid_operation)?;
            ensure_missing_store_root_for_path(tx, &node.path, now)
                .map_err(NodeMutationError::write_unavailable)?;
            require_parent_folder_for_mutation(tx, &node.path)?;
            let change_id = history::begin_change(
                tx,
                author_principal,
                "restore",
                now,
                Some("restore"),
                existing.is_none().then_some(page_id),
            )
            .map_err(NodeMutationError::write_unavailable)?;
            let revision =
                record_change(tx, &node).map_err(NodeMutationError::write_unavailable)?;
            update_path_state(tx, &node.path, revision)
                .map_err(NodeMutationError::write_unavailable)?;
            node.etag = compute_node_etag(&node);
            let row_id = save_node(tx, existing.as_ref().map(|stored| stored.row_id), &node)
                .map_err(NodeMutationError::write_unavailable)?;
            sync_node_fts(tx, existing.as_ref(), Some((row_id, &node)))
                .map_err(NodeMutationError::write_unavailable)?;
            sync_node_links(tx, &node).map_err(NodeMutationError::write_unavailable)?;
            history::finish_change(tx, change_id).map_err(NodeMutationError::write_unavailable)?;
            Ok(WriteNodeResult {
                node: node_ack(&node),
                created: existing.is_none(),
            })
        })
    }
}

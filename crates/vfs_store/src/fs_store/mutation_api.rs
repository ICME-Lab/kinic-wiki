use super::*;

impl FsStore {
    pub fn write_node(
        &self,
        request: WriteNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        self.write_node_with_publication_commit(request, now, None)
    }

    pub fn write_node_with_publication_commit(
        &self,
        request: WriteNodeRequest,
        now: i64,
        publication_operation_id: Option<i64>,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        self.write_node_with_publication_commit_as(request, now, publication_operation_id, "system")
    }

    pub fn write_node_with_publication_commit_as(
        &self,
        request: WriteNodeRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        let WriteNodeRequest {
            database_id,
            path,
            kind,
            content,
            metadata_json,
            expected_etag,
        } = request;
        self.write_history_mutation_conn(
            publication_operation_id,
            author_principal,
            "write",
            now,
            None,
            |tx| {
                write_node_item_in_tx(
                    tx,
                    &database_id,
                    WriteNodeItem {
                        path,
                        kind,
                        content,
                        metadata_json,
                        expected_etag,
                    },
                    now,
                )
            },
        )
    }

    pub fn write_nodes(
        &self,
        request: WriteNodesRequest,
        now: i64,
    ) -> Result<Vec<WriteNodeResult>, NodeMutationError> {
        self.write_nodes_with_publication_commit(request, now, None)
    }

    pub fn write_nodes_with_publication_commit(
        &self,
        request: WriteNodesRequest,
        now: i64,
        publication_operation_id: Option<i64>,
    ) -> Result<Vec<WriteNodeResult>, NodeMutationError> {
        self.write_nodes_with_publication_commit_as(
            request,
            now,
            publication_operation_id,
            "system",
        )
    }

    pub fn write_nodes_with_publication_commit_as(
        &self,
        request: WriteNodesRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<Vec<WriteNodeResult>, NodeMutationError> {
        validate_write_nodes_count(request.nodes.len())
            .map_err(NodeMutationError::invalid_operation)?;
        preflight_write_nodes_budget(&request.nodes)?;
        let database_id = request.database_id;
        let nodes = request.nodes;
        self.write_history_mutation_conn(
            publication_operation_id,
            author_principal,
            "write_nodes",
            now,
            None,
            |tx| {
                let mut results = Vec::with_capacity(nodes.len());
                for (index, item) in nodes.into_iter().enumerate() {
                    results.push(
                        write_node_item_in_tx(tx, &database_id, item, now)
                            .map_err(|error| error.with_failed_index(index))?,
                    );
                }
                Ok(results)
            },
        )
    }

    pub fn append_node(
        &self,
        request: AppendNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        self.append_node_as(request, now, "system")
    }

    pub fn append_node_as(
        &self,
        request: AppendNodeRequest,
        now: i64,
        author_principal: &str,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(None, author_principal, "append", now, None, |tx| {
            append_node_in_tx(tx, request, now)
        })
    }

    pub fn edit_node(
        &self,
        request: EditNodeRequest,
        now: i64,
    ) -> Result<EditNodeResult, NodeMutationError> {
        self.edit_node_as(request, now, "system")
    }

    pub fn edit_node_as(
        &self,
        request: EditNodeRequest,
        now: i64,
        author_principal: &str,
    ) -> Result<EditNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(None, author_principal, "edit", now, None, |tx| {
            edit_node_in_tx(tx, request, now)
        })
    }

    pub fn mkdir_node(
        &self,
        request: MkdirNodeRequest,
        now: i64,
    ) -> Result<MkdirNodeResult, NodeMutationError> {
        self.mkdir_node_as(request, now, "system")
    }

    pub fn mkdir_node_as(
        &self,
        request: MkdirNodeRequest,
        now: i64,
        author_principal: &str,
    ) -> Result<MkdirNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(None, author_principal, "mkdir", now, None, |tx| {
            mkdir_node_in_tx(tx, request, now)
        })
    }

    pub fn move_node(
        &self,
        request: MoveNodeRequest,
        now: i64,
    ) -> Result<MoveNodeResult, NodeMutationError> {
        self.move_node_with_publication_commit(request, now, None)
    }

    pub fn move_node_with_publication_commit(
        &self,
        request: MoveNodeRequest,
        now: i64,
        publication_operation_id: Option<i64>,
    ) -> Result<MoveNodeResult, NodeMutationError> {
        self.move_node_with_publication_commit_as(request, now, publication_operation_id, "system")
    }

    pub fn move_node_with_publication_commit_as(
        &self,
        request: MoveNodeRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<MoveNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(
            publication_operation_id,
            author_principal,
            "move",
            now,
            None,
            |tx| move_node_in_tx(tx, request, now),
        )
    }

    pub fn mutate_nodes_batch(
        &self,
        request: MutateNodesBatchRequest,
        now: i64,
    ) -> Result<Vec<NodeMutationResult>, NodeMutationError> {
        self.mutate_nodes_batch_with_publication_commit(request, now, None)
    }

    pub fn mutate_nodes_batch_with_publication_commit(
        &self,
        request: MutateNodesBatchRequest,
        now: i64,
        publication_operation_id: Option<i64>,
    ) -> Result<Vec<NodeMutationResult>, NodeMutationError> {
        self.mutate_nodes_batch_with_publication_commit_as(
            request,
            now,
            publication_operation_id,
            "system",
        )
    }

    pub fn mutate_nodes_batch_with_publication_commit_as(
        &self,
        request: MutateNodesBatchRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<Vec<NodeMutationResult>, NodeMutationError> {
        validate_mutate_nodes_batch_count(request.operations.len())
            .map_err(NodeMutationError::invalid_operation)?;
        let database_id = request.database_id;
        let operations = request.operations;
        let preflight_operations = operations.clone();
        self.write_history_mutation_conn_with_preflight(
            publication_operation_id,
            author_principal,
            "batch",
            now,
            None,
            move |_| preflight_mutate_nodes_batch_budget(&preflight_operations),
            |tx| {
                operations
                    .into_iter()
                    .enumerate()
                    .map(|(index, operation)| {
                        mutate_node_in_tx(tx, &database_id, operation, now)
                            .map_err(|error| error.with_failed_index(index))
                    })
                    .collect()
            },
        )
    }

    pub fn multi_edit_node(
        &self,
        request: MultiEditNodeRequest,
        now: i64,
    ) -> Result<MultiEditNodeResult, NodeMutationError> {
        self.multi_edit_node_as(request, now, "system")
    }

    pub fn multi_edit_node_as(
        &self,
        request: MultiEditNodeRequest,
        now: i64,
        author_principal: &str,
    ) -> Result<MultiEditNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(None, author_principal, "multi_edit", now, None, |tx| {
            multi_edit_node_in_tx(tx, request, now)
        })
    }

    pub fn delete_node(
        &self,
        request: DeleteNodeRequest,
        now: i64,
    ) -> Result<DeleteNodeResult, NodeMutationError> {
        self.delete_node_with_publication_commit_as(request, now, None, "system")
    }

    pub fn delete_node_with_publication_commit_as(
        &self,
        request: DeleteNodeRequest,
        now: i64,
        publication_operation_id: Option<i64>,
        author_principal: &str,
    ) -> Result<DeleteNodeResult, NodeMutationError> {
        self.write_history_mutation_conn(
            publication_operation_id,
            author_principal,
            "delete",
            now,
            None,
            |tx| delete_node_in_tx(tx, request),
        )
    }

    pub fn publication_mutation_committed(&self, operation_id: i64) -> Result<bool, String> {
        self.read_conn(|conn| {
            conn.query_row(
                "SELECT 1 FROM publication_mutation_commits WHERE operation_id = ?1",
                params![operation_id],
                |row| crate::sqlite::row_get::<i64>(row, 0),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(|error| error.to_string())
        })
    }

    pub fn clear_publication_mutation_commit(&self, operation_id: i64) -> Result<(), String> {
        self.write_conn(|tx| {
            tx.execute(
                "DELETE FROM publication_mutation_commits WHERE operation_id = ?1",
                params![operation_id],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        })
    }
}

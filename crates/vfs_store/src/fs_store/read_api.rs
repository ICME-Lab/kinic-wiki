use super::*;

impl FsStore {
    pub fn status(&self) -> Result<Status, String> {
        self.read_conn(|conn| {
            Ok(Status {
                file_count: count_nodes(conn, "file")?,
                source_count: count_nodes(conn, "source")?,
            })
        })
    }

    pub fn logical_size_bytes(&self) -> Result<u64, String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let conn = Connection::open_with_flags(
                &self.database_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_URI
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| error.to_string())?;
            logical_size_bytes_for_conn(&conn)
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.read_conn(logical_size_bytes_for_conn)
        }
    }

    pub fn read_node(&self, path: &str) -> Result<Option<Node>, String> {
        let normalized = normalize_node_path(path, false)?;
        self.read_conn(|conn| load_node(conn, &normalized))
    }

    pub fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>, String> {
        let prefix = normalize_node_path(&request.prefix, true)?;
        let limit = capped_list_nodes_limit(request.limit);
        self.read_conn(|conn| {
            let rows = load_scoped_entry_rows(conn, &prefix, request.recursive.then_some(limit))?;
            let mut entries = build_entries_from_rows(&rows, &prefix, request.recursive);
            if !request.recursive {
                entries.truncate(limit as usize);
            }
            Ok(entries)
        })
    }

    pub fn list_children(&self, request: ListChildrenRequest) -> Result<Vec<ChildNode>, String> {
        let path = normalize_list_children_path(&request.path)?;
        self.read_conn(|conn| {
            let concrete_node = load_stored_node(conn, &path)?;
            if concrete_node
                .as_ref()
                .is_some_and(|stored| stored.node.kind != NodeKind::Folder)
            {
                return Err(format!("not a directory: {path}"));
            }
            let rows =
                load_child_rows(conn, &path, concrete_node.as_ref().map(|node| node.row_id))?;
            if rows.is_empty() && !allows_empty_directory_listing(&path) && concrete_node.is_none()
            {
                return Err(format!("path not found: {path}"));
            }
            build_child_nodes(&path, rows)
        })
    }
}

// Where: crates/vfs_runtime/src/publications.rs
// What: Owner-controlled publication records and anonymous single-node reads.
// Why: Publishing one page must not grant database-wide read access.
use super::*;
use crate::sqlite::{Result as SqliteResult, Row};

const PUBLIC_NODE_ID_HEX_CHARS: usize = 32;

#[cfg(any(test, debug_assertions))]
static TEST_PUBLICATION_DETACH_FAIL_ONCE: LazyLock<Mutex<BTreeSet<String>>> =
    LazyLock::new(|| Mutex::new(BTreeSet::new()));

#[cfg(any(test, debug_assertions))]
pub fn fail_next_publication_detach_for_test(database_id: &str) {
    TEST_PUBLICATION_DETACH_FAIL_ONCE
        .lock()
        .expect("test publication detach failure lock should not poison")
        .insert(database_id.to_string());
}

impl VfsService {
    pub(crate) fn member_visible_direct_node_publication_paths(
        &self,
        database_id: &str,
        caller: &str,
        parent_path: &str,
    ) -> Result<BTreeSet<String>, String> {
        self.read_index(|conn| {
            if caller == ANONYMOUS_PRINCIPAL
                || load_member_role(conn, database_id, caller)?.is_none()
            {
                return Ok(BTreeSet::new());
            }
            let child_prefix = if parent_path == "/" {
                "/".to_string()
            } else {
                format!("{parent_path}/")
            };
            let mut stmt = conn
                .prepare(
                    "SELECT path
                     FROM node_publications
                     WHERE database_id = ?1
                       AND instr(path, ?2) = 1
                       AND instr(substr(path, length(?2) + 1), '/') = 0",
                )
                .map_err(|error| error.to_string())?;
            crate::sqlite::query_map(&mut stmt, params![database_id, child_prefix], |row| {
                crate::sqlite::row_get(row, 0)
            })
            .map(|paths| paths.into_iter().collect())
            .map_err(|error| error.to_string())
        })
    }

    pub fn publish_node(
        &self,
        caller: &str,
        request: PublishNodeRequest,
        public_id: &str,
        now: i64,
    ) -> Result<NodePublication, String> {
        self.require_role(&request.database_id, caller, RequiredRole::Owner)?;
        validate_public_node_id(public_id)?;
        let meta = self.database_meta(&request.database_id)?;
        let node = self
            .database_store(&meta)?
            .read_node(&request.path)?
            .ok_or_else(|| format!("node not found: {}", request.path))?;
        if node.kind != NodeKind::File || !request.path.ends_with(".md") {
            return Err("only Markdown file nodes can be published".to_string());
        }

        self.write_index(|conn| {
            if let Some(publication) =
                load_node_publication(conn, &request.database_id, &request.path)?
            {
                return Ok(publication);
            }
            conn.execute(
                "INSERT INTO node_publications
                   (public_id, database_id, path, published_at_ms)
                 VALUES (?1, ?2, ?3, ?4)",
                params![public_id, request.database_id, request.path, now],
            )
            .map_err(|error| error.to_string())?;
            load_node_publication_by_id(conn, public_id)?
                .ok_or_else(|| "published node record was not persisted".to_string())
        })
    }

    pub fn unpublish_node(&self, caller: &str, request: PublishNodeRequest) -> Result<(), String> {
        self.require_role(&request.database_id, caller, RequiredRole::Owner)?;
        self.remove_node_publications_for_path(&request.database_id, &request.path)
    }

    pub fn get_node_publication(
        &self,
        caller: &str,
        request: PublishNodeRequest,
    ) -> Result<Option<NodePublication>, String> {
        self.require_role(&request.database_id, caller, RequiredRole::Reader)?;
        self.read_index(|conn| load_node_publication(conn, &request.database_id, &request.path))
    }

    pub fn read_public_node(&self, public_id: &str) -> Result<Option<PublicNode>, String> {
        validate_public_node_id(public_id)?;
        let publication =
            self.read_index(|conn| load_active_node_publication_by_id(conn, public_id))?;
        let Some(publication) = publication else {
            return Ok(None);
        };
        let meta = self.database_meta(&publication.database_id)?;
        let Some(node) = self.database_store(&meta)?.read_node(&publication.path)? else {
            return Ok(None);
        };
        if node.kind != NodeKind::File || !publication.path.ends_with(".md") {
            return Ok(None);
        }
        Ok(Some(PublicNode {
            content: node.content,
            updated_at: node.updated_at,
            published_at_ms: publication.published_at_ms,
        }))
    }

    pub(crate) fn remove_node_publications_for_path(
        &self,
        database_id: &str,
        path: &str,
    ) -> Result<(), String> {
        self.detach_node_publications_for_paths(database_id, &[path])
            .map(|_| ())
    }

    pub(crate) fn detach_node_publications_for_paths(
        &self,
        database_id: &str,
        paths: &[&str],
    ) -> Result<Vec<NodePublication>, String> {
        #[cfg(any(test, debug_assertions))]
        if TEST_PUBLICATION_DETACH_FAIL_ONCE
            .lock()
            .map_err(|_| "test publication detach failure lock poisoned".to_string())?
            .remove(database_id)
        {
            return Err(format!(
                "injected publication detach failure: {database_id}"
            ));
        }

        self.write_index(|conn| {
            let mut detached = BTreeMap::<String, NodePublication>::new();
            for path in paths {
                let descendant_prefix = format!("{path}/");
                let mut stmt = conn
                    .prepare(
                        "SELECT public_id, database_id, path, published_at_ms
                         FROM node_publications
                         WHERE database_id = ?1
                           AND (path = ?2 OR instr(path, ?3) = 1)",
                    )
                    .map_err(|error| error.to_string())?;
                for publication in crate::sqlite::query_map(
                    &mut stmt,
                    params![database_id, *path, descendant_prefix],
                    publication_from_row,
                )
                .map_err(|error| error.to_string())?
                {
                    detached.insert(publication.public_id.clone(), publication);
                }
            }
            for public_id in detached.keys() {
                conn.execute(
                    "DELETE FROM node_publications WHERE public_id = ?1",
                    params![public_id.as_str()],
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(detached.into_values().collect())
        })
    }

    pub(crate) fn restore_node_publications(
        &self,
        publications: &[NodePublication],
    ) -> Result<(), String> {
        if publications.is_empty() {
            return Ok(());
        }
        self.write_index(|conn| {
            for publication in publications {
                conn.execute(
                    "INSERT INTO node_publications
                       (public_id, database_id, path, published_at_ms)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        publication.public_id,
                        publication.database_id,
                        publication.path,
                        publication.published_at_ms
                    ],
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }
}

fn load_node_publication(
    conn: &Connection,
    database_id: &str,
    path: &str,
) -> Result<Option<NodePublication>, String> {
    conn.query_row(
        "SELECT public_id, database_id, path, published_at_ms
         FROM node_publications
         WHERE database_id = ?1 AND path = ?2",
        params![database_id, path],
        publication_from_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_node_publication_by_id(
    conn: &Connection,
    public_id: &str,
) -> Result<Option<NodePublication>, String> {
    conn.query_row(
        "SELECT public_id, database_id, path, published_at_ms
         FROM node_publications
         WHERE public_id = ?1",
        params![public_id],
        publication_from_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_active_node_publication_by_id(
    conn: &Connection,
    public_id: &str,
) -> Result<Option<NodePublication>, String> {
    conn.query_row(
        "SELECT p.public_id, p.database_id, p.path, p.published_at_ms
         FROM node_publications p
         JOIN databases d ON d.database_id = p.database_id
         WHERE p.public_id = ?1 AND d.status = 'active'",
        params![public_id],
        publication_from_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn publication_from_row(row: &Row<'_>) -> SqliteResult<NodePublication> {
    Ok(NodePublication {
        public_id: crate::sqlite::row_get(row, 0)?,
        database_id: crate::sqlite::row_get(row, 1)?,
        path: crate::sqlite::row_get(row, 2)?,
        published_at_ms: crate::sqlite::row_get(row, 3)?,
    })
}

fn validate_public_node_id(public_id: &str) -> Result<(), String> {
    if public_id.len() != PUBLIC_NODE_ID_HEX_CHARS
        || !public_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("invalid public node id".to_string());
    }
    Ok(())
}

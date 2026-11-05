//! Finite, restartable logical rebuild. No stable-memory image copying or VACUUM.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RebuildCursor {
    pub table: String,
    pub last_key: String,
    pub source_fingerprint: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RebuildBudget {
    pub max_rows: u32,
    pub max_bytes: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RebuildPage {
    pub cursor: RebuildCursor,
    pub done: bool,
    pub rows: u64,
    pub bytes: u64,
    pub digest: String,
}
// Only literal identifiers from this list enter generated SQL.
const TABLES: &[(&str, &str)] = &[
    (
        "fs_nodes",
        "id,path,kind,content,created_at,updated_at,etag,metadata_json,parent_id,name",
    ),
    ("fs_node_identities", "node_id,current_row_id"),
    (
        "fs_node_revisions",
        "revision,node_id,path,kind,content,created_at,updated_at,etag,metadata_json,deleted",
    ),
    (
        "fs_links",
        "source_path,target_path,raw_href,link_text,link_kind,updated_at",
    ),
    ("fs_change_log", "revision,path,change_kind"),
    ("fs_path_state", "path,last_change_revision"),
    ("publication_mutation_commits", "operation_id"),
    (
        "learning_publication_commits",
        "operation_id,request_json,result_json",
    ),
    ("schema_migrations", "version,applied_at"),
    ("sqlite_sequence", "name,seq"),
];
const MAX_BYTES: u32 = 2 * 1024 * 1024;
type PageRows = Vec<(i64, Vec<Value>)>;
fn descriptor(table: &str) -> Result<(usize, &'static str), String> {
    TABLES
        .iter()
        .enumerate()
        .find(|(_, t)| t.0 == table)
        .map(|(i, t)| (i, t.1))
        .ok_or_else(|| "unknown rebuild table".into())
}
fn guard(conn: &Connection) -> Result<String, String> {
    crate::schema::validate_rebuild_source(conn)?;
    let mut stmt = conn
        .prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
        .map_err(|e| e.to_string())?;
    let schema = crate::sqlite::query_map(&mut stmt, params![], |r| {
        Ok((
            crate::sqlite::row_get::<String>(r, 0)?,
            crate::sqlite::row_get::<Option<String>>(r, 1)?,
        ))
    })
    .map_err(|e| e.to_string())?;
    for (name, _) in &schema {
        if TABLES.iter().any(|t| t.0 == name)
            || [
                "fs_nodes_fts",
                "fs_nodes_fts_data",
                "fs_nodes_fts_idx",
                "fs_nodes_fts_content",
                "fs_nodes_fts_docsize",
                "fs_nodes_fts_config",
                "fs_evidence_settings",
                "fs_evidence_blobs",
                "fs_evidence_manifests",
                "fs_evidence_bindings",
                "fs_search_metadata",
                "fs_search_content",
                "fs_rebuild_state",
                "fs_rebuild_receipts",
                "sqlite_stat1",
            ]
            .contains(&name.as_str())
        {
            continue;
        }
        return Err(format!("unknown rebuild source schema: {name}"));
    }
    for (table, columns) in TABLES {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| e.to_string())?;
        let actual = crate::sqlite::query_map(&mut stmt, params![], |r| {
            crate::sqlite::row_get::<String>(r, 1)
        })
        .map_err(|e| e.to_string())?;
        if actual.join(",") != *columns {
            return Err(format!("unknown rebuild source columns: {table}"));
        }
    }
    let revisions:(i64,i64)=conn.query_row("SELECT COALESCE((SELECT MAX(revision) FROM fs_change_log),0),COALESCE((SELECT MAX(revision) FROM fs_node_revisions),0)",params![],|r|Ok((crate::sqlite::row_get(r,0)?,crate::sqlite::row_get(r,1)?))).map_err(|e|e.to_string())?;
    Ok(sha256_hex(
        &serde_json::to_string(&(schema, revisions)).map_err(|e| e.to_string())?,
    ))
}
fn assert_guard(conn: &Connection, expected: &str) -> Result<(), String> {
    if guard(conn)? != expected {
        Err("rebuild source changed".into())
    } else {
        Ok(())
    }
}
fn value_text(v: &[Value], i: usize) -> Result<String, String> {
    v.get(i)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "invalid rebuild text".into())
}
fn value_int(v: &[Value], i: usize) -> Result<i64, String> {
    v.get(i)
        .and_then(Value::as_i64)
        .ok_or_else(|| "invalid rebuild integer".into())
}
fn logical_row(conn: &Connection, table: &str, values: &mut [Value]) -> Result<(), String> {
    let (p, k, c, created, updated, e, m) = match table {
        "fs_nodes" => (1, 2, 3, 4, 5, 6, 7),
        "fs_node_revisions" => (2, 3, 4, 5, 6, 7, 8),
        _ => return Ok(()),
    };
    let mut node = Node {
        path: value_text(values, p)?,
        kind: node_kind_from_db(&value_text(values, k)?).map_err(|e| e.to_string())?,
        content: value_text(values, c)?,
        created_at: value_int(values, created)?,
        updated_at: value_int(values, updated)?,
        etag: value_text(values, e)?,
        metadata_json: value_text(values, m)?,
    };
    evidence::hydrate_node(conn, &mut node)?;
    values[c] = node.content.into();
    Ok(())
}
fn physical_row(conn: &Connection, table: &str, values: &mut [Value]) -> Result<(), String> {
    let (p, k, c, created, updated, e, m) = match table {
        "fs_nodes" => (1, 2, 3, 4, 5, 6, 7),
        "fs_node_revisions" => (2, 3, 4, 5, 6, 7, 8),
        _ => return Ok(()),
    };
    let node = Node {
        path: value_text(values, p)?,
        kind: node_kind_from_db(&value_text(values, k)?).map_err(|e| e.to_string())?,
        content: value_text(values, c)?,
        created_at: value_int(values, created)?,
        updated_at: value_int(values, updated)?,
        etag: value_text(values, e)?,
        metadata_json: value_text(values, m)?,
    };
    values[c] = evidence::store_evidence(conn, &node, None)?.into();
    Ok(())
}
fn sql_values(values: &[Value]) -> Result<Vec<crate::sqlite::types::Value>, String> {
    values
        .iter()
        .map(|v| {
            Ok(match v {
                Value::Null => crate::sqlite::nullable_text_value(None),
                Value::String(s) => crate::sqlite::text_value(s),
                Value::Number(n) => {
                    crate::sqlite::integer_value(n.as_i64().ok_or("invalid rebuild number")?)
                }
                _ => return Err("invalid rebuild SQL scalar".into()),
            })
        })
        .collect()
}
fn load_page(
    conn: &Connection,
    cursor: &RebuildCursor,
    budget: &RebuildBudget,
) -> Result<(PageRows, u64, bool), String> {
    let (_, columns) = descriptor(&cursor.table)?;
    let last = cursor
        .last_key
        .parse::<i64>()
        .map_err(|_| "invalid rebuild key")?;
    let sql = format!(
        "SELECT rowid,CASE WHEN length(CAST(json_array({columns}) AS BLOB))<=?3 THEN json_array({columns}) ELSE NULL END FROM {} WHERE rowid>?1 ORDER BY rowid LIMIT ?2",
        cursor.table
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    let mut bytes = 0u64;
    let mut error = None;
    let mut more = false;
    let scan = crate::sqlite::query_try_map_limit(
        &mut stmt,
        params![last, budget.max_rows as i64 + 1, budget.max_bytes as i64],
        budget.max_rows as usize + 1,
        |row| -> Result<(), crate::sqlite::QueryTryMapError<()>> {
            if rows.len() == budget.max_rows as usize {
                more = true;
                return Err(crate::sqlite::QueryTryMapError::Validation(()));
            }
            let raw: Option<String> = crate::sqlite::row_get(row, 1)?;
            let Some(raw) = raw else {
                if rows.is_empty() {
                    error=Some("rebuild_row_exceeds_budget: inspect size and explicitly increase step budget".to_string());
                }
                more = true;
                return Err(crate::sqlite::QueryTryMapError::Validation(()));
            };
            let mut values: Vec<Value> = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(e) => {
                    error = Some(e.to_string());
                    return Err(crate::sqlite::QueryTryMapError::Validation(()));
                }
            };
            if let Err(e) = logical_row(conn, &cursor.table, &mut values) {
                error = Some(e);
                return Err(crate::sqlite::QueryTryMapError::Validation(()));
            }
            let size = match serde_json::to_vec(&values) {
                Ok(b) => b.len() as u64,
                Err(e) => {
                    error = Some(e.to_string());
                    return Err(crate::sqlite::QueryTryMapError::Validation(()));
                }
            };
            if bytes + size > budget.max_bytes as u64 {
                if rows.is_empty() {
                    error = Some("rebuild_row_exceeds_budget".into());
                }
                more = true;
                return Err(crate::sqlite::QueryTryMapError::Validation(()));
            }
            bytes += size;
            rows.push((crate::sqlite::row_get(row, 0)?, values));
            Ok(())
        },
    );
    if let Err(crate::sqlite::QueryTryMapError::Sqlite(e)) = scan {
        return Err(e.to_string());
    }
    if let Some(e) = error {
        return Err(e);
    }
    Ok((rows, bytes, more))
}
fn check_budget(budget: &RebuildBudget) -> Result<(), String> {
    if budget.max_rows == 0
        || budget.max_rows > 32
        || budget.max_bytes == 0
        || budget.max_bytes > MAX_BYTES
    {
        Err("rebuild budget requires 1..32 rows and 1..2097152 bytes".into())
    } else {
        Ok(())
    }
}
fn next_page(
    cursor: &RebuildCursor,
    rows: &PageRows,
    bytes: u64,
    more: bool,
) -> Result<RebuildPage, String> {
    let (index, _) = descriptor(&cursor.table)?;
    let mut next = cursor.clone();
    if more {
        next.last_key = rows.last().ok_or("rebuild made no progress")?.0.to_string();
    } else {
        next.table = TABLES.get(index + 1).map_or("complete", |t| t.0).into();
        next.last_key = "0".into();
    }
    let digest = sha256_hex(&serde_json::to_string(&(cursor, rows)).map_err(|e| e.to_string())?);
    Ok(RebuildPage {
        done: next.table == "complete",
        cursor: next,
        rows: rows.len() as u64,
        bytes,
        digest,
    })
}
impl FsStore {
    pub fn rebuild_destination_prepared(&self) -> Result<bool, String> {
        self.read_conn(|c|{
            let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='fs_rebuild_state')",params![],|r|crate::sqlite::row_bool(r,0)).map_err(|e|e.to_string())?;
            if !exists {return Ok(false);}
            c.query_row("SELECT EXISTS(SELECT 1 FROM fs_rebuild_state WHERE id=1)",params![],|r|crate::sqlite::row_bool(r,0)).map_err(|e|e.to_string())
        })
    }
    pub fn rebuild_start_cursor(&self) -> Result<RebuildCursor, String> {
        self.read_conn(|conn| {
            Ok(RebuildCursor {
                table: TABLES[0].0.into(),
                last_key: "0".into(),
                source_fingerprint: guard(conn)?,
            })
        })
    }
    pub fn begin_rebuild_into(&self, target: &FsStore) -> Result<RebuildCursor, String> {
        #[cfg(not(target_arch = "wasm32"))]
        if std::fs::canonicalize(&self.database_path).map_err(|e| e.to_string())?
            == std::fs::canonicalize(&target.database_path).map_err(|e| e.to_string())?
        {
            return Err("rebuild source and destination must differ".into());
        }
        #[cfg(target_arch = "wasm32")]
        if self.handle == target.handle {
            return Err("rebuild source and destination must differ".into());
        }
        let cursor = self.rebuild_start_cursor()?;
        let existing = target.read_conn(|conn| {
            conn.query_row(
                "SELECT source_guard FROM fs_rebuild_state WHERE id=1",
                params![],
                |r| crate::sqlite::row_get::<String>(r, 0),
            )
            .optional()
            .map_err(|e| e.to_string())
        })?;
        if let Some(g) = existing {
            if g != cursor.source_fingerprint {
                return Err("rebuild destination belongs to another source".into());
            }
            return Ok(cursor);
        }
        target.enable_evidence_storage()?;
        target.write_conn(|conn|{
            conn.execute_batch("DROP TRIGGER fs_node_revision_insert; DROP TRIGGER fs_node_revision_update; DROP TRIGGER fs_node_revision_delete;").map_err(|e|e.to_string())?;
            for (table,_) in TABLES.iter().filter(|t|t.0!="schema_migrations") {conn.execute(&format!("DELETE FROM {table}"),params![]).map_err(|e|e.to_string())?;}
            conn.execute("DELETE FROM fs_search_metadata",params![]).map_err(|e|e.to_string())?;
            conn.execute("INSERT INTO fs_nodes_fts(fs_nodes_fts) VALUES('rebuild')",params![]).map_err(|e|e.to_string())?;
            conn.execute("INSERT INTO fs_rebuild_state(id,source_guard) VALUES(1,?1)",params![cursor.source_fingerprint]).map_err(|e|e.to_string())?;Ok(())
        })?;
        Ok(cursor)
    }
    pub fn copy_rebuild_step(
        &self,
        target: &FsStore,
        cursor: &RebuildCursor,
        budget: RebuildBudget,
    ) -> Result<RebuildPage, String> {
        check_budget(&budget)?;
        self.read_conn(|c| assert_guard(c, &cursor.source_fingerprint))?;
        let key = serde_json::to_string(cursor).map_err(|e| e.to_string())?;
        if let Some(json) = target.read_conn(|c| {
            c.query_row(
                "SELECT page_json FROM fs_rebuild_receipts WHERE phase='copy' AND cursor=?1",
                params![key],
                |r| crate::sqlite::row_get::<String>(r, 0),
            )
            .optional()
            .map_err(|e| e.to_string())
        })? {
            return serde_json::from_str(&json).map_err(|e| e.to_string());
        }
        let (rows, bytes, more) = self.read_conn(|c| load_page(c, cursor, &budget))?;
        let page = next_page(cursor, &rows, bytes, more)?;
        let (_, columns) = descriptor(&cursor.table)?;
        target.write_conn(|conn| {
            let g: String = conn
                .query_row(
                    "SELECT source_guard FROM fs_rebuild_state WHERE id=1",
                    params![],
                    |r| crate::sqlite::row_get(r, 0),
                )
                .map_err(|e| e.to_string())?;
            if g != cursor.source_fingerprint {
                return Err("rebuild destination guard mismatch".into());
            }
            if cursor.table == "sqlite_sequence" && cursor.last_key == "0" {
                conn.execute("DELETE FROM sqlite_sequence", params![])
                    .map_err(|e| e.to_string())?;
            }
            for (rowid, original) in &rows {
                let mut values = original.clone();
                physical_row(conn, &cursor.table, &mut values)?;
                if cursor.table == "schema_migrations" {
                    crate::sqlite::execute_values(
                        conn,
                        "UPDATE schema_migrations SET applied_at=?2 WHERE version=?1",
                        &sql_values(&values)?,
                    )
                    .map_err(|e| e.to_string())?;
                } else {
                    let mut params = vec![crate::sqlite::integer_value(*rowid)];
                    params.extend(sql_values(&values)?);
                    let placeholders = (1..=params.len())
                        .map(|n| format!("?{n}"))
                        .collect::<Vec<_>>()
                        .join(",");
                    crate::sqlite::execute_values(
                        conn,
                        &format!(
                            "INSERT INTO {}(rowid,{columns}) VALUES({placeholders})",
                            cursor.table
                        ),
                        &params,
                    )
                    .map_err(|e| e.to_string())?;
                }
                if cursor.table == "fs_nodes" {
                    let node = load_stored_node(conn, &value_text(original, 1)?)?
                        .ok_or("copied node missing")?;
                    sync_node_fts(conn, None, Some((node.row_id, &node.node)))?;
                }
            }
            if page.done {
                let sql = include_str!("../../migrations/004_node_revisions.sql");
                let start = sql
                    .find("CREATE TRIGGER fs_node_revision_insert")
                    .ok_or("revision trigger template missing")?;
                conn.execute_batch(&sql[start..])
                    .map_err(|e| e.to_string())?;
                conn.execute(
                    "UPDATE fs_rebuild_state SET copy_done=1 WHERE id=1",
                    params![],
                )
                .map_err(|e| e.to_string())?;
            }
            let json = serde_json::to_string(&page).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO fs_rebuild_receipts(phase,cursor,page_json) VALUES('copy',?1,?2)",
                params![key, json],
            )
            .map_err(|e| e.to_string())?;
            Ok(page)
        })
    }
    pub fn verify_rebuild_step(
        &self,
        target: &FsStore,
        cursor: &RebuildCursor,
        budget: RebuildBudget,
    ) -> Result<RebuildPage, String> {
        check_budget(&budget)?;
        self.read_conn(|c| assert_guard(c, &cursor.source_fingerprint))?;
        let ready = target.read_conn(|c| {
            c.query_row(
                "SELECT copy_done FROM fs_rebuild_state WHERE id=1 AND source_guard=?1",
                params![cursor.source_fingerprint],
                |r| crate::sqlite::row_bool(r, 0),
            )
            .map_err(|e| e.to_string())
        })?;
        if !ready {
            return Err("rebuild copy is incomplete".into());
        }
        let (rows, bytes, more) = self.read_conn(|c| load_page(c, cursor, &budget))?;
        let (_, columns) = descriptor(&cursor.table)?;
        target.read_conn(|conn| {
            for (rowid, expected) in &rows {
                let key = if cursor.table == "schema_migrations" {
                    "version=?1"
                } else {
                    "rowid=?1"
                };
                let bind = if cursor.table == "schema_migrations" {
                    crate::sqlite::text_value(value_text(expected, 0)?)
                } else {
                    crate::sqlite::integer_value(*rowid)
                };
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT json_array({columns}) FROM {} WHERE {key}",
                        cursor.table
                    ))
                    .map_err(|e| e.to_string())?;
                let raw = crate::sqlite::query_one(
                    &mut stmt,
                    crate::sqlite::params_from_values(&[bind]),
                    |r| crate::sqlite::row_get::<String>(r, 0),
                )
                .map_err(|e| e.to_string())?;
                let mut actual: Vec<Value> =
                    serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                logical_row(conn, &cursor.table, &mut actual)?;
                if &actual != expected {
                    return Err(format!("rebuild verification mismatch in {}", cursor.table));
                }
            }
            Ok(())
        })?;
        // At every table end compare row counts to detect extra target rows too.
        if !more {
            let sql = format!("SELECT COUNT(*) FROM {}", cursor.table);
            let count = |store: &FsStore| {
                store.read_conn(|c| {
                    c.query_row(&sql, params![], |r| crate::sqlite::row_get::<i64>(r, 0))
                        .map_err(|e| e.to_string())
                })
            };
            if count(self)? != count(target)? {
                return Err("rebuild row count mismatch".into());
            }
        }
        let page = next_page(cursor, &rows, bytes, more)?;
        if page.done {
            target.write_conn(|c| {
                c.execute(
                    "UPDATE fs_rebuild_state SET verify_done=1 WHERE id=1",
                    params![],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })?;
        }
        Ok(page)
    }
}

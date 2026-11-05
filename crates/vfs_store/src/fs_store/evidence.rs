//! Authenticated internal evidence references; arbitrary user text never grants blob access.
use super::*;
use crate::evidence_codec::{EncodedEvidence, EvidencePiece, decode_evidence, encode_evidence};

impl FsStore {
    /// Enable only a fresh destination; existing records require the bounded rebuild.
    pub fn enable_evidence_storage(&self) -> Result<(), String> {
        self.write_conn(|conn| {
            let used: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM fs_nodes WHERE kind<>'folder')",
                    params![],
                    |r| crate::sqlite::row_bool(r, 0),
                )
                .map_err(|e| e.to_string())?;
            if used {
                return Err("evidence storage requires an empty rebuild destination".into());
            }
            if enabled(conn)? { return Ok(()); }
            conn.execute_batch("DROP TABLE fs_nodes_fts; CREATE VIRTUAL TABLE fs_nodes_fts USING fts5(path,title,content,content='fs_search_content',content_rowid='id',tokenize='trigram case_sensitive 0'); INSERT INTO fs_nodes_fts(rowid,path,title,content) SELECT id,path,title,content FROM fs_search_content;").map_err(|e|e.to_string())?;
            conn.execute("UPDATE fs_evidence_settings SET enabled=1 WHERE id=1",params![]).map_err(|e|e.to_string())?;
            Ok(())
        })
    }
    pub fn evidence_storage_enabled(&self) -> Result<bool, String> {
        self.read_conn(enabled)
    }
}
fn enabled(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT enabled FROM fs_evidence_settings WHERE id=1",
        params![],
        |r| crate::sqlite::row_bool(r, 0),
    )
    .map_err(|e| e.to_string())
}
fn bind(conn: &Connection, node: &Node, reference: &str) -> Result<String, String> {
    conn.execute(
        "INSERT OR IGNORE INTO fs_evidence_bindings(path,etag,reference) VALUES(?1,?2,?3)",
        params![node.path, node.etag, reference],
    )
    .map_err(|e| e.to_string())?;
    Ok(reference.into())
}
pub(super) fn store_evidence(
    conn: &Connection,
    node: &Node,
    prior_row: Option<i64>,
) -> Result<String, String> {
    if !enabled(conn)? || node.kind != NodeKind::Source {
        return Ok(node.content.clone());
    }
    if let Some(row) = prior_row {
        let prior:Option<(String,String)> = conn.query_row("SELECT b.reference,m.manifest_json FROM fs_nodes n JOIN fs_evidence_bindings b ON b.path=n.path AND b.etag=n.etag AND b.reference=n.content JOIN fs_evidence_manifests m ON m.reference=b.reference WHERE n.id=?1",params![row],|r|Ok((crate::sqlite::row_get(r,0)?,crate::sqlite::row_get(r,1)?))).optional().map_err(|e|e.to_string())?;
        if let Some((reference, json)) = prior {
            let manifest: EncodedEvidence =
                serde_json::from_str(&json).map_err(|e| e.to_string())?;
            if manifest.original_sha256 == sha256_hex(&node.content) {
                return bind(conn, node, &reference);
            }
        }
    }
    let Some((manifest, blobs)) = encode_evidence(&node.path, &node.metadata_json, &node.content)?
    else {
        return Ok(node.content.clone());
    };
    let run = manifest.pieces.iter().find_map(|p| match p {
        EvidencePiece::Blob { run_id, .. } => Some(run_id.as_str()),
        _ => None,
    });
    if let Some(run) = run {
        for (sha, bytes) in blobs {
            let body = String::from_utf8(bytes).map_err(|_| "evidence blob must be UTF-8")?;
            conn.execute(
                "INSERT OR IGNORE INTO fs_evidence_blobs(run_id,sha256,body) VALUES(?1,?2,?3)",
                params![run, sha, body],
            )
            .map_err(|e| e.to_string())?;
            let saved: String = conn
                .query_row(
                    "SELECT body FROM fs_evidence_blobs WHERE run_id=?1 AND sha256=?2",
                    params![run, sha],
                    |r| crate::sqlite::row_get(r, 0),
                )
                .map_err(|e| e.to_string())?;
            if saved != body {
                return Err("evidence blob collision".into());
            }
        }
    }
    let reference = format!("kinic:evidence:v1:{}", manifest.original_sha256);
    let json = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO fs_evidence_manifests(reference,manifest_json) VALUES(?1,?2)",
        params![reference, json],
    )
    .map_err(|e| e.to_string())?;
    let saved: String = conn
        .query_row(
            "SELECT manifest_json FROM fs_evidence_manifests WHERE reference=?1",
            params![reference],
            |r| crate::sqlite::row_get(r, 0),
        )
        .map_err(|e| e.to_string())?;
    if saved != json {
        return Err("evidence manifest collision".into());
    }
    bind(conn, node, &reference)
}

pub(crate) fn hydrate_node(conn: &Connection, node: &mut Node) -> Result<(), String> {
    if !node.content.starts_with("kinic:evidence:v1:") {
        return Ok(());
    }
    let binding: Option<String> = conn
        .query_row(
            "SELECT reference FROM fs_evidence_bindings WHERE path=?1 AND etag=?2 AND reference=?3",
            params![node.path, node.etag, node.content],
            |r| crate::sqlite::row_get(r, 0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(reference) = binding else {
        return Ok(());
    };
    let json: String = conn
        .query_row(
            "SELECT manifest_json FROM fs_evidence_manifests WHERE reference=?1",
            params![reference],
            |r| crate::sqlite::row_get(r, 0),
        )
        .map_err(|e| e.to_string())?;
    let manifest: EncodedEvidence = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    node.content = decode_evidence(&manifest, |run, sha| {
        let body: String = conn
            .query_row(
                "SELECT body FROM fs_evidence_blobs WHERE run_id=?1 AND sha256=?2",
                params![run, sha],
                |r| crate::sqlite::row_get(r, 0),
            )
            .map_err(|e| e.to_string())?;
        Ok(body.into_bytes())
    })?;
    if compute_node_etag(node) != node.etag {
        return Err("evidence node etag mismatch after reconstruction".into());
    }
    Ok(())
}

pub(super) fn search_projection(conn: &Connection, node: &Node) -> Result<(bool, String), String> {
    let shared: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM fs_evidence_bindings WHERE path=?1 AND etag=?2)",
            params![node.path, node.etag],
            |r| crate::sqlite::row_bool(r, 0),
        )
        .map_err(|e| e.to_string())?;
    if !shared {
        return Ok((false, node.content.clone()));
    }
    let value: serde_json::Value =
        serde_json::from_str(&node.content).map_err(|e| e.to_string())?;
    let capture = value["payload"].get("capture").unwrap_or(&value["payload"]);
    let mut summary = serde_json::Map::new();
    for key in ["run_id", "id", "kind"] {
        if let Some(text) = value[key].as_str().filter(|s| s.len() <= 512) {
            summary.insert(key.into(), text.into());
        }
    }
    for key in [
        "event",
        "hook_event_name",
        "tool_name",
        "engine",
        "timestamp",
        "tool_use_id",
    ] {
        if let Some(text) = capture[key].as_str().filter(|s| s.len() <= 512) {
            summary.insert(key.into(), text.into());
        }
    }
    Ok((true, serde_json::Value::Object(summary).to_string()))
}
pub(crate) fn search_storage_enabled(conn: &Connection) -> Result<bool, String> {
    enabled(conn)
}

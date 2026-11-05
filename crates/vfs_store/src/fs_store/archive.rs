//! Same-image retention, deliberately limited to raw, single-revision hook events.
//! No VACUUM, mount allocation, schema rewrite, or unbounded history scan.
use super::*;
use serde_json::Value;
use vfs_types::{
    ArchiveIntermediateSourceRequest, ArchiveIntermediateSourceResult, StoragePageStats,
};

fn is_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn stats(conn: &Connection) -> Result<StoragePageStats, String> {
    fn pragma(conn: &Connection, sql: &str) -> Result<u64, String> {
        let n = conn
            .query_row(sql, params![], |r| crate::sqlite::row_get::<i64>(r, 0))
            .map_err(|e| e.to_string())?;
        u64::try_from(n).map_err(|e| e.to_string())
    }
    Ok(StoragePageStats {
        page_size: pragma(conn, "PRAGMA page_size")?,
        page_count: pragma(conn, "PRAGMA page_count")?,
        freelist_pages: pragma(conn, "PRAGMA freelist_count")?,
    })
}
fn snapshot(conn: &Connection) -> Result<String, String> {
    Ok(snapshot_revision_token(
        "/",
        sync::current_snapshot_revision_number(conn)?,
    ))
}
fn eligible(node: &Node) -> Result<(), String> {
    if node.kind != NodeKind::Source || node.content.len() + node.metadata_json.len() > 1_000_000 {
        return Err("archive requires a bounded raw source".into());
    }
    let m: Value = serde_json::from_str(&node.metadata_json).map_err(|e| e.to_string())?;
    let e: Value = serde_json::from_str(&node.content).map_err(|e| e.to_string())?;
    let id = e["id"].as_str().ok_or("missing event id")?;
    let run = e["run_id"].as_str().ok_or("missing event run")?;
    let expected = format!(
        "/Sources/learning-runs/{}/{}.json",
        sha256_hex(run),
        sha256_hex(id)
    );
    let capture = &e["payload"]["capture"];
    if id.is_empty()
        || run.is_empty()
        || node.path != expected
        || e["kind"] != "hook"
        || capture["terminal"] == true
        || (capture["event"] != "PostToolUse" && capture["hook_event_name"] != "PostToolUse")
        || m["approved"] == true
        || m["protected"] == true
        || m["authority"] == "human"
        || !m["kinic_superpowers"].is_null()
    {
        return Err("source is not an unprotected intermediate hook".into());
    }
    Ok(())
}
// Publication receipts can retain revision references after their current target
// has changed. Fail closed rather than silently invalidating such references.
fn check_publication_refs(conn: &Connection, node_id: &str) -> Result<(), String> {
    let (count,bytes):(i64,i64)=conn.query_row("SELECT COUNT(*),COALESCE(SUM(length(CAST(request_json AS BLOB))),0) FROM (SELECT request_json FROM learning_publication_commits LIMIT 257)",params![],|r|Ok((crate::sqlite::row_get(r,0)?,crate::sqlite::row_get(r,1)?))).map_err(|e|e.to_string())?;
    if count > 256 || bytes > 4_000_000 {
        return Err("publication reference inspection exceeds archive budget".into());
    }
    let mut stmt = conn
        .prepare("SELECT request_json FROM learning_publication_commits LIMIT 256")
        .map_err(|e| e.to_string())?;
    let rows = crate::sqlite::query_map(&mut stmt, params![], |r| {
        crate::sqlite::row_get::<String>(r, 0)
    })
    .map_err(|e| e.to_string())?;
    for row in rows {
        let json: Value = serde_json::from_str(&row).map_err(|e| e.to_string())?;
        let refs = json["evidence"]
            .as_array()
            .ok_or("invalid publication receipt")?;
        if refs.iter().any(|r| r["node_id"].as_str() == Some(node_id)) {
            return Err("source is retained by a publication receipt".into());
        }
    }
    Ok(())
}
impl FsStore {
    pub fn storage_page_stats(&self) -> Result<StoragePageStats, String> {
        self.read_conn(stats)
    }
    pub fn archive_intermediate_source(
        &self,
        r: ArchiveIntermediateSourceRequest,
    ) -> Result<ArchiveIntermediateSourceResult, String> {
        if !is_hash(&r.backup_manifest_sha256)
            || !is_hash(&r.expected_content_hash)
            || r.path.len() > 1024
            || r.expected_etag.len() > 128
            || r.expected_snapshot_revision.len() > 128
        {
            return Err("invalid archive guard".into());
        }
        let node_id = r
            .expected_node_id
            .parse::<i64>()
            .map_err(|_| "invalid archive node identity")?;
        let revision =
            i64::try_from(r.expected_revision).map_err(|_| "invalid archive revision")?;
        self.write_conn(|tx| {
            if snapshot(tx)?!=r.expected_snapshot_revision { return Err("archive reference snapshot changed".into()); }
            // Check physical sizes before loading/hydrating private content.
            let size:i64=tx.query_row("SELECT length(CAST(content AS BLOB))+length(CAST(metadata_json AS BLOB)) FROM fs_nodes WHERE path=?1",params![r.path],|row|crate::sqlite::row_get(row,0)).map_err(|e|e.to_string())?;
            if size>1_000_000 { return Err("source exceeds archive byte budget".into()); }
            let stored=load_stored_node(tx,&r.path)?.ok_or("archive source missing")?;
            if stored.node.etag!=r.expected_etag || sha256_hex(&stored.node.content)!=r.expected_content_hash { return Err("archive source changed".into()); }
            eligible(&stored.node)?;
            let owned:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM fs_node_identities WHERE node_id=?1 AND current_row_id=?2)",params![node_id,stored.row_id],|row|crate::sqlite::row_bool(row,0)).map_err(|e|e.to_string())?;
            let history:(i64,i64,i64)=tx.query_row("SELECT COUNT(*),COALESCE(MIN(revision),0),COALESCE(MAX(revision),0) FROM (SELECT revision FROM fs_node_revisions WHERE node_id=?1 LIMIT 2)",params![node_id],|row|Ok((crate::sqlite::row_get(row,0)?,crate::sqlite::row_get(row,1)?,crate::sqlite::row_get(row,2)?))).map_err(|e|e.to_string())?;
            let exact:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM fs_node_revisions WHERE node_id=?1 AND revision=?2 AND path=?3 AND etag=?4 AND content=?5 AND metadata_json=?6 AND kind='source' AND deleted=0 AND created_at=?7 AND updated_at=?8)",params![node_id,revision,r.path,r.expected_etag,stored.node.content,stored.node.metadata_json,stored.node.created_at,stored.node.updated_at],|row|crate::sqlite::row_bool(row,0)).map_err(|e|e.to_string())?;
            if !owned || history!=(1,revision,revision) || !exact { return Err("archive requires exactly the backed-up raw revision".into()); }
            let referenced:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM fs_links WHERE target_path=?1) OR EXISTS(SELECT 1 FROM fs_evidence_bindings WHERE path=?1)",params![r.path],|row|crate::sqlite::row_bool(row,0)).map_err(|e|e.to_string())?;
            if referenced { return Err("source has links or shared evidence bindings".into()); }
            check_publication_refs(tx,&r.expected_node_id)?;
            let before=stats(tx)?;
            // Normal delete preserves change log, tombstone identity, links and FTS.
            // Its transient delete snapshot is pruned in this same transaction.
            delete_node_with_history(tx,&stored)?;
            tx.execute("DELETE FROM fs_node_revisions WHERE node_id=?1",params![node_id]).map_err(|e|e.to_string())?;
            Ok(ArchiveIntermediateSourceResult{path:r.path,snapshot_revision:snapshot(tx)?,before,after:stats(tx)?})
        })
    }
}

//! Transactional, identity-partitioned outbox. Acknowledged IDs remain reserved.
use super::model::*;
use anyhow::{Result, bail};
use rusqlite::{Connection, params};
use std::path::Path;
use vfs_client::VfsApi;
use vfs_types::{MkdirNodeRequest, NodeKind, WriteNodeItem, WriteNodeRequest, WriteNodesRequest};

pub struct Outbox {
    conn: Connection,
    scope: String,
}
impl Outbox {
    pub fn open(root: &Path, canister: &str, database: &str, principal: &str) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
        }
        let path = root.join("learning-outbox.sqlite3");
        let conn = Connection::open(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS learning_outbox(scope TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,id)); CREATE TABLE IF NOT EXISTS learning_outbox_owner(scope TEXT PRIMARY KEY,pid INTEGER NOT NULL);")?;
        Ok(Self {
            conn,
            scope: hash(&serde_json::to_string(&(canister, database, principal))?),
        })
    }
    pub fn enqueue(&self, event: &Event) -> Result<()> {
        if event.id.is_empty() || event.run_id.is_empty() || event.kind.is_empty() {
            bail!("event requires id, run_id and kind");
        }
        let body = serde_json::to_string(event)?;
        self.conn.execute(
            "INSERT OR IGNORE INTO learning_outbox(scope,id,body) VALUES(?1,?2,?3)",
            params![self.scope, event.id, body],
        )?;
        let stored: String = self.conn.query_row(
            "SELECT body FROM learning_outbox WHERE scope=?1 AND id=?2",
            params![self.scope, event.id],
            |row| row.get(0),
        )?;
        if stored != body {
            bail!("event id reused with different content");
        }
        Ok(())
    }
    pub fn pending(&self) -> Result<Vec<Event>> {
        let mut stmt = self.conn.prepare(
            "SELECT body FROM learning_outbox WHERE scope=?1 AND acknowledged=0 ORDER BY rowid",
        )?;
        let rows = stmt.query_map([&self.scope], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn pending_count(&self) -> Result<usize> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM learning_outbox WHERE scope=?1 AND acknowledged=0",
            [&self.scope],
            |r| r.get::<_, i64>(0),
        )? as usize)
    }
    /// True while a live process holds this scope's flush lease.
    pub fn flush_owner_active(&self) -> Result<bool> {
        let owner = self
            .conn
            .query_row(
                "SELECT pid FROM learning_outbox_owner WHERE scope=?1",
                [&self.scope],
                |r| r.get::<_, u32>(0),
            )
            .ok();
        Ok(owner.is_some_and(super::jobs::process_alive))
    }
    fn acquire(&self) -> Result<Option<FlushLease<'_>>> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        if self.flush_owner_active()? {
            self.conn.execute_batch("ROLLBACK")?;
            return Ok(None);
        }
        let result = self.conn.execute(
            "INSERT OR REPLACE INTO learning_outbox_owner(scope,pid) VALUES(?1,?2)",
            params![self.scope, std::process::id()],
        );
        match result {
            Ok(_) => self.conn.execute_batch("COMMIT")?,
            Err(e) => {
                self.conn.execute_batch("ROLLBACK")?;
                return Err(e.into());
            }
        }
        Ok(Some(FlushLease { outbox: self }))
    }
    /// Single-owner flush. Returns None when another live process owns the lease.
    /// The lease is released before the final pending check: an enqueuer either
    /// sees a live owner that will recheck, or may start its own flusher.
    pub async fn flush_exclusive(&self, client: &impl VfsApi, db: &str) -> Result<Option<usize>> {
        let mut sent = 0;
        loop {
            let Some(lease) = self.acquire()? else {
                return Ok((sent > 0).then_some(sent));
            };
            sent += self.flush(client, db).await?;
            drop(lease);
            if self.pending_count()? == 0 {
                return Ok(Some(sent));
            }
        }
    }
    pub async fn flush(&self, client: &impl VfsApi, db: &str) -> Result<usize> {
        client.check_database_write_cycles(db).await?;
        let mut sent = 0;
        for batch in batches(self.pending()?)? {
            let items = batch_items(&batch);
            if client
                .write_nodes(WriteNodesRequest {
                    database_id: db.into(),
                    nodes: items,
                })
                .await
                .is_err()
            {
                // The batch is atomic and create-only. Any failure (an event that
                // already landed before a lost acknowledgement, a lost response,
                // or a client without batching) falls back to per-event immutable
                // verification, which still rejects conflicting content.
                for (event, path, body) in &batch {
                    write_immutable(client, db, path, body).await?;
                    self.acknowledge(std::slice::from_ref(event))?;
                    sent += 1;
                }
                continue;
            }
            let events: Vec<_> = batch.into_iter().map(|(event, _, _)| event).collect();
            self.acknowledge(&events)?;
            sent += events.len();
        }
        Ok(sent)
    }
    fn acknowledge(&self, events: &[Event]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for event in events {
            tx.execute(
                "UPDATE learning_outbox SET acknowledged=1 WHERE scope=?1 AND id=?2",
                params![self.scope, event.id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
struct FlushLease<'a> {
    outbox: &'a Outbox,
}
impl Drop for FlushLease<'_> {
    fn drop(&mut self) {
        let _ = self.outbox.conn.execute(
            "DELETE FROM learning_outbox_owner WHERE scope=?1 AND pid=?2",
            params![self.outbox.scope, std::process::id()],
        );
    }
}
pub fn evidence_path(event: &Event) -> String {
    format!(
        "/Sources/learning-runs/{}/{}.json",
        hash(&event.run_id),
        hash(&event.id)
    )
}
// Canister write_nodes accepts at most 100 items; folders count as items. The
// byte bound keeps one update well below the 2 MiB ingress message limit.
const BATCH_MAX_NODES: usize = 100;
const BATCH_MAX_BYTES: usize = 1_000_000;
type Pending = (Event, String, String);
fn ancestors(path: &str) -> Vec<String> {
    let segments: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
    (1..segments.len())
        .map(|n| format!("/{}", segments[..n].join("/")))
        .collect()
}
fn batches(events: Vec<Event>) -> Result<Vec<Vec<Pending>>> {
    let mut batches = vec![];
    let mut current: Vec<Pending> = vec![];
    let mut folders = std::collections::BTreeSet::new();
    let mut bytes = 0;
    for event in events {
        let path = evidence_path(&event);
        let body = serde_json::to_string(&event)?;
        let new_folders = ancestors(&path)
            .into_iter()
            .filter(|f| !folders.contains(f))
            .count();
        let nodes = folders.len() + current.len() + new_folders + 1;
        if !current.is_empty() && (nodes > BATCH_MAX_NODES || bytes + body.len() > BATCH_MAX_BYTES)
        {
            batches.push(std::mem::take(&mut current));
            folders.clear();
            bytes = 0;
        }
        folders.extend(ancestors(&path));
        bytes += body.len();
        current.push((event, path, body));
    }
    if !current.is_empty() {
        batches.push(current);
    }
    Ok(batches)
}
fn batch_items(batch: &[Pending]) -> Vec<WriteNodeItem> {
    // BTreeSet order places each parent before its children.
    let folders: std::collections::BTreeSet<_> = batch
        .iter()
        .flat_map(|(_, path, _)| ancestors(path))
        .collect();
    folders
        .into_iter()
        .map(|path| WriteNodeItem {
            path,
            kind: NodeKind::Folder,
            content: String::new(),
            metadata_json: "{}".into(),
            expected_etag: None,
        })
        .chain(batch.iter().map(|(_, path, body)| WriteNodeItem {
            path: path.clone(),
            kind: NodeKind::Source,
            content: body.clone(),
            metadata_json: EVIDENCE_METADATA.into(),
            expected_etag: None,
        }))
        .collect()
}
const EVIDENCE_METADATA: &str = "{\"kind\":\"kinic.learning.evidence\"}";
pub async fn ensure_parents(client: &impl VfsApi, db: &str, path: &str) -> Result<()> {
    let segments = path
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let mut folder = String::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        folder.push('/');
        folder.push_str(segment);
        client
            .mkdir_node(MkdirNodeRequest {
                database_id: db.into(),
                path: folder.clone(),
            })
            .await?;
    }
    Ok(())
}
pub async fn write_immutable(client: &impl VfsApi, db: &str, path: &str, body: &str) -> Result<()> {
    if let Some(current) = client.read_node(db, path).await? {
        if current.content != body {
            bail!("immutable learning evidence conflicts: {path}");
        }
        return Ok(());
    }
    ensure_parents(client, db, path).await?;
    let result = client
        .write_node(WriteNodeRequest {
            database_id: db.into(),
            path: path.into(),
            kind: NodeKind::Source,
            content: body.into(),
            metadata_json: EVIDENCE_METADATA.into(),
            expected_etag: None,
        })
        .await;
    if let Err(error) = result {
        match client.read_node(db, path).await? {
            Some(current) if current.content == body => {}
            _ => return Err(error),
        }
    }
    Ok(())
}
#[cfg(test)]
mod batch_tests {
    use super::*;

    fn event(i: usize, run: usize, bytes: usize) -> Event {
        Event {
            id: format!("e{i}"),
            run_id: format!("r{run}"),
            kind: "hook".into(),
            payload: serde_json::json!({"pad":"x".repeat(bytes)}),
        }
    }

    #[test]
    fn batches_respect_node_and_byte_limits_including_folders() {
        // One run per event: each event adds a run folder and a file.
        let split = batches((0..150).map(|i| event(i, i, 0)).collect()).unwrap();
        assert!(split.len() > 1);
        assert_eq!(split.iter().map(Vec::len).sum::<usize>(), 150);
        for batch in &split {
            assert!(batch_items(batch).len() <= BATCH_MAX_NODES);
        }
        let large = batches((0..5).map(|i| event(i, 0, 400_000)).collect()).unwrap();
        assert!(
            large
                .iter()
                .all(|b| b.iter().map(|(_, _, body)| body.len()).sum::<usize>() <= BATCH_MAX_BYTES)
        );
        // An oversized single event still forms its own batch rather than stalling.
        let single = batches(vec![event(0, 0, BATCH_MAX_BYTES)]).unwrap();
        assert_eq!(single.len(), 1);
    }

    #[test]
    fn batch_items_create_parents_before_children() {
        let items = batch_items(&batches(vec![event(0, 0, 0), event(1, 1, 0)]).unwrap()[0]);
        let paths: Vec<_> = items.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(paths[0], "/Sources");
        assert_eq!(paths[1], "/Sources/learning-runs");
        assert_eq!(
            items.iter().filter(|i| i.kind == NodeKind::Folder).count(),
            4
        );
        assert!(items[4..].iter().all(|i| i.kind == NodeKind::Source));
    }

    #[test]
    fn flush_lease_admits_one_live_owner() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = Outbox::open(dir.path(), "c", "db", "p").unwrap();
        let other = Outbox::open(dir.path(), "c", "db", "p").unwrap();
        assert!(!outbox.flush_owner_active().unwrap());
        let lease = outbox.acquire().unwrap().unwrap();
        assert!(other.flush_owner_active().unwrap());
        assert!(other.acquire().unwrap().is_none());
        drop(lease);
        assert!(!other.flush_owner_active().unwrap());
        // A crashed owner's stale row does not block a new flusher.
        other
            .conn
            .execute(
                "INSERT OR REPLACE INTO learning_outbox_owner(scope,pid) VALUES(?1,?2)",
                params![other.scope, u32::MAX - 1],
            )
            .unwrap();
        assert!(other.acquire().unwrap().is_some());
    }
}

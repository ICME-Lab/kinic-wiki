//! Transactional, identity-partitioned outbox. Acknowledged IDs remain reserved.
use super::model::*;
use crate::agent_status::delivery_snapshot;
use anyhow::{Result, bail};
use rusqlite::{Connection, params};
use std::{
    io::Write,
    path::{Path, PathBuf},
};
use vfs_client::VfsApi;
use vfs_types::{MkdirNodeRequest, NodeKind, WriteNodeItem, WriteNodeRequest, WriteNodesRequest};

pub struct Outbox {
    conn: Connection,
    scope: String,
    path: PathBuf,
    identity: (String, String, String),
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
        // Serialize additive migrations across concurrently starting CLI processes.
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let has_time = conn
            .prepare("PRAGMA table_info(learning_outbox)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|n| n == "enqueued_at");
        if !has_time {
            conn.execute_batch("ALTER TABLE learning_outbox ADD COLUMN enqueued_at TEXT")?;
        }
        conn.execute_batch("CREATE TABLE IF NOT EXISTS learning_exclusions(scope TEXT NOT NULL,id TEXT NOT NULL,body_hash TEXT NOT NULL,manifest_hash TEXT NOT NULL,PRIMARY KEY(scope,id)); CREATE TABLE IF NOT EXISTS learning_delivery(scope TEXT PRIMARY KEY, last_attempt_at TEXT, last_success_at TEXT, last_failure_at TEXT, last_error_code TEXT); COMMIT;")?;
        let outbox = Self {
            conn,
            scope: hash(&serde_json::to_string(&(canister, database, principal))?),
            path,
            identity: (canister.into(), database.into(), principal.into()),
        };
        outbox.refresh_snapshot();
        Ok(outbox)
    }
    pub fn enqueue(&self, event: &Event) -> Result<()> {
        if event.id.is_empty() || event.run_id.is_empty() || event.kind.is_empty() {
            bail!("event requires id, run_id and kind");
        }
        let body = serde_json::to_string(event)?;
        self.mutate(|conn| {
            conn.execute(
            "INSERT OR IGNORE INTO learning_outbox(scope,id,body,enqueued_at) VALUES(?1,?2,?3,?4)",
            params![self.scope, event.id, body, chrono::Utc::now().to_rfc3339()],
        )?;
            let stored: String = conn.query_row(
                "SELECT body FROM learning_outbox WHERE scope=?1 AND id=?2",
                params![self.scope, event.id],
                |row| row.get(0),
            )?;
            if stored != body {
                bail!("event id reused with different content");
            }
            Ok(())
        })
    }
    /// Requires the caller to hold this outbox's delivery lease and verify a backup.
    pub(super) fn exclude(&self, event: &Event, manifest: &str) -> Result<()> {
        let expected = serde_json::to_string(event)?;
        self.mutate(|conn| {
            let (body, ack): (String, bool) = conn.query_row("SELECT body,acknowledged FROM learning_outbox WHERE scope=?1 AND id=?2", params![self.scope,event.id], |r|Ok((r.get(0)?,r.get(1)?)))?;
            anyhow::ensure!(body == expected && !ack, "event changed or already delivered");
            conn.execute("INSERT OR IGNORE INTO learning_exclusions(scope,id,body_hash,manifest_hash) VALUES(?1,?2,?3,?4)", params![self.scope,event.id,hash(&body),manifest])?;
            Ok(())
        })
    }
    pub fn pending(&self) -> Result<Vec<Event>> {
        let mut stmt = self.conn.prepare(
            "SELECT body FROM learning_outbox WHERE scope=?1 AND acknowledged=0 AND NOT EXISTS (SELECT 1 FROM learning_exclusions e WHERE e.scope=learning_outbox.scope AND e.id=learning_outbox.id) ORDER BY rowid",
        )?;
        let rows = stmt.query_map([&self.scope], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn pending_count(&self) -> Result<usize> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM learning_outbox WHERE scope=?1 AND acknowledged=0 AND NOT EXISTS (SELECT 1 FROM learning_exclusions e WHERE e.scope=learning_outbox.scope AND e.id=learning_outbox.id)",
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
    pub(super) fn acquire(&self) -> Result<Option<FlushLease<'_>>> {
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
        self.refresh_snapshot();
        Ok(Some(FlushLease { outbox: self }))
    }
    /// Only detached hook delivery waits; foreground commands remain fail-fast.
    pub(super) async fn acquire_wait(
        &self,
        limit: std::time::Duration,
    ) -> Result<Option<FlushLease<'_>>> {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            if let Some(lease) = self.acquire()? {
                return Ok(Some(lease));
            }
            if tokio::time::Instant::now() >= deadline {
                self.failure("delivery_busy_timeout")?;
                return Ok(None);
            }
            tokio::time::sleep_until(
                (tokio::time::Instant::now() + std::time::Duration::from_millis(100)).min(deadline),
            )
            .await;
        }
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
            sent += self.flush_owned(client, db).await?;
            drop(lease);
            if self.pending_count()? == 0 {
                return Ok(Some(sent));
            }
        }
    }
    /// Flush only the selected runs while preserving the shared delivery lease.
    pub async fn flush_runs(
        &self,
        client: &impl VfsApi,
        db: &str,
        runs: &std::collections::BTreeSet<String>,
    ) -> Result<Option<usize>> {
        let mut sent = 0;
        loop {
            let Some(lease) = self.acquire()? else {
                return Ok((sent > 0).then_some(sent));
            };
            sent += self.flush_owned_selection(client, db, Some(runs)).await?;
            drop(lease);
            if !self
                .pending()?
                .iter()
                .any(|event| runs.contains(&event.run_id))
            {
                return Ok(Some(sent));
            }
        }
    }
    /// All callers, including synchronous record/run commands, use the same lease.
    pub async fn flush(&self, client: &impl VfsApi, db: &str) -> Result<usize> {
        self.flush_exclusive(client, db)
            .await?
            .ok_or_else(|| anyhow::anyhow!("delivery_pending: another process is sending evidence"))
    }
    pub fn pending_run(&self, run: &str) -> Result<bool> {
        Ok(self.pending()?.iter().any(|e| e.run_id == run))
    }
    pub async fn ensure_run_sent(&self, client: &impl VfsApi, db: &str, run: &str) -> Result<()> {
        if self.pending_run(run)? {
            self.flush_runs(
                client,
                db,
                &std::collections::BTreeSet::from([run.to_string()]),
            )
            .await?;
        }
        anyhow::ensure!(
            !self.pending_run(run)?,
            "delivery_pending: run evidence has not been sent; retry after agent flush"
        );
        Ok(())
    }
    pub(super) fn failure(&self, code: &str) -> Result<()> {
        self.mutate(|conn| {
            conn.execute("INSERT INTO learning_delivery(scope,last_failure_at,last_error_code) VALUES(?1,?2,?3) ON CONFLICT(scope) DO UPDATE SET last_failure_at=excluded.last_failure_at,last_error_code=excluded.last_error_code", params![self.scope,chrono::Utc::now().to_rfc3339(),code])?;
            Ok(())
        })
    }
    pub(super) async fn flush_owned(&self, client: &impl VfsApi, db: &str) -> Result<usize> {
        self.flush_owned_selection(client, db, None).await
    }
    async fn flush_owned_selection(
        &self,
        client: &impl VfsApi,
        db: &str,
        runs: Option<&std::collections::BTreeSet<String>>,
    ) -> Result<usize> {
        if !self
            .pending()?
            .iter()
            .any(|event| runs.is_none_or(|runs| runs.contains(&event.run_id)))
        {
            return Ok(0);
        }
        self.mutate(|conn| {
            conn.execute("INSERT INTO learning_delivery(scope,last_attempt_at) VALUES(?1,?2) ON CONFLICT(scope) DO UPDATE SET last_attempt_at=excluded.last_attempt_at", params![self.scope,chrono::Utc::now().to_rfc3339()])?;
            Ok(())
        })?;
        let result = self.send_pending(client, db, runs).await;
        match &result {
            Ok(_) => {
                self.mutate(|conn| {
                    conn.execute(
                        "UPDATE learning_delivery SET last_success_at=?2 WHERE scope=?1",
                        params![self.scope, chrono::Utc::now().to_rfc3339()],
                    )?;
                    Ok(())
                })?;
            }
            Err(error) => {
                self.failure(delivery_failure_code(error, db))?;
            }
        }
        result
    }
    async fn send_pending(
        &self,
        client: &impl VfsApi,
        db: &str,
        runs: Option<&std::collections::BTreeSet<String>>,
    ) -> Result<usize> {
        client.check_database_write_cycles(db).await?;
        let mut sent = 0;
        for batch in batches(
            self.pending()?
                .into_iter()
                .filter(|event| runs.is_none_or(|runs| runs.contains(&event.run_id)))
                .collect(),
        )? {
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
        self.mutate(|conn| {
            for event in events {
                conn.execute(
                    "UPDATE learning_outbox SET acknowledged=1 WHERE scope=?1 AND id=?2",
                    params![self.scope, event.id],
                )?;
            }
            Ok(())
        })
    }
    /// Invalidate before a committed change. Snapshot failures never change the
    /// result of a successful outbox operation.
    fn mutate<T>(&self, action: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let tx = self.conn.unchecked_transaction()?;
        // Upgrade to a writer before invalidating the shared summary.
        tx.execute(
            "UPDATE learning_outbox SET acknowledged=acknowledged WHERE 0",
            [],
        )?;
        let _ = std::fs::remove_file(delivery_snapshot::path(&self.path, &self.scope));
        let value = action(&tx)?;
        tx.commit()?;
        self.refresh_snapshot();
        Ok(value)
    }
    fn refresh_snapshot(&self) {
        // Re-read after acquiring the database's writer lock. A delayed writer
        // therefore publishes the newest committed state, never an older copy.
        let Ok(tx) = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        ) else {
            return;
        };
        if self.write_snapshot().is_err() {
            // Keep invalidation under the same lock, so an older failed writer
            // cannot remove a newer writer's successfully published summary.
            let _ = std::fs::remove_file(delivery_snapshot::path(&self.path, &self.scope));
        }
        drop(tx);
    }
    fn write_snapshot(&self) -> Result<()> {
        let path = delivery_snapshot::path(&self.path, &self.scope);
        let bytes = delivery_snapshot::build(&self.conn, &self.path, &self.scope, &self.identity)?;
        let temp = path.with_extension(format!(
            "{}.{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        let result = (|| -> Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&temp, &path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    }
}
fn delivery_failure_code(error: &anyhow::Error, db: &str) -> &'static str {
    if error.chain().any(|cause| {
        matches!(cause.downcast_ref::<ic_agent::AgentError>(),
            Some(ic_agent::AgentError::CertifiedReject { reject, .. }
                | ic_agent::AgentError::UncertifiedReject { reject, .. })
                if reject.error_code.as_deref() == Some("IC0207"))
    }) {
        return "canister_cycles_frozen";
    }
    let suspended = format!("database cycles are suspended: {db}");
    let sqlite_suspended = format!("sqlite error 1: {suspended}");
    if error.chain().any(|cause| {
        let message = cause.to_string();
        message == suspended || message == sqlite_suspended
    }) {
        "cycles_suspended"
    } else {
        "delivery_failed"
    }
}
pub(super) struct FlushLease<'a> {
    outbox: &'a Outbox,
}
impl Drop for FlushLease<'_> {
    fn drop(&mut self) {
        let _ = self.outbox.mutate(|conn| {
            conn.execute(
                "DELETE FROM learning_outbox_owner WHERE scope=?1 AND pid=?2",
                params![self.outbox.scope, std::process::id()],
            )?;
            Ok(())
        });
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

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    #[tokio::test]
    async fn busy_delivery_timeout_preserves_evidence_and_records_failure() {
        let root = tempfile::tempdir().unwrap();
        let owner = Outbox::open(root.path(), "c", "d", "p").unwrap();
        let waiter = Outbox::open(root.path(), "c", "d", "p").unwrap();
        let lease = owner.acquire().unwrap().unwrap();
        waiter
            .enqueue(&Event {
                id: "pending".into(),
                run_id: "run".into(),
                kind: "hook".into(),
                payload: serde_json::json!({}),
            })
            .unwrap();
        assert!(
            waiter
                .acquire_wait(std::time::Duration::ZERO)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(waiter.pending_count().unwrap(), 1);
        let code: String = waiter
            .conn
            .query_row(
                "SELECT last_error_code FROM learning_delivery WHERE scope=?1",
                [&waiter.scope],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(code, "delivery_busy_timeout");
        drop(lease);
        assert!(
            waiter
                .acquire_wait(std::time::Duration::ZERO)
                .await
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn migration_keeps_unknown_old_time_and_records_new_event_time() {
        let root = tempfile::tempdir().unwrap();
        let db = Connection::open(root.path().join("learning-outbox.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE learning_outbox(scope TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,id)); INSERT INTO learning_outbox VALUES('legacy','old','{}',0);").unwrap();
        drop(db);
        let outbox = Outbox::open(root.path(), "c", "d", "p").unwrap();
        let old: Option<String> = outbox
            .conn
            .query_row(
                "SELECT enqueued_at FROM learning_outbox WHERE id='old'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(old.is_none());
        let e = Event {
            id: "new".into(),
            run_id: "run".into(),
            kind: "hook".into(),
            payload: serde_json::json!({}),
        };
        outbox.enqueue(&e).unwrap();
        let time: String = outbox
            .conn
            .query_row(
                "SELECT enqueued_at FROM learning_outbox WHERE id='new'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(&time).is_ok());
    }
}

#[cfg(test)]
mod process_tests {
    use super::*;
    #[test]
    #[ignore = "child fixture used by cross_process_lease_recovers_after_owner_exit"]
    fn lease_child() {
        let root = std::env::var_os("KINIC_LEASE_TEST_ROOT").unwrap();
        let root = Path::new(&root);
        let outbox = Outbox::open(root, "c", "d", "p").unwrap();
        let _lease = outbox.acquire().unwrap().unwrap();
        std::fs::write(root.join("owned"), b"ready").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
    #[test]
    fn cross_process_lease_recovers_after_owner_exit() {
        let root = tempfile::tempdir().unwrap();
        let outbox = Outbox::open(root.path(), "c", "d", "p").unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "learning::outbox::process_tests::lease_child",
                "--ignored",
            ])
            .env("KINIC_LEASE_TEST_ROOT", root.path())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        while !root.path().join("owned").exists() && started.elapsed().as_secs() < 10 {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let ready = root.path().join("owned").exists();
        let busy = outbox.acquire().unwrap().is_none();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ready && busy);
        assert!(outbox.acquire().unwrap().is_some());
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    use serde_json::{Value, json};
    fn sample(id: &str) -> Event {
        Event {
            id: id.into(),
            run_id: id.into(),
            kind: "run".into(),
            payload: json!({"project_id":"project-a","private":"private event body"}),
        }
    }
    fn snapshot(outbox: &Outbox) -> Value {
        serde_json::from_slice(
            &std::fs::read(delivery_snapshot::path(&outbox.path, &outbox.scope)).unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn snapshot_concurrent_writers_and_delayed_refresh_keep_newest_counts() {
        let dir = tempfile::tempdir().unwrap();
        let first = Outbox::open(dir.path(), "endpoint:canister", "db", "principal").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let threads: Vec<_> = (0..4)
            .map(|i| {
                let barrier = barrier.clone();
                let root = dir.path().to_path_buf();
                std::thread::spawn(move || {
                    let outbox =
                        Outbox::open(&root, "endpoint:canister", "db", "principal").unwrap();
                    barrier.wait();
                    for j in 0..5 {
                        outbox.enqueue(&sample(&format!("event-{i}-{j}"))).unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        // The oldest open writer refreshes last; it must collect current state.
        first.refresh_snapshot();
        assert_eq!(first.pending_count().unwrap(), 20);
        let value = snapshot(&first);
        assert_eq!(
            value["partitions"]
                .as_object()
                .unwrap()
                .values()
                .next()
                .unwrap()["record"]["pending_records"],
            20
        );
        assert!(!value.to_string().contains("private event body"));
    }
    #[test]
    fn snapshot_failure_does_not_fail_enqueue_or_preserve_old_success() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = Outbox::open(dir.path(), "endpoint:canister", "db", "principal").unwrap();
        outbox.enqueue(&sample("one")).unwrap();
        let path = delivery_snapshot::path(&outbox.path, &outbox.scope);
        std::fs::remove_file(&path).unwrap();
        // An unusable destination forces atomic publication to fail.
        std::fs::create_dir(&path).unwrap();
        outbox.enqueue(&sample("two")).unwrap();
        assert_eq!(outbox.pending_count().unwrap(), 2);
        assert!(path.is_dir());
        assert!(
            !dir.path().read_dir().unwrap().any(|e| e
                .unwrap()
                .path()
                .extension()
                .is_some_and(|e| e == "tmp"))
        );
        std::fs::remove_dir(&path).unwrap();
        outbox.refresh_snapshot();
        assert_eq!(
            snapshot(&outbox)["partitions"]
                .as_object()
                .unwrap()
                .values()
                .next()
                .unwrap()["record"]["pending_records"],
            2
        );
    }
    #[test]
    fn delivery_failure_classifies_only_the_known_database_suspension() {
        for (message, expected) in [
            ("database cycles are suspended: db", "cycles_suspended"),
            (
                "sqlite error 1: database cycles are suspended: db",
                "cycles_suspended",
            ),
            (
                "sqlite error 1: database cycles are suspended: another-db",
                "delivery_failed",
            ),
            (
                "database cycles are suspended: another-db",
                "delivery_failed",
            ),
            (
                "network failed mentioning cycles or identity",
                "delivery_failed",
            ),
            ("identity not found", "delivery_failed"),
        ] {
            let error = anyhow::anyhow!(message).context("delivery request failed");
            assert_eq!(delivery_failure_code(&error, "db"), expected);
        }
    }
    #[test]
    fn delivery_failure_distinguishes_replica_frozen_code_from_database_suspension() {
        use ic_agent::{
            AgentError,
            agent::{RejectCode, RejectResponse},
        };
        for (code, expected) in [
            (Some("IC0207"), "canister_cycles_frozen"),
            (Some("IC0503"), "delivery_failed"),
            (None, "delivery_failed"),
        ] {
            for certified in [true, false] {
                let reject = RejectResponse {
                    reject_code: RejectCode::SysTransient,
                    reject_message: "Canister aaaaa-aa is unable to process query calls because it's frozen. private diagnostic details".into(),
                    error_code: code.map(str::to_owned),
                };
                let cause = if certified {
                    AgentError::CertifiedReject {
                        reject,
                        operation: None,
                    }
                } else {
                    AgentError::UncertifiedReject {
                        reject,
                        operation: None,
                    }
                };
                let error = anyhow::Error::new(cause)
                    .context("query failed for check_database_write_cycles");
                assert_eq!(delivery_failure_code(&error, "db"), expected);
            }
        }
        // A model/transport string mentioning the same code is not a typed replica rejection.
        assert_eq!(
            delivery_failure_code(&anyhow::anyhow!("IC0207 frozen"), "db"),
            "delivery_failed"
        );
    }
    #[test]
    fn snapshot_preserves_failure_type_without_serializing_raw_errors() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = Outbox::open(dir.path(), "endpoint:canister", "db", "principal").unwrap();
        outbox.failure("identity_unavailable").unwrap();
        assert_eq!(
            snapshot(&outbox)["delivery"]["last_send_failure"]["code"],
            "identity_unavailable"
        );
        outbox.failure("canister_cycles_frozen").unwrap();
        assert_eq!(
            snapshot(&outbox)["delivery"]["last_send_failure"]["code"],
            "canister_cycles_frozen"
        );
        outbox.failure("cycles_suspended").unwrap();
        assert_eq!(
            snapshot(&outbox)["delivery"]["last_send_failure"]["code"],
            "cycles_suspended"
        );
    }
}

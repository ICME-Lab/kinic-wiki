//! Transactional, identity-partitioned outbox. Acknowledged IDs remain reserved.
use super::model::*;
use anyhow::{Result, bail};
use rusqlite::{Connection, params};
use std::path::Path;
use vfs_client::VfsApi;
use vfs_types::{MkdirNodeRequest, NodeKind, WriteNodeRequest};

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
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS learning_outbox(scope TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,id));")?;
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
    pub async fn flush(&self, client: &impl VfsApi, db: &str) -> Result<usize> {
        client.check_database_write_cycles(db).await?;
        let mut sent = 0;
        for event in self.pending()? {
            let path = format!(
                "/Sources/learning-runs/{}/{}.json",
                hash(&event.run_id),
                hash(&event.id)
            );
            let body = serde_json::to_string(&event)?;
            write_immutable(client, db, &path, &body).await?;
            self.conn.execute(
                "UPDATE learning_outbox SET acknowledged=1 WHERE scope=?1 AND id=?2",
                params![self.scope, event.id],
            )?;
            sent += 1;
        }
        Ok(sent)
    }
}
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
            metadata_json: "{\"kind\":\"kinic.learning.evidence\"}".into(),
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

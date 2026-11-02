//! Durable project-scoped learning work and single-process ownership.
use super::hash;
use anyhow::{Result, ensure};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LearningJob {
    pub run_id: String,
    pub cwd: PathBuf,
    pub config_path: PathBuf,
    pub state: String,
    pub candidate_path: Option<String>,
    pub evaluation_path: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub config_hash: Option<String>,
}
#[cfg(test)]
thread_local! {
    pub(super) static TEST_AFTER_WAKE_SNAPSHOT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
pub struct JobQueue {
    conn: Connection,
}
impl JobQueue {
    pub fn open(root: &Path, binding: &str, project: &str) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
        }
        let path = root.join(format!(
            "jobs-{}.sqlite",
            hash(&serde_json::to_string(&(binding, project))?)
        ));
        let conn = Connection::open(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(run TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS wakeup(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);")?;
        Ok(Self { conn })
    }
    pub fn enqueue(&self, run: &str, cwd: &Path, config: &Path) -> Result<()> {
        ensure!(!run.is_empty(), "run id required");
        let job = LearningJob {
            run_id: run.into(),
            cwd: cwd.into(),
            config_path: config.into(),
            state: "pending".into(),
            candidate_path: None,
            evaluation_path: None,
            error: None,
            config_hash: None,
        };
        self.conn.execute(
            "INSERT OR IGNORE INTO jobs(run,body) VALUES(?1,?2)",
            params![run, serde_json::to_string(&job)?],
        )?;
        let existing = self.list()?.into_iter().find(|j| j.run_id == run).unwrap();
        ensure!(
            existing.cwd == cwd && existing.config_path == config,
            "run binding changed"
        );
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<LearningJob>> {
        let mut statement = self.conn.prepare("SELECT body FROM jobs ORDER BY rowid")?;
        statement
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    pub fn save(&self, job: &LearningJob) -> Result<()> {
        ensure!(
            self.conn.execute(
                "UPDATE jobs SET body=?1 WHERE run=?2",
                params![serde_json::to_string(job)?, job.run_id]
            )? == 1,
            "job missing"
        );
        Ok(())
    }
    pub fn enqueue_with_wakeup(&self, run: &str, cwd: &Path, config: &Path) -> Result<()> {
        let transaction = self.conn.unchecked_transaction()?;
        self.enqueue(run, cwd, config)?;
        self.request_wakeup()?;
        transaction.commit()?;
        Ok(())
    }
    pub fn wakeup_and_jobs(&self) -> Result<(Option<i64>, Vec<LearningJob>)> {
        let transaction = self.conn.unchecked_transaction()?;
        let generation = self.pending_wakeup()?;
        #[cfg(test)]
        if let Some(callback) = TEST_AFTER_WAKE_SNAPSHOT.with(|hook| hook.borrow_mut().take()) {
            callback();
        }
        let jobs = self.list()?;
        transaction.commit()?;
        Ok((generation, jobs))
    }
    pub fn request_wakeup(&self) -> Result<()> {
        self.conn.execute("INSERT INTO wakeup(singleton,generation,acknowledged) VALUES(1,1,0) ON CONFLICT(singleton) DO UPDATE SET generation=generation+1", [])?;
        Ok(())
    }
    pub fn pending_wakeup(&self) -> Result<Option<i64>> {
        use rusqlite::OptionalExtension;
        Ok(self
            .conn
            .query_row(
                "SELECT generation FROM wakeup WHERE singleton=1 AND generation > acknowledged",
                [],
                |row| row.get(0),
            )
            .optional()?)
    }
    pub fn acknowledge_wakeup(&self, generation: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE wakeup SET acknowledged=?1 WHERE singleton=1 AND generation=?1",
            [generation],
        )?;
        Ok(())
    }
    pub fn acquire(&self) -> Result<Option<JobLease<'_>>> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let owner = self
            .conn
            .query_row("SELECT pid FROM owner WHERE singleton=1", [], |r| {
                r.get::<_, u32>(0)
            })
            .ok();
        if owner.is_some_and(process_alive) {
            self.conn.execute_batch("ROLLBACK")?;
            return Ok(None);
        }
        let result = self.conn.execute(
            "INSERT OR REPLACE INTO owner(singleton,pid) VALUES(1,?1)",
            [std::process::id()],
        );
        match result {
            Ok(_) => self.conn.execute_batch("COMMIT")?,
            Err(e) => {
                self.conn.execute_batch("ROLLBACK")?;
                return Err(e.into());
            }
        }
        Ok(Some(JobLease { queue: self }))
    }
}
pub struct JobLease<'a> {
    queue: &'a JobQueue,
}
impl Drop for JobLease<'_> {
    fn drop(&mut self) {
        let _ = self.queue.conn.execute(
            "DELETE FROM owner WHERE singleton=1 AND pid=?1",
            [std::process::id()],
        );
    }
}
pub(super) fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(true)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn newer_wakeup_is_not_cleared_by_an_older_acknowledgement() {
        let temp = tempfile::tempdir().unwrap();
        let q = JobQueue::open(temp.path(), "identity-db", "project-a").unwrap();
        q.request_wakeup().unwrap();
        let first = q.pending_wakeup().unwrap().unwrap();
        q.request_wakeup().unwrap();
        q.acknowledge_wakeup(first).unwrap();
        let second = q.pending_wakeup().unwrap().unwrap();
        assert!(second > first);
        q.acknowledge_wakeup(second).unwrap();
        assert_eq!(q.pending_wakeup().unwrap(), None);
        q.request_wakeup().unwrap();
        q.acknowledge_wakeup(first).unwrap();
        assert!(q.pending_wakeup().unwrap().unwrap() > second);
    }
    #[test]
    fn jobs_survive_reopen_deduplicate_and_partition_projects() {
        let temp = tempfile::tempdir().unwrap();
        let q = JobQueue::open(temp.path(), "identity-db", "project-a").unwrap();
        q.enqueue("run", Path::new("/repo/a"), Path::new("/repo/a/config"))
            .unwrap();
        q.enqueue("run", Path::new("/repo/a"), Path::new("/repo/a/config"))
            .unwrap();
        assert!(
            q.enqueue("run", Path::new("/repo/b"), Path::new("/repo/a/config"))
                .is_err()
        );
        assert_eq!(q.list().unwrap().len(), 1);
        let mut job = q.list().unwrap().remove(0);
        job.state = "candidate".into();
        job.candidate_path = Some("/Sources/candidate".into());
        q.save(&job).unwrap();
        drop(q);
        let q = JobQueue::open(temp.path(), "identity-db", "project-a").unwrap();
        assert_eq!(q.list().unwrap()[0].state, "candidate");
        assert!(
            JobQueue::open(temp.path(), "identity-db", "project-b")
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        assert!(
            JobQueue::open(temp.path(), "other-identity-db", "project-a")
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
    }
}

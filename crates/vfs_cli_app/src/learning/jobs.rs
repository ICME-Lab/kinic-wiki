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
    #[serde(default)]
    pub retry_policy: Option<RetryPolicy>,
    #[serde(default)]
    pub pause: Option<JobPause>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RetryPolicy {
    pub attempts: u32,
    pub next_attempt_at_ms: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobPause {
    pub previous_state: String,
    pub reason: String,
}
impl LearningJob {
    pub fn pause(&mut self, reason: &str) {
        if self.state != "paused" {
            self.pause = Some(JobPause {
                previous_state: self.state.clone(),
                reason: reason.into(),
            });
            self.state = "paused".into();
        }
    }
    /// Reserve before execution so a crash cannot reset the automatic budget.
    pub fn begin_attempt(&mut self, now: i64) -> bool {
        if ["paused", "held", "published", "publishing"].contains(&self.state.as_str()) {
            return false;
        }
        if self.state == "retry" && self.retry_policy.is_none() {
            self.pause("legacy_attempt_count_unknown");
            return false;
        }
        let retry = self.retry_policy.get_or_insert_with(RetryPolicy::default);
        if retry.attempts >= 3 {
            self.pause("attempt_limit_reached");
            return false;
        }
        if retry.next_attempt_at_ms.is_some_and(|due| now < due) {
            return false;
        }
        retry.attempts += 1;
        // Also protect interrupted processes before an error can be saved.
        retry.next_attempt_at_ms = Some(now.saturating_add(if retry.attempts == 1 {
            300_000
        } else {
            1_800_000
        }));
        true
    }
    pub fn fail_error(&mut self, error: &anyhow::Error, now: i64) {
        let reason = error
            .chain()
            .find_map(|cause| permanent_failure_reason(&cause.to_string()));
        self.fail_attempt(&error.to_string(), now);
        if self.state == "retry"
            && let Some(reason) = reason
        {
            self.pause(reason);
        }
    }
    pub fn fail_attempt(&mut self, error: &str, now: i64) {
        self.error = Some(error.into());
        if self.state == "publishing" {
            return;
        }
        self.state = "retry".into();
        let reason = permanent_failure_reason(error).or_else(|| {
            self.retry_policy
                .as_ref()
                .filter(|r| r.attempts >= 3)
                .map(|_| "attempt_limit_reached")
        });
        if let Some(reason) = reason {
            self.pause(reason);
        } else if let Some(retry) = &mut self.retry_policy {
            retry.next_attempt_at_ms = Some(now.saturating_add(if retry.attempts == 1 {
                300_000
            } else {
                1_800_000
            }));
        }
    }
}
fn permanent_failure_reason(error: &str) -> Option<&'static str> {
    let message = error.to_lowercase();
    if [
        "no recorded context",
        "no context receipt",
        "no outcome evidence",
        "artifact missing",
        "source missing",
        "dependent node missing",
        "evidence revision missing",
    ]
    .iter()
    .any(|s| message.contains(s))
    {
        Some("evidence_missing")
    } else if [
        "identity",
        "principal",
        "another project",
        "mismatch",
        "configuration changed",
        "config changed",
        "conflict",
        "evidence changed",
        "target changed",
        "target missing",
        "retrieval scope changed",
        "anonymous caller not allowed",
        "unauthorized",
        "not authorized",
        "permission denied",
        "access denied",
    ]
    .iter()
    .any(|s| message.contains(s))
    {
        Some("binding_or_evidence_changed")
    } else {
        None
    }
}
#[cfg(test)]
thread_local! {
    pub(super) static TEST_AFTER_WAKE_SNAPSHOT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
pub struct JobQueue {
    conn: Connection,
}
impl JobQueue {
    fn path(root: &Path, binding: &str, project: &str) -> Result<PathBuf> {
        Ok(root.join(format!(
            "jobs-{}.sqlite",
            hash(&serde_json::to_string(&(binding, project))?)
        )))
    }
    pub fn open_existing(root: &Path, binding: &str, project: &str) -> Result<Self> {
        let conn = Connection::open_with_flags(
            Self::path(root, binding, project)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        Ok(Self { conn })
    }
    pub fn control(
        &self,
        run: &str,
        config: &Path,
        pause: bool,
        apply: bool,
        current_hash: &str,
    ) -> Result<LearningJob> {
        let _lease =
            if apply {
                Some(self.acquire()?.ok_or_else(|| {
                    anyhow::anyhow!("learning worker is busy; retry after it exits")
                })?)
            } else {
                None
            };
        let mut job = self
            .list()?
            .into_iter()
            .find(|j| j.run_id == run)
            .ok_or_else(|| anyhow::anyhow!("job not found in selected project"))?;
        ensure!(job.config_path == config, "job configuration mismatch");
        ensure!(
            job.state != "publishing",
            "ambiguous publication requires reconciliation"
        );
        if pause {
            ensure!(
                !["published", "held"].contains(&job.state.as_str()),
                "completed or held proposal cannot be paused"
            );
            job.pause("operator_paused");
        } else {
            ensure!(job.state == "paused", "only paused jobs can be resumed");
            ensure!(
                job.config_hash
                    .as_deref()
                    .is_none_or(|hash| hash == current_hash),
                "restore the original learning configuration and validation suite before resuming; retained evidence requires reconciliation"
            );
            let paused = job
                .pause
                .clone()
                .ok_or_else(|| anyhow::anyhow!("paused job has no prior state"))?;
            ensure!(
                !["publishing", "published", "held", "paused"]
                    .contains(&paused.previous_state.as_str()),
                "invalid prior job state"
            );
            job.state = if paused.previous_state == "retry" {
                "pending".into()
            } else {
                paused.previous_state
            };
            job.retry_policy = Some(RetryPolicy::default());
            job.error = None;
        }
        if apply {
            self.save(&job)?;
        }
        Ok(job)
    }
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
            retry_policy: Some(RetryPolicy::default()),
            pause: None,
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
    fn job() -> LearningJob {
        serde_json::from_value(serde_json::json!({"run_id":"r","cwd":"/repo","config_path":"/repo/config","state":"pending","candidate_path":null,"evaluation_path":null,"error":null})).unwrap()
    }
    #[test]
    fn retry_budget_is_persisted_and_due_only_after_minimum_delay() {
        let mut j = job();
        assert!(j.begin_attempt(1000));
        j.fail_attempt("temporary transport failure", 1000);
        assert!(!j.begin_attempt(1000 + 299999));
        let mut j: LearningJob = serde_json::from_str(&serde_json::to_string(&j).unwrap()).unwrap();
        assert!(j.begin_attempt(301000));
        j.fail_attempt("temporary transport failure", 301000);
        assert!(!j.begin_attempt(2100999));
        assert!(j.begin_attempt(2101000));
        j.fail_attempt("temporary transport failure", 2101000);
        assert_eq!(j.state, "paused");
        assert!(!j.begin_attempt(i64::MAX));
    }
    #[test]
    fn uncounted_retry_and_missing_evidence_are_paused_without_attempt() {
        let mut j = job();
        j.state = "retry".into();
        assert!(!j.begin_attempt(1000));
        assert_eq!(j.state, "paused");
        let mut j = job();
        assert!(j.begin_attempt(1000));
        j.fail_attempt("run has no context receipt", 1000);
        assert_eq!(j.state, "paused");
        for error in [
            "target missing before publication",
            "dependent node missing",
            "evidence revision missing",
        ] {
            let mut j = job();
            assert!(j.begin_attempt(1000));
            j.state = "evaluated".into();
            j.fail_attempt(error, 1000);
            assert_eq!(j.state, "paused", "{error}");
        }
    }
    #[test]
    fn job_control_preview_preserves_queue_and_apply_respects_owner_and_binding() {
        let t = tempfile::tempdir().unwrap();
        let q = JobQueue::open(t.path(), "b", "p").unwrap();
        q.enqueue("r", Path::new("/repo"), Path::new("/repo/config"))
            .unwrap();
        let preview = q
            .control("r", Path::new("/repo/config"), true, false, "hash")
            .unwrap();
        assert_eq!(preview.state, "paused");
        assert_eq!(q.list().unwrap()[0].state, "pending");
        assert!(
            q.control("r", Path::new("/other"), true, true, "hash")
                .is_err()
        );
        let lease = q.acquire().unwrap().unwrap();
        assert!(
            q.control("r", Path::new("/repo/config"), true, true, "hash")
                .is_err()
        );
        drop(lease);
        q.control("r", Path::new("/repo/config"), true, true, "hash")
            .unwrap();
        assert_eq!(q.list().unwrap()[0].state, "paused");
        q.control("r", Path::new("/repo/config"), false, true, "hash")
            .unwrap();
        assert_eq!(q.list().unwrap()[0].state, "pending");
        assert_eq!(q.pending_wakeup().unwrap(), None);
        let mut j = q.list().unwrap().remove(0);
        j.state = "publishing".into();
        q.save(&j).unwrap();
        assert!(
            q.control("r", Path::new("/repo/config"), true, true, "hash")
                .is_err()
        );
    }
    #[test]
    fn contextual_authorization_failure_requires_inspection() {
        let mut j = job();
        assert!(j.begin_attempt(1000));
        let error =
            anyhow::anyhow!("anonymous caller not allowed").context("query failed for read_node");
        j.fail_error(&error, 1000);
        assert_eq!(j.state, "paused");
        assert_eq!(j.pause.unwrap().reason, "binding_or_evidence_changed");
    }
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

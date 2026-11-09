//! Finite, restartable CLI learning orchestration. No hosted or resident worker.
use super::*;
use crate::learning::jobs::{JobQueue, LearningJob};

fn binding(client: &impl VfsApi, c: &ResolvedConnection) -> Result<String> {
    Ok(serde_json::to_string(&(
        endpoint(c),
        &c.database_id,
        client.caller_principal().context("identity unavailable")?,
    ))?)
}
pub fn queue(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    state: &StateArgs,
    project: &ProjectConfig,
) -> Result<JobQueue> {
    JobQueue::open(
        &state_root(state)?,
        &binding(client, c)?,
        &project.project_id,
    )
}
pub fn control_job(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    root: &Path,
    state: &StateArgs,
    command: &JobCommand,
) -> Result<Value> {
    let path = discover_config(root)?
        .context("project learning setup required")?
        .canonicalize()?;
    let project = load_project(&path)?;
    project.validate_connection(c)?;
    ensure!(
        project
            .principal
            .as_deref()
            .is_some_and(|p| Some(p.to_string()) == client.caller_principal()),
        "project identity changed or unconfigured"
    );
    let (pause, args) = match command {
        JobCommand::Pause(args) => (true, args),
        JobCommand::Resume(args) => (false, args),
    };
    let state = target_state(state, root)?;
    // Preview uses the existing queue without creating directories, schemas or jobs.
    let q = if args.apply {
        queue(client, c, &state, &project)?
    } else {
        JobQueue::open_existing(
            &state_root(&state)?,
            &binding(client, c)?,
            &project.project_id,
        )?
    };
    let current_hash = if pause {
        String::new()
    } else {
        config_fingerprint(&project).context(
            "restore the original learning configuration and validation suite before resuming",
        )?
    };
    let job = q.control(&args.run_id, &path, pause, args.apply, &current_hash)?;
    Ok(
        json!({"dry_run":!args.apply,"applied":args.apply,"run_id":job.run_id,"state":job.state,"pause":job.pause,"retry_policy":job.retry_policy,"model_started":false,"next_action":if pause {"Inspect evidence and binding before learn jobs resume --run-id <run-id> --apply"} else {"Run learn drain --run-id <run-id> when ready; resume alone starts no work"}}),
    )
}
pub fn enqueue(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    state: &StateArgs,
    project: &ProjectConfig,
    run: &str,
    cwd: &Path,
    path: &Path,
) -> Result<()> {
    if project.enabled {
        let queue = queue(client, c, state, project)?;
        queue.enqueue_with_wakeup(run, cwd, path)?;
    }
    Ok(())
}
#[cfg(test)]
thread_local! {
    pub(super) static TEST_DELIVERY_PENDING: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    pub(super) static TEST_AFTER_OUTBOX_CHECK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    pub(super) static TEST_LAUNCHES: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
}
#[cfg(test)]
pub fn launch(
    _c: &ResolvedConnection,
    _state: &StateArgs,
    cwd: &Path,
    _config: &Path,
) -> Result<()> {
    TEST_LAUNCHES.with(|calls| calls.borrow_mut().push(cwd.to_path_buf()));
    Ok(())
}
#[cfg(not(test))]
pub fn launch(c: &ResolvedConnection, state: &StateArgs, cwd: &Path, config: &Path) -> Result<()> {
    spawn_detached(drain_command(c, state, cwd, config)?)
}
pub fn launch_flush(
    c: &ResolvedConnection,
    state: &StateArgs,
    cwd: &Path,
    engine: &str,
    config: Option<&Path>,
) -> Result<()> {
    let mut cmd = cli_command(c, cwd)?;
    cmd.args(["agent", "flush", "--replay-inbox", "--engine", engine]);
    if let Some(config) = config {
        cmd.arg("--recall-config").arg(config);
    }
    if let Some(dir) = &state.state_dir {
        cmd.arg("--state-dir").arg(dir);
    }
    spawn_detached(cmd)
}
fn spawn_detached(mut cmd: std::process::Command) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
fn cli_command(c: &ResolvedConnection, cwd: &Path) -> Result<std::process::Command> {
    let mut cmd = std::process::Command::new(std::env::current_exe()?);
    cmd.args([
        "--replica-host",
        &c.replica_host,
        "--canister-id",
        &c.canister_id,
        "--database-id",
        c.database_id.as_deref().context("database required")?,
    ]);
    if std::env::args().any(|a| a == "--allow-non-ii-identity")
        || std::env::var("KINIC_VFS_CLI_ALLOW_NON_II").as_deref() == Ok("1")
    {
        cmd.arg("--allow-non-ii-identity");
    }
    cmd.current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    Ok(cmd)
}
fn drain_command(
    c: &ResolvedConnection,
    state: &StateArgs,
    cwd: &Path,
    config: &Path,
) -> Result<std::process::Command> {
    let mut cmd = cli_command(c, cwd)?;
    cmd.args(["learn", "drain", "--require-wakeup", "--project-root"])
        .arg(cwd)
        .arg("--recall-config")
        .arg(config);
    if let Some(dir) = &state.state_dir {
        cmd.arg("--state-dir").arg(dir);
    }
    Ok(cmd)
}
#[cfg(test)]
pub async fn drain(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    root: &Path,
    state: &StateArgs,
) -> Result<Value> {
    drain_with_config(client, c, root, state, None, false).await
}
#[derive(Default)]
pub struct DrainSelection {
    pub run_id: Option<String>,
    pub max_jobs: Option<u32>,
}
impl DrainSelection {
    fn includes(&self, job: &LearningJob) -> bool {
        self.run_id.as_ref().is_none_or(|run| run == &job.run_id)
            && !["paused", "held", "published", "publishing"].contains(&job.state.as_str())
    }
}
#[cfg(test)]
pub async fn drain_with_config(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    root: &Path,
    state: &StateArgs,
    config: Option<&Path>,
    require_wakeup: bool,
) -> Result<Value> {
    drain_selected(
        client,
        c,
        root,
        state,
        config,
        require_wakeup,
        &DrainSelection::default(),
    )
    .await
}
pub async fn drain_selected(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    root: &Path,
    state: &StateArgs,
    config: Option<&Path>,
    require_wakeup: bool,
    selection: &DrainSelection,
) -> Result<Value> {
    ensure!(
        selection.run_id.is_none() || selection.max_jobs.is_none(),
        "run-id and max-jobs are mutually exclusive"
    );
    ensure!(selection.max_jobs != Some(0), "max-jobs must be positive");
    let effective_state = target_state(state, root)?;
    let state = &effective_state;
    let path = config
        .map(PathBuf::from)
        .or(discover_config(root)?)
        .context("project learning setup required")?
        .canonicalize()?;
    let project = load_project(&path)?;
    project.validate_connection(c)?;
    ensure!(
        project
            .principal
            .as_deref()
            .is_none_or(|p| Some(p.to_string()) == client.caller_principal()),
        "project identity changed"
    );
    let q = queue(client, c, state, &project)?;
    if let Some(run) = &selection.run_id {
        ensure!(
            q.list()?.iter().any(|job| &job.run_id == run),
            "job not found in selected project"
        );
    }
    if !project.enabled {
        return Ok(json!({"disabled":true,"jobs":q.list()?}));
    }
    // Each job/evidence generation is attempted at most once by this finite process. Release the
    // lease before the final queue check: an enqueuer either sees an owner that
    // will recheck, or can start its own owner after release.
    let mut attempted = std::collections::BTreeSet::new();
    let mut started = 0u32;
    let mut first_pass = true;
    loop {
        let Some(lease) = q.acquire()? else {
            return Ok(json!({"busy":true,"jobs":q.list()?}));
        };
        if first_pass && require_wakeup && q.pending_wakeup()?.is_none() {
            return Ok(json!({"already_woken":true,"jobs":q.list()?}));
        }
        first_pass = false;
        let outbox = open_outbox(client, c, state)?;
        refresh_claude_evidence(&q, &outbox, selection.run_id.as_deref())?;
        let selected = if selection.run_id.is_some() || selection.max_jobs.is_some() {
            Some(
                q.list()?
                    .into_iter()
                    .filter(|job| selection.includes(job))
                    .filter(|job| {
                        selection.max_jobs.is_none()
                            || !(job.state == "candidate"
                                && job.candidate_path.is_some()
                                && project.validation_suite.is_none())
                    })
                    .take(selection.max_jobs.unwrap_or(u32::MAX) as usize)
                    .map(|job| job.run_id)
                    .collect::<std::collections::BTreeSet<_>>(),
            )
        } else {
            None
        };
        if let Some(runs) = &selected {
            outbox
                .flush_runs(client, c.database_id.as_deref().unwrap(), runs)
                .await?;
        } else {
            outbox
                .flush_exclusive(client, c.database_id.as_deref().unwrap())
                .await?;
        }
        let selected_job = |job: &LearningJob| {
            selection.includes(job)
                && selected
                    .as_ref()
                    .is_none_or(|runs| runs.contains(&job.run_id))
        };
        if q.list()?
            .iter()
            .any(|j| selected_job(j) && outbox.pending_run(&j.run_id).unwrap_or(true))
        {
            #[cfg(test)]
            if let Some(after_pending) = TEST_DELIVERY_PENDING.with(|hook| hook.borrow_mut().take())
            {
                after_pending();
            }
            // A sender may have finished and launched a replacement while we
            // held the job lease. Release before rechecking so either that
            // replacement can acquire it or this drain resumes the ready work.
            drop(lease);
            if q.list()?
                .iter()
                .any(|j| selected_job(j) && outbox.pending_run(&j.run_id).unwrap_or(true))
            {
                return Ok(json!({"busy":true,"reason":"delivery_pending","jobs":q.list()?}));
            }
            continue;
        }
        #[cfg(test)]
        if let Some(callback) = TEST_AFTER_OUTBOX_CHECK.with(|hook| hook.borrow_mut().take()) {
            callback();
        }
        let (wake_generation, jobs) = q.wakeup_and_jobs()?;
        let mut delivery_blocked = false;
        for mut job in jobs {
            if attempted.contains(&attempt_key(&job)) || !selected_job(&job) {
                continue;
            }
            if selection.max_jobs.is_some_and(|max| started >= max) {
                break;
            }
            if outbox.pending_run(&job.run_id)? {
                delivery_blocked = true;
                continue;
            }
            let current = load_project(&path)?;
            if current.validate_connection(c).is_err()
                || current.project_id != project.project_id
                || current.principal != project.principal
            {
                job.pause("binding_or_evidence_changed");
                q.save(&job)?;
                anyhow::bail!("project binding changed during drain; selected job paused");
            }
            if !current.enabled {
                break;
            }
            attempted.insert(attempt_key(&job));
            if job.state == "candidate"
                && job.candidate_path.is_some()
                && current.validation_suite.is_none()
            {
                continue;
            }
            let current_hash = config_fingerprint(&current)?;
            if job
                .config_hash
                .as_ref()
                .is_some_and(|old| old != &current_hash)
            {
                job.pause("configuration_changed");
                q.save(&job)?;
                continue;
            }
            if !job.begin_attempt(chrono::Utc::now().timestamp_millis()) {
                q.save(&job)?;
                if job.state == "paused"
                    && (selection.run_id.is_some() || selection.max_jobs.is_some())
                {
                    anyhow::bail!(
                        "learning job {} requires inspection before resuming",
                        job.run_id
                    );
                }
                continue;
            }
            started += 1;
            job.config_hash = Some(current_hash);
            q.save(&job)?;
            let outcome = process(client, c, &path, &current, state, &q, &mut job).await;
            if let Err(e) = outcome {
                job.fail_error(&e, chrono::Utc::now().timestamp_millis());
                q.save(&job)?;
                if selection.run_id.is_some() || selection.max_jobs.is_some() {
                    return Err(
                        e.context(format!("learning job {} failed and was paused", job.run_id))
                    );
                }
            }
        }
        if !delivery_blocked
            && selection.run_id.is_none()
            && selection.max_jobs.is_none()
            && let Some(generation) = wake_generation
        {
            q.acknowledge_wakeup(generation)?;
        }
        drop(lease);
        if delivery_blocked {
            if q.list()?
                .iter()
                .any(|job| selected_job(job) && outbox.pending_run(&job.run_id).unwrap_or(true))
            {
                return Ok(json!({"busy":true,"reason":"delivery_pending","jobs":q.list()?}));
            }
            continue;
        }
        if !load_project(&path)?.enabled {
            break;
        }
        if selection.run_id.is_some() || selection.max_jobs.is_some() {
            break;
        }
        if q.pending_wakeup()?.is_some() {
            continue;
        }
        if !unattempted(&q.list()?, &attempted) {
            break;
        }
    }

    Ok(json!({"jobs":q.list()?}))
}
async fn process(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    path: &Path,
    project: &ProjectConfig,
    state: &StateArgs,
    q: &JobQueue,
    job: &mut LearningJob,
) -> Result<()> {
    ensure_terminal_evidence(client, c, state, job)?;
    ensure!(job.config_path == path, "job configuration changed");
    ensure!(
        active_project_at(client, c, &job.cwd, Some(path))?
            .as_ref()
            .is_some_and(|p| p.project_id == project.project_id),
        "job belongs to another project"
    );
    let root = work_root(client, c, state, project)?;
    std::fs::create_dir_all(&root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    }
    // Full queue binding isolates identical project IDs across connections.
    // Immutable configuration names also prevent settings substitution between reads.
    let body = serde_json::to_vec(&project.runner)?;
    let runner_file = root.join(format!(
        "runner-{}.json",
        hash(&String::from_utf8_lossy(&body))
    ));
    if runner_file.exists() {
        ensure!(
            std::fs::read(&runner_file)? == body,
            "runner artifact differs from content address"
        );
    } else {
        use std::io::Write;
        let temporary = root.join(format!("runner-{}.tmp", now_id()));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&body)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &runner_file)?;
    }
    if job.candidate_path.is_none() {
        let value = Box::pin(learn_value_at(
            client,
            c,
            LearnCommand::Propose {
                run_id: job.run_id.clone(),
                runner_file: runner_file.clone(),
                state: state.clone(),
            },
            &job.cwd,
            Some(path),
        ))
        .await?;
        job.candidate_path = Some(
            value["candidate_path"]
                .as_str()
                .context("missing candidate path")?
                .into(),
        );
        job.state = if value["held"] == true {
            "held"
        } else {
            "candidate"
        }
        .into();
        job.error = value["reason"].as_str().map(str::to_owned);
        q.save(job)?;
        ensure_terminal_evidence(client, c, state, job)?;
        if job.state == "held" {
            return Ok(());
        }
    }
    let Some(suite) = &project.validation_suite else {
        job.state = "candidate".into();
        job.error = Some("validation suite not configured; candidate retained".into());
        q.save(job)?;
        return Ok(());
    };
    if job.evaluation_path.is_none() {
        let value = Box::pin(learn_value_at(
            client,
            c,
            LearnCommand::Evaluate {
                no_auto_promote: true,
                candidate_path: job.candidate_path.clone().unwrap(),
                suite: suite.clone(),
                runner_file,
                recall_config: path.into(),
                output: root.join(format!("evaluation-{}", now_id())),
                trials: 3,
                state: state.clone(),
            },
            &job.cwd,
            Some(path),
        ))
        .await?;
        job.evaluation_path = Some(
            value["evaluation_path"]
                .as_str()
                .context("missing evaluation path")?
                .into(),
        );
        job.state = if value["grounded"] == true && value["comparison"]["eligible"] == true {
            "evaluated"
        } else {
            "held"
        }
        .into();
        job.error = None;
        q.save(job)?;
    }
    ensure_terminal_evidence(client, c, state, job)?;
    if job.state == "held" {
        return Ok(());
    }
    let current = load_project(path)?;
    ensure!(current.enabled, "learning disabled before publication");
    ensure_current_config(&current, job)?;
    ensure_terminal_evidence(client, c, state, job)?;
    job.state = "publishing".into();
    q.save(job)?;
    let result = promote_candidate_at(
        client,
        c,
        job.candidate_path.clone().unwrap(),
        job.evaluation_path.clone().unwrap(),
        state,
        &job.cwd,
        Some(path),
    )
    .await;
    match result {
        Ok(_) => {
            job.state = "published".into();
            job.error = None;
            q.save(job)?;
        }
        Err(e) => {
            // Keep the previous immutable report, but let a later drain evaluate afresh.
            let message = e.to_string();
            if [
                "retrieval scope changed",
                "evidence changed",
                "target changed",
                "target missing",
            ]
            .iter()
            .any(|s| message.contains(s))
            {
                // This pre-publication validation failed with a known outcome.
                // Preserve its evidence and require inspection before another attempt.
                job.state = "evaluated".into();
                job.fail_attempt(&message, chrono::Utc::now().timestamp_millis());
            }
            job.error = Some(message);
            q.save(job)?;
        }
    }
    Ok(())
}

fn config_fingerprint(project: &ProjectConfig) -> Result<String> {
    let mut config = serde_json::to_value(project)?;
    config["enabled"] = json!(true);
    let suite = project
        .validation_suite
        .as_ref()
        .map(std::fs::read)
        .transpose()?;
    Ok(hash(&serde_json::to_string(&(config, suite))?))
}

fn attempt_key(job: &LearningJob) -> String {
    job.terminal_evidence
        .as_ref()
        .map(|generation| format!("{}:{generation}", job.run_id))
        .unwrap_or_else(|| job.run_id.clone())
}

/// Called under the existing project job lease. Hooks only append observations
/// and wake the queue; they never rewrite a running worker's job body.
fn refresh_claude_evidence(
    q: &JobQueue,
    outbox: &outbox::Outbox,
    selected_run: Option<&str>,
) -> Result<()> {
    for mut job in q.list()? {
        if selected_run.is_some_and(|run| run != job.run_id) {
            continue;
        }
        let signature = outbox.claude_terminal_signature(&job.run_id)?;
        if signature.is_none() || signature == job.terminal_evidence {
            continue;
        }
        if ["published", "publishing"].contains(&job.state.as_str()) {
            job.error = Some("New Claude terminal evidence retained; prior publication requires explicit reconciliation".into());
            q.save(&job)?;
            continue;
        }
        if job.state == "paused"
            && !job
                .error
                .as_deref()
                .is_some_and(|error| error.contains("Claude terminal evidence changed"))
        {
            // New evidence cannot resume an operator pause or a failed model.
            continue;
        }
        job.terminal_evidence = signature;
        job.candidate_path = None;
        job.evaluation_path = None;
        job.error = None;
        job.pause = None;
        job.retry_policy = Some(crate::learning::jobs::RetryPolicy::default());
        job.state = "pending".into();
        q.save(&job)?;
    }
    Ok(())
}

fn ensure_terminal_evidence(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    state: &StateArgs,
    job: &LearningJob,
) -> Result<()> {
    if job.terminal_evidence.is_some() {
        ensure!(
            open_outbox(client, c, state)?.claude_terminal_signature(&job.run_id)?
                == job.terminal_evidence,
            "Claude terminal evidence changed during learning; candidate must be refreshed"
        );
    }
    Ok(())
}

fn unattempted(jobs: &[LearningJob], attempted: &std::collections::BTreeSet<String>) -> bool {
    jobs.iter()
        .any(|j| DrainSelection::default().includes(j) && !attempted.contains(&attempt_key(j)))
}
#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn detached_delivery_uses_a_separate_process_group() {
        let root = tempfile::tempdir().unwrap();
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args([
            "-c",
            "ps -o pgid= -p $$ > group; sleep 0.1; printf done > done",
        ])
        .current_dir(root.path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
        spawn_detached(cmd).unwrap();
        let start = std::time::Instant::now();
        while !root.path().join("done").exists() && start.elapsed().as_secs() < 5 {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let group = std::fs::read_to_string(root.path().join("group")).unwrap();
        let parent = std::process::Command::new("ps")
            .args(["-o", "pgid=", "-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        assert_ne!(
            group.trim(),
            String::from_utf8(parent.stdout).unwrap().trim()
        );
    }
    #[test]
    fn release_then_recheck_observes_work_enqueued_while_owner_was_busy() {
        let root = tempfile::tempdir().unwrap();
        let q = JobQueue::open(root.path(), "binding", "project").unwrap();
        q.enqueue("a", Path::new("/a"), Path::new("/config"))
            .unwrap();
        let lease = q.acquire().unwrap().unwrap();
        let snapshot = q.list().unwrap();
        assert_eq!(snapshot.len(), 1);
        let other = JobQueue::open(root.path(), "binding", "project").unwrap();
        other
            .enqueue("b", Path::new("/a"), Path::new("/config"))
            .unwrap();
        assert!(other.acquire().unwrap().is_none());
        let attempted = std::collections::BTreeSet::from(["a".to_string()]);
        drop(lease);
        assert!(unattempted(&q.list().unwrap(), &attempted));
        assert!(q.acquire().unwrap().is_some());
        let attempted = std::collections::BTreeSet::from(["a".to_string(), "b".to_string()]);
        assert!(!unattempted(&q.list().unwrap(), &attempted));
    }
}

fn ensure_current_config(project: &ProjectConfig, job: &LearningJob) -> Result<()> {
    ensure!(
        job.config_hash.as_deref() == Some(config_fingerprint(project)?.as_str()),
        "project configuration or validation suite changed during evaluation"
    );
    Ok(())
}
#[cfg(test)]
mod fingerprint_tests {
    use super::*;
    #[test]
    fn claude_evidence_refresh_preserves_operator_pauses_and_publication_reconciliation() {
        let root = tempfile::tempdir().unwrap();
        let q = JobQueue::open(root.path(), "binding", "project").unwrap();
        let outbox = outbox::Outbox::open(root.path(), "canister", "db", "principal").unwrap();
        let _lease = q.acquire().unwrap().unwrap();
        for run in ["paused", "published", "publishing", "candidate"] {
            q.enqueue(run, root.path(), &root.path().join("config"))
                .unwrap();
            let mut job = q
                .list()
                .unwrap()
                .into_iter()
                .find(|j| j.run_id == run)
                .unwrap();
            job.state = run.into();
            job.candidate_path = Some("old-candidate".into());
            job.terminal_evidence = Some("old-generation".into());
            if run == "paused" {
                job.pause = Some(crate::learning::jobs::JobPause {
                    previous_state: "candidate".into(),
                    reason: "operator_paused".into(),
                });
            }
            q.save(&job).unwrap();
            outbox.enqueue(&event(run, "hook", json!({"engine":"claude","capture":{"event":"Stop","last_assistant_message":"new evidence"}}))).unwrap();
        }
        refresh_claude_evidence(&q, &outbox, Some("candidate")).unwrap();
        assert!(
            q.list()
                .unwrap()
                .into_iter()
                .filter(|job| job.run_id != "candidate")
                .all(|job| job.terminal_evidence.as_deref() == Some("old-generation"))
        );
        refresh_claude_evidence(&q, &outbox, None).unwrap();
        for job in q.list().unwrap() {
            match job.run_id.as_str() {
                "candidate" => {
                    assert_eq!(job.state, "pending");
                    assert!(job.candidate_path.is_none());
                    assert_ne!(job.terminal_evidence.as_deref(), Some("old-generation"));
                }
                "paused" => {
                    assert_eq!(job.state, "paused");
                    assert_eq!(job.pause.unwrap().reason, "operator_paused");
                    assert_eq!(job.candidate_path.as_deref(), Some("old-candidate"));
                }
                "published" | "publishing" => {
                    assert_eq!(job.state, job.run_id);
                    assert_eq!(job.candidate_path.as_deref(), Some("old-candidate"));
                    assert!(job.error.unwrap().contains("explicit reconciliation"));
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn publication_rechecks_validation_manifest_bytes() {
        let root = tempfile::tempdir().unwrap();
        let suite = root.path().join("suite.json");
        std::fs::write(&suite, "original validation").unwrap();
        let project:ProjectConfig=serde_json::from_value(json!({"version":2,"project_id":"00000000000000000000000000000000","enabled":true,"replica_host":"http://local","canister_id":"canister","database_id":"db","principal":"principal","recall":{"budget_tokens":100,"namespace":"/Knowledge/projects/00000000000000000000000000000000"},"runner":{"executable":"/bin/echo"},"validation_suite":suite,"shared_scopes":[]})).unwrap();
        let mut job = LearningJob {
            run_id: "run".into(),
            cwd: root.path().into(),
            config_path: root.path().join("config"),
            state: "evaluated".into(),
            candidate_path: None,
            evaluation_path: None,
            error: None,
            config_hash: Some(config_fingerprint(&project).unwrap()),
            terminal_evidence: None,
            retry_policy: None,
            pause: None,
        };
        ensure_current_config(&project, &job).unwrap();
        std::fs::write(&suite, "changed validation").unwrap();
        assert!(
            ensure_current_config(&project, &job)
                .unwrap_err()
                .to_string()
                .contains("validation suite changed")
        );
        job.config_hash = Some(config_fingerprint(&project).unwrap());
        ensure_current_config(&project, &job).unwrap();
    }
}

fn work_root(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    state: &StateArgs,
    project: &ProjectConfig,
) -> Result<PathBuf> {
    Ok(state_root(state)?.join(format!(
        "project-{}",
        hash(&serde_json::to_string(&(
            binding(client, c)?,
            &project.project_id
        ))?)
    )))
}

#[cfg(test)]
mod artifact_tests {
    use super::*;
    #[test]
    fn review_fix_runtime_artifacts_are_partitioned_by_connection() {
        let root = tempfile::tempdir().unwrap();
        let client = crate::learning::integration_tests::StoreClient::new(root.path());
        let c = ResolvedConnection {
            replica_host: "http://local".into(),
            canister_id: "canister".into(),
            database_id: Some("db".into()),
            replica_host_source: "test".into(),
            canister_id_source: "test".into(),
            database_id_source: None,
        };
        let project:ProjectConfig=serde_json::from_value(json!({"version":2,"project_id":"00000000000000000000000000000000","enabled":true,"replica_host":"http://local","canister_id":"canister","database_id":"db","principal":"principal","recall":{"budget_tokens":100,"namespace":"/Knowledge/projects/00000000000000000000000000000000"},"runner":{"executable":"/bin/echo"}})).unwrap();
        let state = StateArgs {
            state_dir: Some(root.path().join("state")),
            json: true,
        };
        let first = work_root(&client, &c, &state, &project).unwrap();
        let config = root.path().join("outside-project.json");
        let cmd = drain_command(&c, &state, root.path(), &config).unwrap();
        let args = cmd
            .get_args()
            .map(|v| v.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let flag = args.iter().position(|a| a == "--recall-config").unwrap();
        assert_eq!(args[flag + 1], config.display().to_string());
        let mut other = c.clone();
        other.database_id = Some("other-db".into());
        assert_ne!(first, work_root(&client, &other, &state, &project).unwrap());
        other = c.clone();
        other.replica_host = "https://other-host".into();
        assert_ne!(first, work_root(&client, &other, &state, &project).unwrap());
    }
}

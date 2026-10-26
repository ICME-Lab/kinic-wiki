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
        queue(client, c, state, project)?.enqueue(run, cwd, path)?;
    }
    Ok(())
}
#[cfg(test)]
thread_local! {
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
    cmd.args(["learn", "drain", "--project-root"])
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
    drain_with_config(client, c, root, state, None).await
}
pub async fn drain_with_config(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    root: &Path,
    state: &StateArgs,
    config: Option<&Path>,
) -> Result<Value> {
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
    if !project.enabled {
        return Ok(json!({"disabled":true,"jobs":q.list()?}));
    }
    // Each job is attempted at most once by this finite process. Release the
    // lease before the final queue check: an enqueuer either sees an owner that
    // will recheck, or can start its own owner after release.
    let mut attempted = std::collections::BTreeSet::new();
    loop {
        let Some(lease) = q.acquire()? else {
            return Ok(json!({"busy":true,"jobs":q.list()?}));
        };
        let outbox = open_outbox(client, c, state)?;
        outbox
            .flush_exclusive(client, c.database_id.as_deref().unwrap())
            .await?;
        if q.list()?
            .iter()
            .any(|j| outbox.pending_run(&j.run_id).unwrap_or(true))
        {
            return Ok(json!({"busy":true,"reason":"delivery_pending","jobs":q.list()?}));
        }
        for mut job in q.list()? {
            if attempted.contains(&job.run_id) {
                continue;
            }
            let current = load_project(&path)?;
            current.validate_connection(c)?;
            ensure!(
                current.project_id == project.project_id,
                "project identity changed during drain"
            );
            if !current.enabled {
                break;
            }
            let current_hash = config_fingerprint(&current)?;
            if job
                .config_hash
                .as_ref()
                .is_some_and(|old| old != &current_hash)
            {
                if job.state == "publishing" {
                    job.error=Some("configuration changed during an ambiguous publication; exact attempt preserved for manual reconciliation".into());
                    q.save(&job)?;
                    attempted.insert(job.run_id.clone());
                    continue;
                }
                if job.state != "published" {
                    job.candidate_path = None;
                    job.evaluation_path = None;
                    job.state = "pending".into();
                }
            }
            if ["published", "held"].contains(&job.state.as_str()) {
                continue;
            }
            attempted.insert(job.run_id.clone());
            job.config_hash = Some(current_hash);
            q.save(&job)?;
            let outcome = process(client, c, &path, &current, state, &q, &mut job).await;
            if let Err(e) = outcome {
                if job.state != "publishing" {
                    let message = e.to_string();
                    if ["changed", "mismatch", "conflict"]
                        .iter()
                        .any(|s| message.contains(s))
                    {
                        job.candidate_path = None;
                        job.evaluation_path = None;
                    }
                    job.state = "retry".into();
                }
                job.error = Some(e.to_string());
                q.save(&job)?;
            }
        }
        drop(lease);
        if !load_project(&path)?.enabled || !unattempted(&q.list()?, &attempted) {
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
    if job.state == "held" {
        return Ok(());
    }
    let current = load_project(path)?;
    ensure!(current.enabled, "learning disabled before publication");
    ensure_current_config(&current, job)?;
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
                job.candidate_path = None;
                job.evaluation_path = None;
                job.state = "retry".into();
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

fn unattempted(jobs: &[LearningJob], attempted: &std::collections::BTreeSet<String>) -> bool {
    jobs.iter().any(|j| {
        !attempted.contains(&j.run_id) && !["held", "published"].contains(&j.state.as_str())
    })
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

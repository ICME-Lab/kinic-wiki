//! CLI-owned hook routing, exact context and durable terminal work.
use super::*;
use crate::learning::redaction::redact;
use rusqlite::Connection;

fn route_run(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    state: &StateArgs,
    project: Option<&ProjectConfig>,
    request: &Value,
    kind: &str,
) -> Result<String> {
    if let Some(id) = request["__kinic_run_id"].as_str() {
        let prefix = project.map(|p| p.project_id.as_str()).unwrap_or("legacy");
        ensure!(
            id.starts_with(&format!("{prefix}:")),
            "reserved hook run belongs to another project"
        );
        return Ok(id.into());
    }
    reserve_run(c, state, project, client.caller_principal(), request, kind)
}
fn reserve_run(
    c: &ResolvedConnection,
    state: &StateArgs,
    project: Option<&ProjectConfig>,
    principal: Option<String>,
    request: &Value,
    kind: &str,
) -> Result<String> {
    let session = request["session_id"]
        .as_str()
        .context("hook session_id required")?;
    let project_prefix = project.map(|p| p.project_id.as_str()).unwrap_or("legacy");
    let prefix = format!(
        "{project_prefix}:{}",
        request["engine"].as_str().unwrap_or("unknown")
    );
    if let Some(turn) = request["turn_id"].as_str() {
        return Ok(format!("{prefix}:{session}:{turn}"));
    }
    if let Some(run) = request["run_id"].as_str() {
        return Ok(format!("{prefix}:{run}"));
    }
    let root = state_root(state)?;
    std::fs::create_dir_all(&root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = root.join("hook-sessions.sqlite");
    let conn = Connection::open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions(binding TEXT PRIMARY KEY, sequence INTEGER NOT NULL);",
    )?;
    let binding = hash(&serde_json::to_string(&(
        endpoint(c),
        &c.database_id,
        principal,
        &prefix,
        session,
    ))?);
    let seq = if ["recall", "UserPromptSubmit", "SessionStart"].contains(&kind) {
        conn.query_row("INSERT INTO sessions(binding,sequence) VALUES(?1,1) ON CONFLICT(binding) DO UPDATE SET sequence=sequence+1 RETURNING sequence",[&binding],|r|r.get::<_,u64>(0))?
    } else {
        conn.query_row(
            "SELECT sequence FROM sessions WHERE binding=?1",
            [&binding],
            |r| r.get::<_, u64>(0),
        )
        .unwrap_or(0)
    };
    Ok(format!("{prefix}:{session}:prompt-{seq}"))
}
fn evidence(request: &Value) -> Value {
    if let Some(snapshot) = request.get("__kinic_evidence") {
        return snapshot.clone();
    }
    let mut capture = request.clone();
    // Persisted session evidence is optional and explicitly bounded. Never turn a
    // completed hook into a verified outcome.
    let kind = request["event"]
        .as_str()
        .or(request["hook_event_name"].as_str())
        .unwrap_or("record");
    if let Some(path) = request["transcript_path"]
        .as_str()
        .filter(|_| !["recall", "UserPromptSubmit", "SessionStart"].contains(&kind))
    {
        let result = (|| -> Result<Value> {
            use std::io::{Seek, SeekFrom};
            let mut file = std::fs::File::open(path)?;
            let length = file.metadata()?.len();
            let truncated = length > 1024 * 1024;
            let start = length.saturating_sub(1024 * 1024);
            file.seek(SeekFrom::Start(start))?;
            let mut bytes = vec![];
            file.take(1024 * 1024).read_to_end(&mut bytes)?;
            let text = String::from_utf8_lossy(&bytes);
            let mut rows = text
                .lines()
                .skip(usize::from(start > 0))
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .collect::<Vec<_>>();
            let boundary = rows.iter().rposition(|row| {
                row["payload"]["type"] == "user_message"
                    || row["type"] == "user"
                    || row["payload"]["role"] == "user"
                    || row["message"]["role"] == "user"
            });
            let records = boundary
                .map(|index| rows.split_off(index))
                .unwrap_or_default();
            Ok(
                json!({"records":records,"complete":false,"truncated":truncated,"missing_turn_boundary":boundary.is_none(),"limitations":["current turn snapshot only; task success and adoption not inferred"]}),
            )
        })();
        capture["session_evidence"] = match result {
            Ok(v) => v,
            Err(_) => json!({"complete":false,"missing":true}),
        };
    }
    redact(&mut capture);
    json!({"capture":capture,"complete":false,"adoption":"unknown"})
}
pub async fn handle(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    engine: &str,
    config: Option<PathBuf>,
    state: &StateArgs,
    mut request: Value,
) -> Result<Value> {
    request["engine"] = json!(engine);
    ensure!(
        ["codex", "dsh"].contains(&engine),
        "unsupported hook engine"
    );
    let cwd =
        PathBuf::from(request["cwd"].as_str().context("hook cwd required")?).canonicalize()?;
    let settings = crate::agent_config::AgentConfig::at(&cwd)?;
    let explicit = if request["__kinic_explicit_config"] == false {
        None
    } else {
        config.as_deref()
    };
    let project = settings.portable_project(explicit)?;
    let Some(config) = config
        .clone()
        .or(settings.hook_path()?)
        .map(std::fs::canonicalize)
        .transpose()?
    else {
        return Ok(
            json!({"skipped":true,"reason":"project learning is not configured","additionalContext":""}),
        );
    };
    // Runtime overrides are useful for this invocation, but cannot become the
    // portable config path of a durable job. Stdin has the same transient rule.
    let job_project = project.as_ref().filter(|_| {
        explicit.is_none()
            || explicit.is_some_and(|path| {
                crate::agent_config::read_json_value(path).is_ok_and(|value| value["version"] == 2)
            })
    });
    let binding = routing_binding(
        c,
        &client
            .caller_principal()
            .context("authenticated identity required")?,
    );
    if let Some(expected) = request["expected_routing_binding"].as_str()
        && expected != binding
    {
        return Ok(
            json!({"routing_binding":binding,"recorded":false,"error_code":"routing_changed"}),
        );
    }
    if let Some(project) = &project {
        project.validate_connection(c)?;
        ensure!(
            project
                .principal
                .as_deref()
                .is_none_or(|p| Some(p.to_string()) == client.caller_principal()),
            "project identity changed"
        );
    }
    let kind = request["event"]
        .as_str()
        .or(request["hook_event_name"].as_str())
        .unwrap_or("record");
    let id = route_run(client, c, state, project.as_ref(), &request, kind)?;
    if ["recall", "UserPromptSubmit", "SessionStart"].contains(&kind) {
        let task = request["task"]
            .as_str()
            .or(request["prompt"].as_str())
            .unwrap_or("");
        if task.is_empty() {
            return Ok(json!({"additionalContext":"","reason":"no task supplied"}));
        }
        let opts = load_recall_optional(explicit, task, client, c, state, &cwd, None)?;
        let receipt = recall(client, c.database_id.as_deref().unwrap(), &id, &opts).await?;
        persist_receipt(client, c, state, &receipt, false).await?;
        let mut task_value = json!(task);
        redact(&mut task_value);
        let outbox = open_outbox(client, c, state)?;
        outbox.enqueue(&event(&id,"run",json!({"project_id":project.as_ref().map(|p|&p.project_id),"task":task_value,"engine":engine,"repository":cwd,"start_commit":git(&cwd,&["rev-parse","HEAD"]).await.ok(),"model":project.as_ref().and_then(|p|p.runner.model.clone()),"settings":project.as_ref().map(|p|safe_runner(&p.runner))})))?;
        return Ok(
            json!({"routing_binding":binding,"additionalContext":receipt.rendered,"receipt_id":receipt.id,"run_id":id,"hookSpecificOutput":{"hookEventName":kind,"additionalContext":receipt.rendered},"pending_sync":true}),
        );
    }
    let mut payload = evidence(&request);
    if request["missing_recall"] == true {
        payload["capture"]["missing_recall"] = json!(true);
    }
    payload["engine"] = json!(engine);
    payload["project_id"] = json!(project.as_ref().map(|p| &p.project_id));
    let outbox = open_outbox(client, c, state)?;
    outbox.enqueue(&event(&id, "hook", payload))?;
    let terminal = kind == "Stop" || request["terminal"] == true;
    if terminal && let Some(p) = job_project {
        job_driver::enqueue(client, c, state, p, &id, &cwd, &config)?;
    }
    Ok(
        json!({"routing_binding":binding,"recorded":true,"run_id":id,"pending_sync":true,"queued":terminal&&job_project.is_some_and(|p|p.enabled)}),
    )
}

/// Save redacted input before network or identity setup; acknowledged calls remove
/// their file. Failed recalls are never replayed as if context had been supplied.
pub fn spool(
    c: &ResolvedConnection,
    state: &StateArgs,
    engine: &str,
    config: Option<PathBuf>,
    request: &Value,
) -> Result<PathBuf> {
    let mut request = request.clone();
    request
        .as_object_mut()
        .context("hook object required")?
        .remove("__kinic_run_id");
    request.as_object_mut().unwrap().remove("__kinic_evidence");
    request["engine"] = json!(engine);
    let cwd = PathBuf::from(request["cwd"].as_str().context("hook cwd required")?);
    let settings = crate::agent_config::AgentConfig::at(&cwd)?;
    let explicit = config.clone();
    let path = config
        .or(settings.hook_path()?)
        .map(std::fs::canonicalize)
        .transpose()?;
    let project = settings.portable_project(explicit.as_deref())?;
    request["__kinic_explicit_config"] = json!(explicit.is_some());
    let kind = request["event"]
        .as_str()
        .or(request["hook_event_name"].as_str())
        .unwrap_or("record");
    let run = reserve_run(
        c,
        state,
        project.as_ref(),
        project.as_ref().and_then(|p| p.principal.clone()),
        &request,
        kind,
    )?;
    request["__kinic_run_id"] = json!(run);
    request["__kinic_config"] = json!(path);
    request["__kinic_principal"] = json!(project.as_ref().and_then(|p| p.principal.clone()));
    // Freeze evidence before remote identity/transport can fail and the log can grow.
    request["__kinic_evidence"] = evidence(&request);
    redact(&mut request);
    let root = inbox_root(c, state, engine, explicit.as_deref(), &cwd)?;
    request["__kinic_owner_pid"] = json!(std::process::id());
    std::fs::create_dir_all(&root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = root.join(format!(
        "{}-{}.json",
        chrono::Utc::now().timestamp_micros(),
        now_id()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(&path)?;
    file.write_all(&serde_json::to_vec(&request)?)?;
    file.sync_all()?;
    Ok(path)
}
pub(super) fn inbox_root(
    c: &ResolvedConnection,
    state: &StateArgs,
    engine: &str,
    explicit: Option<&Path>,
    cwd: &Path,
) -> Result<PathBuf> {
    let settings = crate::agent_config::AgentConfig::at(cwd)?;
    let path = explicit
        .map(Path::to_path_buf)
        .or(settings.hook_path()?)
        .map(std::fs::canonicalize)
        .transpose()?;
    let digest = Some(settings.binding_digest(explicit)?);
    Ok(state_root(state)?
        .join("hook-inbox")
        .join(hash(&serde_json::to_string(&(
            endpoint(c),
            &c.database_id,
            json!(cwd),
            digest,
            path,
            engine,
        ))?)))
}
fn quarantine(path: &Path, code: &str) -> Result<()> {
    let root = path
        .parent()
        .context("inbox parent required")?
        .join("quarantine");
    std::fs::create_dir_all(&root)?;
    let target = root.join(path.file_name().context("inbox name required")?);
    let reason = target.with_extension("reason");
    std::fs::write(
        &reason,
        serde_json::to_vec(&json!({"code":code,"at":chrono::Utc::now().to_rfc3339()}))?,
    )?;
    std::fs::rename(path, target)?;
    Ok(())
}
#[cfg(test)]
pub async fn replay(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    engine: &str,
    config: Option<PathBuf>,
    state: &StateArgs,
    current: &Path,
) -> Result<()> {
    for file in std::fs::read_dir(current.parent().unwrap())? {
        let path = file?.path();
        if let Ok(mut v) = read_json::<Value>(&path)
            && let Some(obj) = v.as_object_mut()
        {
            obj.remove("__kinic_owner_pid");
            std::fs::write(&path, serde_json::to_vec(&v)?)?;
        }
    }
    let current_request: Value = read_json(current)?;
    replay_after(client, c, engine, config, state, current, &current_request).await
}
/// Replay older spooled entries routed like `current_request`. The current entry
/// may already be removed; its path only identifies the inbox and is skipped.
pub async fn replay_after(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    engine: &str,
    config: Option<PathBuf>,
    state: &StateArgs,
    current: &Path,
    current_request: &Value,
) -> Result<()> {
    let effective_config = current_request["__kinic_config"]
        .as_str()
        .map(PathBuf::from);
    let _ = config;
    let mut pending = std::fs::read_dir(current.parent().context("inbox directory required")?)?
        .map(|e| e.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    pending.sort();
    let mut processed = 0;
    for path in pending
        .into_iter()
        .filter(|p| p != current && p.extension().is_some_and(|e| e == "json"))
    {
        let mut request: Value = match read_json(&path) {
            Ok(v) => v,
            Err(_) => {
                quarantine(&path, "invalid_json")?;
                continue;
            }
        };
        if !request.is_object()
            || request["engine"].as_str().is_none()
            || request["cwd"].as_str().is_none()
            || request["__kinic_principal"].as_str().is_none()
            || request["__kinic_config"].as_str().is_none()
        {
            quarantine(&path, "binding_unverifiable")?;
            continue;
        }
        if request["__kinic_owner_pid"]
            .as_u64()
            .and_then(|p| u32::try_from(p).ok())
            .is_some_and(crate::learning::jobs::process_alive)
        {
            continue;
        }
        let saved_engine = request["engine"]
            .as_str()
            .context("inbox engine missing")?
            .to_string();
        let saved_config = request["__kinic_config"].as_str().map(PathBuf::from);
        if saved_engine != engine
            || saved_config != effective_config
            || request["cwd"] != current_request["cwd"]
        {
            continue;
        }
        let Some(principal) = request["__kinic_principal"].as_str() else {
            continue;
        };
        if Some(principal.to_string()) != client.caller_principal() {
            continue;
        }
        if processed == 100 {
            break;
        }
        processed += 1;
        let kind = request["event"]
            .as_str()
            .or(request["hook_event_name"].as_str())
            .unwrap_or("record");
        if ["recall", "UserPromptSubmit", "SessionStart"].contains(&kind) {
            request["event"] = json!("record");
            request["missing_recall"] = json!(true);
        }
        if request.get("__kinic_evidence").is_none() {
            // Old inbox records have no immutable log boundary. Preserve the
            // observation, but never read today's log as yesterday's evidence.
            request
                .as_object_mut()
                .context("inbox object required")?
                .remove("transcript_path");
            request["session_evidence"] = json!({"complete":false,"missing":true,"reason":"legacy inbox has no captured transcript"});
        }
        handle(client, c, &saved_engine, saved_config, state, request).await?;
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub fn pending_count(state: &StateArgs, config: &Path) -> Result<usize> {
    let root = state_root(state)?.join("hook-inbox");
    if !root.exists() {
        return Ok(0);
    }
    let config = config.canonicalize()?;
    let mut count = 0;
    for dir in std::fs::read_dir(root)? {
        let dir = dir?;
        if !dir.file_type()?.is_dir() {
            continue;
        }
        for file in std::fs::read_dir(dir.path())? {
            let file = file?;
            if file.path().extension().is_none_or(|e| e != "json") {
                continue;
            }
            let value: Value = read_json(&file.path())?;
            if value["__kinic_config"]
                .as_str()
                .is_some_and(|p| Path::new(p) == config)
            {
                count += 1;
            }
        }
    }
    Ok(count)
}

#[cfg(test)]
mod capture_tests {
    use super::*;
    #[test]
    fn hook_inbox_and_transcript_use_common_cli_redaction() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("session.jsonl");
        std::fs::write(&log,format!("{}\n{}\n{}\n",json!({"payload":{"role":"user","content":"previous project private question"}}),json!({"payload":{"type":"user_message","message":"current task"}}),json!({"message":"Authorization: Bearer eyJabcdefghijk1234567890","tool":"api_key=not-in-process-env-secret"}))).unwrap();
        let request = json!({"event":"Stop","cwd":dir.path(),"session_id":"normal-session","transcript_path":log,"payload":{"cookie":"private-cookie-value","tool_response":"api_key=not-in-process-env-secret"}});
        let captured = evidence(&request);
        let text = captured.to_string();
        assert!(!text.contains("previous project private question"));
        assert!(!text.contains("not-in-process-env-secret"));
        assert!(!text.contains("private-cookie-value"));
        assert!(!text.contains("eyJabcdefghijk1234567890"));
        assert_eq!(captured["complete"], false);
        let c = ResolvedConnection {
            replica_host: "http://local".into(),
            canister_id: "canister".into(),
            database_id: Some("db".into()),
            replica_host_source: "test".into(),
            canister_id_source: "test".into(),
            database_id_source: None,
        };
        let state = StateArgs {
            state_dir: Some(dir.path().join("state")),
            json: true,
        };
        let saved = spool(&c, &state, "codex", None, &request).unwrap();
        let text = std::fs::read_to_string(saved).unwrap();
        assert!(!text.contains("not-in-process-env-secret"));
        assert!(!text.contains("private-cookie-value"));
    }
}

//! Local evidence reader. Never opens creation-capable learning stores or clients.
use crate::{
    agent_config::AgentConfig,
    learning::{Event, cli::StatusArgs, hash, jobs::LearningJob, project::ProjectConfig},
};
use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use vfs_cli::{
    cli::ConnectionArgs,
    connection::{ResolvedConnection, resolve_connection_optional_canister},
};

const MAX_ROWS: usize = 4096;
const MAX_BODY: usize = 1024 * 1024;
const MAX_BYTES: usize = 16 * MAX_BODY;
type ReadResult<T> = std::result::Result<T, &'static str>;
fn unknown(code: &str, path: Option<&Path>) -> Value {
    json!({"status":"unknown","code":code,"source":path,"observed_at":null})
}
fn modified(path: &Path) -> Option<String> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
}
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    name.into()
}
fn read_json(path: &Path) -> ReadResult<Value> {
    if !std::fs::metadata(path)
        .map_err(|_| "source_unreadable")?
        .is_file()
    {
        return Err("source_unreadable");
    }
    let file = std::fs::File::open(path).map_err(|_| "source_unreadable")?;
    let mut bytes = Vec::new();
    file.take((MAX_BODY + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "source_unreadable")?;
    if bytes.len() > MAX_BODY {
        return Err("evidence_truncated");
    }
    serde_json::from_slice(&bytes).map_err(|_| "source_unreadable")
}
/// WAL readers can mutate shared memory even with SQLITE_OPEN_READ_ONLY. Refuse
/// live WALs and use immutable mode only for a closed, checkpointed WAL database.
/// Rollback-journal databases use normal read-only locking and a short timeout.
fn open_readonly(path: &Path) -> ReadResult<Connection> {
    if !path.exists() {
        return Err("source_absent");
    }
    if !std::fs::metadata(path)
        .map_err(|_| "source_unreadable")?
        .is_file()
    {
        return Err("source_unreadable");
    }
    if sidecar(path, "-wal").exists() || sidecar(path, "-shm").exists() {
        return Err("active_wal_unverified");
    }
    if sidecar(path, "-journal").exists() {
        return Err("active_journal_unverified");
    }
    let mut header = [0u8; 20];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut header))
        .map_err(|_| "source_unreadable")?;
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = if header[18] == 2 || header[19] == 2 {
        let path = path.canonicalize().map_err(|_| "source_unreadable")?;
        let path = path.to_str().ok_or("source_unreadable")?;
        let encoded: String = path
            .as_bytes()
            .iter()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"/-._~".contains(b) {
                    (*b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        Connection::open_with_flags(
            format!("file:{encoded}?mode=ro&immutable=1"),
            flags | OpenFlags::SQLITE_OPEN_URI,
        )
    } else {
        Connection::open_with_flags(path, flags)
    }
    .map_err(|_| "source_unreadable")?;
    conn.busy_timeout(Duration::from_millis(100))
        .map_err(|_| "source_unreadable")?;
    // Read-only main databases can still spill query temporaries to disk.
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|_| "source_unreadable")?;
    Ok(conn)
}
fn safe_id(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value.len() <= 512
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:/".contains(&b)))
    .then_some(value)
}
struct Entry {
    event: Event,
    acknowledged: bool,
    sequence: i64,
}
fn events(path: &Path, scope: &str) -> ReadResult<(Vec<Entry>, bool)> {
    let conn = open_readonly(path)?;
    let mut stmt = conn.prepare("SELECT CASE WHEN length(body)<=1048576 THEN body ELSE NULL END,acknowledged,rowid FROM learning_outbox NOT INDEXED WHERE scope=?1 ORDER BY rowid DESC LIMIT 4097").map_err(|_|"source_unreadable")?;
    let rows = stmt
        .query_map([scope], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|_| "source_unreadable")?;
    let (mut out, mut incomplete, mut bytes) = (Vec::new(), false, 0);
    for (index, row) in rows.enumerate() {
        if index == MAX_ROWS {
            incomplete = true;
            break;
        }
        let (body, ack, sequence) = row.map_err(|_| "source_unreadable")?;
        let Some(body) = body else {
            incomplete = true;
            continue;
        };
        bytes += body.len();
        if bytes > MAX_BYTES {
            incomplete = true;
            break;
        }
        match serde_json::from_str::<Event>(&body) {
            Ok(event) if [0, 1].contains(&ack) => out.push(Entry {
                event,
                acknowledged: ack == 1,
                sequence,
            }),
            _ => incomplete = true,
        }
    }
    Ok((out, incomplete))
}
#[derive(Eq, PartialEq, Hash)]
enum RunOwner {
    Project(String),
    Workspace(PathBuf),
}
#[derive(Default)]
struct Ownership {
    owners: HashSet<RunOwner>,
    unresolved: bool,
}
// Evidence from all events must agree before a bare run ID can propagate ownership.
fn run_ownership(entries: &[Entry]) -> HashMap<&str, Ownership> {
    let mut runs = HashMap::<&str, Ownership>::new();
    for entry in entries {
        let ownership = runs.entry(&entry.event.run_id).or_default();
        let payload = &entry.event.payload;
        if !payload["project_id"].is_null() {
            if let Some(id) = payload["project_id"].as_str().filter(|s| !s.is_empty()) {
                ownership.owners.insert(RunOwner::Project(id.into()));
            } else {
                ownership.unresolved = true;
            }
        } else if entry.event.kind == "run" && !payload["repository"].is_null() {
            let workspace = payload["repository"].as_str().and_then(|repository| {
                let path = Path::new(repository);
                vfs_cli::connection::find_workspace_root_at(path)
                    .ok()
                    .flatten()
                    .or_else(|| path.canonicalize().ok())
            });
            if let Some(workspace) = workspace {
                ownership.owners.insert(RunOwner::Workspace(workspace));
            } else {
                ownership.unresolved = true;
            }
        }
    }
    runs
}
fn delivery(path: &Path, scope: &str, record: &mut Value) {
    // Keep status strictly read-only, including old schemas and active WALs.
    let Ok(conn) = open_readonly(path) else {
        return;
    };
    record["delivery_scope"] = json!("selected destination and principal; shared across projects");
    let age = conn.query_row("SELECT MIN(enqueued_at),COUNT(*)-COUNT(enqueued_at) FROM learning_outbox WHERE scope=?1 AND acknowledged=0", [scope], |r| Ok((r.get::<_,Option<String>>(0)?, r.get::<_,i64>(1)?)));
    if let Ok((oldest, unknown)) = age {
        record["pending_time_unknown"] = json!(unknown > 0);
        record["oldest_pending_at"] = if unknown > 0 {
            Value::Null
        } else {
            timestamp(oldest)
        };
    }
    let row = conn.query_row("SELECT last_attempt_at,last_success_at,last_failure_at,last_error_code FROM learning_delivery WHERE scope=?1",[scope],|r| Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?)));
    if let Ok((attempt, success, failure, code)) = row {
        record["last_send_attempt_at"] = timestamp(attempt);
        record["last_send_success_at"] = timestamp(success);
        record["last_send_failure"] = match code.as_deref() {
            Some(
                code @ ("delivery_failed"
                | "inbox_replay_failed"
                | "spawn_failed"
                | "drain_spawn_failed"
                | "identity_unavailable"
                | "delivery_busy_timeout"),
            ) => json!({"status":"observed","code":code,"at":timestamp(failure)}),
            Some(_) => unknown("unrecognized_failure_code", None),
            None => json!({"status":"not_observed","code":"no_failure_recorded","at":null}),
        };
    }
}
fn timestamp(value: Option<String>) -> Value {
    value
        .filter(|s| s.len() <= 64 && chrono::DateTime::parse_from_rfc3339(s).is_ok())
        .map_or(Value::Null, Value::String)
}
fn quarantine_status(path: &Path) -> Value {
    let root = path.join("quarantine");
    if !root.exists() {
        return json!({"count":0,"source":root,"reasons":[]});
    }
    let read = || -> ReadResult<Value> {
        let mut count = 0;
        let mut reasons = Vec::new();
        let mut scanned = 0;
        for item in std::fs::read_dir(&root).map_err(|_| "source_unreadable")? {
            scanned += 1;
            if scanned > MAX_ROWS {
                return Err("evidence_truncated");
            }
            let file = item.map_err(|_| "source_unreadable")?.path();
            if file.extension().is_some_and(|e| e == "json") {
                count += 1;
            }
            if file.extension().is_some_and(|e| e == "reason") {
                let v = read_json(&file)?;
                let code = match v["code"].as_str() {
                    Some("invalid_json") => "invalid_json",
                    Some("binding_unverifiable") => "binding_unverifiable",
                    _ => "unknown",
                };
                if !reasons.contains(&code) {
                    reasons.push(code);
                }
            }
        }
        Ok(json!({"count":count,"source":root,"reasons":reasons}))
    };
    read().unwrap_or_else(|code| json!({"count":null,"source":root,"code":code}))
}
fn records(
    path: &Path,
    scope: &str,
    project: Option<&ProjectConfig>,
    root: &Path,
) -> (Value, Value) {
    let (entries, incomplete) = match events(path, scope) {
        Ok(v) => v,
        Err(code) => return (unknown(code, Some(path)), unknown(code, Some(path))),
    };
    let ownership = run_ownership(&entries);
    let target = project
        .map(|p| RunOwner::Project(p.project_id.clone()))
        .unwrap_or_else(|| RunOwner::Workspace(root.into()));
    let unattributed = entries
        .iter()
        .filter(|entry| {
            let owner = &ownership[entry.event.run_id.as_str()];
            owner.unresolved || owner.owners.len() != 1
        })
        .count();
    let incomplete = incomplete || unattributed > 0;
    let entries: Vec<_> = entries
        .iter()
        .filter(|entry| {
            let owner = &ownership[entry.event.run_id.as_str()];
            !owner.unresolved && owner.owners.len() == 1 && owner.owners.contains(&target)
        })
        .collect();
    let pending = entries.iter().filter(|e| !e.acknowledged).count();
    let mut record = json!({"status":if incomplete {"partial"} else {"observed"},"code":if incomplete {"evidence_truncated_or_invalid"} else {"local_records_read"},"source":path,"storage_modified_at":modified(path),"scope":"selected destination, principal and identified project runs","pending_records":if incomplete {None} else {Some(pending)},"acknowledged_records":if incomplete {None} else {Some(entries.len()-pending)},"last_record":null,"last_send_failure":unknown("failure_not_persisted",None),"last_send_success_at":null});
    record["unattributed_records"] = json!(unattributed);
    delivery(path, scope, &mut record);
    if let Some(entry) = entries.first() {
        record["last_record"] = json!({"id":safe_id(&entry.event.id),"run_id":safe_id(&entry.event.run_id),"kind":safe_id(&entry.event.kind),"local_sequence":entry.sequence,"observed_at":null,"acknowledged":entry.acknowledged});
    }
    let mut context = unknown("receipt_not_observed", Some(path));
    if let Some(entry) = entries.iter().find(|e| e.event.kind == "context") {
        context = json!({"status":"observed","code":"receipt_assembled","source":path,"run_id":safe_id(&entry.event.run_id),"receipt_id":entry.event.payload["id"].as_str().and_then(safe_id),"event_id":safe_id(&entry.event.id),"observed_at":null,"delivery":"unverified","adoption":"unknown"});
    }
    (record, context)
}
fn jobs(path: &Path, config_path: Option<&Path>) -> Value {
    let read = || -> ReadResult<Value> {
        let conn = open_readonly(path)?;
        let mut stmt=conn.prepare("SELECT CASE WHEN length(body)<=1048576 THEN body ELSE NULL END FROM jobs ORDER BY rowid DESC LIMIT 4097").map_err(|_|"source_unreadable")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, Option<String>>(0))
            .map_err(|_| "source_unreadable")?;
        let (mut jobs, mut incomplete, mut bytes) = (Vec::new(), false, 0);
        for (index, row) in rows.enumerate() {
            if index == MAX_ROWS {
                incomplete = true;
                break;
            }
            let Some(body) = row.map_err(|_| "source_unreadable")? else {
                incomplete = true;
                continue;
            };
            bytes += body.len();
            if bytes > MAX_BYTES {
                incomplete = true;
                break;
            }
            let Ok(job) = serde_json::from_str::<LearningJob>(&body) else {
                incomplete = true;
                continue;
            };
            if config_path
                .is_none_or(|path| job.config_path.canonicalize().ok().as_deref() != Some(path))
            {
                incomplete = true;
                continue;
            }
            let state = match job.state.as_str() {
                "pending" | "candidate" | "evaluated" | "publishing" | "published" | "held"
                | "retry" => job.state.as_str(),
                _ => "unknown",
            };
            let reason = match state {
                "held" if job.evaluation_path.is_some() => "evaluation_not_eligible",
                "held" => "held_reason_unverified",
                "retry" => "retry_pending",
                "publishing" => "publication_outcome_unconfirmed",
                _ if job.error.is_some() => "job_error_recorded",
                _ => "state_recorded",
            };
            jobs.push(json!({"run_id":safe_id(&job.run_id),"state":state,"candidate_path":job.candidate_path.as_deref().and_then(safe_id),"evaluation_path":job.evaluation_path.as_deref().and_then(safe_id),"reason_code":reason,"observed_at":null}));
        }
        Ok(
            json!({"status":if incomplete {"partial"} else {"observed"},"code":if incomplete {"evidence_truncated_or_invalid"} else {"local_jobs_read"},"source":path,"storage_modified_at":modified(path),"jobs":jobs,"scope":"selected destination, configured principal, project and config file; recorded states, not live process health"}),
        )
    };
    read().unwrap_or_else(|code| unknown(code, Some(path)))
}
fn inbox(
    root: &Path,
    settings: &AgentConfig,
    c: &ResolvedConnection,
    explicit: Option<&Path>,
    config_path: Option<&Path>,
    engines: &[String],
) -> Value {
    let read = || -> ReadResult<Value> {
        let digest = Some(
            settings
                .binding_digest(explicit)
                .map_err(|_| "configuration_unavailable")?,
        );
        let mut counts = Vec::new();
        for engine in engines {
            let key = hash(
                &serde_json::to_string(&(
                    format!("{}:{}", c.replica_host, c.canister_id),
                    &c.database_id,
                    json!(settings.cwd),
                    &digest,
                    config_path,
                    engine,
                ))
                .map_err(|_| "configuration_unavailable")?,
            );
            let path = root.join("hook-inbox").join(key);
            if !path.exists() {
                counts.push(json!({"engine":engine,"status":"unknown","code":"source_absent","pending_inputs":null,"source":path}));
                continue;
            }
            let inspect = || -> ReadResult<Value> {
                let mut count = 0;
                let mut inspected = 0;
                let mut incomplete = false;
                let mut bytes = 0;
                for entry in std::fs::read_dir(&path).map_err(|_| "source_unreadable")? {
                    inspected += 1;
                    if inspected > MAX_ROWS {
                        incomplete = true;
                        break;
                    }
                    let file = entry.map_err(|_| "source_unreadable")?.path();
                    if file.extension().is_none_or(|e| e != "json") {
                        continue;
                    }
                    let size = std::fs::metadata(&file)
                        .map_err(|_| "source_unreadable")?
                        .len();
                    bytes += size.min((MAX_BYTES + 1) as u64);
                    if bytes > MAX_BYTES as u64 {
                        incomplete = true;
                        break;
                    }
                    match read_json(&file) {
                        Ok(value)
                            if value["engine"] == *engine
                                && value["cwd"] == json!(settings.cwd) =>
                        {
                            count += 1
                        }
                        _ => incomplete = true,
                    }
                }
                Ok(
                    json!({"engine":engine,"status":if incomplete {"partial"} else {"observed"},"code":if incomplete {"evidence_truncated_or_invalid"} else {"pending_intake_read"},"pending_inputs":if incomplete {None} else {Some(count)},"source":path}),
                )
            };
            let mut value = inspect().unwrap_or_else(|code|json!({"engine":engine,"status":"unknown","code":code,"pending_inputs":null,"source":path}));
            value["quarantine"] = quarantine_status(&path);
            counts.push(value);
        }
        Ok(
            json!({"status":if counts.iter().any(|c|c["status"]!="observed"){"partial"}else{"observed"},"code":"current_partitions_only","per_engine":counts,"scope":"current cwd, destination and configuration fingerprint only; older partitions and legacy adapter queues are not counted","combined_total":null}),
        )
    };
    read().unwrap_or_else(|code| unknown(code, None))
}

pub fn run(args: &StatusArgs, connection: &ConnectionArgs) -> Result<()> {
    let cwd = std::env::current_dir()?;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let settings = home
        .as_ref()
        .and_then(|home| AgentConfig::load(&cwd, home).ok());
    let explicit = args.recall_config.as_deref();
    let portable = if explicit == Some(Path::new("-")) {
        Err(anyhow::anyhow!(
            "status requires a local configuration file"
        ))
    } else {
        settings
            .as_ref()
            .map(|c| c.portable_project(explicit))
            .transpose()
    };
    let config_valid =
        portable.is_ok() && settings.is_some() && explicit.is_none_or(|p| p != Path::new("-"));
    let project = portable.ok().flatten().flatten();
    let config_path = explicit
        .map(PathBuf::from)
        .or_else(|| settings.as_ref().and_then(|s| s.hook_path().ok().flatten()))
        .and_then(|p| p.canonicalize().ok());
    let mut connection = connection.clone();
    if let Some(p) = &project {
        if !connection.local && connection.replica_host.is_none() {
            connection.replica_host = Some(p.replica_host.clone());
        }
        if connection.canister_id.is_none() && std::env::var_os("VFS_CANISTER_ID").is_none() {
            connection.canister_id = Some(p.canister_id.clone());
        }
        if connection.database_id.is_none() && std::env::var_os("VFS_DATABASE_ID").is_none() {
            connection.database_id = Some(p.database_id.clone());
        }
    }
    let preview = resolve_connection_optional_canister(
        connection.local,
        connection.replica_host.clone(),
        connection.canister_id.clone(),
        connection.database_id.clone(),
    )
    .ok();
    let resolved = preview.as_ref().and_then(|p| {
        Some(ResolvedConnection {
            replica_host: p.replica_host.clone(),
            canister_id: p.canister_id.clone()?,
            database_id: p.database_id.clone(),
            replica_host_source: p.replica_host_source.clone(),
            canister_id_source: p.canister_id_source.clone()?,
            database_id_source: p.database_id_source.clone(),
        })
    });
    let stored = resolved
        .as_ref()
        .and_then(|c| {
            crate::identity::load_diagnostic_identity(
                &c.canister_id,
                connection.allow_non_ii_identity,
            )
            .ok()
            .flatten()
        })
        .and_then(|i| i.sender().ok())
        .map(|p| p.to_text());
    let principal = project
        .as_ref()
        .and_then(|p| p.principal.clone())
        .or(stored.clone());
    let binding_valid = project.as_ref().is_none_or(|p| {
        resolved
            .as_ref()
            .is_some_and(|c| p.validate_connection(c).is_ok())
            && stored.as_ref().is_none_or(|actual| {
                p.principal
                    .as_ref()
                    .is_none_or(|expected| actual == expected)
            })
    });
    let state = args
        .state
        .state_dir
        .clone()
        .or_else(|| std::env::var_os("KINIC_LEARNING_HOME").map(PathBuf::from))
        .or_else(|| settings.as_ref().and_then(|s| s.state_dir()))
        .or_else(|| home.as_ref().map(|h| h.join(".kinic/learning")));
    let mut engines = settings
        .as_ref()
        .map(|s| s.configured_engines())
        .unwrap_or_default();
    if let Some(project) = &project {
        let engine = format!("{:?}", project.runner.engine).to_lowercase();
        if !engines.contains(&engine) {
            engines.push(engine);
        }
    }
    let root = settings.as_ref().map(|s| s.root.as_path()).unwrap_or(&cwd);
    let mut record = unknown("binding_unavailable", None);
    let mut context = unknown("binding_unavailable", None);
    let mut learning = unknown("binding_unavailable", None);
    let mut intake = unknown("binding_unavailable", None);
    if config_valid && binding_valid {
        if let (Some(state), Some(c), Some(principal)) = (&state, &resolved, &principal) {
            let scope = hash(&serde_json::to_string(&(
                format!("{}:{}", c.replica_host, c.canister_id),
                &c.database_id,
                principal,
            ))?);
            (record, context) = records(
                &state.join("learning-outbox.sqlite3"),
                &scope,
                project.as_ref(),
                root,
            );
            if let Some(project) = &project {
                let binding = serde_json::to_string(&(
                    format!("{}:{}", c.replica_host, c.canister_id),
                    &c.database_id,
                    principal,
                ))?;
                let key = hash(&serde_json::to_string(&(binding, &project.project_id))?);
                learning = jobs(
                    &state.join(format!("jobs-{key}.sqlite")),
                    config_path.as_deref(),
                );
            }
        }
        if let (Some(state), Some(c), Some(settings)) = (&state, &resolved, &settings) {
            intake = inbox(
                state,
                settings,
                c,
                explicit,
                config_path.as_deref(),
                &["codex".into(), "dsh".into()],
            );
        }
    }
    let value = json!({"schema_version":1,"checked_at":chrono::Utc::now().to_rfc3339(),"mode":"local_read_only",
        "target":{"project_root":root,"project_id":project.as_ref().map(|p|&p.project_id),"canister_id":preview.as_ref().and_then(|c|c.canister_id.as_ref()),"database_id":preview.as_ref().and_then(|c|c.database_id.as_ref()),"principal":principal,"stored_principal":stored,"principal_basis":if project.as_ref().and_then(|p|p.principal.as_ref()).is_some(){if stored.is_some(){"configured_project_compared_to_stored_identity"}else{"configured_project_not_authenticated"}}else if stored.is_some(){"stored_identity"}else{"unknown"},"binding":if !config_valid{"configuration_unavailable"}else if !binding_valid{"project_binding_mismatch"}else if resolved.is_some(){"resolved"}else{"incomplete"}},
        "configuration":{"status":if config_valid{"observed"}else{"unknown"},"code":if config_valid{"configuration_read"}else{"configuration_unavailable"},"sources":settings.as_ref().map(|s|&s.sources),"explicit_config":explicit,"engines":engines,"activation":"unverified","operation":"unverified"},
        "records":record,"context":context,"learning":learning,"intake":intake,
        "legacy_adapter_queue":unknown("legacy_queue_not_inspected",None),
        "publication":unknown("remote_evidence_not_read",None),"rollback":unknown("remote_evidence_not_read",None)});
    if args.state.json {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        print_text(&value);
    }
    Ok(())
}

fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => "unknown".into(),
    }
}
fn print_text(value: &Value) {
    println!("Local learning evidence (no remote verification)");
    for (label, key) in [
        ("Project", "project_root"),
        ("Database", "database_id"),
        ("Principal", "principal"),
        ("Principal basis", "principal_basis"),
        ("Binding", "binding"),
    ] {
        println!("{label}: {}", text(&value["target"][key]));
    }
    println!("Checked at: {}", text(&value["checked_at"]));
    for (label, key) in [
        ("Configuration", "configuration"),
        ("Records", "records"),
        ("Context", "context"),
        ("Learning", "learning"),
        ("Intake", "intake"),
        ("Publication", "publication"),
        ("Rollback", "rollback"),
    ] {
        let section = &value[key];
        println!(
            "{label}: {} [{}]",
            text(&section["status"]),
            text(&section["code"])
        );
        if let Some(source) = section["source"].as_str() {
            println!("  Source: {source}");
        }
        if let Some(time) = section["storage_modified_at"].as_str() {
            println!("  Storage modified at: {time} (event time unknown)");
        }
    }
    println!(
        "Pending records: {}",
        text(&value["records"]["pending_records"])
    );
    println!(
        "Oldest pending: {} (unknown legacy timestamps: {})",
        text(&value["records"]["oldest_pending_at"]),
        text(&value["records"]["pending_time_unknown"])
    );
    println!(
        "Last send attempt: {}; success: {}; failure: {} at {}",
        text(&value["records"]["last_send_attempt_at"]),
        text(&value["records"]["last_send_success_at"]),
        text(&value["records"]["last_send_failure"]["code"]),
        text(&value["records"]["last_send_failure"]["at"])
    );
    println!(
        "Delivery scope: {}",
        text(&value["records"]["delivery_scope"])
    );
    println!(
        "Acknowledged records: {}",
        text(&value["records"]["acknowledged_records"])
    );
    println!(
        "Last record: {} (run {})",
        text(&value["records"]["last_record"]["id"]),
        text(&value["records"]["last_record"]["run_id"])
    );
    println!(
        "Receipt: {} (run {})",
        text(&value["context"]["receipt_id"]),
        text(&value["context"]["run_id"])
    );
    println!("Delivery: {}", text(&value["context"]["delivery"]));
    println!("Adoption: {}", text(&value["context"]["adoption"]));
    if let Some(jobs) = value["learning"]["jobs"].as_array() {
        for job in jobs {
            println!(
                "Job {}: {} [{}]",
                text(&job["run_id"]),
                text(&job["state"]),
                text(&job["reason_code"])
            );
            println!(
                "  Candidate: {}\n  Evaluation: {}",
                text(&job["candidate_path"]),
                text(&job["evaluation_path"])
            );
        }
    }
    if let Some(engines) = value["intake"]["per_engine"].as_array() {
        for engine in engines {
            println!(
                "Pending inputs ({}): {} [{}]",
                text(&engine["engine"]),
                text(&engine["pending_inputs"]),
                text(&engine["code"])
            );
            println!("  Source: {}", text(&engine["source"]));
            println!(
                "  Quarantined: {} at {}; reasons: {}",
                text(&engine["quarantine"]["count"]),
                text(&engine["quarantine"]["source"]),
                engine["quarantine"]["reasons"]
            );
        }
    }
    if let Some(sources) = value["configuration"]["sources"].as_object() {
        for (field, source) in sources {
            println!("Setting {field}: {}", text(source));
        }
    }
    println!(
        "Scope: current configuration/cwd; older partitions and legacy adapter queues excluded. Counts are separate stages and are not added. App activation and operation are unverified."
    );
}

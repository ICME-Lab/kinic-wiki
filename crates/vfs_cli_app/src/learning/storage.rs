//! Read-only inventories and explicit, fail-closed evidence cleanup.
use super::*;
use rusqlite::{Connection, OpenFlags, params};
use std::collections::{BTreeSet, HashSet};
use std::io::Write;

const MAX_ROWS: usize = 100_000;
const MAX_BYTES: usize = 512 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Item {
    pub key: String,
    pub category: String,
    pub bytes: usize,
    pub sha256: String,
    pub etag: Option<String>,
    pub metadata_hash: Option<String>,
    pub event_kind: Option<String>,
    pub run_id: Option<String>,
    pub event_id: Option<String>,
    pub snapshot_hash: Option<String>,
    pub snapshot_bytes: usize,
    pub acknowledged: bool,
    pub excluded: bool,
    pub owned: bool,
    pub eligible_reason: Option<String>,
    pub protected_by: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Inventory {
    pub version: u8,
    pub binding: (String, String, String, String),
    #[serde(default)]
    pub state_root: Option<PathBuf>,
    #[serde(default)]
    pub archive_intermediate: bool,
    pub complete: bool,
    pub issues: Vec<String>,
    pub items: Vec<Item>,
    pub jobs_hash: String,
    pub source_sizes: Value,
}
struct Data {
    report: Inventory,
    bodies: BTreeMap<String, String>,
    nodes: BTreeMap<String, Node>,
    events: BTreeMap<String, Event>,
    jobs: Vec<String>,
}
#[derive(Serialize, Deserialize)]
struct Preview {
    version: u8,
    inventory: Inventory,
    selected: Vec<String>,
    current_body_bytes: usize,
    limitations: Vec<String>,
}
fn category(path: &str) -> &str {
    if path.starts_with("/Sources/learning-runs/") {
        "learning_runs"
    } else if path.starts_with("/Sources/learning-candidates/") {
        "candidates"
    } else if path.starts_with("/Sources/learning-evaluations/") {
        "evaluations"
    } else if path.starts_with("/Sources/learning-publications/")
        || path.starts_with("/Sources/learning-rollbacks/")
    {
        "publication_and_rollback"
    } else if path.starts_with("/Knowledge/") {
        "knowledge_and_cases"
    } else {
        "other"
    }
}
fn item(
    key: String,
    body: &str,
    node: Option<&Node>,
    event: Option<&Event>,
    project: &str,
    ack: bool,
    excluded: bool,
) -> Item {
    let snapshot = event.and_then(|e| e.payload.pointer("/capture/session_evidence"));
    let owned = event.is_some_and(|e| {
        e.run_id.starts_with(&format!("{project}:")) && e.payload["project_id"] == project
    });
    let fixture = event.is_some_and(|e| e.payload["test_fixture"] == true);
    Item {
        category: node.map_or("local_outbox", |n| category(&n.path)).into(),
        bytes: body.len(),
        sha256: hash(body),
        etag: node.map(|n| n.etag.clone()),
        metadata_hash: node.map(|n| hash(&n.metadata_json)),
        event_kind: event.map(|e| e.kind.clone()),
        run_id: event.map(|e| e.run_id.clone()),
        event_id: event.map(|e| e.id.clone()),
        snapshot_hash: snapshot.map(|v| hash(&v.to_string())),
        snapshot_bytes: snapshot.map_or(0, |v| v.to_string().len()),
        acknowledged: ack,
        excluded,
        owned,
        eligible_reason: if owned && fixture && !ack && !excluded {
            Some("explicit_test_fixture".into())
        } else {
            None
        },
        protected_by: vec![],
        key,
    }
}
fn stamp(path: &Path) -> Result<Vec<Option<(u64, SystemTime)>>> {
    [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-journal", path.display())),
    ]
    .iter()
    .map(|p| match std::fs::metadata(p) {
        Ok(m) => Ok(Some((m.len(), m.modified()?))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    })
    .collect()
}
use std::time::SystemTime;
// Copy a stable db/WAL pair, then open only the private copy. No live-source SHM writes.
fn readonly_copy(path: &Path) -> Result<(tempfile::TempDir, Connection)> {
    let before = stamp(path)?;
    ensure!(before[2].is_none(), "active rollback journal");
    ensure!(
        before.iter().flatten().map(|(n, _)| *n).sum::<u64>() <= MAX_BYTES as u64,
        "local database exceeds inspection budget"
    );
    let temp = tempfile::tempdir()?;
    let copy = temp.path().join("state.sqlite");
    std::fs::copy(path, &copy)?;
    if before[1].is_some() {
        std::fs::copy(
            format!("{}-wal", path.display()),
            temp.path().join("state.sqlite-wal"),
        )?;
    }
    ensure!(
        before == stamp(path)?,
        "local state changed during snapshot"
    );
    let conn = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.pragma_update(None, "query_only", true)?;
    Ok((temp, conn))
}
// Resolve existing ancestors without creating state during read-only inspection.
fn canonical_state_root(root: &Path) -> Result<PathBuf> {
    let absolute = std::path::absolute(root)?;
    match absolute.canonicalize() {
        Ok(path) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let name = absolute
                .file_name()
                .context("unresolvable state directory")?;
            let parent = absolute.parent().context("state directory has no parent")?;
            Ok(canonical_state_root(parent)?.join(name))
        }
        Err(e) => Err(e.into()),
    }
}
fn local(data: &mut Data, root: &Path, scope: &str, project: &str) -> Result<()> {
    data.report.state_root = Some(canonical_state_root(root)?);
    let path = root.join("learning-outbox.sqlite3");
    if path.exists() {
        let (_tmp, conn) = readonly_copy(&path)?;
        let has_exclusions: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='learning_exclusions')",
            [],
            |r| r.get(0),
        )?;
        let mut cursor = 0i64;
        let mut total = 0usize;
        loop {
            let mut stmt=conn.prepare("SELECT rowid,id,body,acknowledged,scope FROM learning_outbox WHERE rowid>?1 ORDER BY rowid LIMIT 100")?;
            let rows = stmt
                .query_map(params![cursor], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, bool>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if rows.is_empty() {
                break;
            }
            for (seq, id, body, ack, row_scope) in rows {
                cursor = seq;
                total += body.len();
                ensure!(
                    total <= MAX_BYTES && data.report.items.len() < MAX_ROWS,
                    "local inventory budget exceeded"
                );
                let e: Event = serde_json::from_str(&body)?;
                ensure!(e.id == id, "outbox identity mismatch");
                let excluded = has_exclusions
                    && conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM learning_exclusions WHERE scope=?1 AND id=?2)",
                        params![row_scope, id],
                        |r| r.get::<_, bool>(0),
                    )?;
                let selected_scope = row_scope == scope;
                let key = if selected_scope {
                    format!("local:{id}")
                } else {
                    format!("local:{row_scope}:{id}")
                };
                let mut entry = item(key.clone(), &body, None, Some(&e), project, ack, excluded);
                // Opaque foreign scopes are reference sources only, never cleanup targets.
                if !selected_scope {
                    entry.owned = false;
                    entry.eligible_reason = None;
                }
                data.report.items.push(entry);
                data.bodies.insert(key.clone(), body);
                data.events.insert(key, e);
            }
        }
        data.report.source_sizes["local_sqlite_file_bytes"] =
            json!(std::fs::metadata(&path)?.len());
    }
    if root.exists() {
        for entry in std::fs::read_dir(root)? {
            let p = entry?.path();
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with("jobs-") && name.ends_with(".sqlite") {
                let (_tmp, c) = readonly_copy(&p)?;
                let mut stmt = c.prepare("SELECT body FROM jobs ORDER BY run")?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                ensure!(rows.len() < MAX_ROWS, "job inventory incomplete");
                for body in rows {
                    let _: jobs::LearningJob = serde_json::from_str(&body)?;
                    data.jobs.push(body);
                }
            }
        }
        // Unprocessed inbox evidence can contain references not yet present in the outbox.
        let mut dirs = vec![root.join("hook-inbox")];
        let mut seen = 0;
        let mut inbox_bytes = 0usize;
        while let Some(dir) = dirs.pop() {
            if !dir.exists() {
                continue;
            }
            for entry in std::fs::read_dir(dir)? {
                let entry = entry?;
                seen += 1;
                ensure!(seen < MAX_ROWS, "inbox inventory incomplete");
                let p = entry.path();
                ensure!(
                    !entry.file_type()?.is_symlink(),
                    "inbox symlink cannot be inspected safely"
                );
                if p.is_dir() {
                    dirs.push(p);
                } else if p.extension().is_some_and(|e| e == "json") {
                    let before = std::fs::metadata(&p)?;
                    inbox_bytes = inbox_bytes
                        .checked_add(usize::try_from(before.len())?)
                        .context("inbox size overflow")?;
                    ensure!(
                        inbox_bytes <= MAX_BYTES && data.report.items.len() < MAX_ROWS,
                        "inbox inventory budget exceeded"
                    );
                    let body = std::fs::read_to_string(&p)?;
                    let after = std::fs::metadata(&p)?;
                    ensure!(
                        before.len() == after.len() && before.modified()? == after.modified()?,
                        "inbox changed during inspection"
                    );
                    let value: Value = serde_json::from_str(&body)?;
                    ensure!(
                        value["__kinic_run_id"].is_string()
                            && value["__kinic_evidence"].is_object(),
                        "unrecognized inbox evidence"
                    );
                    let key = format!("inbox:{}", p.strip_prefix(root)?.to_string_lossy());
                    let mut entry = item(key.clone(), &body, None, None, project, false, false);
                    entry.category = "hook_inbox".into();
                    data.report.items.push(entry);
                    data.bodies.insert(key, body);
                }
            }
        }
    }
    data.jobs.sort();
    data.report.jobs_hash = hash(&serde_json::to_string(&data.jobs)?);
    Ok(())
}
async fn remote(data: &mut Data, client: &impl VfsApi, db: &str, project: &str) -> Result<()> {
    let mut cursor = None;
    let mut revision = None;
    let mut session = None;
    let mut seen = HashSet::new();
    let mut total = 0;
    loop {
        let page = client
            .export_snapshot(ExportSnapshotRequest {
                database_id: db.into(),
                prefix: Some("/".into()),
                limit: 100,
                cursor: cursor.clone(),
                snapshot_revision: revision.clone(),
                snapshot_session_id: session.clone(),
            })
            .await?;
        if let Some(r) = &revision {
            ensure!(r == &page.snapshot_revision, "remote snapshot changed");
        }
        revision = Some(page.snapshot_revision);
        session = page.snapshot_session_id;
        for n in page.nodes {
            total += n.content.len() + n.metadata_json.len();
            ensure!(
                total <= MAX_BYTES && data.report.items.len() < MAX_ROWS,
                "remote inventory budget exceeded"
            );
            let key = format!("remote:{}", n.path);
            ensure!(!data.nodes.contains_key(&key), "duplicate snapshot path");
            let e = if n.path.starts_with("/Sources/learning-runs/") && n.kind != NodeKind::Folder {
                Some(serde_json::from_str::<Event>(&n.content).context("invalid learning event")?)
            } else {
                None
            };
            let mut i = item(
                key.clone(),
                &n.content,
                Some(&n),
                e.as_ref(),
                project,
                false,
                false,
            );
            if e.as_ref().is_some_and(|e| evidence_path(e) != n.path) {
                i.owned = false;
                i.eligible_reason = None;
            }
            let metadata: Value = serde_json::from_str(&n.metadata_json)?;
            if n.kind == NodeKind::Folder
                || metadata["approved"] == true
                || metadata["protected"] == true
                || metadata["authority"] == "human"
                || !metadata["kinic_superpowers"].is_null()
            {
                i.owned = false;
                i.eligible_reason = None;
            }
            if data.report.archive_intermediate
                && i.owned
                && e.as_ref().is_some_and(|e| {
                    e.kind == "hook"
                        && e.payload["capture"]["terminal"] != true
                        && (e.payload["capture"]["event"] == "PostToolUse"
                            || e.payload["capture"]["hook_event_name"] == "PostToolUse")
                })
            {
                i.eligible_reason = Some("archive_intermediate".into());
            }
            data.report.items.push(i);
            data.bodies
                .insert(key.clone(), format!("{}\n{}", n.content, n.metadata_json));
            data.nodes.insert(key, n);
        }
        match page.next_cursor {
            None => break,
            Some(next) => {
                ensure!(seen.insert(next.clone()), "snapshot cursor repeated");
                cursor = Some(next);
            }
        }
    }
    Ok(())
}
// A directory reference protects its children; a child path or longer directory name does not.
fn directory_reference(body: &str, directory: &str) -> bool {
    body.match_indices(directory).any(|(start, _)| {
        let tail = &body[start + directory.len()..];
        let tail = tail.strip_prefix('/').unwrap_or(tail);
        tail.chars().next().is_none_or(|c| {
            c.is_whitespace() || matches!(c, '\"' | '\'' | ')' | ']' | '}' | '>' | '#' | '?')
        })
    })
}
fn protect(data: &mut Data) {
    let mut canonical = BTreeMap::new();
    let structural_sources: BTreeMap<_, _> = data
        .report
        .items
        .iter()
        .filter(|i| {
            data.report.archive_intermediate
                && i.owned
                && (i.category == "learning_runs"
                    || (i.category == "local_outbox" && i.acknowledged))
                && matches!(i.event_kind.as_deref(), Some("hook" | "run" | "context"))
        })
        .filter_map(|i| {
            let run = i.run_id.as_ref()?;
            let node = data.nodes.get(&i.key);
            let mut value = if let Some(e) = data.events.get(&i.key) {
                serde_json::to_value(e).ok()?
            } else {
                serde_json::from_str::<Value>(&node?.content).ok()?
            };
            // Remove only schema-defined declarations, never arbitrary payload references.
            value.as_object_mut()?.remove("run_id");
            if let Some(payload) = value["payload"].as_object_mut() {
                match i.event_kind.as_deref() {
                    Some("run") => {
                        payload.remove("id");
                    }
                    Some("context") => {
                        payload.remove("run_id");
                    }
                    Some("hook") => {
                        if let Some(capture) =
                            payload.get_mut("capture").and_then(Value::as_object_mut)
                        {
                            capture.remove("__kinic_run_id");
                            capture.remove("run_id");
                        }
                    }
                    _ => {}
                }
            }
            Some((
                i.key.clone(),
                (
                    run.clone(),
                    format!(
                        "{}\n{}",
                        value,
                        node.map_or("", |n| n.metadata_json.as_str())
                    ),
                ),
            ))
        })
        .collect();
    let delivered_mirrors: BTreeMap<_, _> = data
        .report
        .items
        .iter()
        .filter(|i| i.key.starts_with("local:") && i.owned && i.acknowledged && !i.excluded)
        .map(|i| {
            (
                i.key.clone(),
                (i.event_id.clone(), i.run_id.clone(), i.sha256.clone()),
            )
        })
        .collect();
    for i in &mut data.report.items {
        let group = (i.category.clone(), i.sha256.clone());
        if i.owned
            && !i.acknowledged
            && !i.excluded
            && canonical.insert(group, i.key.clone()).is_some()
        {
            i.eligible_reason = Some("exact_body_duplicate".into());
        }
        if !data.report.complete || i.eligible_reason.is_none() {
            i.eligible_reason = None;
            continue;
        }
        let run_directory = i
            .run_id
            .as_ref()
            .map(|run| format!("/Sources/learning-runs/{}", hash(run)));
        let needles: Vec<&str> = [
            i.key.strip_prefix("remote:"),
            i.event_id.as_deref(),
            i.run_id.as_deref(),
            Some(i.sha256.as_str()),
        ]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect();
        for (key, body) in &data.bodies {
            if key == &i.key {
                continue;
            }
            // A delivered exact copy is not a dependency on itself. Pending copies,
            // distinct events and foreign partitions still protect the remote node.
            if i.key.starts_with("remote:")
                && delivered_mirrors.get(key).is_some_and(|(id, run, sha)| {
                    id == &i.event_id && run == &i.run_id && sha == &i.sha256
                })
            {
                continue;
            }
            let sibling = structural_sources.get(key).filter(|(run, _)| {
                i.eligible_reason.as_deref() == Some("archive_intermediate")
                    && Some(run) == i.run_id.as_ref()
            });
            if needles.iter().any(|s| {
                if Some(*s) == i.run_id.as_deref()
                    && let Some((_, projected)) = sibling
                {
                    projected.contains(s)
                } else {
                    body.contains(s)
                }
            }) || run_directory
                .as_ref()
                .is_some_and(|directory| directory_reference(body, directory))
            {
                i.protected_by.push(key.clone());
                break; // A protected target cannot be deleted; further reasons are not needed.
            }
        }
        for (n, body) in data.jobs.iter().enumerate() {
            if !i.protected_by.is_empty() {
                break;
            }
            if needles.iter().any(|s| body.contains(s))
                || run_directory
                    .as_ref()
                    .is_some_and(|directory| directory_reference(body, directory))
            {
                i.protected_by.push(format!("job:{n}"));
                break;
            }
        }
        if !i.protected_by.is_empty() || !data.report.complete {
            i.eligible_reason = None;
        }
    }
    data.report.items.sort_by(|a, b| a.key.cmp(&b.key));
}
fn empty_data(c: &ResolvedConnection, project: &ProjectConfig) -> Data {
    let principal = project.principal.clone().unwrap_or_default();
    let db = c.database_id.clone().unwrap_or_default();
    Data {
        report: Inventory {
            version: 2,
            state_root: None,
            archive_intermediate: false,
            binding: (
                endpoint(c),
                db.clone(),
                principal.clone(),
                project.project_id.clone(),
            ),
            complete: true,
            issues: vec![],
            items: vec![],
            jobs_hash: hash("[]"),
            source_sizes: json!({"local_sqlite_file_bytes":null,"remote_history_bytes":null,"remote_index_bytes":null,"remote_database_file_bytes":null,"physical_reclaim_bytes":null}),
        },
        bodies: BTreeMap::new(),
        nodes: BTreeMap::new(),
        events: BTreeMap::new(),
        jobs: vec![],
    }
}
#[cfg(test)]
async fn collect(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    project: &ProjectConfig,
    root: &Path,
    local_only: bool,
) -> Data {
    collect_with_policy(client, c, project, root, local_only, false).await
}
async fn collect_with_policy(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    project: &ProjectConfig,
    root: &Path,
    local_only: bool,
    archive_intermediate: bool,
) -> Data {
    let mut data = empty_data(c, project);
    data.report.archive_intermediate = archive_intermediate;
    let db = data.report.binding.1.clone();
    let principal = data.report.binding.2.clone();
    let scope = hash(&serde_json::to_string(&(endpoint(c), &db, &principal)).unwrap());
    if local(&mut data, root, &scope, &project.project_id).is_err() {
        data.report.complete = false;
        data.report
            .issues
            .push("local_inspection_incomplete".into());
    }
    if local_only {
        data.report.complete = false;
        data.report.issues.push("remote_not_inspected".into());
    } else if remote(&mut data, client, &db, &project.project_id)
        .await
        .is_err()
    {
        data.report.complete = false;
        data.report
            .issues
            .push("remote_inspection_incomplete".into());
    }
    protect(&mut data);
    data
}
fn summary(report: &Inventory) -> Value {
    let mut groups = BTreeMap::<String, (usize, usize)>::new();
    let mut snapshots = BTreeMap::<String, (usize, usize)>::new();
    for i in &report.items {
        let g = groups.entry(i.category.clone()).or_default();
        g.0 += 1;
        g.1 += i.bytes;
        if let Some(h) = &i.snapshot_hash {
            let source = if i.key.starts_with("local:") {
                "local"
            } else {
                "remote"
            };
            let g = snapshots.entry(format!("{source}:{h}")).or_default();
            g.0 += 1;
            g.1 = i.snapshot_bytes;
        }
    }
    json!({"inventory":report,"categories":groups,"repeated_snapshot_bytes":snapshots.values().map(|(n,b)|n.saturating_sub(1)*b).sum::<usize>(),"eligible_count":report.items.iter().filter(|i|i.eligible_reason.is_some()).count(),"excluded_records":report.items.iter().filter(|i|i.excluded).count(),"protection_detail":"protected_by gives a blocking reference, not every reference; unprotected candidates scan all sources","measurement":"UTF-8 content bytes; not physical allocation or cycles"})
}
fn write_new_verified(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    ensure!(std::fs::read(path)? == bytes, "backup readback mismatch");
    Ok(())
}
pub fn print_summary(value: &Value) {
    println!("{}", human_summary(value));
}
fn human_summary(value: &Value) -> String {
    let r = &value["inventory"];
    let mut lines = vec![format!(
        "Complete: {}\nEligible: {}\nExcluded: {}",
        r["complete"], value["eligible_count"], value["excluded_records"]
    )];
    if let Some(groups) = value["categories"].as_object() {
        for (k, v) in groups {
            lines.push(format!("{k}: {} records / {} content bytes", v[0], v[1]));
        }
    }
    if !r["issues"].is_null() {
        lines.push(format!("issues: {}", r["issues"]));
    }
    for key in ["preview", "preview_sha256", "applied", "limitations"] {
        if !value[key].is_null() {
            lines.push(format!("{key}: {}", value[key]));
        }
    }
    lines.push(
        "History, indexes and physical reclaim remain unknown unless separately measured.".into(),
    );
    lines.join("\n")
}

pub fn local_inventory(c: &ResolvedConnection, cwd: &Path, state: &StateArgs) -> Result<Value> {
    let path = discover_config(cwd)?.context("portable learning project required")?;
    let project = load_project(&path)?;
    project.validate_connection(c)?;
    let root = state_root_at(state, cwd)?;
    let mut data = empty_data(c, &project);
    let scope = hash(&serde_json::to_string(&(
        endpoint(c),
        &project.database_id,
        &project.principal.clone().unwrap_or_default(),
    ))?);
    if local(&mut data, &root, &scope, &project.project_id).is_err() {
        data.report
            .issues
            .push("local_inspection_incomplete".into());
    }
    data.report.complete = false;
    data.report.issues.push("remote_not_inspected".into());
    protect(&mut data);
    let mut value = summary(&data.report);
    value["identity_basis"] = json!("configured principal; not authenticated");
    Ok(value)
}
pub async fn run(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    cwd: &Path,
    state: &StateArgs,
    command: StorageCommand,
) -> Result<Value> {
    let path = discover_config(cwd)?.context("portable learning project required")?;
    let project = load_project(&path)?;
    project.validate_connection(c)?;
    ensure!(
        project.principal.is_some() && project.principal == client.caller_principal(),
        "project identity mismatch"
    );
    let root = state_root_at(state, cwd)?;
    let local_only = matches!(command, StorageCommand::Inventory { local_only: true });
    let archive_intermediate = match &command {
        StorageCommand::Preview {
            archive_intermediate,
            ..
        } => *archive_intermediate,
        StorageCommand::Apply { preview, .. } => {
            let preview: Preview = serde_json::from_value(read_json(preview)?)?;
            preview.inventory.archive_intermediate
        }
        _ => false,
    };
    let data =
        collect_with_policy(client, c, &project, &root, local_only, archive_intermediate).await;
    match command {
        StorageCommand::Inventory { .. } => Ok(summary(&data.report)),
        StorageCommand::Preview { output, .. } => {
            let selected: Vec<_> = data
                .report
                .items
                .iter()
                .filter(|i| i.eligible_reason.is_some())
                .map(|i| i.key.clone())
                .collect();
            let bytes = data
                .report
                .items
                .iter()
                .filter(|i| selected.contains(&i.key))
                .map(|i| i.bytes)
                .sum();
            let preview=Preview{version:1,inventory:data.report.clone(),selected,current_body_bytes:bytes,limitations:vec!["No history purge or physical reclaim guarantee".into(),if archive_intermediate {"Includes explicitly requested archival of unreferenced intermediate tool evidence; online availability is lost".into()} else {"Only exact duplicates or explicitly marked test fixtures; no age-based cleanup".into()},"Apply requires reviewed file digest, verified backup and quiescent project writers".into()]};
            let raw = serde_json::to_vec_pretty(&preview)?;
            write_new_verified(&output, &raw)?;
            let mut value = summary(&data.report);
            value["preview"] = json!(output);
            value["preview_sha256"] = json!(hash(std::str::from_utf8(&raw)?));
            value["limitations"] = json!(preview.limitations);
            Ok(value)
        }
        StorageCommand::Apply {
            preview,
            backup_dir,
            confirm,
        } => {
            apply(
                client,
                c,
                &project,
                &root,
                &data,
                &preview,
                &backup_dir,
                &confirm,
            )
            .await
        }
    }
}
#[allow(
    clippy::too_many_arguments,
    reason = "Keep authenticated binding, immutable inventory and reviewed backup inputs explicit at the mutation boundary"
)]
async fn apply(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    project: &ProjectConfig,
    root: &Path,
    data: &Data,
    preview_path: &Path,
    backup_dir: &Path,
    confirm: &str,
) -> Result<Value> {
    ensure!(
        !project.enabled,
        "disable automatic learning before cleanup"
    );
    let raw = std::fs::read(preview_path)?;
    ensure!(raw.len() <= MAX_BYTES, "preview too large");
    ensure!(
        hash(std::str::from_utf8(&raw)?) == confirm,
        "reviewed preview digest mismatch"
    );
    let p: Preview = serde_json::from_slice(&raw)?;
    ensure!(
        p.version == 1 && p.inventory.version == 2,
        "unsupported preview"
    );
    ensure!(
        p.inventory.binding == data.report.binding
            && p.inventory.archive_intermediate == data.report.archive_intermediate
            && p.inventory.complete
            && data.report.complete
            && p.inventory.state_root.is_some()
            && p.inventory.state_root == data.report.state_root
            && data.report.state_root.as_ref() == Some(&canonical_state_root(root)?),
        "binding changed or incomplete dependency inspection"
    );
    let selected: BTreeSet<_> = p.selected.iter().cloned().collect();
    ensure!(selected.len() == p.selected.len(), "duplicate cleanup key");
    for key in &selected {
        ensure!(
            p.inventory
                .items
                .iter()
                .any(|i| &i.key == key && i.eligible_reason.is_some()),
            "unapproved cleanup item"
        );
    }
    if backup_dir.exists() {
        let receipt:Value=read_json(&backup_dir.join("complete.json")).context("previous cleanup incomplete; preserve backup and reconcile, do not retry automatically")?;
        ensure!(
            receipt["preview_sha256"] == confirm,
            "backup belongs to another preview"
        );
        let final_items: Vec<Item> = serde_json::from_value(receipt["items"].clone())?;
        ensure!(
            final_items == data.report.items,
            "state changed after cleanup; inspect before retry"
        );
        return Ok(json!({"already_applied":true,"applied":[],"backup":backup_dir}));
    }
    // Recompute all dependencies, but pin the reviewed targets rather than unrelated arrivals.
    // A new reference/job changes target protection/eligibility and must reject the preview.
    for key in &selected {
        let approved = p.inventory.items.iter().find(|i| &i.key == key);
        let current = data.report.items.iter().find(|i| &i.key == key);
        ensure!(
            approved == current,
            "reviewed target or its dependencies changed; review a new preview"
        );
    }
    if selected.is_empty() {
        return Ok(
            json!({"applied":[],"current_body_bytes_removed":0,"physical_reclaim_bytes":null}),
        );
    }
    std::fs::create_dir(backup_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(backup_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    write_new_verified(&backup_dir.join("preview.json"), &raw)?;
    for key in &selected {
        let body = if let Some(n) = data.nodes.get(key) {
            serde_json::to_vec(n)?
        } else {
            serde_json::to_vec(data.events.get(key).context("event missing")?)?
        };
        write_new_verified(&backup_dir.join(format!("{}.json", hash(key))), &body)?;
    }
    let outbox = Outbox::open(
        root,
        &data.report.binding.0,
        &data.report.binding.1,
        &data.report.binding.2,
    )?;
    let _lease = outbox
        .acquire()?
        .context("delivery is active; cleanup not applied")?;
    let mut expected = data.report.clone();
    let mut applied: Vec<String> = vec![];
    let ordered: Vec<_> = selected.iter().cloned().collect();
    for batch in ordered.chunks(100) {
        let fresh = collect_with_policy(
            client,
            c,
            project,
            root,
            false,
            expected.archive_intermediate,
        )
        .await;
        ensure!(
            fresh.report.complete && fresh.report.state_root == expected.state_root,
            "dependency inspection changed"
        );
        for key in selected.iter().filter(|k| !applied.contains(k)) {
            ensure!(
                fresh.report.items.iter().find(|i| &i.key == key)
                    == expected.items.iter().find(|i| &i.key == key),
                "reviewed target or dependencies changed during cleanup"
            );
        }
        for key in batch {
            ensure!(
                fresh
                    .report
                    .items
                    .iter()
                    .any(|i| &i.key == key && i.eligible_reason.is_some()),
                "cleanup target became protected"
            );
        }
        let operations: Vec<_> = batch
            .iter()
            .filter_map(|key| data.nodes.get(key))
            .map(|n| {
                vfs_types::NodeMutation::Delete(vfs_types::DeleteNodeItem {
                    path: n.path.clone(),
                    expected_etag: Some(n.etag.clone()),
                    expected_folder_index_etag: None,
                })
            })
            .collect();
        if !operations.is_empty() {
            // One atomic remote transaction; never fall back to individual deletes on error.
            client
                .mutate_nodes_batch(vfs_types::MutateNodesBatchRequest {
                    database_id: data.report.binding.1.clone(),
                    operations,
                })
                .await?;
        }
        for key in batch {
            if let Some(n) = data.nodes.get(key) {
                ensure!(
                    client
                        .read_node(&data.report.binding.1, &n.path)
                        .await?
                        .is_none(),
                    "delete readback failed"
                );
            } else {
                outbox.exclude(data.events.get(key).context("event missing")?, confirm)?;
            }
            applied.push(key.clone());
            write_new_verified(&backup_dir.join(format!("{}.done", hash(key))), b"applied")?;
        }
        // Recheck both remaining targets and dependencies on archived preimages.
        // Unrelated arrivals are allowed, never a fresh-etag retry for a changed target.
        let mut after = collect_with_policy(
            client,
            c,
            project,
            root,
            false,
            expected.archive_intermediate,
        )
        .await;
        ensure!(
            after.report.complete && after.report.state_root == expected.state_root,
            "dependency inspection changed after cleanup; reconcile backup"
        );
        for key in selected.iter().filter(|k| !applied.contains(k)) {
            ensure!(
                after.report.items.iter().find(|i| &i.key == key)
                    == expected.items.iter().find(|i| &i.key == key),
                "remaining target or dependencies changed; reconcile backup"
            );
        }
        let actual_report = after.report.clone();
        for key in &applied {
            let mut preimage = data
                .report
                .items
                .iter()
                .find(|i| &i.key == key)
                .context("preimage missing")?
                .clone();
            preimage.protected_by.clear();
            after.report.items.retain(|i| &i.key != key);
            after.report.items.push(preimage);
        }
        protect(&mut after);
        ensure!(
            applied.iter().all(|key| after
                .report
                .items
                .iter()
                .any(|i| &i.key == key && i.eligible_reason.is_some())),
            "new dependency on archived evidence; reconcile backup"
        );
        expected = actual_report;
    }
    write_new_verified(
        &backup_dir.join("complete.json"),
        &serde_json::to_vec(&json!({"preview_sha256":confirm,"items":expected.items}))?,
    )?;
    Ok(
        json!({"applied":applied,"current_body_bytes_selected":p.current_body_bytes,"physical_reclaim_bytes":null,"backup":backup_dir,"limitations":"Historical content retained; no physical reclamation claimed"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::learning::integration_tests::StoreClient;
    const PROJECT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn fixture() -> (
        tempfile::TempDir,
        StoreClient,
        ResolvedConnection,
        ProjectConfig,
        PathBuf,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let client = StoreClient::new(dir.path());
        let c = ResolvedConnection {
            replica_host: "http://local".into(),
            canister_id: "canister".into(),
            database_id: Some("db".into()),
            replica_host_source: "test".into(),
            canister_id_source: "test".into(),
            database_id_source: None,
        };
        let p=ProjectConfig{version:2,project_id:PROJECT.into(),enabled:false,replica_host:c.replica_host.clone(),canister_id:c.canister_id.clone(),database_id:"db".into(),principal:Some("principal".into()),recall:serde_json::from_value(json!({"namespace":"/Knowledge","budget_tokens":4096,"fts":true,"graph":true,"semantic":false,"max_index_nodes":1000,"environment":[],"task":""})).unwrap(),runner:RunnerConfig::default(),validation_suite:None,shared_scopes:vec![]};
        let root = dir.path().join("state");
        (dir, client, c, p, root)
    }
    fn test_event(id: &str) -> Event {
        Event {
            id: id.into(),
            run_id: format!("{PROJECT}:{id}"),
            kind: "hook".into(),
            payload: json!({"project_id":PROJECT,"test_fixture":true,"capture":{"session_evidence":{"records":["private transcript"]}}}),
        }
    }
    async fn remote_event(client: &StoreClient, e: &Event) {
        write_immutable(
            client,
            "db",
            &evidence_path(e),
            &serde_json::to_string(e).unwrap(),
        )
        .await
        .unwrap();
    }
    fn preview_file(dir: &Path, data: &Data) -> (PathBuf, String) {
        let p = Preview {
            version: 1,
            inventory: data.report.clone(),
            selected: data
                .report
                .items
                .iter()
                .filter(|i| i.eligible_reason.is_some())
                .map(|i| i.key.clone())
                .collect(),
            current_body_bytes: 0,
            limitations: vec![],
        };
        let raw = serde_json::to_string(&p).unwrap();
        let path = dir.join("preview.json");
        std::fs::write(&path, &raw).unwrap();
        (path, hash(&raw))
    }
    #[tokio::test]
    async fn inventory_pages_all_nodes_without_bodies_and_protects_references() {
        let (_dir, client, c, p, root) = fixture();
        for n in 0..105 {
            remote_event(&client, &test_event(&format!("fixture-{n}"))).await;
        }
        let target = evidence_path(&test_event("fixture-0"));
        write_immutable(
            &client,
            "db",
            "/Knowledge/case.md",
            &format!("[evidence]({target})"),
        )
        .await
        .unwrap();
        let data = collect(&client, &c, &p, &root, false).await;
        assert!(data.report.complete, "{:?}", data.report.issues);
        assert_eq!(
            data.report
                .items
                .iter()
                .filter(|i| i.event_kind.is_some())
                .count(),
            105
        );
        assert!(
            data.report
                .items
                .iter()
                .find(|i| i.key == format!("remote:{target}"))
                .unwrap()
                .eligible_reason
                .is_none()
        );
        assert!(
            !summary(&data.report)
                .to_string()
                .contains("private transcript")
        );
    }
    #[tokio::test]
    async fn protected_metadata_and_foreign_projects_are_never_eligible() {
        let (_dir, client, c, p, root) = fixture();
        let e = test_event("approved");
        remote_event(&client, &e).await;
        let n = client
            .read_node("db", &evidence_path(&e))
            .await
            .unwrap()
            .unwrap();
        client
            .write_node(WriteNodeRequest {
                database_id: "db".into(),
                path: n.path,
                kind: n.kind,
                content: n.content,
                metadata_json: "{\"approved\":true}".into(),
                expected_etag: Some(n.etag),
            })
            .await
            .unwrap();
        let mut foreign = test_event("foreign");
        foreign.payload["project_id"] = json!("another");
        remote_event(&client, &foreign).await;
        let data = collect(&client, &c, &p, &root, false).await;
        assert!(
            data.report
                .items
                .iter()
                .all(|i| i.eligible_reason.is_none())
        );
    }
    #[tokio::test]
    async fn backup_delete_and_repeat_apply_preserve_other_records() {
        let (dir, client, c, p, root) = fixture();
        let e = test_event("remove");
        remote_event(&client, &e).await;
        write_immutable(&client, "db", "/Knowledge/keep.md", "retain")
            .await
            .unwrap();
        let data = collect(&client, &c, &p, &root, false).await;
        let (file, digest) = preview_file(dir.path(), &data);
        let backup = dir.path().join("backup");
        let result = apply(&client, &c, &p, &root, &data, &file, &backup, &digest)
            .await
            .unwrap();
        assert_eq!(result["applied"].as_array().unwrap().len(), 1);
        let saved: Node = serde_json::from_slice(
            &std::fs::read(backup.join(format!(
                "{}.json",
                hash(&format!("remote:{}", evidence_path(&e)))
            )))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(saved.content, serde_json::to_string(&e).unwrap());
        let after = collect(&client, &c, &p, &root, false).await;
        let repeated = apply(&client, &c, &p, &root, &after, &file, &backup, &digest)
            .await
            .unwrap();
        assert_eq!(repeated["already_applied"], true);
        assert!(
            client
                .read_node("db", "/Knowledge/keep.md")
                .await
                .unwrap()
                .is_some()
        );
    }
    #[tokio::test]
    async fn preview_rejects_new_references_changed_bodies_and_bad_confirmation() {
        let (dir, client, c, p, root) = fixture();
        let e = test_event("guarded");
        remote_event(&client, &e).await;
        let data = collect(&client, &c, &p, &root, false).await;
        let (file, digest) = preview_file(dir.path(), &data);
        assert!(
            apply(
                &client,
                &c,
                &p,
                &root,
                &data,
                &file,
                &dir.path().join("bad"),
                "wrong"
            )
            .await
            .is_err()
        );
        write_immutable(
            &client,
            "db",
            "/Knowledge/new-reference.md",
            &evidence_path(&e),
        )
        .await
        .unwrap();
        let changed = collect(&client, &c, &p, &root, false).await;
        assert!(
            apply(
                &client,
                &c,
                &p,
                &root,
                &changed,
                &file,
                &dir.path().join("blocked"),
                &digest
            )
            .await
            .is_err()
        );
        assert!(
            client
                .read_node("db", &evidence_path(&e))
                .await
                .unwrap()
                .is_some()
        );
        assert!(!dir.path().join("blocked").exists());
    }
    #[tokio::test]
    async fn local_exclusion_keeps_bytes_and_reserved_ids_and_does_not_acknowledge() {
        let (dir, client, c, p, root) = fixture();
        let e = test_event("local-only");
        let out = Outbox::open(&root, &endpoint(&c), "db", "principal").unwrap();
        out.enqueue(&e).unwrap();
        let data = collect(&client, &c, &p, &root, false).await;
        assert!(data.report.complete, "{:?}", data.report.issues);
        let (file, digest) = preview_file(dir.path(), &data);
        apply(
            &client,
            &c,
            &p,
            &root,
            &data,
            &file,
            &dir.path().join("backup"),
            &digest,
        )
        .await
        .unwrap();
        assert_eq!(out.pending_count().unwrap(), 0);
        out.enqueue(&e).unwrap();
        assert_eq!(out.pending_count().unwrap(), 0);
        let mut changed = e.clone();
        changed.payload = json!({});
        assert!(out.enqueue(&changed).is_err());
        let after = collect(&client, &c, &p, &root, false).await;
        let i = after
            .report
            .items
            .iter()
            .find(|i| i.key == "local:local-only")
            .unwrap();
        assert!(i.excluded && !i.acknowledged);
        assert_eq!(i.sha256, hash(&serde_json::to_string(&e).unwrap()));
    }
    #[tokio::test]
    async fn dependency_change_during_delete_stops_remaining_cleanup_and_completion() {
        for incomplete in [false, true] {
            let (dir, client, c, p, root) = fixture();
            let events: Vec<_> = (0..101)
                .map(|n| test_event(&format!("race-{n:03}")))
                .collect();
            for e in &events {
                remote_event(&client, e).await;
            }
            let data = collect(&client, &c, &p, &root, false).await;
            let (file, digest) = preview_file(dir.path(), &data);
            let backup = dir.path().join("backup");
            let target = data
                .report
                .items
                .iter()
                .filter(|i| i.eligible_reason.is_some())
                .nth(100)
                .unwrap()
                .run_id
                .clone()
                .unwrap();
            let state = root.clone();
            *client.after_delete.lock().unwrap() = Some(Box::new(move || {
                std::fs::create_dir_all(&state).unwrap();
                if incomplete {
                    std::fs::write(state.join("jobs-broken.sqlite"), "not sqlite").unwrap();
                } else {
                    let db = Connection::open(state.join("jobs-new.sqlite")).unwrap();
                    db.execute_batch("CREATE TABLE jobs(run TEXT PRIMARY KEY,body TEXT NOT NULL)")
                        .unwrap();
                    let job = jobs::LearningJob {
                        run_id: target.clone(),
                        cwd: state.clone(),
                        config_path: state.join("config.json"),
                        state: "paused".into(),
                        candidate_path: None,
                        evaluation_path: None,
                        error: None,
                        config_hash: None,
                        terminal_evidence: None,
                        retry_policy: None,
                        pause: None,
                    };
                    db.execute(
                        "INSERT INTO jobs VALUES(?1,?2)",
                        params![target, serde_json::to_string(&job).unwrap()],
                    )
                    .unwrap();
                }
            }));
            assert!(
                apply(&client, &c, &p, &root, &data, &file, &backup, &digest)
                    .await
                    .is_err()
            );
            assert!(!backup.join("complete.json").exists());
            let mut live = 0;
            for e in &events {
                live += client
                    .read_node("db", &evidence_path(e))
                    .await
                    .unwrap()
                    .is_some() as usize;
            }
            assert_eq!(live, 1, "must stop after first atomic batch");
            assert_eq!(*client.delete_batches.lock().unwrap(), vec![100]);
        }
    }
    #[tokio::test]
    async fn archive_policy_retains_terminal_and_pending_evidence() {
        let (_dir, client, c, p, root) = fixture();
        let mut a = test_event("archive-a");
        a.run_id = format!("{PROJECT}:archive-run");
        a.payload.as_object_mut().unwrap().remove("test_fixture");
        a.payload["capture"]["event"] = json!("PostToolUse");
        let mut b = a.clone();
        b.id = "archive-b".into();
        let mut stop = a.clone();
        stop.id = "archive-stop".into();
        stop.payload["capture"]["event"] = json!("Stop");
        for e in [&a, &b, &stop] {
            remote_event(&client, e).await;
        }
        let ordinary = collect(&client, &c, &p, &root, false).await;
        assert!(
            ordinary
                .report
                .items
                .iter()
                .all(|i| i.eligible_reason.is_none())
        );
        let data = collect_with_policy(&client, &c, &p, &root, false, true).await;
        assert_eq!(
            data.report
                .items
                .iter()
                .filter(|i| i.eligible_reason.is_some())
                .count(),
            2
        );
        let mut linked = stop.clone();
        linked.id = "explicit-link".into();
        linked.payload["source_run"] = json!(a.run_id);
        remote_event(&client, &linked).await;
        let linked_data = collect_with_policy(&client, &c, &p, &root, false, true).await;
        assert!(
            linked_data
                .report
                .items
                .iter()
                .all(|i| i.eligible_reason.is_none())
        );
        let node = client
            .read_node("db", &evidence_path(&linked))
            .await
            .unwrap()
            .unwrap();
        client
            .delete_node(DeleteNodeRequest {
                database_id: "db".into(),
                path: node.path,
                expected_etag: Some(node.etag),
                expected_folder_index_etag: None,
            })
            .await
            .unwrap();
        let out = Outbox::open(&root, &endpoint(&c), "db", "principal").unwrap();
        out.enqueue(&a).unwrap();
        let pending = collect_with_policy(&client, &c, &p, &root, false, true).await;
        assert!(
            pending
                .report
                .items
                .iter()
                .all(|i| i.eligible_reason.is_none())
        );
    }

    #[tokio::test]
    async fn archive_preview_applies_policy_and_preserves_terminal() {
        let (dir, client, c, p, root) = fixture();
        let mut e = test_event("ordinary-tool");
        e.payload.as_object_mut().unwrap().remove("test_fixture");
        e.payload["capture"]["event"] = json!("PostToolUse");
        e.run_id = format!("{PROJECT}:ordinary-run");
        let mut stop = e.clone();
        stop.id = "terminal".into();
        stop.payload["capture"]["event"] = json!("Stop");
        for event in [&e, &stop] {
            remote_event(&client, event).await;
        }
        let data = collect_with_policy(&client, &c, &p, &root, false, true).await;
        let (file, digest) = preview_file(dir.path(), &data);
        apply(
            &client,
            &c,
            &p,
            &root,
            &data,
            &file,
            &dir.path().join("backup"),
            &digest,
        )
        .await
        .unwrap();
        assert!(
            client
                .read_node("db", &evidence_path(&e))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            client
                .read_node("db", &evidence_path(&stop))
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(*client.delete_batches.lock().unwrap(), vec![1]);
    }

    #[tokio::test]
    async fn run_directory_references_protect_children_without_matching_siblings() {
        for suffix in ["", "/", "-other", "/other.json"] {
            let (_dir, client, c, p, root) = fixture();
            let mut e = test_event("directory-child");
            e.payload.as_object_mut().unwrap().remove("test_fixture");
            e.payload["capture"]["event"] = json!("PostToolUse");
            remote_event(&client, &e).await;
            let path = evidence_path(&e);
            let folder = path.rsplit_once('/').unwrap().0;
            write_immutable(
                &client,
                "db",
                "/Knowledge/case.md",
                &format!("[run]({folder}{suffix})"),
            )
            .await
            .unwrap();
            let data = collect_with_policy(&client, &c, &p, &root, false, true).await;
            let item = data
                .report
                .items
                .iter()
                .find(|i| i.event_id.as_deref() == Some("directory-child"))
                .unwrap();
            assert_eq!(
                item.eligible_reason.is_none(),
                suffix.is_empty() || suffix == "/",
                "{suffix}"
            );
        }
    }

    #[test]
    fn human_output_explains_incomplete_inventory() {
        let (_dir, _client, c, p, _root) = fixture();
        let mut data = empty_data(&c, &p);
        data.report.complete = false;
        data.report.issues = vec![
            "local_inspection_incomplete".into(),
            "remote_inspection_incomplete".into(),
        ];
        let text = human_summary(&summary(&data.report));
        assert!(text.contains("Complete: false"));
        assert!(text.contains("local_inspection_incomplete"));
        assert!(text.contains("remote_inspection_incomplete"));
    }

    #[tokio::test]
    async fn archive_policy_preserves_explicit_run_dependencies() {
        let (_dir, client, c, p, root) = fixture();
        let mut e = test_event("tool-evidence");
        e.payload.as_object_mut().unwrap().remove("test_fixture");
        e.payload["capture"]["event"] = json!("PostToolUse");
        remote_event(&client, &e).await;
        write_immutable(
            &client,
            "db",
            "/Sources/learning-candidates/protected.json",
            &json!({"source_run":e.run_id}).to_string(),
        )
        .await
        .unwrap();
        let data = collect_with_policy(&client, &c, &p, &root, false, true).await;
        assert!(
            data.report
                .items
                .iter()
                .all(|i| i.eligible_reason.is_none())
        );
    }

    #[tokio::test]
    async fn reviewed_targets_accept_unrelated_arrivals() {
        let (dir, client, c, p, root) = fixture();
        let e = test_event("reviewed");
        remote_event(&client, &e).await;
        let data = collect(&client, &c, &p, &root, false).await;
        let (file, digest) = preview_file(dir.path(), &data);
        write_immutable(&client, "db", "/Knowledge/unrelated.md", "unrelated work")
            .await
            .unwrap();
        let fresh = collect(&client, &c, &p, &root, false).await;
        let result = apply(
            &client,
            &c,
            &p,
            &root,
            &fresh,
            &file,
            &dir.path().join("backup"),
            &digest,
        )
        .await
        .unwrap();
        assert_eq!(result["applied"].as_array().unwrap().len(), 1);
        assert!(
            client
                .read_node("db", "/Knowledge/unrelated.md")
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn cleanup_allows_unrelated_enqueue_but_detects_new_reference_to_deleted_target() {
        for referenced in [false, true] {
            let (dir, client, c, p, root) = fixture();
            let target = test_event("target");
            remote_event(&client, &target).await;
            let data = collect(&client, &c, &p, &root, false).await;
            let (file, digest) = preview_file(dir.path(), &data);
            let state = root.clone();
            let destination = endpoint(&c);
            let run = target.run_id.clone();
            *client.after_delete.lock().unwrap() = Some(Box::new(move || {
                let out = Outbox::open(&state, &destination, "db", "principal").unwrap();
                let mut e = test_event("unrelated-new");
                if referenced {
                    e.payload["source_run"] = json!(run);
                }
                out.enqueue(&e).unwrap();
            }));
            let backup = dir.path().join("backup");
            let result = apply(&client, &c, &p, &root, &data, &file, &backup, &digest).await;
            assert_eq!(result.is_err(), referenced);
            assert_eq!(backup.join("complete.json").exists(), !referenced);
        }
    }

    #[tokio::test]
    async fn cleanup_uses_atomic_delete_batches() {
        let (dir, client, c, p, root) = fixture();
        for id in ["batch-a", "batch-b"] {
            remote_event(&client, &test_event(id)).await;
        }
        let data = collect(&client, &c, &p, &root, false).await;
        let (file, digest) = preview_file(dir.path(), &data);
        let result = apply(
            &client,
            &c,
            &p,
            &root,
            &data,
            &file,
            &dir.path().join("backup"),
            &digest,
        )
        .await
        .unwrap();
        assert_eq!(result["applied"].as_array().unwrap().len(), 2);
        assert_eq!(*client.delete_batches.lock().unwrap(), vec![2]);
    }

    #[tokio::test]
    async fn batch_conflict_rolls_back_and_response_loss_never_retries_deletes() {
        use std::sync::atomic::Ordering;
        for lost_response in [false, true] {
            let (dir, client, c, p, root) = fixture();
            for id in ["batch-a", "batch-b"] {
                remote_event(&client, &test_event(id)).await;
            }
            let data = collect(&client, &c, &p, &root, false).await;
            let (file, digest) = preview_file(dir.path(), &data);
            client
                .fail_after_delete_batch
                .store(lost_response, Ordering::SeqCst);
            client
                .reject_second_batch_item
                .store(!lost_response, Ordering::SeqCst);
            let backup = dir.path().join("backup");
            assert!(
                apply(&client, &c, &p, &root, &data, &file, &backup, &digest)
                    .await
                    .is_err()
            );
            assert!(!backup.join("complete.json").exists());
            for id in ["batch-a", "batch-b"] {
                assert_eq!(
                    client
                        .read_node("db", &evidence_path(&test_event(id)))
                        .await
                        .unwrap()
                        .is_none(),
                    lost_response
                );
            }
            let fresh = collect(&client, &c, &p, &root, false).await;
            assert!(
                apply(&client, &c, &p, &root, &fresh, &file, &backup, &digest)
                    .await
                    .is_err()
            );
            assert_eq!(*client.delete_batches.lock().unwrap(), vec![2]);
        }
    }

    #[tokio::test]
    async fn inbox_is_inspected_without_replay_and_protects_referenced_evidence() {
        let (_dir, client, c, p, root) = fixture();
        let e = test_event("inbox-referenced");
        remote_event(&client, &e).await;
        remote_event(&client, &test_event("unrelated")).await;
        let inbox = root.join("hook-inbox/old-partition");
        std::fs::create_dir_all(&inbox).unwrap();
        let file = inbox.join("pending.json");
        let raw = json!({"__kinic_run_id":"old-run","__kinic_evidence":{"capture":{"source":evidence_path(&e)}}}).to_string();
        std::fs::write(&file, &raw).unwrap();
        let data = collect(&client, &c, &p, &root, false).await;
        assert!(data.report.complete);
        assert!(
            data.report
                .items
                .iter()
                .find(|i| i.event_id.as_deref() == Some("inbox-referenced"))
                .unwrap()
                .eligible_reason
                .is_none()
        );
        assert!(
            data.report
                .items
                .iter()
                .find(|i| i.event_id.as_deref() == Some("unrelated"))
                .unwrap()
                .eligible_reason
                .is_some()
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), raw);
        assert!(!summary(&data.report).to_string().contains("old-run"));
        std::fs::write(&file, "invalid json").unwrap();
        let broken = collect(&client, &c, &p, &root, false).await;
        assert!(!broken.report.complete);
        assert!(
            broken
                .report
                .items
                .iter()
                .all(|i| i.eligible_reason.is_none())
        );
    }

    #[tokio::test]
    async fn review_other_partition_references_protect_remote_evidence() {
        let (_dir, client, c, p, root) = fixture();
        let e = test_event("target");
        remote_event(&client, &e).await;
        let other = Outbox::open(&root, &endpoint(&c), "db", "other-principal").unwrap();
        let mut reference = test_event("reference");
        reference.payload["source"] = json!(evidence_path(&e));
        other.enqueue(&reference).unwrap();
        let data = collect(&client, &c, &p, &root, false).await;
        assert!(data.report.complete);
        assert!(
            data.report
                .items
                .iter()
                .find(|i| i.key == format!("remote:{}", evidence_path(&e)))
                .unwrap()
                .eligible_reason
                .is_none()
        );
        assert!(
            data.report
                .items
                .iter()
                .filter(|i| i.key.starts_with("local:"))
                .all(|i| i.eligible_reason.is_none())
        );
    }

    #[tokio::test]
    async fn review_changed_state_root_rejects_preview() {
        let (dir, client, c, p, root) = fixture();
        remote_event(&client, &test_event("target")).await;
        let before = collect(&client, &c, &p, &root, false).await;
        let (file, digest) = preview_file(dir.path(), &before);
        let other = dir.path().join("other-state");
        let after = collect(&client, &c, &p, &other, false).await;
        assert!(
            apply(
                &client,
                &c,
                &p,
                &other,
                &after,
                &file,
                &dir.path().join("backup"),
                &digest
            )
            .await
            .is_err()
        );
        assert!(!dir.path().join("backup").exists());
    }

    #[tokio::test]
    async fn review_acknowledged_exact_mirror_allows_cleanup_but_references_do_not() {
        let (dir, client, c, p, root) = fixture();
        let e = test_event("target");
        let out = Outbox::open(&root, &endpoint(&c), "db", "principal").unwrap();
        out.enqueue(&e).unwrap();
        remote_event(&client, &e).await;
        let pending = collect(&client, &c, &p, &root, false).await;
        let key = format!("remote:{}", evidence_path(&e));
        assert!(
            pending
                .report
                .items
                .iter()
                .find(|i| i.key == key)
                .unwrap()
                .eligible_reason
                .is_none()
        );
        out.flush(&client, "db").await.unwrap();
        let data = collect(&client, &c, &p, &root, false).await;
        assert!(
            data.report
                .items
                .iter()
                .find(|i| i.key == key)
                .unwrap()
                .eligible_reason
                .is_some()
        );
        let mut reference = test_event("reference");
        reference.payload["source"] = json!(evidence_path(&e));
        out.enqueue(&reference).unwrap();
        let referenced = collect(&client, &c, &p, &root, false).await;
        assert!(
            referenced
                .report
                .items
                .iter()
                .find(|i| i.key == key)
                .unwrap()
                .eligible_reason
                .is_none()
        );
        // A separately acknowledged reference must still protect the target.
        out.flush(&client, "db").await.unwrap();
        let referenced = collect(&client, &c, &p, &root, false).await;
        assert!(
            referenced
                .report
                .items
                .iter()
                .find(|i| i.key == key)
                .unwrap()
                .eligible_reason
                .is_none()
        );
        let _ = dir;
    }

    #[tokio::test]
    async fn delivered_mirror_cleanup_keeps_acknowledged_local_reservation() {
        let (dir, client, c, p, root) = fixture();
        let e = test_event("delivered");
        let out = Outbox::open(&root, &endpoint(&c), "db", "principal").unwrap();
        out.enqueue(&e).unwrap();
        out.flush(&client, "db").await.unwrap();
        let data = collect(&client, &c, &p, &root, false).await;
        let (file, digest) = preview_file(dir.path(), &data);
        let result = apply(
            &client,
            &c,
            &p,
            &root,
            &data,
            &file,
            &dir.path().join("backup"),
            &digest,
        )
        .await
        .unwrap();
        assert_eq!(result["applied"].as_array().unwrap().len(), 1);
        assert!(
            client
                .read_node("db", &evidence_path(&e))
                .await
                .unwrap()
                .is_none()
        );
        out.enqueue(&e).unwrap();
        assert_eq!(out.pending_count().unwrap(), 0);
        let after = collect(&client, &c, &p, &root, false).await;
        assert!(
            after
                .report
                .items
                .iter()
                .any(|i| i.key == "local:delivered" && i.acknowledged && !i.excluded)
        );
    }

    #[tokio::test]
    async fn legacy_preview_without_state_binding_is_rejected_before_backup() {
        let (dir, client, c, p, root) = fixture();
        remote_event(&client, &test_event("legacy")).await;
        let mut data = collect(&client, &c, &p, &root, false).await;
        data.report.version = 1;
        data.report.state_root = None;
        let (file, digest) = preview_file(dir.path(), &data);
        let fresh = collect(&client, &c, &p, &root, false).await;
        assert!(
            apply(
                &client,
                &c,
                &p,
                &root,
                &fresh,
                &file,
                &dir.path().join("backup"),
                &digest
            )
            .await
            .is_err()
        );
        assert!(!dir.path().join("backup").exists());
    }

    #[test]
    fn state_root_binding_survives_directory_creation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("new/nested");
        let before = canonical_state_root(&root).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(before, canonical_state_root(&root).unwrap());
        assert_eq!(before, canonical_state_root(&root.join(".")).unwrap());
    }

    #[test]
    fn local_and_remote_mirrors_are_not_counted_as_redundant_remote_storage() {
        let (_dir, _client, c, p, _root) = fixture();
        let mut data = empty_data(&c, &p);
        let e = test_event("mirror");
        let body = serde_json::to_string(&e).unwrap();
        let node = Node {
            path: evidence_path(&e),
            kind: NodeKind::File,
            content: body.clone(),
            created_at: 0,
            updated_at: 0,
            etag: "etag".into(),
            metadata_json: "{}".into(),
        };
        data.report.items.push(item(
            "local:mirror".into(),
            &body,
            None,
            Some(&e),
            PROJECT,
            true,
            false,
        ));
        data.report.items.push(item(
            format!("remote:{}", node.path),
            &body,
            Some(&node),
            Some(&e),
            PROJECT,
            false,
            false,
        ));
        assert_eq!(summary(&data.report)["repeated_snapshot_bytes"], 0);
    }
}

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
fn local(data: &mut Data, root: &Path, scope: &str, project: &str) -> Result<()> {
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
            let mut stmt=conn.prepare("SELECT rowid,id,body,acknowledged FROM learning_outbox WHERE scope=?1 AND rowid>?2 ORDER BY rowid LIMIT 100")?;
            let rows = stmt
                .query_map(params![scope, cursor], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, bool>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if rows.is_empty() {
                break;
            }
            for (seq, id, body, ack) in rows {
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
                        params![scope, id],
                        |r| r.get::<_, bool>(0),
                    )?;
                let key = format!("local:{id}");
                data.report.items.push(item(
                    key.clone(),
                    &body,
                    None,
                    Some(&e),
                    project,
                    ack,
                    excluded,
                ));
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
                    anyhow::bail!(
                        "unprocessed or quarantined inbox evidence requires reconciliation"
                    );
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
fn protect(data: &mut Data) {
    let mut canonical = BTreeMap::new();
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
            if needles.iter().any(|s| body.contains(s)) {
                i.protected_by.push(key.clone());
            }
        }
        for (n, body) in data.jobs.iter().enumerate() {
            if needles.iter().any(|s| body.contains(s)) {
                i.protected_by.push(format!("job:{n}"));
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
            version: 1,
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
async fn collect(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    project: &ProjectConfig,
    root: &Path,
    local_only: bool,
) -> Data {
    let mut data = empty_data(c, project);
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
    json!({"inventory":report,"categories":groups,"repeated_snapshot_bytes":snapshots.values().map(|(n,b)|n.saturating_sub(1)*b).sum::<usize>(),"eligible_count":report.items.iter().filter(|i|i.eligible_reason.is_some()).count(),"excluded_records":report.items.iter().filter(|i|i.excluded).count(),"measurement":"UTF-8 content bytes; not physical allocation or cycles"})
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
    let r = &value["inventory"];
    println!(
        "Complete: {}\nEligible: {}\nExcluded: {}",
        r["complete"], value["eligible_count"], value["excluded_records"]
    );
    if let Some(groups) = value["categories"].as_object() {
        for (k, v) in groups {
            println!("{k}: {} records / {} content bytes", v[0], v[1]);
        }
    }
    for key in [
        "issues",
        "preview",
        "preview_sha256",
        "applied",
        "limitations",
    ] {
        if !value[key].is_null() {
            println!("{key}: {}", value[key]);
        }
    }
    println!("History, indexes and physical reclaim remain unknown unless separately measured.");
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
    let data = collect(client, c, &project, &root, local_only).await;
    match command {
        StorageCommand::Inventory { .. } => Ok(summary(&data.report)),
        StorageCommand::Preview { output } => {
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
            let preview=Preview{version:1,inventory:data.report.clone(),selected,current_body_bytes:bytes,limitations:vec!["No history purge or physical reclaim guarantee".into(),"Only exact duplicates or explicitly marked test fixtures; no age-based cleanup".into(),"Apply requires reviewed file digest, verified backup and quiescent project writers".into()]};
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
        p.version == 1 && p.inventory.version == 1,
        "unsupported preview"
    );
    ensure!(
        p.inventory.binding == data.report.binding && p.inventory.complete && data.report.complete,
        "binding changed or incomplete dependency inspection"
    );
    ensure!(
        p.inventory.jobs_hash == data.report.jobs_hash,
        "jobs changed since preview"
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
    // Exact inventory comparison refuses unrelated edits/additions that could add references.
    ensure!(
        p.inventory.items == data.report.items,
        "inventory changed; create and review a new preview"
    );
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
    let mut applied = vec![];
    for key in &selected {
        let fresh = collect(client, c, project, root, false).await;
        ensure!(
            fresh.report.complete && fresh.report.jobs_hash == expected.jobs_hash,
            "dependency inspection changed"
        );
        ensure!(
            fresh.report.items == expected.items,
            "references or records changed during cleanup"
        );
        ensure!(
            fresh
                .report
                .items
                .iter()
                .any(|i| &i.key == key && i.eligible_reason.is_some()),
            "cleanup target became protected"
        );
        if let Some(n) = data.nodes.get(key) {
            client
                .delete_node(DeleteNodeRequest {
                    database_id: data.report.binding.1.clone(),
                    path: n.path.clone(),
                    expected_etag: Some(n.etag.clone()),
                    expected_folder_index_etag: None,
                })
                .await?;
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
        // Rebuild expected references from the exact remaining data next iteration, while requiring
        // other content/metadata hashes unchanged. No automatic fresh-etag retry is performed.
        let after = collect(client, c, project, root, false).await;
        ensure!(
            after.report.complete && after.report.jobs_hash == expected.jobs_hash,
            "dependency inspection changed after cleanup; reconcile backup"
        );
        for pending in selected.iter().filter(|k| !applied.contains(k)) {
            ensure!(
                after
                    .report
                    .items
                    .iter()
                    .any(|i| &i.key == pending && i.eligible_reason.is_some()),
                "remaining cleanup target became protected"
            );
        }
        let remaining: Vec<_> = expected
            .items
            .iter()
            .filter(|i| &i.key != key)
            .map(|i| (&i.key, &i.sha256, &i.etag, &i.metadata_hash))
            .collect();
        let actual: Vec<_> = after
            .report
            .items
            .iter()
            .filter(|i| &i.key != key)
            .map(|i| (&i.key, &i.sha256, &i.etag, &i.metadata_hash))
            .collect();
        ensure!(
            remaining == actual,
            "concurrent modification after cleanup; reconcile backup"
        );
        expected = after.report;
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
            let a = test_event("race-a");
            let b = test_event("race-b");
            remote_event(&client, &a).await;
            remote_event(&client, &b).await;
            let data = collect(&client, &c, &p, &root, false).await;
            let (file, digest) = preview_file(dir.path(), &data);
            let backup = dir.path().join("backup");
            let target = data
                .report
                .items
                .iter()
                .filter(|i| i.eligible_reason.is_some())
                .nth(1)
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
            let live = client
                .read_node("db", &evidence_path(&a))
                .await
                .unwrap()
                .is_some() as usize
                + client
                    .read_node("db", &evidence_path(&b))
                    .await
                    .unwrap()
                    .is_some() as usize;
            assert_eq!(live, 1, "must stop after first deletion");
        }
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

//! Writer-produced summaries; readers never open a live SQLite connection.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
#[derive(Serialize, Deserialize)]
pub(crate) struct Snapshot {
    version: u8,
    scope: String,
    identity: (String, String, String),
    observed_at: String,
    source_stamp: Vec<Option<(u64, u128)>>,
    partitions: BTreeMap<String, Projection>,
    empty: Projection,
    delivery: Delivery,
}
#[derive(Serialize, Deserialize)]
struct Projection {
    record: Record,
    context: Option<Receipt>,
}
#[derive(Serialize, Deserialize)]
struct Record {
    pending_records: Option<u64>,
    acknowledged_records: Option<u64>,
    unattributed_records: u64,
    last_record: Option<LastRecord>,
}
#[derive(Serialize, Deserialize)]
struct LastRecord {
    id: Option<String>,
    run_id: Option<String>,
    kind: Option<String>,
    local_sequence: i64,
    acknowledged: bool,
}
#[derive(Serialize, Deserialize)]
struct Receipt {
    run_id: Option<String>,
    receipt_id: Option<String>,
    event_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Delivery {
    last_send_attempt_at: Option<String>,
    last_send_success_at: Option<String>,
    last_send_failure: Failure,
    delivery_timestamps_valid: bool,
    oldest_pending_at: Option<String>,
    pending_time_unknown: bool,
}
#[derive(Serialize, Deserialize)]
struct Failure {
    code: String,
    at: Option<String>,
}
fn key(owner: &RunOwner) -> String {
    match owner {
        RunOwner::Project(id) => hash(&format!("project:{id}")),
        RunOwner::Workspace(path) => hash(&format!("workspace:{}", path.display())),
    }
}
pub(crate) fn path(database: &Path, scope: &str) -> PathBuf {
    database.with_file_name(format!("delivery-summary-{scope}.json"))
}
fn stamp(database: &Path) -> Vec<Option<(u64, u128)>> {
    [database.to_path_buf(), sidecar(database, "-wal")]
        .iter()
        .map(|path| {
            let meta = std::fs::metadata(path).ok()?;
            Some((
                meta.len(),
                meta.modified()
                    .ok()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()?
                    .as_nanos(),
            ))
        })
        .collect()
}
pub(crate) fn build(
    conn: &Connection,
    database: &Path,
    scope: &str,
    identity: &(String, String, String),
) -> Result<Vec<u8>> {
    let (entries, incomplete) = events_from_connection(conn, scope).map_err(anyhow::Error::msg)?;
    let projection = |owner: &RunOwner| -> Result<Projection> {
        let (record, context) = records_from_entries(database, &entries, incomplete, owner);
        Ok(Projection {
            record: serde_json::from_value(record)?,
            context: if context["status"] == "observed" {
                Some(serde_json::from_value(context)?)
            } else {
                None
            },
        })
    };
    let owners: HashSet<_> = run_ownership(&entries)
        .into_values()
        .flat_map(|o| o.owners)
        .collect();
    let mut partitions = BTreeMap::new();
    for owner in owners {
        partitions.insert(key(&owner), projection(&owner)?);
    }
    let mut delivery = json!({"last_send_attempt_at":null,"last_send_success_at":null,"last_send_failure":{"code":"no_failure_recorded","at":null},"delivery_timestamps_valid":true,"oldest_pending_at":null,"pending_time_unknown":false});
    delivery_from_connection(conn, scope, &mut delivery);
    let snapshot = Snapshot {
        version: 1,
        scope: scope.into(),
        identity: identity.clone(),
        observed_at: chrono::Utc::now().to_rfc3339(),
        source_stamp: stamp(database),
        partitions,
        // A target absent from the complete attribution map has zero records;
        // incomplete or conflicting evidence preserves unknown counts.
        empty: projection(&RunOwner::Project(String::new()))?,
        delivery: serde_json::from_value(delivery)?,
    };
    let bytes = serde_json::to_vec(&snapshot)?;
    anyhow::ensure!(
        bytes.len() <= MAX_SNAPSHOT_BYTES,
        "delivery snapshot exceeds size bound"
    );
    Ok(bytes)
}
pub(super) fn read(
    database: &Path,
    scope: &str,
    project: Option<&ProjectConfig>,
    root: &Path,
) -> (Value, Value) {
    let source = path(database, scope);
    let inspect = || -> ReadResult<(Value, Value)> {
        let metadata = std::fs::symlink_metadata(&source).map_err(|_| "active_wal_unverified")?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_SNAPSHOT_BYTES as u64 {
            return Err("delivery_snapshot_invalid");
        }
        let mut bytes = Vec::new();
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options
            .open(&source)
            .map_err(|_| "delivery_snapshot_invalid")?;
        if !file
            .metadata()
            .map_err(|_| "delivery_snapshot_invalid")?
            .is_file()
        {
            return Err("delivery_snapshot_invalid");
        }
        file.take((MAX_SNAPSHOT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "delivery_snapshot_invalid")?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err("delivery_snapshot_invalid");
        }
        let snapshot: Snapshot =
            serde_json::from_slice(&bytes).map_err(|_| "delivery_snapshot_invalid")?;
        if snapshot.version != 1
            || snapshot.scope != scope
            || hash(
                &serde_json::to_string(&snapshot.identity)
                    .map_err(|_| "delivery_snapshot_invalid")?,
            ) != scope
        {
            return Err("delivery_snapshot_scope_mismatch");
        }
        let observed = chrono::DateTime::parse_from_rfc3339(&snapshot.observed_at)
            .map_err(|_| "delivery_snapshot_invalid")?;
        let age = chrono::Utc::now().signed_duration_since(observed);
        if age < chrono::Duration::seconds(-30) || age > chrono::Duration::seconds(300) {
            return Err("delivery_snapshot_stale");
        }
        if snapshot.source_stamp != stamp(database) {
            return Err("delivery_snapshot_superseded");
        }
        let target = project
            .map(|p| RunOwner::Project(p.project_id.clone()))
            .unwrap_or_else(|| RunOwner::Workspace(root.into()));
        let projection = snapshot
            .partitions
            .get(&key(&target))
            .unwrap_or(&snapshot.empty);
        let mut record =
            serde_json::to_value(&projection.record).map_err(|_| "delivery_snapshot_invalid")?;
        record["status"] = json!(if projection.record.pending_records.is_some() {
            "observed"
        } else {
            "partial"
        });
        record["code"] = json!("delivery_snapshot_read");
        record["source"] = json!(source);
        record["storage_modified_at"] = json!(modified(database));
        record["observed_at"] = json!(snapshot.observed_at);
        record["scope"] = json!("selected destination, principal and identified project runs");
        record["snapshot_scope"] = json!(scope);
        record["delivery_scope"] =
            json!("selected destination and principal; shared across projects");
        record["delivery_timestamps_valid"] = json!(snapshot.delivery.delivery_timestamps_valid);
        record["last_send_attempt_at"] = timestamp(snapshot.delivery.last_send_attempt_at);
        record["last_send_success_at"] = timestamp(snapshot.delivery.last_send_success_at);
        record["oldest_pending_at"] = timestamp(snapshot.delivery.oldest_pending_at);
        record["pending_time_unknown"] = json!(snapshot.delivery.pending_time_unknown);
        let failure = snapshot.delivery.last_send_failure;
        record["last_send_failure"] = if recognized_failure(&failure.code) {
            json!({"status":"observed","code":failure.code,"at":timestamp(failure.at)})
        } else if failure.code == "no_failure_recorded" {
            json!({"status":"not_observed","code":"no_failure_recorded","at":null})
        } else {
            unknown("unrecognized_failure_code", None)
        };
        if let Some(last) = record["last_record"].as_object_mut() {
            for field in ["id", "run_id", "kind"] {
                let sanitized = last
                    .get(field)
                    .and_then(Value::as_str)
                    .and_then(safe_id)
                    .map(str::to_owned);
                last.insert(field.into(), json!(sanitized));
            }
            last.insert("observed_at".into(), Value::Null);
        }
        let context = match &projection.context {
            Some(receipt) => {
                json!({"status":"observed","code":"receipt_assembled","source":source,"run_id":receipt.run_id.as_deref().and_then(safe_id),"receipt_id":receipt.receipt_id.as_deref().and_then(safe_id),"event_id":receipt.event_id.as_deref().and_then(safe_id),"observed_at":null,"delivery":"unverified","adoption":"unknown"})
            }
            None => unknown("receipt_not_observed", Some(&source)),
        };
        Ok((record, context))
    };
    inspect().unwrap_or_else(|code| (unknown(code, Some(&source)), unknown(code, Some(&source))))
}
pub(super) fn recognized_failure(code: &str) -> bool {
    matches!(
        code,
        "delivery_failed"
            | "inbox_replay_failed"
            | "spawn_failed"
            | "drain_spawn_failed"
            | "identity_unavailable"
            | "delivery_busy_timeout"
            | "cycles_suspended"
            | "canister_cycles_frozen"
    )
}

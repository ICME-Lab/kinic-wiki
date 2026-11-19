//! Controller entrypoints own authorization; these synchronous service operations own safety.
use super::*;
use vfs_store::{RebuildBudget, RebuildCursor};
use vfs_types::{
    EvidenceRebuildControlRequest, EvidenceRebuildRequest, EvidenceRebuildStatus,
    EvidenceRebuildStepRequest,
};
const SOURCE_SCHEMA: &str = "vfs_store:005_evidence_storage";
fn digest(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn state_hash(mut s: EvidenceRebuildStatus) -> Result<EvidenceRebuildStatus, String> {
    s.state_hash.clear();
    s.resume_writes_allowed = s.phase == "ActivatedReadOnly";
    s.state_hash = digest(&serde_json::to_string(&s).map_err(|e| e.to_string())?);
    Ok(s)
}
fn decode(s: &str) -> Result<EvidenceRebuildStatus, String> {
    let status: EvidenceRebuildStatus = serde_json::from_str(s).map_err(|e| e.to_string())?;
    if ![
        "Idle",
        "Gated",
        "Copying",
        "Verifying",
        "Ready",
        "ActivatedReadOnly",
        "Active",
        "Aborted",
    ]
    .contains(&status.phase.as_str())
        || state_hash(status.clone())?.state_hash != status.state_hash
    {
        return Err("invalid maintenance journal state".into());
    }
    Ok(status)
}
fn load(conn: &Connection, db: &str) -> Result<Option<EvidenceRebuildStatus>, String> {
    conn.query_row(
        "SELECT state_json FROM database_maintenance WHERE database_id=?1 AND is_current=1",
        params![db],
        |r| crate::sqlite::row_get::<String>(r, 0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|json| decode(&json))
    .transpose()
}
pub(crate) fn require_open(conn: &Connection, db: &str) -> Result<(), String> {
    if let Some(s) = load(conn, db)?
        && !["Active", "Aborted"].contains(&s.phase.as_str())
    {
        return Err(format!("database maintenance is holding writes: {db}"));
    }
    Ok(())
}
impl VfsService {
    pub(crate) fn require_maintenance_open(&self, db: &str) -> Result<(), String> {
        self.read_index(|c| require_open(c, db))
    }
    pub fn evidence_rebuild_status(&self, db: &str) -> Result<EvidenceRebuildStatus, String> {
        if let Some(state) = self.read_index(|c| load(c, db))? {
            return Ok(state);
        }
        let meta = self.database_meta(db)?;
        let store = self.database_store(&meta)?;
        let cursor = store.rebuild_start_cursor()?;
        state_hash(EvidenceRebuildStatus {
            database_id: db.into(),
            migration_id: String::new(),
            phase: "Idle".into(),
            step: 0,
            state_hash: String::new(),
            source_mount: meta.mount_id,
            target_mount: 0,
            source_schema: SOURCE_SCHEMA.into(),
            source_guard: cursor.source_fingerprint.clone(),
            cursor_json: serde_json::to_string(&cursor).map_err(|e| e.to_string())?,
            verification_digest: String::new(),
            verified: false,
            source_logical_bytes: store.logical_size_bytes()?,
            target_logical_bytes: 0,
            retained_old_logical_bytes: 0,
            resume_writes_allowed: false,
        })
    }
    fn maintenance_stores(&self, s: &EvidenceRebuildStatus) -> Result<(FsStore, FsStore), String> {
        let (source_file,target_file)=self.read_index(|c|c.query_row("SELECT source_file,target_file FROM database_maintenance WHERE database_id=?1 AND migration_id=?2 AND is_current=1",params![s.database_id,s.migration_id],|r|Ok((crate::sqlite::row_get::<String>(r,0)?,crate::sqlite::row_get::<String>(r,1)?))).map_err(|e|e.to_string()))?;
        let mut source = self.database_meta(&s.database_id)?;
        source.mount_id = s.source_mount;
        source.db_file_name = source_file;
        let mut target = source.clone();
        target.mount_id = s.target_mount;
        target.db_file_name = target_file;
        Ok((self.database_store(&source)?, self.database_store(&target)?))
    }
    fn maintenance_replay(
        &self,
        s: &EvidenceRebuildStatus,
        op: &str,
        hash: &str,
    ) -> Result<bool, String> {
        self.read_index(|c|c.query_row("SELECT COALESCE(last_operation,'')=?3 AND COALESCE(last_request_hash,'')=?4 FROM database_maintenance WHERE database_id=?1 AND migration_id=?2 AND is_current=1",params![s.database_id,s.migration_id,op,hash],|r|crate::sqlite::row_bool(r,0)).map_err(|e|e.to_string()))
    }
    fn persist_maintenance(
        &self,
        old: &EvidenceRebuildStatus,
        mut next: EvidenceRebuildStatus,
        op: &str,
        hash: &str,
    ) -> Result<EvidenceRebuildStatus, String> {
        next.step = old.step.checked_add(1).ok_or("maintenance step overflow")?;
        let next = state_hash(next)?;
        self.write_index(|c| persist(c, old, &next, op, hash))?;
        Ok(next)
    }
    pub fn evidence_rebuild_begin(
        &self,
        r: EvidenceRebuildRequest,
        now: i64,
    ) -> Result<EvidenceRebuildStatus, String> {
        if r.expected_schema != SOURCE_SCHEMA {
            return Err("unexpected source schema".into());
        }
        let existing = self.read_index(|c| load(c, &r.database_id))?;
        let mut state = if let Some(s) =
            existing.filter(|s| !["Active", "Aborted"].contains(&s.phase.as_str()))
        {
            if s.source_mount != r.expected_source_mount {
                return Err("source mount changed".into());
            }
            if s.phase != "Gated" {
                return Ok(s);
            }
            s
        } else {
            let meta = self.database_meta(&r.database_id)?;
            if meta.mount_id != r.expected_source_mount {
                return Err("source mount changed".into());
            }
            let store = self.database_store(&meta)?;
            let cursor = store.rebuild_start_cursor()?;
            let source_size = store.logical_size_bytes()?;
            self.write_index(|c|{
                let pending:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM publication_mutation_recovery_batches WHERE database_id=?1)",params![r.database_id],|r|crate::sqlite::row_bool(r,0)).map_err(|e|e.to_string())?;
                if pending{return Err("publication recovery must finish before maintenance".into());}
                let mount=databases::allocate_mount_id(c)?;
                databases::record_mount_history(c,&r.database_id,mount,"evidence_rebuild",now)?;
                #[cfg(not(target_arch="wasm32"))]
                let target_file=self.databases_dir.join(format!("{}.rebuild-{mount}.sqlite3",r.database_id)).to_string_lossy().into_owned();
                #[cfg(target_arch="wasm32")]
                let target_file=format!("stable-db-{mount}");
                let migration=digest(&format!("{}:{mount}:{}:{now}",r.database_id,cursor.source_fingerprint));
                let state=state_hash(EvidenceRebuildStatus{database_id:r.database_id.clone(),migration_id:migration.clone(),phase:"Gated".into(),step:0,state_hash:String::new(),source_mount:meta.mount_id,target_mount:mount,source_schema:SOURCE_SCHEMA.into(),source_guard:cursor.source_fingerprint.clone(),cursor_json:serde_json::to_string(&cursor).map_err(|e|e.to_string())?,verification_digest:String::new(),verified:false,source_logical_bytes:source_size,target_logical_bytes:0,retained_old_logical_bytes:source_size,resume_writes_allowed:false})?;
                c.execute("UPDATE database_maintenance SET is_current=0 WHERE database_id=?1",params![r.database_id]).map_err(|e|e.to_string())?;
                c.execute("INSERT INTO database_maintenance(migration_id,database_id,is_current,state_json,source_file,target_file) VALUES(?1,?2,1,?3,?4,?5)",params![migration,r.database_id,serde_json::to_string(&state).map_err(|e|e.to_string())?,meta.db_file_name,target_file]).map_err(|e|e.to_string())?;Ok(state)
            })?
        };
        let (source, target) = self.maintenance_stores(&state)?;
        if !target.rebuild_destination_prepared()? {
            target.run_fs_migrations()?;
        }
        let cursor = source.begin_rebuild_into(&target)?;
        if cursor.source_fingerprint != state.source_guard {
            return Err("gated source changed".into());
        }
        let old = state.clone();
        state.phase = "Copying".into();
        state.cursor_json = serde_json::to_string(&cursor).map_err(|e| e.to_string())?;
        let hash = digest(&serde_json::to_string(&r).map_err(|e| e.to_string())?);
        self.persist_maintenance(&old, state, "begin", &hash)
    }
    pub fn evidence_rebuild_step(
        &self,
        r: EvidenceRebuildStepRequest,
    ) -> Result<EvidenceRebuildStatus, String> {
        self.maintenance_page(r, false)
    }
    pub fn evidence_rebuild_verify(
        &self,
        r: EvidenceRebuildStepRequest,
    ) -> Result<EvidenceRebuildStatus, String> {
        self.maintenance_page(r, true)
    }
    fn maintenance_page(
        &self,
        r: EvidenceRebuildStepRequest,
        verify: bool,
    ) -> Result<EvidenceRebuildStatus, String> {
        let s = self.evidence_rebuild_status(&r.database_id)?;
        let op = if verify { "verify" } else { "copy" };
        if s.migration_id != r.migration_id {
            return Err("maintenance migration mismatch".into());
        }
        let hash = digest(&serde_json::to_string(&r).map_err(|e| e.to_string())?);
        if self.maintenance_replay(&s, op, &hash)? {
            return Ok(s);
        }
        if s.step != r.expected_step || s.phase != if verify { "Verifying" } else { "Copying" } {
            return Err("maintenance step or phase changed".into());
        }
        let (source, target) = self.maintenance_stores(&s)?;
        let cursor: RebuildCursor =
            serde_json::from_str(&s.cursor_json).map_err(|e| e.to_string())?;
        let budget = RebuildBudget {
            max_rows: r.max_rows,
            max_bytes: r.max_bytes,
        };
        let page = if verify {
            source.verify_rebuild_step(&target, &cursor, budget)?
        } else {
            source.copy_rebuild_step(&target, &cursor, budget)?
        };
        let mut next = s.clone();
        next.target_logical_bytes = target.logical_size_bytes()?;
        next.cursor_json = serde_json::to_string(&page.cursor).map_err(|e| e.to_string())?;
        if verify {
            next.verification_digest =
                digest(&format!("{}:{}", s.verification_digest, page.digest));
        }
        if page.done {
            if verify {
                next.phase = "Ready".into();
                next.verified = true;
            } else {
                next.phase = "Verifying".into();
                next.cursor_json = serde_json::to_string(&source.rebuild_start_cursor()?)
                    .map_err(|e| e.to_string())?;
            }
        }
        self.persist_maintenance(&s, next, op, &hash)
    }
    pub fn evidence_rebuild_activate(
        &self,
        r: EvidenceRebuildControlRequest,
    ) -> Result<EvidenceRebuildStatus, String> {
        self.maintenance_control(r, "activate")
    }
    pub fn evidence_rebuild_rollback(
        &self,
        r: EvidenceRebuildControlRequest,
    ) -> Result<EvidenceRebuildStatus, String> {
        self.maintenance_control(r, "rollback")
    }
    pub fn evidence_rebuild_resume_writes(
        &self,
        r: EvidenceRebuildControlRequest,
    ) -> Result<EvidenceRebuildStatus, String> {
        self.maintenance_control(r, "resume")
    }
    fn maintenance_control(
        &self,
        r: EvidenceRebuildControlRequest,
        op: &str,
    ) -> Result<EvidenceRebuildStatus, String> {
        let s = self.evidence_rebuild_status(&r.database_id)?;
        if s.migration_id != r.migration_id {
            return Err("maintenance migration mismatch".into());
        }
        let hash = digest(&serde_json::to_string(&r).map_err(|e| e.to_string())?);
        if self.maintenance_replay(&s, op, &hash)? {
            return Ok(s);
        }
        if s.state_hash != r.expected_state_hash {
            return Err("maintenance state changed".into());
        }
        let mut next = s.clone();
        let mut pointer = None;
        match op {
            "activate" => {
                if s.phase != "Ready" || !s.verified {
                    return Err("rebuild is not verified".into());
                }
                let (source, target) = self.maintenance_stores(&s)?;
                if source.rebuild_start_cursor()?.source_fingerprint != s.source_guard {
                    return Err("source changed after verification".into());
                }
                next.target_logical_bytes = target.logical_size_bytes()?;
                if next.target_logical_bytes == 0
                    || next.target_logical_bytes > s.source_logical_bytes / 2
                {
                    return Err(
                        "rebuild has not demonstrated at least 50% logical size reduction".into(),
                    );
                }
                next.phase = "ActivatedReadOnly".into();
                pointer = Some((s.source_mount, s.target_mount, false));
            }
            "rollback" => {
                if ["Active", "Aborted", "Idle"].contains(&s.phase.as_str()) {
                    return Err("rollback unavailable after writes resume".into());
                }
                if s.phase == "ActivatedReadOnly" {
                    pointer = Some((s.target_mount, s.source_mount, true));
                }
                next.phase = "Aborted".into();
            }
            "resume" => {
                if s.phase != "ActivatedReadOnly" || !s.verified {
                    return Err("write resumption requires verified read-only activation".into());
                }
                next.phase = "Active".into();
            }
            _ => return Err("unknown maintenance action".into()),
        }
        next.step = s.step.checked_add(1).ok_or("maintenance step overflow")?;
        let next = state_hash(next)?;
        self.write_index(|c|{
            if let Some((from,to,rollback))=pointer {
                let file_column=if rollback{"source_file"}else{"target_file"};
                let file:String=c.query_row(&format!("SELECT {file_column} FROM database_maintenance WHERE migration_id=?1"),params![s.migration_id],|r|crate::sqlite::row_get(r,0)).map_err(|e|e.to_string())?;
                let size=if rollback{s.source_logical_bytes}else{next.target_logical_bytes};
                c.execute("UPDATE databases SET mount_id=?2,active_mount_id=?2,db_file_name=?3,logical_size_bytes=?4 WHERE database_id=?1 AND mount_id=?5",params![s.database_id,to as i64,file,size as i64,from as i64]).map_err(|e|e.to_string())?;
                let changed=c.query_row("SELECT changes()",params![],|r|crate::sqlite::row_get::<i64>(r,0)).map_err(|e|e.to_string())?;
                if changed!=1{return Err("catalog mount changed during maintenance".into());}
            }
            persist(c,&s,&next,op,&hash)
        })?;
        Ok(next)
    }
}
fn persist(
    conn: &Connection,
    old: &EvidenceRebuildStatus,
    next: &EvidenceRebuildStatus,
    op: &str,
    hash: &str,
) -> Result<(), String> {
    let old_json = serde_json::to_string(old).map_err(|e| e.to_string())?;
    let next_json = serde_json::to_string(next).map_err(|e| e.to_string())?;
    conn.execute("UPDATE database_maintenance SET state_json=?3,last_operation=?4,last_request_hash=?5 WHERE migration_id=?1 AND is_current=1 AND state_json=?2",params![old.migration_id,old_json,next_json,op,hash]).map_err(|e|e.to_string())?;
    let changed = conn
        .query_row("SELECT changes()", params![], |r| {
            crate::sqlite::row_get::<i64>(r, 0)
        })
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("maintenance journal changed".into());
    }
    Ok(())
}

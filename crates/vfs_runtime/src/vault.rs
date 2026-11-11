//! Private Vault mounts and payer accounting. Never expose these tables to SQL clients.
use super::*;
use crate::billing::load_storage_cycle_account;

fn sql_error(e: crate::sqlite::Error) -> String {
    e.to_string()
}

impl VfsService {
    /// Allocate from the same historical namespace as ordinary database migrations.
    pub fn vault_mount_id(&self) -> Result<u16, String> {
        self.write_index(|tx| {
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT mount_id FROM internal_mounts WHERE name='vault'",
                    params![],
                    |r| crate::sqlite::row_get(r, 0),
                )
                .optional()
                .map_err(sql_error)?;
            if let Some(id) = existing {
                return mount_id_from_db(id).map_err(sql_error);
            }
            let id = allocate_mount_id(tx)?;
            tx.execute(
                "INSERT INTO internal_mounts(name,mount_id) VALUES('vault',?1)",
                params![i64::from(id)],
            )
            .map_err(sql_error)?;
            Ok(id)
        })
    }
    pub fn vault_payer(&self, owner: &str) -> Result<Option<String>, String> {
        require_account_deletion_principal_for_vault(owner)?;
        self.read_index(|db| {
            db.query_row(
                "SELECT database_id FROM vault_payers WHERE owner=?1",
                params![owner],
                |r| crate::sqlite::row_get(r, 0),
            )
            .optional()
            .map_err(sql_error)
        })
    }
    pub fn vault_set_payer(&self, owner: &str, database_id: &str, now: i64) -> Result<(), String> {
        require_account_deletion_principal_for_vault(owner)?;
        self.write_index(|tx|{
            eligible(tx,owner,database_id)?;
            let pending:i64=tx.query_row("SELECT count(*) FROM vault_cycle_reservations WHERE owner=?1 AND (settled_at_ms IS NULL OR in_flight=1)",params![owner],|r|crate::sqlite::row_get(r,0)).map_err(sql_error)?;
            if pending!=0{return Err("Vault has unsettled cycle reservations".into())}
            // Settle accrued storage against the old payer before moving the binding.
            settle_storage(tx,owner,now)?;
            tx.execute("INSERT INTO vault_payers(owner,database_id,storage_charged_at_ms) VALUES(?1,?2,?3) ON CONFLICT(owner) DO UPDATE SET database_id=excluded.database_id,storage_charged_at_ms=excluded.storage_charged_at_ms",params![owner,database_id,now]).map_err(sql_error)?;
            Ok(())
        })
    }
    pub fn vault_require_spending(&self, owner: &str, now: i64) -> Result<String, String> {
        self.write_index(|tx| {
            let payer = payer(tx, owner)?;
            eligible(tx, owner, &payer)?;
            settle_storage(tx, owner, now)?;
            let balance = load_storage_cycle_account(tx, &payer)?.balance_cycles;
            let min = load_cycles_billing_config(tx)?.min_update_cycles;
            if balance < i64::try_from(min).map_err(|_| "minimum cycle amount overflow")? {
                return Err("insufficient Vault payer balance".into());
            }
            Ok(payer)
        })
    }
    pub fn vault_track_storage(&self, owner: &str, bytes: u64, now: i64) -> Result<(), String> {
        self.write_index(|tx| {
            settle_storage(tx, owner, now)?;
            tx.execute(
                "UPDATE vault_payers SET storage_bytes=?2 WHERE owner=?1",
                params![
                    owner,
                    i64::try_from(bytes).map_err(|_| "Vault storage overflow")?
                ],
            )
            .map_err(sql_error)?;
            Ok(())
        })
    }
    /// Debit before external work. Tokens are private, owner scoped and retry stable.
    pub fn vault_reserve_cycles(
        &self,
        owner: &str,
        token: &str,
        amount: u64,
        now: i64,
    ) -> Result<(), String> {
        if token.len() > 128 || token.is_empty() {
            return Err("invalid reservation token".into());
        }
        let generation = self
            .vault_current_generation()
            .map_err(|_| "Vault generation unavailable")?;
        self.write_index(|tx|{
            if let Some((reserved,settled))=tx.query_row("SELECT reserved,settled_at_ms FROM vault_cycle_reservations WHERE owner=?1 AND token=?2",params![owner,token],|r|Ok((crate::sqlite::row_get::<i64>(r,0)?,crate::sqlite::row_get::<Option<i64>>(r,1)?))).optional().map_err(sql_error)? {
                return if reserved==amount as i64 && settled.is_none(){Ok(())}else{Err("reservation replay conflict".into())}
            }
            let database=payer(tx,owner)?; eligible(tx,owner,&database)?;settle_storage(tx,owner,now)?;
            tx.execute("DELETE FROM vault_cycle_reservations WHERE in_flight=0 AND execution_billed>=execution_checkpoint AND settled_at_ms IS NOT NULL AND settled_at_ms<=?1",params![now.saturating_sub(DAY_MS)]).map_err(sql_error)?;
            let count:i64=tx.query_row("SELECT count(*) FROM vault_cycle_reservations",params![],|r|crate::sqlite::row_get(r,0)).map_err(sql_error)?;
            if count>=10000{return Err("Vault reservation journal full".into())}
            let amount=i64::try_from(amount).map_err(|_|"cycle reservation overflow")?;
            let balance=load_storage_cycle_account(tx,&database)?.balance_cycles;
            if balance<amount{return Err("insufficient Vault payer balance".into())}
            adjust_balance(tx,&database,owner,-amount,now)?;
            tx.execute("INSERT INTO vault_cycle_reservations(owner,token,database_id,reserved,created_at_ms,generation) VALUES(?1,?2,?3,?4,?5,?6)",params![owner,token,database,amount,now,generation]).map_err(sql_error)?;
            Ok(())
        })
    }
    /// Settlement is permitted after ownership loss and is independent of today's budget.
    pub fn vault_settle_cycles(
        &self,
        owner: &str,
        token: &str,
        actual: u64,
        now: i64,
    ) -> Result<(), String> {
        self.write_index(|tx| settle_reservation(tx, owner, token, actual, now, true, false))
    }
    pub fn vault_reconcile_refunded_cycles(
        &self,
        owner: &str,
        token: &str,
        actual: u64,
        now: i64,
    ) -> Result<(), String> {
        self.write_index(|tx| settle_reservation(tx, owner, token, actual, now, true, true))
    }
    pub fn vault_cancel_reserved_cycles(
        &self,
        owner: &str,
        token: &str,
        actual: u64,
        orphan: bool,
        now: i64,
    ) -> Result<(), String> {
        self.write_index(|tx| {
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM vault_cycle_reservations WHERE owner=?1 AND token=?2",
                    params![owner, token],
                    |r| crate::sqlite::row_get(r, 0),
                )
                .optional()
                .map_err(sql_error)?;
            // Outstanding rows are never compacted. Absence leaves no debit to refund/replay.
            if exists.is_none() {
                return Ok(());
            }
            settle_reservation(tx, owner, token, actual, now, orphan, false)
        })
    }
    pub fn vault_charge_execution(&self, owner: &str, amount: u64, now: i64) -> Result<(), String> {
        self.write_index(|tx| {
            let database = payer(tx, owner)?;
            // Unreserved requests need current authority. Reserved completion uses its original payer.
            eligible(tx, owner, &database)?;
            let balance = load_storage_cycle_account(tx, &database)?.balance_cycles;
            adjust_balance(
                tx,
                &database,
                owner,
                -balance
                    .max(0)
                    .min(i64::try_from(amount).unwrap_or(i64::MAX)),
                now,
            )
        })
    }
    pub(crate) fn require_no_vault_payer_references(&self, id: &str) -> Result<(), String> {
        self.read_index(|db|{
            let n:i64=db.query_row("SELECT EXISTS(SELECT 1 FROM vault_payers WHERE database_id=?1) OR EXISTS(SELECT 1 FROM vault_cycle_reservations WHERE database_id=?1 AND (settled_at_ms IS NULL OR in_flight=1))",params![id],|r|crate::sqlite::row_get(r,0)).map_err(sql_error)?;
            if n!=0 {Err("database is a Vault payer; rebind the Vault payer first".into())}else{Ok(())}
        })
    }
}
fn require_account_deletion_principal_for_vault(owner: &str) -> Result<(), String> {
    if owner.is_empty() || owner == ANONYMOUS_PRINCIPAL {
        Err("anonymous Vault owner".into())
    } else {
        Ok(())
    }
}
fn payer(db: &Connection, owner: &str) -> Result<String, String> {
    require_account_deletion_principal_for_vault(owner)?;
    db.query_row(
        "SELECT database_id FROM vault_payers WHERE owner=?1",
        params![owner],
        |r| crate::sqlite::row_get(r, 0),
    )
    .optional()
    .map_err(sql_error)?
    .ok_or_else(|| "Vault payer required".into())
}
fn eligible(db: &Connection, owner: &str, database: &str) -> Result<(), String> {
    let valid:i64=db.query_row("SELECT EXISTS(SELECT 1 FROM databases d JOIN database_members m ON m.database_id=d.database_id WHERE d.database_id=?1 AND d.status='active' AND m.principal=?2 AND m.role='owner')",params![database,owner],|r|crate::sqlite::row_get(r,0)).map_err(sql_error)?;
    if valid == 1 {
        Ok(())
    } else {
        Err("Vault payer must be an active database owned by the caller".into())
    }
}
fn settle_storage(tx: &Transaction<'_>, owner: &str, now: i64) -> Result<(), String> {
    let row:Option<(String,i64,i64)>=tx.query_row("SELECT database_id,storage_bytes,storage_charged_at_ms FROM vault_payers WHERE owner=?1",params![owner],|r|Ok((crate::sqlite::row_get(r,0)?,crate::sqlite::row_get(r,1)?,crate::sqlite::row_get(r,2)?))).optional().map_err(sql_error)?;
    let Some((database, bytes, at)) = row else {
        return Ok(());
    };
    let elapsed = now.saturating_sub(at);
    if elapsed < 1000 {
        return Ok(());
    }
    let cost = billing::compute_storage_charge_cycles(bytes as u64, elapsed)?;
    let balance = load_storage_cycle_account(tx, &database)?.balance_cycles;
    let paid = balance.max(0).min(i64::try_from(cost).unwrap_or(i64::MAX));
    if paid > 0 {
        adjust_balance(tx, &database, owner, -paid, now)?;
    }
    tx.execute(
        "UPDATE vault_payers SET storage_charged_at_ms=?2 WHERE owner=?1",
        params![owner, now],
    )
    .map_err(sql_error)?;
    Ok(())
}
fn adjust_balance(
    tx: &Transaction<'_>,
    database: &str,
    owner: &str,
    delta: i64,
    now: i64,
) -> Result<(), String> {
    if delta == 0 {
        return Ok(());
    }
    let account = load_storage_cycle_account(tx, database)?;
    let balance = account
        .balance_cycles
        .checked_add(delta)
        .ok_or("payer balance overflow")?;
    let config = load_cycles_billing_config(tx)?;
    tx.execute("UPDATE database_cycle_accounts SET balance_cycles=?2,suspended_at_ms=CASE WHEN ?2>=?3 THEN NULL ELSE ?4 END,updated_at_ms=?4 WHERE database_id=?1",params![database,balance,config.min_update_cycles as i64,now]).map_err(sql_error)?;
    insert_database_ledger(
        tx,
        DatabaseLedgerInsert {
            database_id: database,
            kind: if delta < 0 { "charge" } else { "refund" },
            amount_cycles: delta,
            balance_after_cycles: balance,
            payment_amount_e8s: None,
            caller: owner,
            method: Some("vault"),
            cycles_delta: Some(delta.unsigned_abs() as u128),
            config: Some(&config),
            ledger_block_index: None,
            now,
        },
    )?;
    Ok(())
}

impl VfsService {
    /// Only the embedding service may access this mount; it is absent from database lookup.
    pub fn vault_transaction<T>(
        &self,
        context: vault_store::OwnerContext,
        f: impl FnOnce(&Connection) -> vault_types::Result<T>,
    ) -> vault_types::Result<T> {
        self.vault_raw_transaction(|db| {
            context.run(db, |db| {
                vault_store::config(db)?;
                f(db)
            })
        })
    }
    pub fn vault_config(&self) -> vault_types::Result<Option<vault_types::VaultConfig>> {
        self.vault_raw_transaction(|db| {
            let raw: Option<String> = db
                .query_row(
                    "SELECT value FROM global_settings WHERE key='config'",
                    params![],
                    |r| crate::sqlite::row_get(r, 0),
                )
                .optional()
                .map_err(|_| vault_types::Error::Storage)?;
            raw.map(|raw| serde_json::from_str(&raw).map_err(|_| vault_types::Error::Storage))
                .transpose()
        })
    }
    /// The canister authenticates controller authority before calling this configuration API.
    pub fn vault_set_config(
        &self,
        config: Option<vault_types::VaultConfig>,
    ) -> vault_types::Result<()> {
        if let Some(ref config) = config {
            validate_vault_config(config)?;
        }
        self.vault_raw_transaction(|db|{
            match config {
                Some(config)=>{let raw=serde_json::to_string(&config).map_err(|_|vault_types::Error::Storage)?;db.execute("INSERT INTO global_settings(key,value) VALUES('config',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![raw]).map_err(|_|vault_types::Error::Storage)?;}
                None=>{db.execute("DELETE FROM global_settings WHERE key='config'",params![]).map_err(|_|vault_types::Error::Storage)?;}
            }
            Ok(())
        })
    }
    fn vault_raw_transaction<T>(
        &self,
        f: impl FnOnce(&Connection) -> vault_types::Result<T>,
    ) -> vault_types::Result<T> {
        let mount = self
            .vault_mount_id()
            .map_err(|_| vault_types::Error::Storage)?;
        #[cfg(not(target_arch = "wasm32"))]
        {
            let path = self
                .databases_dir
                .join(format!("private-vault-{mount}.sqlite3"));
            create_dir_all(&self.databases_dir).map_err(|_| vault_types::Error::Storage)?;
            let mut db = Connection::open(path).map_err(|_| vault_types::Error::Storage)?;
            let tx = db.transaction().map_err(|_| vault_types::Error::Storage)?;
            initialize_vault_schema(&tx)?;
            tx.execute_batch("PRAGMA max_page_count=262144")
                .map_err(|_| vault_types::Error::Storage)?;
            let result = f(&tx)?;
            tx.commit().map_err(|_| vault_types::Error::Storage)?;
            Ok(result)
        }
        #[cfg(target_arch = "wasm32")]
        {
            let handle = (self.database_handle)(mount).map_err(|_| vault_types::Error::Storage)?;
            let mut app_error = None;
            handle
                .update(|db| {
                    let result = (|| {
                        initialize_vault_schema(db)?;
                        db.execute_batch("PRAGMA max_page_count=262144")
                            .map_err(|_| vault_types::Error::Storage)?;
                        f(db)
                    })();
                    result.map_err(|e| {
                        app_error = Some(e);
                        DbError::Sqlite(1, "Vault transaction aborted".into())
                    })
                })
                .map_err(|_| app_error.unwrap_or(vault_types::Error::Storage))
        }
    }
}
fn initialize_vault_schema(db: &Connection) -> vault_types::Result<()> {
    let initialized: Option<i64> = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='global_settings'",
            params![],
            |r| crate::sqlite::row_get(r, 0),
        )
        .optional()
        .map_err(|_| vault_types::Error::Storage)?;
    if initialized.is_none() {
        db.execute_batch(&[vault_store::SCHEMA,vault_store::CONTENT_SCHEMA,vault_store::RESTORE_SCHEMA,
            "CREATE INDEX uploads_expiry ON uploads(owner,expires); CREATE INDEX exports_expiry ON exports(owner,state,expires); CREATE INDEX restores_expiry ON restores(owner,expires); PRAGMA user_version=1;"].concat()).map_err(|_|vault_types::Error::Storage)?;
    }
    let version: i64 = db
        .query_row("PRAGMA user_version", params![], |r| {
            crate::sqlite::row_get(r, 0)
        })
        .map_err(|_| vault_types::Error::Storage)?;
    if version == 1 {
        db.execute_batch(vault_store::EXPIRY_SCHEMA)
            .map_err(|_| vault_types::Error::Storage)?;
        db.execute_batch("PRAGMA user_version=2")
            .map_err(|_| vault_types::Error::Storage)?;
    }
    if !matches!(version, 1 | 2) {
        return Err(vault_types::Error::Storage);
    }
    Ok(())
}
pub fn validate_vault_config(config: &vault_types::VaultConfig) -> vault_types::Result<()> {
    let origin = url::Url::parse(&config.origin).map_err(|_| vault_types::Error::InvalidInput)?;
    let host = origin.host_str().ok_or(vault_types::Error::InvalidInput)?;
    let local = host == "localhost";
    if config.origin != origin.origin().ascii_serialization()
        || (!local && origin.scheme() != "https")
        || (local && !matches!(origin.scheme(), "http" | "https"))
        || !(host == config.rp_id || host.ends_with(&format!(".{}", config.rp_id)))
        || config.rp_id.is_empty()
        || config.rp_id.len() > 253
        || config.rp_id.starts_with('.')
        || config.key_name.is_empty()
        || config.key_name.len() > 64
        || config.minimum_cycles < 100_000_000_000
    {
        return Err(vault_types::Error::InvalidInput);
    }
    Ok(())
}

impl VfsService {
    /// Bounded, durable round-robin sweep; storage fees continue while owners are offline.
    pub fn vault_settle_storage_timer_batch(&self, now: i64) -> Result<(), String> {
        self.vault_maintain_expired((now.max(0) as u64) / 1000)
            .map_err(|_| "Vault expiry maintenance failed")?;
        self.write_index(|tx|{
            let saved:Option<(String,i64)>=tx.query_row("SELECT cursor_owner,billing_now_ms FROM vault_storage_billing_state WHERE slot=1",params![],|r|Ok((crate::sqlite::row_get(r,0)?,crate::sqlite::row_get(r,1)?))).optional().map_err(sql_error)?;
            let (cursor,billing_now)=saved.unwrap_or_else(||(String::new(),now));
            let mut stmt=tx.prepare("SELECT owner FROM vault_payers WHERE owner>?1 ORDER BY owner LIMIT 1001").map_err(sql_error)?;
            let owners:Vec<String>=crate::sqlite::query_map(&mut stmt,params![cursor],|r|crate::sqlite::row_get(r,0)).map_err(sql_error)?;
            for owner in owners.iter().take(1000){settle_storage(tx,owner,billing_now)?;}
            if owners.len()>1000 {
                tx.execute("INSERT INTO vault_storage_billing_state(slot,cursor_owner,billing_now_ms) VALUES(1,?1,?2) ON CONFLICT(slot) DO UPDATE SET cursor_owner=excluded.cursor_owner,billing_now_ms=excluded.billing_now_ms",params![owners[999],billing_now]).map_err(sql_error)?;
            }else{tx.execute("DELETE FROM vault_storage_billing_state WHERE slot=1",params![]).map_err(sql_error)?;}
            Ok(())
        })
    }
    /// Completion accounting remains possible after a controller disables new Vault operations.
    pub fn vault_settle_key_flight(
        &self,
        context: vault_store::OwnerContext,
        token: u64,
        now: u64,
        actual: u64,
    ) -> vault_types::Result<()> {
        self.vault_raw_transaction(|db| {
            context.run(db, |db| vault_store::keys::settle(db, token, now, actual))
        })
    }
}

impl VfsService {
    pub fn vault_cancel_pending_key_flight(
        &self,
        context: vault_store::OwnerContext,
        now: u64,
    ) -> vault_types::Result<Option<(u64, u64, bool)>> {
        self.vault_raw_transaction(|db| {
            context.run(db, |db| {
                let result = vault_store::keys::cancel_pending(db, now)?;
                if let Some((token, _, _)) = result {
                    if let Some(mut control) =
                        vault_store::load::<serde_json::Value>(db, "control")?
                    {
                        if control
                            .get("derive")
                            .and_then(|f| f.get("token"))
                            .and_then(|t| t.as_u64())
                            == Some(token)
                        {
                            control["derive"] = serde_json::Value::Null;
                            vault_store::save(db, "control", &control)?;
                        }
                    }
                }
                Ok(result)
            })
        })
    }
}

fn settle_reservation(
    tx: &Transaction<'_>,
    owner: &str,
    token: &str,
    actual: u64,
    now: i64,
    complete: bool,
    allow_down: bool,
) -> Result<(), String> {
    let (database,reserved,old):(String,i64,Option<i64>)=tx.query_row("SELECT database_id,reserved,actual FROM vault_cycle_reservations WHERE owner=?1 AND token=?2",params![owner,token],|r|Ok((crate::sqlite::row_get(r,0)?,crate::sqlite::row_get(r,1)?,crate::sqlite::row_get(r,2)?))).map_err(sql_error)?;
    let actual = i64::try_from(actual).map_err(|_| "cycle settlement overflow")?;
    if actual > reserved {
        return Err("settlement exceeds reservation".into());
    }
    let refund = match old {
        Some(old) if old == actual => 0,
        Some(old) if allow_down && old >= actual => old - actual,
        Some(_) => return Err("settlement replay conflict".into()),
        None => reserved - actual,
    };
    adjust_balance(tx, &database, owner, refund, now)?;
    tx.execute("UPDATE vault_cycle_reservations SET actual=?3,settled_at_ms=?4,in_flight=CASE WHEN ?5=1 THEN 0 ELSE in_flight END WHERE owner=?1 AND token=?2",params![owner,token,actual,now,if complete{1i64}else{0i64}]).map_err(sql_error)?;
    Ok(())
}
impl VfsService {
    /// Called only during canister init/upgrade; request handlers never advance generations.
    pub fn vault_start_generation(&self) -> vault_types::Result<()> {
        self.vault_raw_transaction(|db|{
            db.execute("INSERT INTO global_settings(key,value) VALUES('generation','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)",params![]).map_err(|_|vault_types::Error::Storage)?;
            Ok(())
        })
    }
}

impl VfsService {
    pub fn vault_checkpoint_execution(
        &self,
        owner: &str,
        token: &str,
        cycles: u64,
    ) -> Result<(), String> {
        let cycles = i64::try_from(cycles).map_err(|_| "execution checkpoint overflow")?;
        self.write_index(|tx|{
            tx.execute("UPDATE vault_cycle_reservations SET execution_checkpoint=max(execution_checkpoint,?3) WHERE owner=?1 AND token=?2",params![owner,token,cycles]).map_err(sql_error)?;
            Ok(())
        })
    }
    pub fn vault_finish_execution(
        &self,
        owner: &str,
        token: &str,
        cycles: u64,
        now: i64,
    ) -> Result<(), String> {
        self.write_index(|tx| finish_reserved_execution(tx, owner, token, cycles, now))
    }
    pub fn vault_recover_orphan_execution(
        &self,
        owner: &str,
        now: i64,
    ) -> Result<Vec<u64>, String> {
        let generation = self
            .vault_current_generation()
            .map_err(|_| "Vault generation unavailable")?;
        self.write_index(|tx|{
            let mut stmt=tx.prepare("SELECT token,execution_checkpoint,in_flight FROM vault_cycle_reservations WHERE owner=?1 AND generation<?2 AND (execution_checkpoint>execution_billed OR (token LIKE 'challenge:%' AND in_flight=1)) ORDER BY created_at_ms,token LIMIT 1000").map_err(sql_error)?;
            let rows:Vec<(String,i64,i64)>=crate::sqlite::query_map(&mut stmt,params![owner,generation],|r|Ok((crate::sqlite::row_get(r,0)?,crate::sqlite::row_get(r,1)?,crate::sqlite::row_get(r,2)?))).map_err(sql_error)?;
            let mut challenges=vec![];
            for (token,checkpoint,flight) in rows {
                if let Some(id)=token.strip_prefix("challenge:").and_then(|n|n.parse::<u64>().ok()) {
                    if flight==1{settle_reservation(tx,owner,&token,0,now,true,false)?;}
                    challenges.push(id);
                }
                finish_reserved_execution(tx,owner,&token,checkpoint as u64,now)?;
            }
            Ok(challenges)
        })
    }
    fn vault_current_generation(&self) -> vault_types::Result<i64> {
        self.vault_raw_transaction(|db|db.query_row("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='generation'),0)",params![],|r|crate::sqlite::row_get(r,0)).map_err(|_|vault_types::Error::Storage))
    }
    pub fn vault_clear_orphan_challenges(
        &self,
        context: vault_store::OwnerContext,
        tokens: &[u64],
    ) -> vault_types::Result<()> {
        self.vault_raw_transaction(|db| {
            context.run(db, |db| {
                if let Some(mut control) = vault_store::load::<serde_json::Value>(db, "control")? {
                    if control
                        .get("random")
                        .and_then(|f| f.get("token"))
                        .and_then(|t| t.as_u64())
                        .is_some_and(|t| tokens.contains(&t))
                    {
                        control["random"] = serde_json::Value::Null;
                        vault_store::save(db, "control", &control)?;
                    }
                }
                Ok(())
            })
        })
    }
}
fn finish_reserved_execution(
    tx: &Transaction<'_>,
    owner: &str,
    token: &str,
    cycles: u64,
    now: i64,
) -> Result<(), String> {
    let (database,checkpoint,billed):(String,i64,i64)=tx.query_row("SELECT database_id,execution_checkpoint,execution_billed FROM vault_cycle_reservations WHERE owner=?1 AND token=?2",params![owner,token],|r|Ok((crate::sqlite::row_get(r,0)?,crate::sqlite::row_get(r,1)?,crate::sqlite::row_get(r,2)?))).map_err(sql_error)?;
    let total = i64::try_from(cycles)
        .map_err(|_| "execution total overflow")?
        .max(checkpoint);
    let due = total.saturating_sub(billed).max(0);
    if due > 0 {
        let balance = load_storage_cycle_account(tx, &database)?
            .balance_cycles
            .max(0);
        adjust_balance(tx, &database, owner, -balance.min(due), now)?;
        tx.execute("UPDATE vault_cycle_reservations SET execution_billed=?3,execution_checkpoint=max(execution_checkpoint,?3) WHERE owner=?1 AND token=?2",params![owner,token,total]).map_err(sql_error)?;
    }
    Ok(())
}

impl VfsService {
    /// Run owner recovery without relying on a funded payer or enabled Vault configuration.
    pub fn vault_recover_pending_work(
        &self,
        context: vault_store::OwnerContext,
        now: u64,
    ) -> Result<(), String> {
        let owner = context.owner().to_text();
        let millis =
            i64::try_from(now.saturating_mul(1000)).map_err(|_| "recovery timestamp overflow")?;
        let key_result = (|| {
            let flight = self
                .vault_cancel_pending_key_flight(context, now)
                .map_err(|_| "Vault key recovery failed")?;
            if let Some((token, actual, orphan)) = flight {
                self.vault_cancel_reserved_cycles(
                    &owner,
                    &format!("derive:{token}"),
                    actual,
                    orphan,
                    millis,
                )?;
                self.vault_raw_transaction(|db| {
                    context.run(db, |db| vault_store::keys::acknowledge_cancel(db, token))
                })
                .map_err(|_| "Vault cancellation acknowledgement failed")?;
            }
            Ok(())
        })();
        // Challenge recovery is independent of key-journal reconciliation/compaction.
        let challenges = self.vault_recover_orphan_execution(&owner, millis)?;
        self.vault_clear_orphan_challenges(context, &challenges)
            .map_err(|_| "Vault challenge recovery failed")?;
        key_result
    }
}

impl VfsService {
    pub fn vault_transaction_at<T>(
        &self,
        context: vault_store::OwnerContext,
        now: u64,
        f: impl FnOnce(&Connection) -> vault_types::Result<T>,
    ) -> vault_types::Result<T> {
        self.vault_maintain_expired(now)?;
        self.vault_transaction(context, f)
    }
    pub fn vault_maintain_expired(&self, now: u64) -> vault_types::Result<()> {
        let reclaimed =
            self.vault_raw_transaction(|db| vault_store::content::maintain_expired(db, now))?;
        if let Some((owner, usage)) = reclaimed {
            let millis =
                i64::try_from(now.saturating_mul(1000)).map_err(|_| vault_types::Error::Storage)?;
            self.vault_track_storage(&owner.to_text(), usage, millis)
                .map_err(|_| vault_types::Error::Storage)?;
        }
        Ok(())
    }
}

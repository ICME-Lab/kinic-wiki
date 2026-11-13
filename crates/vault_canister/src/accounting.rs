//! Private prepaid accounts and the reviewed bounded reservation/checkpoint journal.
use crate::state::{State, transaction};
use kinic_sqlite_compat::{self as sqlite, Connection, OptionalExtension, params};
use vault_types::Error;
const DAY_MS: i64 = 86_400_000;
const ANONYMOUS_PRINCIPAL: &str = "2vxsx-fae";

fn sql_error(e: sqlite::Error) -> String {
    e.to_string()
}

impl State {
    pub fn vault_require_spending(&self, owner: &str, now: i64) -> Result<String, String> {
        self.write_index(|tx| {
            let account = account(tx, owner)?;
            eligible(tx, owner, &account)?;
            settle_storage(tx, owner, now)?;
            let balance = load_storage_cycle_account(tx, &account)?.balance_cycles;
            let min = 20_000_000u64;
            if balance < i64::try_from(min).map_err(|_| "minimum cycle amount overflow")? {
                return Err("insufficient Vault account balance".into());
            }
            Ok(account)
        })
    }
    #[cfg(test)]
    pub fn vault_track_storage(&self, owner: &str, bytes: u64, now: i64) -> Result<(), String> {
        self.write_index(|tx| {
            settle_storage(tx, owner, now)?;
            tx.execute(
                "UPDATE accounts SET storage_bytes=?2 WHERE owner=?1",
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
            if let Some((reserved,settled))=tx.query_row("SELECT reserved,settled_at_ms FROM vault_cycle_reservations WHERE owner=?1 AND token=?2",params![owner,token],|r|Ok((sqlite::row_get::<i64>(r,0)?,sqlite::row_get::<Option<i64>>(r,1)?))).optional().map_err(sql_error)? {
                return if reserved==amount as i64 && settled.is_none(){Ok(())}else{Err("reservation replay conflict".into())}
            }
            let account_owner=account(tx,owner)?; eligible(tx,owner,&account_owner)?;settle_storage(tx,owner,now)?;
            tx.execute("DELETE FROM vault_cycle_reservations WHERE in_flight=0 AND execution_billed>=execution_checkpoint AND settled_at_ms IS NOT NULL AND settled_at_ms<=?1",params![now.saturating_sub(DAY_MS)]).map_err(sql_error)?;
            let count:i64=tx.query_row("SELECT count(*) FROM vault_cycle_reservations",params![],|r|sqlite::row_get(r,0)).map_err(sql_error)?;
            if count>=10000{return Err("Vault reservation journal full".into())}
            let amount=i64::try_from(amount).map_err(|_|"cycle reservation overflow")?;
            let balance=load_storage_cycle_account(tx,&account_owner)?.balance_cycles;
            if balance<amount{return Err("insufficient Vault account balance".into())}
            adjust_balance(tx,&account_owner,owner,-amount,now)?;
            tx.execute("INSERT INTO vault_cycle_reservations(owner,token,account_owner,reserved,created_at_ms,generation) VALUES(?1,?2,?3,?4,?5,?6)",params![owner,token,account_owner,amount,now,generation]).map_err(sql_error)?;
            Ok(())
        })
    }
    /// Settlement is permitted after disabling new work and is independent of today's budget.
    #[cfg(test)]
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
    pub fn vault_charge_execution(&self, owner: &str, amount: u64, now: i64) -> Result<(), String> {
        self.write_index(|tx| {
            let account_owner = account(tx, owner)?;
            // Unreserved requests use the authenticated prepaid account.
            eligible(tx, owner, &account_owner)?;
            let balance = load_storage_cycle_account(tx, &account_owner)?.balance_cycles;
            adjust_balance(
                tx,
                &account_owner,
                owner,
                -balance
                    .max(0)
                    .min(i64::try_from(amount).unwrap_or(i64::MAX)),
                now,
            )
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
fn account(db: &Connection, owner: &str) -> Result<String, String> {
    require_account_deletion_principal_for_vault(owner)?;
    let exists: i64 = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE owner=?1)",
            params![owner],
            |r| sqlite::row_get(r, 0),
        )
        .map_err(sql_error)?;
    if exists == 1 {
        Ok(owner.into())
    } else {
        Err("prepaid account required".into())
    }
}
fn eligible(_: &Connection, owner: &str, account: &str) -> Result<(), String> {
    if owner == account {
        require_account_deletion_principal_for_vault(owner)
    } else {
        Err("account owner mismatch".into())
    }
}
fn settle_storage(tx: &Connection, owner: &str, now: i64) -> Result<(), String> {
    let row: Option<(String, i64, i64)> = tx
        .query_row(
            "SELECT owner,storage_bytes,storage_charged_at_ms FROM accounts WHERE owner=?1",
            params![owner],
            |r| {
                Ok((
                    sqlite::row_get(r, 0)?,
                    sqlite::row_get(r, 1)?,
                    sqlite::row_get(r, 2)?,
                ))
            },
        )
        .optional()
        .map_err(sql_error)?;
    let Some((account_owner, bytes, at)) = row else {
        return Ok(());
    };
    let elapsed = now.saturating_sub(at);
    if elapsed < 1000 {
        return Ok(());
    }
    let cost = storage_cost(bytes as u64, elapsed)?;
    let balance = load_storage_cycle_account(tx, &account_owner)?.balance_cycles;
    let paid = balance.max(0).min(i64::try_from(cost).unwrap_or(i64::MAX));
    if paid > 0 {
        adjust_balance(tx, &account_owner, owner, -paid, now)?;
    }
    tx.execute(
        "UPDATE accounts SET storage_charged_at_ms=?2 WHERE owner=?1",
        params![owner, now],
    )
    .map_err(sql_error)?;
    Ok(())
}
fn adjust_balance(
    tx: &Connection,
    account_owner: &str,
    owner: &str,
    delta: i64,
    now: i64,
) -> Result<(), String> {
    if delta == 0 {
        return Ok(());
    }
    let account = load_storage_cycle_account(tx, account_owner)?;
    let balance = account
        .balance_cycles
        .checked_add(delta)
        .ok_or("account balance overflow")?;
    tx.execute(
        "UPDATE accounts SET balance_cycles=?2 WHERE owner=?1",
        params![account_owner, balance],
    )
    .map_err(sql_error)?;
    record_entry(
        tx,
        owner,
        if delta < 0 { "charge" } else { "refund" },
        delta,
        balance,
        now,
        None,
    )
    .map_err(|_| "account ledger failure")?;

    Ok(())
}

impl State {
    pub fn vault_config(&self) -> vault_types::Result<Option<vault_types::VaultConfig>> {
        self.vault_raw_transaction(|db| {
            let raw: Option<String> = db
                .query_row(
                    "SELECT value FROM global_settings WHERE key='config'",
                    params![],
                    |r| sqlite::row_get(r, 0),
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
    pub(crate) fn vault_raw_transaction<T>(
        &self,
        f: impl FnOnce(&Connection) -> vault_types::Result<T>,
    ) -> vault_types::Result<T> {
        transaction(f)
    }
}
pub fn validate_vault_config(config: &vault_types::VaultConfig) -> vault_types::Result<()> {
    if config.key_name.is_empty()
        || config.key_name.len() > 64
        || config.minimum_cycles < 100_000_000_000
    {
        return Err(Error::InvalidInput);
    }
    Ok(())
}

impl State {
    /// Bounded, durable round-robin sweep; storage fees continue while owners are offline.
    pub fn vault_settle_storage_timer_batch(&self, now: i64) -> Result<(), String> {
        self.vault_maintain_expired((now.max(0) as u64) / 1000)
            .map_err(|_| "Vault expiry maintenance failed")?;
        self.write_index(|tx|{
            let saved:Option<(String,i64)>=tx.query_row("SELECT cursor_owner,billing_now_ms FROM vault_storage_billing_state WHERE slot=1",params![],|r|Ok((sqlite::row_get(r,0)?,sqlite::row_get(r,1)?))).optional().map_err(sql_error)?;
            let (cursor,billing_now)=saved.unwrap_or_else(||(String::new(),now));
            let mut stmt=tx.prepare("SELECT owner FROM accounts WHERE owner>?1 ORDER BY owner LIMIT 1001").map_err(sql_error)?;
            let owners:Vec<String>=sqlite::query_map(&mut stmt,params![cursor],|r|sqlite::row_get(r,0)).map_err(sql_error)?;
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
    ) -> vault_types::Result<bool> {
        self.vault_raw_transaction(|db| {
            context.run(db, |db| {
                let current =
                    vault_service::runtime::settle_key_reservation_in(db, token, now, actual)?;
                let owner = context.owner().to_text();
                let journal = format!("derive:{token}");
                let exists: i64 = db
                    .query_row(
                        "SELECT count(*) FROM vault_cycle_reservations WHERE owner=?1 AND token=?2",
                        params![owner, journal],
                        |r| sqlite::row_get(r, 0),
                    )
                    .map_err(|_| Error::Storage)?;
                if exists != 0 {
                    settle_reservation(
                        db,
                        &owner,
                        &journal,
                        actual,
                        (now * 1000) as i64,
                        true,
                        true,
                    )
                    .map_err(|_| Error::Storage)?;
                }
                Ok(current)
            })
        })
    }
}

fn settle_reservation(
    tx: &Connection,
    owner: &str,
    token: &str,
    actual: u64,
    now: i64,
    complete: bool,
    allow_down: bool,
) -> Result<(), String> {
    let (account_owner,reserved,old):(String,i64,Option<i64>)=tx.query_row("SELECT account_owner,reserved,actual FROM vault_cycle_reservations WHERE owner=?1 AND token=?2",params![owner,token],|r|Ok((sqlite::row_get(r,0)?,sqlite::row_get(r,1)?,sqlite::row_get(r,2)?))).map_err(sql_error)?;
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
    adjust_balance(tx, &account_owner, owner, refund, now)?;
    tx.execute("UPDATE vault_cycle_reservations SET actual=?3,settled_at_ms=?4,in_flight=CASE WHEN ?5=1 THEN 0 ELSE in_flight END WHERE owner=?1 AND token=?2",params![owner,token,actual,now,if complete{1i64}else{0i64}]).map_err(sql_error)?;
    Ok(())
}
impl State {
    /// Called only during canister init/upgrade; request handlers never advance generations.
    pub fn vault_start_generation(&self) -> vault_types::Result<()> {
        self.vault_raw_transaction(|db| {
            let current:i64=db.query_row("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='generation'),0)",params![],|r|sqlite::row_get(r,0)).map_err(|_|Error::Storage)?;
            let next=current.checked_add(1).ok_or(Error::QuotaExceeded)?;
            db.execute("INSERT INTO global_settings(key,value) VALUES('generation',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![next.to_string()]).map_err(|_|Error::Storage)?;
            Ok(())
        })
    }
}

impl State {
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
    fn vault_current_generation(&self) -> vault_types::Result<i64> {
        self.vault_raw_transaction(|db|db.query_row("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='generation'),0)",params![],|r|sqlite::row_get(r,0)).map_err(|_|vault_types::Error::Storage))
    }
}
fn finish_reserved_execution(
    tx: &Connection,
    owner: &str,
    token: &str,
    cycles: u64,
    now: i64,
) -> Result<(), String> {
    let (account_owner,checkpoint,billed):(String,i64,i64)=tx.query_row("SELECT account_owner,execution_checkpoint,execution_billed FROM vault_cycle_reservations WHERE owner=?1 AND token=?2",params![owner,token],|r|Ok((sqlite::row_get(r,0)?,sqlite::row_get(r,1)?,sqlite::row_get(r,2)?))).map_err(sql_error)?;
    let total = i64::try_from(cycles)
        .map_err(|_| "execution total overflow")?
        .max(checkpoint);
    let due = total.saturating_sub(billed).max(0);
    if due > 0 {
        let balance = load_storage_cycle_account(tx, &account_owner)?
            .balance_cycles
            .max(0);
        adjust_balance(tx, &account_owner, owner, -balance.min(due), now)?;
        tx.execute("UPDATE vault_cycle_reservations SET execution_billed=?3,execution_checkpoint=max(execution_checkpoint,?3) WHERE owner=?1 AND token=?2",params![owner,token,total]).map_err(sql_error)?;
    }
    Ok(())
}

impl State {
    pub fn vault_maintain_expired(&self, now: u64) -> vault_types::Result<()> {
        transaction(|db| maintain_expired_in(db, now))
    }
}

fn load_storage_cycle_account(db: &Connection, owner: &str) -> Result<Account, String> {
    let balance_cycles = db
        .query_row(
            "SELECT balance_cycles FROM accounts WHERE owner=?1",
            params![owner],
            |r| sqlite::row_get(r, 0),
        )
        .optional()
        .map_err(sql_error)?
        .unwrap_or(0);
    Ok(Account { balance_cycles })
}
struct Account {
    balance_cycles: i64,
}
fn storage_cost(bytes: u64, elapsed: i64) -> Result<u128, String> {
    Ok(
        u128::from(bytes) * u128::try_from(elapsed.max(0) / 1000).map_err(|_| "time")? * 127_000
            / 1_073_741_824,
    )
}
impl State {
    fn write_index<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut error = None;
        transaction(|db| {
            f(db).map_err(|e| {
                error = Some(e);
                Error::Storage
            })
        })
        .map_err(|_| error.unwrap_or_else(|| "private account_owner failure".into()))
    }
    pub fn balance(&self, owner: &str) -> vault_types::Result<u64> {
        transaction(|db| {
            Ok(load_storage_cycle_account(db, owner)
                .map_err(|_| Error::Storage)?
                .balance_cycles
                .max(0) as u64)
        })
    }
}
pub(crate) fn track_storage_in(
    db: &Connection,
    owner: &str,
    bytes: u64,
    now: i64,
) -> vault_types::Result<()> {
    settle_storage(db, owner, now).map_err(|_| Error::Storage)?;
    db.execute(
        "UPDATE accounts SET storage_bytes=?2 WHERE owner=?1",
        params![owner, i64::try_from(bytes).map_err(|_| Error::Storage)?],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}
pub(crate) fn maintain_expired_in(db: &Connection, now: u64) -> vault_types::Result<()> {
    if let Some((owner, _)) = vault_store::content::maintain_expired(db, now)? {
        let usage = vault_store::OwnerContext::authenticated(owner)?.run(db, |db| {
            recover_pending_in(db, owner, None, now)?;
            vault_store::content::usage(db)
        })?;
        track_storage_in(
            db,
            &owner.to_text(),
            usage,
            i64::try_from(now.saturating_mul(1000)).map_err(|_| Error::Storage)?,
        )?;
    }
    Ok(())
}

pub(crate) fn record_entry(
    db: &Connection,
    owner: &str,
    kind: &str,
    amount: i64,
    balance: i64,
    now: i64,
    operation: Option<&[u8]>,
) -> vault_types::Result<()> {
    use vault_types::capacity::*;
    if owner.len() > PRINCIPAL_TEXT
        || kind.len() > KIND
        || operation.unwrap_or(&[]).len() > 16
        || row_size(
            &[owner.len(), kind.len(), operation.unwrap_or(&[]).len()],
            4,
        )
        .ok_or(Error::QuotaExceeded)?
            > SMALL_ROW
    {
        return Err(Error::InvalidInput);
    }
    // Audit is disposable history only: payment receipts and reservation/checkpoint
    // journals carry the exactly-once state. Evict BEFORE allocating the new row.
    db.execute("DELETE FROM account_ledger WHERE id IN (SELECT id FROM account_ledger ORDER BY id LIMIT max(0,(SELECT count(*) FROM account_ledger)-9999))",params![]).map_err(|_|Error::Storage)?;
    db.execute("INSERT INTO account_ledger(owner,kind,amount_cycles,balance_after,at_ms,operation) VALUES(?1,?2,?3,?4,?5,?6)",params![owner,kind,amount,balance,now,operation.unwrap_or(&[])]).map_err(|_|Error::Storage)?;
    Ok(())
}

/// Cancel only this caller's flight, or recover its expired pre-upgrade flight.
pub(crate) fn recover_pending_in(
    db: &Connection,
    owner: candid::Principal,
    target: Option<&[u8]>,
    now: u64,
) -> vault_types::Result<bool> {
    let text = owner.to_text();
    let millis = (now * 1000) as i64;
    let runtime = vault_store::operations::runtime(db)?;
    let row:Option<(i64,i64,i64)>=db.query_row("SELECT token,generation,created FROM key_flights WHERE owner=?1 AND (in_flight=1 OR phase='cancelled') ORDER BY in_flight DESC,token DESC LIMIT 1",params![owner.as_slice()],|r|Ok((sqlite::row_get(r,0)?,sqlite::row_get(r,1)?,sqlite::row_get(r,2)?))).optional().map_err(|_|Error::Storage)?;
    if let Some((token, generation, created)) = row {
        let control = vault_store::load::<(u64, vault_types::Id)>(db, "derive")?;
        let selected = target.is_some_and(|v| {
            control
                .as_ref()
                .is_some_and(|(t, id)| *t == token as u64 && id == v)
        });
        if selected || (generation != runtime && now >= created as u64 + 120) {
            let (own, actual, orphan) =
                vault_store::keys::cancel_pending(db, now)?.ok_or(Error::Storage)?;
            if own != token as u64 {
                return Err(Error::Conflict);
            }
            let journal = format!("derive:{token}");
            let checkpoint:Option<i64>=db.query_row("SELECT execution_checkpoint FROM vault_cycle_reservations WHERE owner=?1 AND token=?2",params![text,journal],|r|sqlite::row_get(r,0)).optional().map_err(|_|Error::Storage)?;
            if let Some(checkpoint) = checkpoint {
                settle_reservation(db, &text, &journal, actual, millis, orphan, false)
                    .map_err(|_| Error::Storage)?;
                finish_reserved_execution(db, &text, &journal, checkpoint as u64, millis)
                    .map_err(|_| Error::Storage)?;
            }
            if control.as_ref().is_some_and(|(t, _)| *t == own) {
                db.execute("DELETE FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key='derive'",params![]).map_err(|_|Error::Storage)?;
            }
            db.execute("DELETE FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND token=?1 AND result IS NULL",params![token]).map_err(|_|Error::Storage)?;
            vault_store::keys::acknowledge_cancel(db, own)?;
        }
    }
    let pending:i64=db.query_row("SELECT count(*) FROM key_flights WHERE owner=?1 AND (in_flight=1 OR phase='cancelled')",params![owner.as_slice()],|r|sqlite::row_get(r,0)).map_err(|_|Error::Storage)?;
    Ok(pending == 0)
}

/// Server-selected expired journal owners only; this bridge allocates no account or authority.
/// It executes inside the caller's authenticated transaction and restores that SQL scope.
pub(crate) fn reconcile_key_gc_in(
    db: &Connection,
    caller: candid::Principal,
    owners: &[candid::Principal],
    now: i64,
) -> vault_types::Result<()> {
    for owner in owners {
        vault_store::OwnerContext::authenticated(*owner)?.run(db, |db| {
            track_storage_in(db, &owner.to_text(), vault_store::content::usage(db)?, now)
        })?;
    }
    db.execute("INSERT INTO owner_scope(slot,owner) VALUES(1,?1) ON CONFLICT(slot) DO UPDATE SET owner=excluded.owner",params![caller.as_slice()]).map_err(|_|Error::Storage)?;
    Ok(())
}

// Voice reservations share the DB balance transaction; no external calls occur here.
use super::*;
use vfs_types::{
    VoiceAccess, VoicePolicy, VoiceRate, VoiceReservation, VoiceReserveRequest, VoiceSettleRequest,
    VoiceStopRequest,
};

fn cost(rate: u64, seconds: u64) -> Result<u64, String> {
    let n = (u128::from(rate) * u128::from(seconds)).div_ceil(60);
    if n > i64::MAX as u128 {
        return Err("voice amount overflow".into());
    }
    Ok(n as u64)
}
fn latest_rate(conn: &Connection) -> Result<VoiceRate, String> {
    conn.query_row("SELECT version, cycles_per_minute, authority FROM voice_rates ORDER BY version DESC LIMIT 1", params![], |r| Ok(VoiceRate {
        version: crate::sqlite::row_get::<i64>(r, 0)?.max(0) as u64, cycles_per_minute: crate::sqlite::row_get::<i64>(r, 1)?.max(0) as u64, authority: crate::sqlite::row_get(r, 2)?,
    })).map_err(|_| "voice billing not configured".into())
}
fn authority(conn: &Connection, caller: &str) -> Result<(), String> {
    if caller == latest_rate(conn)?.authority {
        Ok(())
    } else {
        Err("voice authority required".into())
    }
}
fn reservation(conn: &Connection, id: &str) -> Result<Option<VoiceReservation>, String> {
    let json: Option<String> = conn
        .query_row(
            "SELECT state_json FROM voice_reservations WHERE session_id = ?1",
            params![id],
            |r| crate::sqlite::row_get(r, 0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    json.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .transpose()
}
fn save(tx: &Transaction<'_>, r: &VoiceReservation) -> Result<(), String> {
    tx.execute("INSERT INTO voice_reservations (session_id, database_id, principal, usage_day, held_cycles, charged_cycles, expires_at_ms, closed, state_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(session_id) DO UPDATE SET held_cycles=excluded.held_cycles, charged_cycles=excluded.charged_cycles, expires_at_ms=excluded.expires_at_ms, closed=excluded.closed, state_json=excluded.state_json",
        params![r.session_id, r.database_id, r.principal, r.usage_day, r.held_cycles as i64, r.charged_cycles as i64, r.expires_at_ms, i64::from(r.closed), serde_json::to_string(r).map_err(|e|e.to_string())?]).map_err(|e| e.to_string())?;
    Ok(())
}
fn movement(
    tx: &Transaction<'_>,
    r: &VoiceReservation,
    delta: i64,
    kind: &str,
    now: i64,
) -> Result<(), String> {
    let balance = billing::load_storage_cycle_account(tx, &r.database_id)?.balance_cycles;
    let next = balance
        .checked_add(delta)
        .filter(|v| *v >= 0)
        .ok_or("insufficient database cycles")?;
    let config = load_cycles_billing_config(tx)?;
    update_database_cycles_balance(tx, &r.database_id, next, &config, now)?;
    insert_database_ledger(
        tx,
        DatabaseLedgerInsert {
            database_id: &r.database_id,
            kind,
            amount_cycles: delta,
            balance_after_cycles: next,
            payment_amount_e8s: None,
            caller: &r.principal,
            method: Some("voice_billing"),
            cycles_delta: None,
            config: None,
            ledger_block_index: None,
            now,
        },
    )?;
    tx.execute("UPDATE database_cycle_ledger SET voice_session_id=?1, voice_seconds=?2, voice_rate_version=?3 WHERE entry_id=(SELECT MAX(entry_id) FROM database_cycle_ledger)", params![r.session_id,r.confirmed_seconds as i64,r.rate_version as i64]).map_err(|e|e.to_string())?;
    Ok(())
}
fn policy(conn: &Connection, db: &str, principal: &str) -> Result<VoicePolicy, String> {
    conn.query_row("SELECT enabled, daily_budget_cycles FROM voice_policies WHERE database_id=?1 AND principal=?2", params![db, principal], |r| Ok(VoicePolicy {
        database_id: db.into(), principal: principal.into(), enabled: crate::sqlite::row_get::<i64>(r, 0)? != 0, daily_budget_cycles: crate::sqlite::row_get::<i64>(r, 1)?.max(0) as u64,
    })).optional().map_err(|e|e.to_string()).map(|v| v.unwrap_or(VoicePolicy { database_id: db.into(), principal: principal.into(), enabled: false, daily_budget_cycles: 0 }))
}
impl VfsService {
    pub fn configure_voice_rate(&self, caller: &str, rate: VoiceRate) -> Result<(), String> {
        validate_principal_text(&rate.authority)?;
        if rate.authority == Principal::anonymous().to_text()
            || rate.version == 0
            || rate.version > i64::MAX as u64
            || rate.cycles_per_minute == 0
        {
            return Err("invalid voice rate".into());
        }
        cost(rate.cycles_per_minute, 600)?;
        self.write_index(|tx| {
            if caller != load_cycles_billing_config(tx)?.billing_authority_id {
                return Err("billing authority required".into());
            }
            if let Ok(previous) = latest_rate(tx)
                && rate.version <= previous.version
            {
                return Err("voice rate version must increase".into());
            }
            tx.execute(
                "INSERT INTO voice_rates(version,cycles_per_minute,authority) VALUES (?1,?2,?3)",
                params![
                    rate.version as i64,
                    rate.cycles_per_minute as i64,
                    rate.authority
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
    pub fn get_voice_rate(&self) -> Result<VoiceRate, String> {
        self.read_index(latest_rate)
    }
    /// Initialize only an absent owner policy. Explicit opt-outs must survive.
    pub fn initialize_voice_policy(&self, caller: &str, db: &str) -> Result<VoicePolicy, String> {
        self.require_database_role(db, caller, RequiredRole::Owner)?;
        self.write_index(|tx| {
            let exists: i64 = tx.query_row("SELECT EXISTS(SELECT 1 FROM voice_policies WHERE database_id=?1 AND principal=?2)", params![db, caller], |r| crate::sqlite::row_get(r, 0)).map_err(|e| e.to_string())?;
            if exists == 0 {
                let budget = cost(latest_rate(tx)?.cycles_per_minute, 600)?;
                tx.execute("INSERT INTO voice_policies(database_id,principal,enabled,daily_budget_cycles) VALUES (?1,?2,1,?3)", params![db, caller, budget as i64]).map_err(|e| e.to_string())?;
            }
            policy(tx, db, caller)
        })
    }
    pub fn get_voice_access(
        &self,
        caller: &str,
        db: &str,
        principal: &str,
        now: i64,
    ) -> Result<VoiceAccess, String> {
        self.require_database_role(
            db,
            caller,
            if caller == principal {
                RequiredRole::Reader
            } else {
                RequiredRole::Owner
            },
        )?;
        self.read_index(|conn| {
            let policy = policy(conn, db, principal)?;
            let used: i64 = conn.query_row("SELECT COALESCE(SUM(held_cycles + charged_cycles),0) FROM voice_reservations WHERE database_id=?1 AND principal=?2 AND usage_day=?3", params![db, principal, now / DAY_MS], |r| crate::sqlite::row_get(r, 0)).map_err(|e|e.to_string())?;
            Ok(VoiceAccess {
                remaining_cycles: policy.daily_budget_cycles.saturating_sub(used.max(0) as u64),
                balance_cycles: billing::load_storage_cycle_account(conn, db)?.balance_cycles.max(0) as u64,
                policy, rate: latest_rate(conn)?,
            })
        })
    }
    pub fn set_voice_policy(&self, caller: &str, value: VoicePolicy) -> Result<(), String> {
        validate_principal_text(&value.principal)?;
        if value.daily_budget_cycles > i64::MAX as u64
            || value.principal == Principal::anonymous().to_text()
        {
            return Err("invalid voice policy".into());
        }
        self.require_database_role(&value.database_id, caller, RequiredRole::Owner)?;
        self.write_index(|tx| {
            tx.execute("INSERT INTO voice_policies(database_id,principal,enabled,daily_budget_cycles) VALUES (?1,?2,?3,?4) ON CONFLICT(database_id,principal) DO UPDATE SET enabled=excluded.enabled,daily_budget_cycles=excluded.daily_budget_cycles", params![value.database_id,value.principal,i64::from(value.enabled),value.daily_budget_cycles as i64]).map_err(|e|e.to_string())?;
            Ok(())
        })
    }
    pub fn get_voice_policy(
        &self,
        caller: &str,
        db: &str,
        principal: &str,
    ) -> Result<VoicePolicy, String> {
        self.require_database_role(
            db,
            caller,
            if caller == principal {
                RequiredRole::Reader
            } else {
                RequiredRole::Owner
            },
        )?;
        self.read_index(|conn| policy(conn, db, principal))
    }
    pub fn reserve_voice(
        &self,
        caller: &str,
        request: VoiceReserveRequest,
        now: i64,
    ) -> Result<VoiceReservation, String> {
        if request.session_id.is_empty()
            || request.session_id.len() > 100
            || request.reserved_seconds == 0
            || request.reserved_seconds > 600
            || !request.reserved_seconds.is_multiple_of(60)
            || now < 0
        {
            return Err("invalid voice reservation".into());
        }
        self.write_index(|tx| {
            authority(tx, caller)?;
            if load_member_role(tx, &request.database_id, &request.principal)?.is_none() { return Err("database access denied".into()); }
            if load_database_status(tx, &request.database_id)? != DatabaseStatus::Active { return Err("database is not active".into()); }
            let p = policy(tx, &request.database_id, &request.principal)?;
            if !p.enabled { return Err("voice permission required".into()); }
            let mut r = if let Some(r) = reservation(tx, &request.session_id)? {
                if r.database_id != request.database_id || r.principal != request.principal || r.rate_version != request.rate_version { return Err("voice reservation conflict".into()); }
                if r.closed || now >= r.expires_at_ms { return Err("voice reservation closed".into()); }
                r
            } else {
                let rate = latest_rate(tx)?;
                if rate.version != request.rate_version || request.reserved_seconds != 60 { return Err("voice rate or reservation changed".into()); }
                VoiceReservation { session_id: request.session_id.clone(), database_id: request.database_id.clone(), principal: request.principal.clone(), rate_version: rate.version, cycles_per_minute: rate.cycles_per_minute, usage_day: now / DAY_MS, created_at_ms: now, expires_at_ms: now + DAY_MS, reserved_seconds: 0, confirmed_seconds: 0, held_cycles: 0, charged_cycles: 0, closed: false, stopped_seconds: None }
            };
            if request.reserved_seconds <= r.reserved_seconds { return Ok(r); }
            if request.reserved_seconds != r.reserved_seconds + 60 { return Err("invalid voice extension".into()); }
            // Limit prefunding to two minutes beyond server-observable elapsed time.
            if request.reserved_seconds > ((now - r.created_at_ms) as u64 / 1000) + 120 { return Err("voice extension too early".into()); }
            let amount = cost(r.cycles_per_minute, request.reserved_seconds)? - cost(r.cycles_per_minute, r.reserved_seconds)?;
            let used: i64 = tx.query_row("SELECT COALESCE(SUM(held_cycles + charged_cycles),0) FROM voice_reservations WHERE database_id=?1 AND principal=?2 AND usage_day=?3", params![r.database_id,r.principal,r.usage_day], |row|crate::sqlite::row_get(row,0)).map_err(|e|e.to_string())?;
            if (used as u64).checked_add(amount).ok_or("voice budget overflow")? > p.daily_budget_cycles { return Err("voice daily budget exceeded".into()); }
            movement(tx, &r, -(amount as i64), "voice_reserve", now)?;
            r.held_cycles += amount;
            r.reserved_seconds = request.reserved_seconds;
            save(tx, &r)?;
            Ok(r)
        })
    }
    pub fn settle_voice(
        &self,
        caller: &str,
        request: VoiceSettleRequest,
        now: i64,
    ) -> Result<VoiceReservation, String> {
        self.write_index(|tx| {
            authority(tx, caller)?;
            let mut r = reservation(tx, &request.session_id)?.ok_or("voice reservation missing")?;
            // The canister deadline is authoritative even if its timer has not run.
            // A recovered Worker cannot turn unconfirmed time into a late charge.
            if now >= r.expires_at_ms {
                if !r.closed {
                    movement(tx, &r, r.held_cycles as i64, "voice_expired_release", now)?;
                    r.held_cycles = 0;
                    r.closed = true;
                    save(tx, &r)?;
                }
                return Ok(r);
            }
            if request.confirmed_seconds > r.reserved_seconds
                || request.confirmed_seconds
                    > ((now - r.created_at_ms).max(0) as u64).div_ceil(1000)
            {
                return Err("invalid voice usage".into());
            }
            if r.closed {
                if request.confirmed_seconds <= r.confirmed_seconds {
                    return Ok(r);
                }
                return Err("voice reservation closed".into());
            }
            if request.confirmed_seconds < r.confirmed_seconds {
                if request.close {
                    movement(tx, &r, r.held_cycles as i64, "voice_release", now)?;
                    r.held_cycles = 0;
                    r.closed = true;
                    save(tx, &r)?;
                }
                return Ok(r);
            }
            if request.confirmed_seconds == r.confirmed_seconds && !request.close {
                return Ok(r);
            }
            let total = cost(r.cycles_per_minute, request.confirmed_seconds)?;
            r.held_cycles -= total - r.charged_cycles;
            r.charged_cycles = total;
            r.confirmed_seconds = request.confirmed_seconds;
            if request.close {
                movement(tx, &r, r.held_cycles as i64, "voice_release", now)?;
                r.held_cycles = 0;
                r.closed = true;
            }
            // Zero movement records the charge classification; reserve/release own balance changes.
            movement(tx, &r, 0, "voice_settle", now)?;
            save(tx, &r)?;
            Ok(r)
        })
    }
    pub fn stop_voice(
        &self,
        caller: &str,
        request: VoiceStopRequest,
        now: i64,
    ) -> Result<VoiceReservation, String> {
        self.write_index(|tx| {
            authority(tx, caller)?;
            let mut r = reservation(tx, &request.session_id)?.ok_or("voice reservation missing")?;
            if request.final_seconds > r.reserved_seconds {
                return Err("invalid voice usage".into());
            }
            if let Some(stopped) = r.stopped_seconds
                && request.final_seconds >= stopped
            {
                return Ok(r);
            }
            let final_seconds = if r.closed || now >= r.expires_at_ms {
                request.final_seconds.min(r.confirmed_seconds)
            } else {
                request.final_seconds
            };
            if now < r.expires_at_ms
                && final_seconds > ((now - r.created_at_ms).max(0) as u64).div_ceil(1000)
            {
                return Err("invalid voice usage".into());
            }
            let total = cost(r.cycles_per_minute, final_seconds)?;
            let release = r
                .held_cycles
                .checked_add(r.charged_cycles)
                .and_then(|reserved| reserved.checked_sub(total))
                .ok_or("invalid voice usage")?;
            r.confirmed_seconds = final_seconds;
            r.charged_cycles = total;
            r.held_cycles = 0;
            r.closed = true;
            r.stopped_seconds = Some(request.final_seconds);
            movement(tx, &r, release as i64, "voice_stop", now)?;
            save(tx, &r)?;
            Ok(r)
        })
    }
    pub fn get_voice_reservation(
        &self,
        caller: &str,
        id: &str,
    ) -> Result<Option<VoiceReservation>, String> {
        self.read_index(|conn| {
            authority(conn, caller)?;
            reservation(conn, id)
        })
    }
    pub fn expire_voice_reservations(&self, now: i64) -> Result<u64, String> {
        self.write_index(|tx| {
            let mut stmt = tx.prepare("SELECT state_json FROM voice_reservations WHERE closed=0 AND expires_at_ms <= ?1 ORDER BY expires_at_ms LIMIT 100").map_err(|e|e.to_string())?;
            let rows: Vec<String> = crate::sqlite::query_map(&mut stmt, params![now], |r|crate::sqlite::row_get(r,0)).map_err(|e|e.to_string())?;
            drop(stmt);
            for row in &rows {
                let mut r: VoiceReservation = serde_json::from_str(row).map_err(|e|e.to_string())?;
                movement(tx, &r, r.held_cycles as i64, "voice_expired_release", now)?;
                r.held_cycles = 0;
                r.closed = true;
                save(tx, &r)?;
            }
            Ok(rows.len() as u64)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    const USER: &str = "rrkah-fqaaa-aaaaa-aaaaq-cai";
    const WORKER: &str = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    fn setup() -> (tempfile::TempDir, VfsService) {
        let dir = tempdir().unwrap();
        let service = VfsService::new(dir.path().join("index.sqlite3"), dir.path().join("dbs"));
        service.run_index_migrations().unwrap();
        service.create_database("wiki", USER, 0).unwrap();
        service.write_index(|tx| {
            tx.execute("UPDATE database_cycle_accounts SET balance_cycles=1000 WHERE database_id='wiki'",params![]).map_err(|e|e.to_string())?;
            Ok(())
        }).unwrap();
        let admin = service
            .cycles_billing_config()
            .unwrap()
            .billing_authority_id;
        service
            .configure_voice_rate(
                &admin,
                VoiceRate {
                    version: 1,
                    cycles_per_minute: 61,
                    authority: WORKER.into(),
                },
            )
            .unwrap();
        service
            .set_voice_policy(
                USER,
                VoicePolicy {
                    database_id: "wiki".into(),
                    principal: USER.into(),
                    enabled: true,
                    daily_budget_cycles: 200,
                },
            )
            .unwrap();
        (dir, service)
    }
    fn request(id: &str, seconds: u64) -> VoiceReserveRequest {
        VoiceReserveRequest {
            session_id: id.into(),
            database_id: "wiki".into(),
            principal: USER.into(),
            rate_version: 1,
            reserved_seconds: seconds,
        }
    }
    #[test]
    fn owner_defaults_preserve_explicit_policy_and_rate_budget() {
        let (_dir, s) = setup();
        s.write_index(|tx| {
            tx.execute("DELETE FROM voice_policies", params![])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
        assert!(s.initialize_voice_policy(WORKER, "wiki").is_err());
        let p = s.initialize_voice_policy(USER, "wiki").unwrap();
        assert!(p.enabled);
        assert_eq!(p.daily_budget_cycles, 610);
        assert_eq!(p, s.initialize_voice_policy(USER, "wiki").unwrap());
        let admin = s.cycles_billing_config().unwrap().billing_authority_id;
        s.configure_voice_rate(
            &admin,
            VoiceRate {
                version: 2,
                cycles_per_minute: 122,
                authority: WORKER.into(),
            },
        )
        .unwrap();
        assert_eq!(
            s.initialize_voice_policy(USER, "wiki")
                .unwrap()
                .daily_budget_cycles,
            610
        );
        s.set_voice_policy(
            USER,
            VoicePolicy {
                enabled: false,
                daily_budget_cycles: 0,
                ..p
            },
        )
        .unwrap();
        let preserved = s.initialize_voice_policy(USER, "wiki").unwrap();
        assert!(!preserved.enabled);
        assert_eq!(preserved.daily_budget_cycles, 0);
    }
    #[test]
    fn access_reports_reserved_budget_and_utc_reset() {
        let (_dir, s) = setup();
        s.reserve_voice(WORKER, request("access", 60), 0).unwrap();
        let access = s.get_voice_access(USER, "wiki", USER, 0).unwrap();
        assert_eq!(access.remaining_cycles, 139);
        assert_eq!(access.balance_cycles, 939);
        assert_eq!(
            s.get_voice_access(USER, "wiki", USER, DAY_MS)
                .unwrap()
                .remaining_cycles,
            200
        );
        assert!(s.get_voice_access(WORKER, "wiki", USER, 0).is_err());
    }
    #[test]
    fn reservation_and_partial_close_are_idempotent() {
        let (_dir, s) = setup();
        let first = s.reserve_voice(WORKER, request("s", 60), 0).unwrap();
        assert_eq!(first.held_cycles, 61);
        assert_eq!(first, s.reserve_voice(WORKER, request("s", 60), 0).unwrap());
        let close = VoiceSettleRequest {
            session_id: "s".into(),
            confirmed_seconds: 10,
            close: true,
        };
        let result = s.settle_voice(WORKER, close.clone(), 10000).unwrap();
        assert_eq!(result.charged_cycles, 11);
        assert_eq!(result.held_cycles, 0);
        assert_eq!(result, s.settle_voice(WORKER, close, 20000).unwrap());
        assert!(s.reserve_voice(WORKER, request("s", 120), 30000).is_err());
    }
    #[test]
    fn authoritative_stop_refunds_over_settlement_and_fences_late_updates() {
        let (_dir, s) = setup();
        s.reserve_voice(WORKER, request("s", 60), 0).unwrap();
        s.settle_voice(
            WORKER,
            VoiceSettleRequest {
                session_id: "s".into(),
                confirmed_seconds: 50,
                close: false,
            },
            50000,
        )
        .unwrap();
        let stop = VoiceStopRequest {
            session_id: "s".into(),
            final_seconds: 45,
        };
        let result = s.stop_voice(WORKER, stop.clone(), 50000).unwrap();
        assert!(result.closed);
        assert_eq!(result.confirmed_seconds, 45);
        assert_eq!(result.charged_cycles, 46);
        assert_eq!(result.held_cycles, 0);
        assert_eq!(result.stopped_seconds, Some(45));
        assert_eq!(result, s.stop_voice(WORKER, stop, 51000).unwrap());
        assert!(
            s.settle_voice(
                WORKER,
                VoiceSettleRequest {
                    session_id: "s".into(),
                    confirmed_seconds: 50,
                    close: false,
                },
                51000,
            )
            .is_err()
        );
        let earlier = s
            .stop_voice(
                WORKER,
                VoiceStopRequest {
                    session_id: "s".into(),
                    final_seconds: 40,
                },
                51000,
            )
            .unwrap();
        assert_eq!(earlier.confirmed_seconds, 40);
        assert_eq!(earlier.charged_cycles, 41);
        assert_eq!(earlier.stopped_seconds, Some(40));
    }
    #[test]
    fn lower_close_releases_reservation_without_reducing_confirmed_usage() {
        let (_dir, s) = setup();
        s.reserve_voice(WORKER, request("s", 60), 0).unwrap();
        s.settle_voice(
            WORKER,
            VoiceSettleRequest {
                session_id: "s".into(),
                confirmed_seconds: 50,
                close: false,
            },
            50000,
        )
        .unwrap();
        let result = s
            .settle_voice(
                WORKER,
                VoiceSettleRequest {
                    session_id: "s".into(),
                    confirmed_seconds: 45,
                    close: true,
                },
                50000,
            )
            .unwrap();
        assert!(result.closed);
        assert_eq!(result.confirmed_seconds, 50);
        assert_eq!(result.charged_cycles, 51);
        assert_eq!(result.held_cycles, 0);
    }
    #[test]
    fn reservation_requires_owner_policy_and_dedicated_authority() {
        let (_dir, s) = setup();
        assert!(s.reserve_voice(USER, request("s", 60), 0).is_err());
        assert!(
            s.set_voice_policy(
                WORKER,
                VoicePolicy {
                    database_id: "wiki".into(),
                    principal: USER.into(),
                    enabled: true,
                    daily_budget_cycles: 100
                }
            )
            .is_err()
        );
        s.set_voice_policy(
            USER,
            VoicePolicy {
                database_id: "wiki".into(),
                principal: USER.into(),
                enabled: false,
                daily_budget_cycles: 100,
            },
        )
        .unwrap();
        assert!(s.reserve_voice(WORKER, request("s", 60), 0).is_err());
    }
    #[test]
    fn parallel_reservations_cannot_exceed_shared_budget() {
        let (_dir, s) = setup();
        for id in ["a", "b", "c"] {
            s.reserve_voice(WORKER, request(id, 60), 0).unwrap();
        }
        assert!(
            s.reserve_voice(WORKER, request("d", 60), 0)
                .unwrap_err()
                .contains("budget")
        );
    }
    #[test]
    fn conflicting_retry_and_excess_usage_reject() {
        let (_dir, s) = setup();
        s.reserve_voice(WORKER, request("s", 60), 0).unwrap();
        let mut conflict = request("s", 60);
        conflict.database_id = "other".into();
        assert!(s.reserve_voice(WORKER, conflict, 0).is_err());
        assert!(
            s.settle_voice(
                WORKER,
                VoiceSettleRequest {
                    session_id: "s".into(),
                    confirmed_seconds: 61,
                    close: true
                },
                61000
            )
            .is_err()
        );
        assert!(
            s.settle_voice(
                WORKER,
                VoiceSettleRequest {
                    session_id: "s".into(),
                    confirmed_seconds: 10,
                    close: true
                },
                100
            )
            .is_err()
        );
    }
    #[test]
    fn timeout_keeps_confirmed_usage_and_releases_unknown_usage_once() {
        let (_dir, s) = setup();
        s.reserve_voice(WORKER, request("s", 60), 0).unwrap();
        s.settle_voice(
            WORKER,
            VoiceSettleRequest {
                session_id: "s".into(),
                confirmed_seconds: 10,
                close: false,
            },
            10000,
        )
        .unwrap();
        assert_eq!(s.expire_voice_reservations(DAY_MS).unwrap(), 1);
        assert_eq!(s.expire_voice_reservations(DAY_MS).unwrap(), 0);
        let r = s.get_voice_reservation(WORKER, "s").unwrap().unwrap();
        assert_eq!(r.charged_cycles, 11);
        assert_eq!(r.held_cycles, 0);
        assert!(r.closed);
    }
    #[test]
    fn late_settlement_cannot_charge_unknown_time_before_the_expiry_timer_runs() {
        let (_dir, s) = setup();
        s.reserve_voice(WORKER, request("s", 60), 0).unwrap();
        s.settle_voice(
            WORKER,
            VoiceSettleRequest {
                session_id: "s".into(),
                confirmed_seconds: 10,
                close: false,
            },
            10000,
        )
        .unwrap();
        let r = s
            .settle_voice(
                WORKER,
                VoiceSettleRequest {
                    session_id: "s".into(),
                    confirmed_seconds: 60,
                    close: true,
                },
                DAY_MS,
            )
            .unwrap();
        assert!(r.closed);
        assert_eq!(r.confirmed_seconds, 10);
        assert_eq!(r.charged_cycles, 11);
        assert_eq!(r.held_cycles, 0);
        let repeated = s
            .settle_voice(
                WORKER,
                VoiceSettleRequest {
                    session_id: "s".into(),
                    confirmed_seconds: 60,
                    close: true,
                },
                DAY_MS + 1,
            )
            .unwrap();
        assert_eq!(repeated, r);
        assert_eq!(s.expire_voice_reservations(DAY_MS).unwrap(), 0);
        let balance = s
            .read_index(
                |conn| Ok(billing::load_storage_cycle_account(conn, "wiki")?.balance_cycles),
            )
            .unwrap();
        assert_eq!(balance, 989);
    }
    #[test]
    fn expiry_recovers_from_persisted_canister_state_without_a_worker_or_client() {
        let (dir, s) = setup();
        s.reserve_voice(WORKER, request("s", 60), 0).unwrap();
        drop(s);
        let recovered = VfsService::new(dir.path().join("index.sqlite3"), dir.path().join("dbs"));
        recovered.run_index_migrations_for_upgrade(None).unwrap();
        assert_eq!(recovered.expire_voice_reservations(DAY_MS).unwrap(), 1);
        assert_eq!(recovered.expire_voice_reservations(DAY_MS).unwrap(), 0);
        let r = recovered
            .get_voice_reservation(WORKER, "s")
            .unwrap()
            .unwrap();
        assert!(r.closed);
        assert_eq!(r.charged_cycles, 0);
        assert_eq!(r.held_cycles, 0);
    }
    #[test]
    fn previous_day_release_does_not_restore_today_budget() {
        let (_dir, s) = setup();
        s.reserve_voice(WORKER, request("old", 60), DAY_MS - 20000)
            .unwrap();
        for id in ["a", "b", "c"] {
            s.reserve_voice(WORKER, request(id, 60), DAY_MS).unwrap();
        }
        s.settle_voice(
            WORKER,
            VoiceSettleRequest {
                session_id: "old".into(),
                confirmed_seconds: 10,
                close: true,
            },
            DAY_MS,
        )
        .unwrap();
        assert!(s.reserve_voice(WORKER, request("d", 60), DAY_MS).is_err());
    }
    #[test]
    fn amount_rounds_once_and_overflow_rejects() {
        assert_eq!(cost(61, 10).unwrap(), 11);
        assert_eq!(cost(61, 0).unwrap(), 0);
        assert!(cost(u64::MAX, 600).is_err());
    }
}

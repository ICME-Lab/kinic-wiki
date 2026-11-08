//! Durable execution-cycle refill journal. Never touches database cycle accounts.
use super::*;
use vfs_types::{
    BEKKO_REFILL_DAY_NS, BEKKO_REFILL_FEE_MARGIN, BekkoRefillAttempt, BekkoRefillConfig,
    BekkoRefillOutcome, BekkoRefillReconciliation, BekkoRefillReservation, BekkoRefillResolution,
    BekkoRefillState,
};

impl VfsService {
    /// Called before scheduling timers on init/upgrade. Unknown transfers remain locked.
    pub fn initialize_bekko_refill(&self, now: u64) -> Result<(), String> {
        self.write_index(|tx| {
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS bekko_refill_state (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state BLOB NOT NULL);",
            )
            .map_err(|e| e.to_string())?;
            let mut state = load(tx)?;
            if let Some(active) = state.active.as_mut() {
                match active.outcome {
                    BekkoRefillOutcome::Checking => {
                        complete(&mut state, BekkoRefillOutcome::Interrupted, now)?
                    }
                    BekkoRefillOutcome::Depositing => {
                        active.outcome =
                            BekkoRefillOutcome::Unknown("interrupted by upgrade".into());
                    }
                    _ => {}
                }
            }
            save(tx, &state)
        })
    }

    pub fn bekko_refill_state(&self) -> Result<BekkoRefillState, String> {
        self.read_index(load)
    }

    pub fn configure_bekko_refill(&self, config: BekkoRefillConfig) -> Result<(), String> {
        if config.threshold_cycles == 0
            || config.target_cycles <= config.threshold_cycles
            || config.max_transfer_cycles == 0
            || config.max_daily_cycles < config.max_transfer_cycles
            || config.wiki_reserve_cycles < BEKKO_REFILL_FEE_MARGIN
        {
            return Err("invalid Bekko refill limits or reserve".into());
        }
        self.change_bekko_refill(|state| {
            state.config_revision = state
                .config_revision
                .checked_add(1)
                .ok_or("configuration revision exhausted")?;
            state.config = config;
            Ok(())
        })
    }

    pub fn begin_bekko_refill(&self, now: u64) -> Result<Option<BekkoRefillAttempt>, String> {
        self.change_bekko_refill(|state| {
            if !state.config.enabled || state.active.is_some() {
                return Ok(None);
            }
            state.next_id = state
                .next_id
                .checked_add(1)
                .ok_or("attempt ids exhausted")?;
            let attempt = BekkoRefillAttempt {
                id: state.next_id,
                config_revision: state.config_revision,
                started_ns: now,
                finished_ns: None,
                observed_bekko_cycles: None,
                amount_cycles: 0,
                outcome: BekkoRefillOutcome::Checking,
            };
            state.active = Some(attempt.clone());
            Ok(Some(attempt))
        })
    }

    /// Run immediately before constructing deposit_cycles, with fresh execution and liquid balances.
    /// The reservation and Depositing journal entry commit together before the await.
    pub fn reserve_bekko_refill(
        &self,
        id: u64,
        bekko: u128,
        wiki: u128,
        liquid: u128,
        now: u64,
    ) -> Result<Option<u128>, String> {
        self.change_bekko_refill(|state| {
            let active = state
                .active
                .as_mut()
                .filter(|a| a.id == id && a.outcome == BekkoRefillOutcome::Checking)
                .ok_or("stale refill check")?;
            active.observed_bekko_cycles = Some(bekko);
            let config = &state.config;
            let skip = if !config.enabled || active.config_revision != state.config_revision {
                Some(BekkoRefillOutcome::ConfigChanged)
            } else if bekko >= config.threshold_cycles {
                Some(BekkoRefillOutcome::Sufficient)
            } else {
                None
            };
            if let Some(outcome) = skip {
                complete(state, outcome, now)?;
                return Ok(None);
            }
            // Future timestamps stay charged if time ever moves backwards.
            state
                .reservations
                .retain(|r| now.saturating_sub(r.sent_ns) < BEKKO_REFILL_DAY_NS);
            let used = state
                .reservations
                .iter()
                .fold(0u128, |sum, r| sum.saturating_add(r.amount_cycles));
            let remaining = config.max_daily_cycles.saturating_sub(used);
            if remaining == 0 || state.reservations.len() >= 256 {
                complete(state, BekkoRefillOutcome::DailyLimit, now)?;
                return Ok(None);
            }
            let available = wiki
                .saturating_sub(config.wiki_reserve_cycles)
                .saturating_sub(BEKKO_REFILL_FEE_MARGIN)
                .min(liquid.saturating_sub(BEKKO_REFILL_FEE_MARGIN));
            let amount = (config.target_cycles - bekko)
                .min(config.max_transfer_cycles)
                .min(remaining)
                .min(available);
            if amount == 0 {
                complete(state, BekkoRefillOutcome::WikiReserve, now)?;
                return Ok(None);
            }
            active.amount_cycles = amount;
            active.outcome = BekkoRefillOutcome::Depositing;
            state.reservations.push(BekkoRefillReservation {
                sent_ns: now,
                amount_cycles: amount,
            });
            Ok(Some(amount))
        })
    }

    pub fn finish_bekko_refill(
        &self,
        id: u64,
        outcome: BekkoRefillOutcome,
        now: u64,
    ) -> Result<(), String> {
        self.change_bekko_refill(|state| {
            let active = state
                .active
                .as_mut()
                .filter(|a| a.id == id)
                .ok_or("stale refill result")?;
            let allowed = match (&active.outcome, &outcome) {
                (BekkoRefillOutcome::Checking, BekkoRefillOutcome::Failed(_)) => true,
                (
                    BekkoRefillOutcome::Depositing,
                    BekkoRefillOutcome::Succeeded
                    | BekkoRefillOutcome::Failed(_)
                    | BekkoRefillOutcome::Unknown(_),
                ) => true,
                _ => false,
            };
            if !allowed {
                return Err("invalid refill completion".into());
            }
            if matches!(outcome, BekkoRefillOutcome::Unknown(_)) {
                active.outcome = bounded_outcome(outcome);
                active.finished_ns = Some(now);
                Ok(())
            } else {
                complete(state, bounded_outcome(outcome), now)
            }
        })
    }

    /// Controller entrypoint must authenticate before calling this method. No automatic reconciliation.
    pub fn reconcile_bekko_refill(
        &self,
        id: u64,
        resolution: BekkoRefillResolution,
        evidence: String,
        now: u64,
    ) -> Result<(), String> {
        if evidence.trim().is_empty() || evidence.len() > 1024 {
            return Err("evidence must contain 1..=1024 bytes".into());
        }
        self.change_bekko_refill(|state| {
            if state.config.enabled { return Err("disable refill before reconciliation".into()); }
            let active = state.active.as_ref().filter(|a| a.id == id).ok_or("stale reconciliation")?;
            if !matches!(active.outcome, BekkoRefillOutcome::Unknown(_)) {
                return Err("only unknown deposits may be reconciled; upgrade to recover interrupted callbacks".into());
            }
            complete(state, BekkoRefillOutcome::Reconciled(BekkoRefillReconciliation {
                deposited: resolution == BekkoRefillResolution::Deposited, evidence }), now)
        })
    }

    fn change_bekko_refill<T>(
        &self,
        f: impl FnOnce(&mut BekkoRefillState) -> Result<T, String>,
    ) -> Result<T, String> {
        self.write_index(|tx| {
            let mut state = load(tx)?;
            let result = f(&mut state)?;
            save(tx, &state)?;
            Ok(result)
        })
    }
}
fn bounded_outcome(outcome: BekkoRefillOutcome) -> BekkoRefillOutcome {
    fn bound(s: String) -> String {
        s.chars().take(512).collect()
    }
    match outcome {
        BekkoRefillOutcome::Failed(s) => BekkoRefillOutcome::Failed(bound(s)),
        BekkoRefillOutcome::Unknown(s) => BekkoRefillOutcome::Unknown(bound(s)),
        other => other,
    }
}
fn complete(
    state: &mut BekkoRefillState,
    outcome: BekkoRefillOutcome,
    now: u64,
) -> Result<(), String> {
    let mut attempt = state.active.take().ok_or("no active refill")?;
    attempt.outcome = outcome;
    attempt.finished_ns = Some(now);
    state.history.push(attempt);
    if state.history.len() > 128 {
        state.history.remove(0);
    }
    Ok(())
}
fn load(conn: &Connection) -> Result<BekkoRefillState, String> {
    let mut stmt = conn
        .prepare("SELECT state FROM bekko_refill_state WHERE singleton = 1")
        .map_err(|e| e.to_string())?;
    let bytes: Option<Vec<u8>> =
        crate::sqlite::query_one(&mut stmt, params![], |row| crate::sqlite::row_get(row, 0))
            .optional()
            .map_err(|e| e.to_string())?;
    bytes
        .map(|bytes| {
            candid::decode_one(&bytes).map_err(|e| format!("invalid Bekko refill state: {e}"))
        })
        .unwrap_or_else(|| Ok(BekkoRefillState::default()))
}
fn save(tx: &Transaction<'_>, state: &BekkoRefillState) -> Result<(), String> {
    let bytes = candid::encode_one(state).map_err(|e| e.to_string())?;
    crate::sqlite::execute_values(
        tx,
        "INSERT INTO bekko_refill_state (singleton, state) VALUES (1, ?1)
        ON CONFLICT(singleton) DO UPDATE SET state = excluded.state",
        &[crate::sqlite::nullable_blob_value(Some(bytes))],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use vfs_types::{BekkoRefillConfig, BekkoRefillOutcome, BekkoRefillResolution};

    fn service(path: &std::path::Path) -> crate::VfsService {
        let svc = crate::VfsService::new(path.join("index.db"), path.join("databases"));
        svc.initialize_bekko_refill(0).unwrap();
        svc
    }
    fn enabled(svc: &crate::VfsService) {
        let mut cfg = BekkoRefillConfig::default();
        cfg.enabled = true;
        svc.configure_bekko_refill(cfg).unwrap();
    }
    #[test]
    fn defaults_do_not_send_and_invalid_config_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        assert!(svc.begin_bekko_refill(1).unwrap().is_none());
        let mut cfg = BekkoRefillConfig::default();
        cfg.target_cycles = cfg.threshold_cycles;
        assert!(svc.configure_bekko_refill(cfg).is_err());
    }
    #[test]
    fn caps_and_wiki_reserve_apply_at_send_time() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        enabled(&svc);
        let check = svc.begin_bekko_refill(1).unwrap().unwrap();
        assert!(svc.begin_bekko_refill(2).unwrap().is_none());
        assert_eq!(
            svc.reserve_bekko_refill(
                check.id,
                100_000_000_000,
                4_400_000_000_000,
                8_000_000_000_000,
                3
            )
            .unwrap(),
            Some(399_000_000_000)
        );
        svc.finish_bekko_refill(check.id, BekkoRefillOutcome::Succeeded, 4)
            .unwrap();
        let check = svc.begin_bekko_refill(5).unwrap().unwrap();
        assert_eq!(
            svc.reserve_bekko_refill(
                check.id,
                600_000_000_000,
                10_000_000_000_000,
                10_000_000_000_000,
                6
            )
            .unwrap(),
            None
        );
        let check = svc.begin_bekko_refill(7).unwrap().unwrap();
        assert_eq!(
            svc.reserve_bekko_refill(check.id, 0, 10_000_000_000_000, 301_000_000_000, 8)
                .unwrap(),
            Some(300_000_000_000)
        );
    }
    #[test]
    fn config_change_invalidates_awaited_balance() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        enabled(&svc);
        let check = svc.begin_bekko_refill(1).unwrap().unwrap();
        let mut cfg = BekkoRefillConfig::default();
        cfg.enabled = true;
        svc.configure_bekko_refill(cfg).unwrap();
        assert_eq!(
            svc.reserve_bekko_refill(check.id, 0, u128::MAX, u128::MAX, 2)
                .unwrap(),
            None
        );
        assert_eq!(
            svc.bekko_refill_state()
                .unwrap()
                .history
                .last()
                .unwrap()
                .outcome,
            BekkoRefillOutcome::ConfigChanged
        );
    }
    #[test]
    fn rolling_budget_survives_history_pruning_config_edits_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        enabled(&svc);
        for now in [1, 3] {
            let check = svc.begin_bekko_refill(now).unwrap().unwrap();
            assert_eq!(
                svc.reserve_bekko_refill(check.id, 0, u128::MAX, u128::MAX, now)
                    .unwrap(),
                Some(600_000_000_000)
            );
            svc.finish_bekko_refill(
                check.id,
                BekkoRefillOutcome::Failed("clean reject".into()),
                now + 1,
            )
            .unwrap();
        }
        for now in 5..150 {
            let check = svc.begin_bekko_refill(now).unwrap().unwrap();
            assert_eq!(
                svc.reserve_bekko_refill(check.id, 0, u128::MAX, u128::MAX, now)
                    .unwrap(),
                None
            );
        }
        let svc = service(dir.path());
        enabled(&svc);
        assert_eq!(svc.bekko_refill_state().unwrap().history.len(), 128);
        let check = svc.begin_bekko_refill(200).unwrap().unwrap();
        assert_eq!(
            svc.reserve_bekko_refill(check.id, 0, u128::MAX, u128::MAX, 201)
                .unwrap(),
            None
        );
        let check = svc.begin_bekko_refill(86_400_000_000_004).unwrap().unwrap();
        assert_eq!(
            svc.reserve_bekko_refill(check.id, 0, u128::MAX, u128::MAX, 86_400_000_000_005)
                .unwrap(),
            Some(600_000_000_000)
        );
    }
    #[test]
    fn upgrade_marks_deposit_unknown_and_blocks_until_explicit_reconciliation() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        enabled(&svc);
        let check = svc.begin_bekko_refill(1).unwrap().unwrap();
        svc.reserve_bekko_refill(check.id, 0, u128::MAX, u128::MAX, 2)
            .unwrap();
        let svc = service(dir.path());
        assert_eq!(
            svc.bekko_refill_state().unwrap().active.unwrap().outcome,
            BekkoRefillOutcome::Unknown("interrupted by upgrade".into())
        );
        assert!(svc.begin_bekko_refill(4).unwrap().is_none());
        assert!(
            svc.reconcile_bekko_refill(
                check.id,
                BekkoRefillResolution::Deposited,
                "checked evidence".into(),
                5
            )
            .is_err()
        );
        svc.configure_bekko_refill(BekkoRefillConfig::default())
            .unwrap();
        assert!(
            svc.reconcile_bekko_refill(
                check.id + 1,
                BekkoRefillResolution::Deposited,
                "checked evidence".into(),
                5
            )
            .is_err()
        );
        assert!(
            svc.reconcile_bekko_refill(check.id, BekkoRefillResolution::Deposited, "".into(), 5)
                .is_err()
        );
        svc.reconcile_bekko_refill(
            check.id,
            BekkoRefillResolution::Deposited,
            "checked evidence".into(),
            5,
        )
        .unwrap();
        assert!(svc.bekko_refill_state().unwrap().active.is_none());
        enabled(&svc);
        assert!(svc.begin_bekko_refill(6).unwrap().is_some());
    }
    #[test]
    fn upgrade_cancels_read_only_check_and_retains_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        enabled(&svc);
        svc.begin_bekko_refill(1).unwrap().unwrap();
        let svc = service(dir.path());
        assert!(svc.bekko_refill_state().unwrap().config.enabled);
        assert!(svc.begin_bekko_refill(2).unwrap().is_some());
    }
    #[test]
    fn no_transfer_when_wiki_or_liquid_reserve_is_exhausted() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        enabled(&svc);
        for (now, wiki, liquid) in [
            (1, 4_001_000_000_000, u128::MAX),
            (3, u128::MAX, 1_000_000_000),
        ] {
            let attempt = svc.begin_bekko_refill(now).unwrap().unwrap();
            assert_eq!(
                svc.reserve_bekko_refill(attempt.id, 0, wiki, liquid, now)
                    .unwrap(),
                None
            );
            let state = svc.bekko_refill_state().unwrap();
            assert_eq!(
                state.history.last().unwrap().outcome,
                BekkoRefillOutcome::WikiReserve
            );
            assert!(state.reservations.is_empty());
        }
    }
    #[test]
    fn unknown_timeout_keeps_lock_and_stale_completion_cannot_release_it() {
        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        enabled(&svc);
        let attempt = svc.begin_bekko_refill(1).unwrap().unwrap();
        svc.reserve_bekko_refill(attempt.id, 0, u128::MAX, u128::MAX, 2)
            .unwrap();
        svc.finish_bekko_refill(attempt.id, BekkoRefillOutcome::Unknown("timeout".into()), 3)
            .unwrap();
        assert!(
            svc.finish_bekko_refill(attempt.id, BekkoRefillOutcome::Succeeded, 4)
                .is_err()
        );
        enabled(&svc);
        assert!(
            svc.begin_bekko_refill(86_400_000_000_010)
                .unwrap()
                .is_none()
        );
        let state = svc.bekko_refill_state().unwrap();
        assert_eq!(state.active.unwrap().amount_cycles, 600_000_000_000);
        assert_eq!(state.reservations.len(), 1);
    }
}

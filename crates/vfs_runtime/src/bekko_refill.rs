//! Durable execution-cycle refill journal. Never touches database cycle accounts.
use super::*;
use candid::Principal;
use vfs_types::{
    BEKKO_REFILL_DAY_NS, BEKKO_REFILL_FEE_MARGIN, BekkoRefillAttempt, BekkoRefillConfig,
    BekkoRefillOutcome, BekkoRefillReconciliation, BekkoRefillReservation, BekkoRefillResolution,
    BekkoRefillState, VaultRefillConfig, VaultRefillStatus,
};

#[derive(Clone, Copy)]
enum RefillTarget {
    Bekko,
    Vault,
}

impl RefillTarget {
    fn table(self) -> &'static str {
        match self {
            Self::Bekko => "bekko_refill_state",
            Self::Vault => "vault_refill_state",
        }
    }
}

impl VfsService {
    /// Called before scheduling timers on init/upgrade. Unknown transfers remain locked.
    pub fn initialize_bekko_refill(&self, now: u64) -> Result<(), String> {
        self.write_index(|tx| {
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS bekko_refill_state (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state BLOB NOT NULL);
                 CREATE TABLE IF NOT EXISTS vault_refill_state (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state BLOB NOT NULL,
                    target TEXT);",
            )
            .map_err(|e| e.to_string())?;
            for target in [RefillTarget::Bekko, RefillTarget::Vault] {
                let mut state = load(tx, target)?;
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
                save(tx, target, &state)?;
            }
            Ok(())
        })
    }

    pub fn bekko_refill_state(&self) -> Result<BekkoRefillState, String> {
        self.read_index(|db| load(db, RefillTarget::Bekko))
    }

    pub fn vault_refill_state(&self) -> Result<Option<VaultRefillStatus>, String> {
        self.read_index(|db| {
            let Some(target) = vault_target(db)? else {
                return Ok(None);
            };
            let mut state = load(db, RefillTarget::Vault)?;
            let shared = load(db, RefillTarget::Bekko)?.config;
            state.config.max_daily_cycles = shared.max_daily_cycles;
            state.config.wiki_reserve_cycles = shared.wiki_reserve_cycles;
            Ok(Some(VaultRefillStatus { target, state }))
        })
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
        self.change_refill(RefillTarget::Bekko, |_, state| configure(state, config))
    }

    pub fn configure_vault_refill(&self, config: VaultRefillConfig) -> Result<(), String> {
        if config.target == Principal::anonymous()
            || config.target == Principal::management_canister()
            || config.target.to_text() == vfs_types::BEKKO_REFILL_CANISTER
            || config.threshold_cycles == 0
            || config.target_cycles <= config.threshold_cycles
            || config.max_transfer_cycles == 0
        {
            return Err("invalid Vault refill target or limits".into());
        }
        self.change_refill(RefillTarget::Vault, |tx, state| {
            if vault_target(tx)? != Some(config.target) && state.active.is_some() {
                return Err("cannot change Vault target while a refill is active".into());
            }
            tx.execute(
                "UPDATE vault_refill_state SET target = ?1 WHERE singleton = 1",
                params![config.target.to_text()],
            )
            .map_err(|e| e.to_string())?;
            configure(
                state,
                BekkoRefillConfig {
                    enabled: config.enabled,
                    threshold_cycles: config.threshold_cycles,
                    target_cycles: config.target_cycles,
                    max_transfer_cycles: config.max_transfer_cycles,
                    ..BekkoRefillConfig::default()
                },
            )
        })
    }

    pub fn begin_bekko_refill(&self, now: u64) -> Result<Option<BekkoRefillAttempt>, String> {
        self.change_refill(RefillTarget::Bekko, |_, state| begin(state, None, now))
    }

    pub fn begin_vault_refill(
        &self,
        now: u64,
    ) -> Result<Option<(Principal, BekkoRefillAttempt)>, String> {
        self.change_refill(RefillTarget::Vault, |tx, state| {
            let Some(target) = vault_target(tx)? else {
                return Ok(None);
            };
            Ok(begin(state, Some(target), now)?.map(|attempt| (target, attempt)))
        })
    }

    /// Run immediately before deposit_cycles, with fresh execution and liquid balances
    /// after subtracting the exact CDK call prepayment from each.
    /// The reservation and Depositing journal entry commit together before the await.
    pub fn reserve_bekko_refill(
        &self,
        id: u64,
        bekko: u128,
        wiki: u128,
        liquid: u128,
        now: u64,
    ) -> Result<Option<u128>, String> {
        self.reserve_refill(RefillTarget::Bekko, id, bekko, wiki, liquid, now)
    }

    pub fn reserve_vault_refill(
        &self,
        id: u64,
        balance: u128,
        wiki: u128,
        liquid: u128,
        now: u64,
    ) -> Result<Option<u128>, String> {
        self.reserve_refill(RefillTarget::Vault, id, balance, wiki, liquid, now)
    }

    fn reserve_refill(
        &self,
        target: RefillTarget,
        id: u64,
        balance: u128,
        wiki: u128,
        liquid: u128,
        now: u64,
    ) -> Result<Option<u128>, String> {
        self.change_refill(target, |tx, state| {
            let (shared, other) = match target {
                RefillTarget::Bekko => (state.config.clone(), load(tx, RefillTarget::Vault)?),
                RefillTarget::Vault => {
                    let bekko = load(tx, RefillTarget::Bekko)?;
                    (bekko.config.clone(), bekko)
                }
            };
            let active = state
                .active
                .as_mut()
                .filter(|a| a.id == id && a.outcome == BekkoRefillOutcome::Checking)
                .ok_or("stale refill check")?;
            active.observed_bekko_cycles = Some(balance);
            let config = &state.config;
            let skip = if !config.enabled || active.config_revision != state.config_revision {
                Some(BekkoRefillOutcome::ConfigChanged)
            } else if balance >= config.threshold_cycles {
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
            let reservations = state.reservations.iter().chain(
                other
                    .reservations
                    .iter()
                    .filter(|r| now.saturating_sub(r.sent_ns) < BEKKO_REFILL_DAY_NS),
            );
            let (used, attempts) = reservations.fold((0u128, 0), |(sum, count), r| {
                (sum.saturating_add(r.amount_cycles), count + 1)
            });
            let remaining = shared.max_daily_cycles.saturating_sub(used);
            if remaining == 0 || attempts >= 256 {
                complete(state, BekkoRefillOutcome::DailyLimit, now)?;
                return Ok(None);
            }
            let available = wiki
                .saturating_sub(shared.wiki_reserve_cycles)
                .saturating_sub(BEKKO_REFILL_FEE_MARGIN)
                .min(liquid.saturating_sub(BEKKO_REFILL_FEE_MARGIN));
            let amount = (config.target_cycles - balance)
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
        self.finish_refill(RefillTarget::Bekko, id, outcome, now)
    }

    pub fn finish_vault_refill(
        &self,
        id: u64,
        outcome: BekkoRefillOutcome,
        now: u64,
    ) -> Result<(), String> {
        self.finish_refill(RefillTarget::Vault, id, outcome, now)
    }

    fn finish_refill(
        &self,
        target: RefillTarget,
        id: u64,
        outcome: BekkoRefillOutcome,
        now: u64,
    ) -> Result<(), String> {
        self.change_refill(target, |_, state| {
            let active = state
                .active
                .as_mut()
                .filter(|a| a.id == id)
                .ok_or("stale refill result")?;
            let allowed = matches!(
                (&active.outcome, &outcome),
                (BekkoRefillOutcome::Checking, BekkoRefillOutcome::Failed(_))
                    | (
                        BekkoRefillOutcome::Depositing,
                        BekkoRefillOutcome::Succeeded
                            | BekkoRefillOutcome::Failed(_)
                            | BekkoRefillOutcome::Unknown(_),
                    )
            );
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
        self.reconcile_refill(RefillTarget::Bekko, id, resolution, evidence, now)
    }

    pub fn reconcile_vault_refill(
        &self,
        id: u64,
        resolution: BekkoRefillResolution,
        evidence: String,
        now: u64,
    ) -> Result<(), String> {
        self.reconcile_refill(RefillTarget::Vault, id, resolution, evidence, now)
    }

    fn reconcile_refill(
        &self,
        target: RefillTarget,
        id: u64,
        resolution: BekkoRefillResolution,
        evidence: String,
        now: u64,
    ) -> Result<(), String> {
        if evidence.trim().is_empty() || evidence.len() > 1024 {
            return Err("evidence must contain 1..=1024 bytes".into());
        }
        self.change_refill(target, |_, state| {
            if state.config.enabled { return Err("disable refill before reconciliation".into()); }
            let active = state.active.as_ref().filter(|a| a.id == id).ok_or("stale reconciliation")?;
            if !matches!(active.outcome, BekkoRefillOutcome::Unknown(_)) {
                return Err("only unknown deposits may be reconciled; upgrade to recover interrupted callbacks".into());
            }
            complete(state, BekkoRefillOutcome::Reconciled(BekkoRefillReconciliation {
                deposited: resolution == BekkoRefillResolution::Deposited, evidence }), now)
        })
    }

    fn change_refill<T>(
        &self,
        target: RefillTarget,
        f: impl FnOnce(&Transaction<'_>, &mut BekkoRefillState) -> Result<T, String>,
    ) -> Result<T, String> {
        self.write_index(|tx| {
            let mut state = load(tx, target)?;
            let result = f(tx, &mut state)?;
            save(tx, target, &state)?;
            Ok(result)
        })
    }
}

fn configure(state: &mut BekkoRefillState, config: BekkoRefillConfig) -> Result<(), String> {
    state.config_revision = state
        .config_revision
        .checked_add(1)
        .ok_or("configuration revision exhausted")?;
    state.config = config;
    Ok(())
}

fn begin(
    state: &mut BekkoRefillState,
    target: Option<Principal>,
    now: u64,
) -> Result<Option<BekkoRefillAttempt>, String> {
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
        target,
        observed_bekko_cycles: None,
        amount_cycles: 0,
        outcome: BekkoRefillOutcome::Checking,
    };
    state.active = Some(attempt.clone());
    Ok(Some(attempt))
}

fn vault_target(conn: &Connection) -> Result<Option<Principal>, String> {
    let mut stmt = conn
        .prepare("SELECT target FROM vault_refill_state WHERE singleton = 1")
        .map_err(|e| e.to_string())?;
    let target: Option<String> =
        crate::sqlite::query_one(&mut stmt, params![], |row| crate::sqlite::row_get(row, 0))
            .map_err(|e| e.to_string())?;
    target
        .map(|target| Principal::from_text(target).map_err(|e| e.to_string()))
        .transpose()
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
fn load(conn: &Connection, target: RefillTarget) -> Result<BekkoRefillState, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT state FROM {} WHERE singleton = 1",
            target.table()
        ))
        .map_err(|e| e.to_string())?;
    let bytes: Option<Vec<u8>> =
        crate::sqlite::query_one(&mut stmt, params![], |row| crate::sqlite::row_get(row, 0))
            .optional()
            .map_err(|e| e.to_string())?;
    bytes
        .map(|bytes| {
            candid::decode_one(&bytes)
                .map_err(|e| format!("invalid refill state in {}: {e}", target.table()))
        })
        .unwrap_or_else(|| Ok(BekkoRefillState::default()))
}
fn save(
    tx: &Transaction<'_>,
    target: RefillTarget,
    state: &BekkoRefillState,
) -> Result<(), String> {
    let bytes = candid::encode_one(state).map_err(|e| e.to_string())?;
    crate::sqlite::execute_values(
        tx,
        &format!(
            "INSERT INTO {} (singleton, state) VALUES (1, ?1)
         ON CONFLICT(singleton) DO UPDATE SET state = excluded.state",
            target.table()
        ),
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
        let cfg = BekkoRefillConfig {
            enabled: true,
            ..BekkoRefillConfig::default()
        };
        svc.configure_bekko_refill(cfg).unwrap();
    }

    #[test]
    fn upgrade_preserves_a_bekko_deposit_written_before_vault_support() {
        use super::{BekkoRefillReservation, params};
        use candid::{CandidType, Principal};
        use vfs_types::VaultRefillConfig;

        #[derive(CandidType)]
        struct LegacyAttempt {
            id: u64,
            config_revision: u64,
            started_ns: u64,
            finished_ns: Option<u64>,
            observed_bekko_cycles: Option<u128>,
            amount_cycles: u128,
            outcome: BekkoRefillOutcome,
        }

        #[derive(CandidType)]
        struct LegacyState {
            config: BekkoRefillConfig,
            config_revision: u64,
            next_id: u64,
            active: Option<LegacyAttempt>,
            history: Vec<LegacyAttempt>,
            reservations: Vec<BekkoRefillReservation>,
        }

        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let prior = LegacyState {
            config: BekkoRefillConfig {
                enabled: true,
                ..BekkoRefillConfig::default()
            },
            config_revision: 3,
            next_id: 7,
            active: Some(LegacyAttempt {
                id: 7,
                config_revision: 3,
                started_ns: 1,
                finished_ns: None,
                observed_bekko_cycles: Some(500_000_000_000),
                amount_cycles: 600_000_000_000,
                outcome: BekkoRefillOutcome::Depositing,
            }),
            history: vec![LegacyAttempt {
                id: 6,
                config_revision: 3,
                started_ns: 0,
                finished_ns: Some(0),
                observed_bekko_cycles: Some(700_000_000_000),
                amount_cycles: 0,
                outcome: BekkoRefillOutcome::Sufficient,
            }],
            reservations: vec![BekkoRefillReservation {
                sent_ns: 2,
                amount_cycles: 600_000_000_000,
            }],
        };
        let blob = candid::encode_one(&prior).unwrap();
        svc.write_index(|tx| {
            tx.execute("DROP TABLE vault_refill_state", params![])
                .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE bekko_refill_state SET state = ?1 WHERE singleton = 1",
                params![blob],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
        svc.initialize_bekko_refill(3).unwrap();
        let upgraded = svc.bekko_refill_state().unwrap();
        assert_eq!(upgraded.config, prior.config);
        assert_eq!(upgraded.reservations, prior.reservations);
        assert_eq!(upgraded.history[0].id, 6);
        assert_eq!(upgraded.history[0].outcome, BekkoRefillOutcome::Sufficient);
        let active = upgraded.active.unwrap();
        assert_eq!(active.id, 7);
        assert_eq!(active.target, None);
        assert_eq!(active.amount_cycles, 600_000_000_000);
        assert!(matches!(active.outcome, BekkoRefillOutcome::Unknown(_)));
        assert!(svc.begin_bekko_refill(4).unwrap().is_none());
        assert!(svc.vault_refill_state().unwrap().is_none());
        svc.configure_vault_refill(VaultRefillConfig {
            target: Principal::from_slice(&[22, 1]),
            enabled: true,
            threshold_cycles: 100_000_000_000,
            target_cycles: 800_000_000_000,
            max_transfer_cycles: 800_000_000_000,
        })
        .unwrap();
        let (_, vault) = svc.begin_vault_refill(4).unwrap().unwrap();
        let wiki_balance = 10_000_000_000_000;
        assert_eq!(
            svc.reserve_vault_refill(vault.id, 0, wiki_balance, wiki_balance, 4)
                .unwrap(),
            Some(600_000_000_000)
        );
    }

    #[test]
    fn vault_refill_uses_the_remaining_wiki_budget_after_existing_bekko_deposits() {
        use candid::Principal;
        use vfs_types::VaultRefillConfig;

        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        enabled(&svc);
        for now in [1, 3] {
            let check = svc.begin_bekko_refill(now).unwrap().unwrap();
            assert_eq!(
                svc.reserve_bekko_refill(check.id, 0, 10_000_000_000_000, 10_000_000_000_000, now)
                    .unwrap(),
                Some(600_000_000_000)
            );
            svc.finish_bekko_refill(check.id, BekkoRefillOutcome::Succeeded, now + 1)
                .unwrap();
        }
        assert!(svc.begin_vault_refill(5).unwrap().is_none());
        let target = Principal::from_slice(&[22, 1]);
        svc.configure_vault_refill(VaultRefillConfig {
            target,
            enabled: true,
            threshold_cycles: 100_000_000_000,
            target_cycles: 400_000_000_000,
            max_transfer_cycles: 400_000_000_000,
        })
        .unwrap();
        let (peer, check) = svc.begin_vault_refill(6).unwrap().unwrap();
        assert_eq!(peer, target);
        assert_eq!(
            svc.reserve_vault_refill(check.id, 0, 10_000_000_000_000, 10_000_000_000_000, 7)
                .unwrap(),
            None
        );
        let day = 86_400_000_000_000;
        let (_, check) = svc.begin_vault_refill(day + 1).unwrap().unwrap();
        assert_eq!(
            svc.reserve_vault_refill(check.id, 0, 10_000_000_000_000, 10_000_000_000_000, day + 1)
                .unwrap(),
            Some(400_000_000_000)
        );
        svc.finish_vault_refill(check.id, BekkoRefillOutcome::Succeeded, day + 1)
            .unwrap();
        let check = svc.begin_bekko_refill(day + 2).unwrap().unwrap();
        assert_eq!(
            svc.reserve_bekko_refill(check.id, 0, 10_000_000_000_000, 10_000_000_000_000, day + 2)
                .unwrap(),
            Some(200_000_000_000)
        );
    }

    #[test]
    fn vault_upgrade_keeps_an_uncertain_deposit_locked_to_its_target() {
        use candid::Principal;
        use vfs_types::VaultRefillConfig;

        let dir = tempfile::tempdir().unwrap();
        let svc = service(dir.path());
        let vault = VaultRefillConfig {
            target: Principal::from_slice(&[22, 1]),
            enabled: true,
            threshold_cycles: 100_000_000_000,
            target_cycles: 1_000_000_000_000,
            max_transfer_cycles: 1_000_000_000_000,
        };
        svc.configure_vault_refill(vault.clone()).unwrap();
        let (_, check) = svc.begin_vault_refill(1).unwrap().unwrap();
        let wiki_balance = 10_000_000_000_000;
        assert_eq!(
            svc.reserve_vault_refill(check.id, 0, wiki_balance, wiki_balance, 1)
                .unwrap(),
            Some(1_000_000_000_000)
        );
        svc.initialize_bekko_refill(2).unwrap();
        let status = svc.vault_refill_state().unwrap().unwrap();
        assert_eq!(status.target, vault.target);
        let active = status.state.active.unwrap();
        assert_eq!(active.target, Some(vault.target));
        assert!(matches!(active.outcome, BekkoRefillOutcome::Unknown(_)));
        assert!(svc.begin_vault_refill(3).unwrap().is_none());
        let other = Principal::from_slice(&[23, 1]);
        assert!(
            svc.configure_vault_refill(VaultRefillConfig {
                target: other,
                ..vault.clone()
            })
            .is_err()
        );

        enabled(&svc);
        let bekko = svc.begin_bekko_refill(3).unwrap().unwrap();
        assert_eq!(
            svc.reserve_bekko_refill(bekko.id, 0, wiki_balance, wiki_balance, 3)
                .unwrap(),
            Some(200_000_000_000)
        );
        svc.configure_vault_refill(VaultRefillConfig {
            enabled: false,
            ..vault.clone()
        })
        .unwrap();
        svc.reconcile_vault_refill(
            check.id,
            BekkoRefillResolution::Deposited,
            "confirmed by replica records".into(),
            4,
        )
        .unwrap();
        svc.configure_vault_refill(VaultRefillConfig {
            target: other,
            ..vault
        })
        .unwrap();
        let (_, next) = svc.begin_vault_refill(4).unwrap().unwrap();
        assert_eq!(
            svc.reserve_vault_refill(next.id, 0, wiki_balance, wiki_balance, 4)
                .unwrap(),
            None
        );
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
        let cfg = BekkoRefillConfig {
            enabled: true,
            ..BekkoRefillConfig::default()
        };
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

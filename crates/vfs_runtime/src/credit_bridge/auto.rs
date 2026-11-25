//! Standing refills: the Wiki owner authorizes bounded transfers that the Vault
//! canister may request without another click. Admission is the only new
//! authority; the hold, dispatch and settlement reuse the manual transfer path.
use super::*;

/// Minimum spacing between refills, so a misbehaving peer cannot loop.
pub const AUTO_TOPUP_INTERVAL_NS: u64 = 10 * 60 * 1_000_000_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct AutoState {
    policy: AutoTopupPolicy,
    /// The link generation that authorized this policy; a relink drops it.
    generation: u64,
    day: u64,
    day_total: u64,
    last_at_ns: Option<u64>,
}

/// What the canister should hold and send for one admitted refill.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutoTopupAdmission {
    pub wiki_owner: Principal,
    pub database_id: String,
    pub amount_cycles: u64,
}

fn link_for_vault(c: &Connection, vault_owner: Principal) -> R<Option<Link>> {
    c.query_row(
        "SELECT record FROM credit_bridge_links WHERE vault_owner=?1",
        params![vault_owner.to_text()],
        |r| crate::sqlite::row_get::<String>(r, 0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(decode)
    .transpose()
}
fn database_name(c: &Connection, db: &str) -> R<String> {
    scalar_text(c, "SELECT name FROM databases WHERE database_id=?1", db)
}
fn scalar_text(c: &Connection, sql: &str, key: &str) -> R<String> {
    c.query_row(sql, params![key], |r| crate::sqlite::row_get(r, 0))
        .map_err(|e| e.to_string())
}
fn validate(policy: &AutoTopupPolicy) -> R<()> {
    if policy.database_id.is_empty()
        || policy.database_id.len() > 128
        || policy.threshold_cycles == 0
        || policy.amount_cycles == 0
        || policy.daily_limit_cycles < policy.amount_cycles
        || [
            policy.threshold_cycles,
            policy.amount_cycles,
            policy.daily_limit_cycles,
            policy.min_database_cycles,
        ]
        .iter()
        .any(|v| *v > i64::MAX as u64)
    {
        return Err("InvalidInput".into());
    }
    Ok(())
}
/// The policy only counts while it belongs to the current active link.
fn current(c: &Connection, l: &Link) -> R<Option<AutoState>> {
    let Some(state) = l.auto.clone() else {
        return Ok(None);
    };
    if !l.active
        || state.generation != l.proof.challenge.generation
        || l.proof.challenge.generation <= fence(c, l.proof.challenge.vault_owner)?
    {
        return Ok(None);
    }
    Ok(Some(state))
}
fn status(c: &Connection, state: &AutoState, now: u64) -> R<AutoTopupStatus> {
    Ok(AutoTopupStatus {
        database_name: database_name(c, &state.policy.database_id)?,
        sent_today_cycles: if state.day == now / DAY {
            state.day_total
        } else {
            0
        },
        last_topup_at_ns: state.last_at_ns,
        policy: state.policy.clone(),
    })
}

impl VfsService {
    /// The Wiki owner sets, replaces (counters kept for the same day) or clears the policy.
    pub fn set_vault_auto_topup(
        &self,
        p: Principal,
        policy: Option<AutoTopupPolicy>,
        now: u64,
    ) -> R<Option<AutoTopupStatus>> {
        auth(p)?;
        self.write_index(|c| {
            enabled(c)?;
            let mut l = active_link(c, p)?;
            let previous = current(c, &l)?;
            l.auto = match policy {
                None => None,
                Some(policy) => {
                    validate(&policy)?;
                    owner(c, &policy.database_id, p)?;
                    let (day, day_total, last_at_ns) = match previous {
                        Some(old) if old.day == now / DAY => {
                            (old.day, old.day_total, old.last_at_ns)
                        }
                        Some(old) => (now / DAY, 0, old.last_at_ns),
                        None => (now / DAY, 0, None),
                    };
                    Some(AutoState {
                        policy,
                        generation: l.proof.challenge.generation,
                        day,
                        day_total,
                        last_at_ns,
                    })
                }
            };
            save_link(c, &l)?;
            l.auto.as_ref().map(|s| status(c, s, now)).transpose()
        })
    }
    pub fn get_vault_auto_topup(&self, p: Principal, now: u64) -> R<Option<AutoTopupStatus>> {
        auth(p)?;
        self.read_index(|c| {
            let Some(l) = link(c, p)? else {
                return Ok(None);
            };
            current(c, &l)?.map(|s| status(c, &s, now)).transpose()
        })
    }
    /// The Vault canister reads the policy of its account's linked Wiki owner.
    pub fn vault_auto_topup_status(
        &self,
        peer: Principal,
        vault_owner: Principal,
        now: u64,
    ) -> R<Option<AutoTopupStatus>> {
        self.vault_bridge_peer(peer)?;
        self.read_index(|c| {
            let Some(l) = link_for_vault(c, vault_owner)? else {
                return Ok(None);
            };
            current(c, &l)?.map(|s| status(c, &s, now)).transpose()
        })
    }
    /// Admits one refill for `vault_owner` and records it against the policy.
    /// Returns `None` when no refill is due; errors mean the request is refused.
    pub fn admit_vault_auto_topup(
        &self,
        peer: Principal,
        vault_owner: Principal,
        vault_balance: u64,
        estimated_fee: u64,
        now: u64,
    ) -> R<Option<AutoTopupAdmission>> {
        self.vault_bridge_peer(peer)?;
        auth(vault_owner)?;
        self.write_index(|c| {
            let s = enabled(c)?;
            let Some(mut l) = link_for_vault(c, vault_owner)? else {
                return Err("NotFound".into());
            };
            let Some(mut state) = current(c, &l)? else {
                return Err("NotFound".into());
            };
            if vault_balance >= state.policy.threshold_cycles {
                return Ok(None);
            }
            if state
                .last_at_ns
                .is_some_and(|at| now < at.saturating_add(AUTO_TOPUP_INTERVAL_NS))
            {
                return Ok(None);
            }
            let wiki_owner = l.proof.wiki_owner;
            let db = state.policy.database_id.clone();
            owner(c, &db, wiki_owner)?;
            // One outstanding transfer per payer: an unresolved one must settle first.
            if scalar(
                c,
                "SELECT count(*) FROM credit_bridge_transfers WHERE payer=?1 AND unresolved=1",
                &wiki_owner.to_text(),
            )? > 0
            {
                return Err("Conflict".into());
            }
            let amount = state.policy.amount_cycles;
            let sent_today = if state.day == now / DAY {
                state.day_total
            } else {
                0
            };
            if u128::from(sent_today) + u128::from(amount) > u128::from(state.policy.daily_limit_cycles)
                || daily(c, now)? + u128::from(amount) > u128::from(s.config.daily_limit_cycles)
            {
                return Err("Capacity".into());
            }
            settle_storage(c, &db, wiki_owner, now)?;
            let balance = database_balance_for_update(c, &db)?.max(0) as u128;
            if balance
                < u128::from(amount)
                    + u128::from(estimated_fee)
                    + u128::from(state.policy.min_database_cycles)
            {
                return Err("Capacity".into());
            }
            state.day = now / DAY;
            state.day_total = sent_today + amount;
            state.last_at_ns = Some(now);
            l.auto = Some(state);
            save_link(c, &l)?;
            Ok(Some(AutoTopupAdmission {
                wiki_owner,
                database_id: db,
                amount_cycles: amount,
            }))
        })
    }
}

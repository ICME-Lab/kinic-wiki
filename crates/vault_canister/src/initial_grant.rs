//! Account bootstrap; queries remain allocation-free. Permanent receipts survive
//! resource deletion, empty balances, and later upgrades.
use candid::{CandidType, Principal};
use kinic_cycle_grants::{Scope, VAULT_INITIAL_CYCLES, record_once, recorded};
use kinic_sqlite_compat::{self as sql, params};
use serde::{Deserialize, Serialize};
use vault_types::{Error, Result};
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct AccountInitialization {
    pub balance: u64,
    pub grant_cycles: u64,
}
pub const SCHEMA: &str = "CREATE TABLE initial_cycle_grants(principal TEXT PRIMARY KEY NOT NULL,database_id TEXT NOT NULL,grant_cycles INTEGER NOT NULL CHECK(grant_cycles>=0),created_at_ms INTEGER NOT NULL);";
impl crate::state::State {
    pub fn initialize_account(&self, owner: Principal, now: i64) -> Result<AccountInitialization> {
        vault_store::OwnerContext::authenticated(owner)?;
        crate::state::transaction(|db| {
            let principal = owner.to_text();
            let grant = recorded(db, Scope::Vault, &principal).map_err(|_| Error::Storage)?;
            let cycles = if let Some(amount) = grant {
                amount
            } else {
                let cycles = VAULT_INITIAL_CYCLES;
                crate::key_subsidy::initialize_in(db, &principal)?;
                crate::accounting::settle_storage(db, &principal, now)
                    .map_err(|_| Error::Storage)?;
                match crate::accounting::admit_credit(db, &principal, cycles, None) {
                    Ok(()) => {}
                    Err(Error::QuotaExceeded) => {
                        // Do not consume eligibility or block reconciliation of a
                        // transfer already paid. A later initialization can claim.
                        let balance:i64=db.query_row("SELECT COALESCE((SELECT balance_cycles FROM accounts WHERE owner=?1),0)",params![principal],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
                        return Ok(AccountInitialization {
                            balance: balance as u64,
                            grant_cycles: 0,
                        });
                    }
                    Err(error) => return Err(error),
                }
                if !record_once(db, Scope::Vault, &principal, "vault", cycles, now)
                    .map_err(|_| Error::Storage)?
                {
                    return Err(Error::Conflict);
                }
                if cycles > 0 {
                    let previous:i64=db.query_row("SELECT COALESCE((SELECT balance_cycles FROM accounts WHERE owner=?1),0)",params![principal],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
                    let balance = previous
                        .checked_add(cycles as i64)
                        .ok_or(Error::QuotaExceeded)?;
                    db.execute("INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES(?1,?2,?3) ON CONFLICT(owner) DO UPDATE SET balance_cycles=excluded.balance_cycles",params![principal,balance,now]).map_err(|_|Error::Storage)?;
                    crate::accounting::record_entry(
                        db,
                        &principal,
                        "free_grant",
                        cycles as i64,
                        balance,
                        now,
                        None,
                    )?;
                }
                cycles
            };
            let balance: i64 = db
                .query_row(
                    "SELECT COALESCE((SELECT balance_cycles FROM accounts WHERE owner=?1),0)",
                    params![principal],
                    |r| sql::row_get(r, 0),
                )
                .map_err(|_| Error::Storage)?;
            Ok(AccountInitialization {
                balance: balance.max(0) as u64,
                grant_cycles: cycles,
            })
        })
    }
}
#[ic_cdk::update]
fn initialize_vault_account() -> Result<AccountInitialization> {
    crate::state::State.initialize_account(ic_cdk::api::msg_caller(), crate::now_millis())
}
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct KeyRetrievalCost {
    pub fee: u64,
    pub owner_fee: u64,
    pub first_key_free: bool,
}
#[ic_cdk::query]
fn vault_key_cost(key_name: Option<String>) -> Result<KeyRetrievalCost> {
    vault_store::OwnerContext::authenticated(ic_cdk::api::msg_caller())?;
    let key_name = match key_name {
        Some(name) => name,
        None => {
            crate::state::State
                .vault_config()?
                .ok_or(Error::KeyService)?
                .key_name
        }
    };
    let fee = ic_cdk::api::cost_vetkd_derive_key(&key_name, 0)
        .ok()
        .and_then(|n| u64::try_from(n).ok())
        .ok_or(Error::KeyService)?;
    let owner = ic_cdk::api::msg_caller().to_text();
    let first_key_free =
        crate::state::transaction(|db| crate::key_subsidy::available_in(db, &owner))?;
    Ok(KeyRetrievalCost {
        fee,
        owner_fee: if first_key_free { 0 } else { fee },
        first_key_free,
    })
}

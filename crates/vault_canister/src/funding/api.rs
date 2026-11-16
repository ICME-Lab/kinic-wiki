//! Authenticated funding endpoints and async orchestration.
use super::ledger::require_ledger;
use super::{
    FundingConfig, Outcome, Payment, PurchaseRequest, QuoteAdmission, Status, admit_quote, auth,
    begin_payment, complete_payment, finish_quote, ledger, load, reconciliation, save, transaction,
};
use kinic_sqlite_compat::{self as sql, params};
use vault_types::Error;

#[ic_cdk::update]
fn set_funding_config(config: Option<FundingConfig>) -> vault_types::Result<()> {
    if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        return Err(Error::Unauthorized);
    }
    if let Some(c) = &config {
        auth(c.ledger)?;
        require_ledger(c.ledger)?;
        auth(c.recipient)?;
        if c.cycles_per_kinic == 0 || c.cycles_per_kinic > i64::MAX as u64 {
            return Err(Error::InvalidInput);
        }
    }
    transaction(|db| {
        db.execute("INSERT INTO global_settings(key,value) VALUES('funding',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![serde_json::to_string(&config).map_err(|_|Error::Storage)?]).map_err(|_|Error::Storage)?;
        Ok(())
    })
}
#[ic_cdk::query]
fn account_balance() -> vault_types::Result<u64> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    crate::state::State.balance(&caller.to_text())
}
#[ic_cdk::query]
fn payment_status(operation: Vec<u8>) -> vault_types::Result<Option<Payment>> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    if operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    transaction(|db| load(db, caller, &operation))
}
#[ic_cdk::update]
async fn quote_purchase(request: PurchaseRequest) -> vault_types::Result<Payment> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    auth(request.beneficiary)?;
    if request.operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    if let Some(p) = transaction(|db| load(db, caller, &request.operation))? {
        return if p.request == request {
            Ok(p)
        } else {
            Err(Error::Conflict)
        };
    }
    let config: FundingConfig = transaction(|db| {
        let raw: String = db
            .query_row(
                "SELECT value FROM global_settings WHERE key='funding'",
                params![],
                |r| sql::row_get(r, 0),
            )
            .map_err(|_| Error::Unauthorized)?;
        serde_json::from_str::<Option<FundingConfig>>(&raw)
            .map_err(|_| Error::Storage)?
            .ok_or(Error::Unauthorized)
    })?;
    require_ledger(config.ledger)?;
    let flight = match admit_quote(caller, request, config, crate::now_nanos())? {
        QuoteAdmission::Existing(payment) => return Ok(payment),
        QuoteAdmission::Fee(flight) => flight,
    };
    let fee = ledger::fee(flight.payment.config.ledger).await;
    finish_quote(&flight, fee, crate::now_nanos())
}
#[ic_cdk::update]
async fn pay_purchase(operation: Vec<u8>) -> vault_types::Result<Payment> {
    if operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    let ledger = transaction(|db| {
        Ok(load(db, caller, &operation)?
            .ok_or(Error::NotFound)?
            .config
            .ledger)
    })?;
    require_ledger(ledger)?;
    let p = begin_payment(caller, &operation, crate::now_nanos())?;
    if p.reconciliation.is_none() && p.uncertain {
        return complete_payment(&p, Outcome::Unknown);
    }
    // Persist the history lower bound and spender before the first possible debit.
    // An existing immutable snapshot is retained for byte-for-byte retries.
    let p = if p.reconciliation.is_none() {
        reconciliation::begin_preparation(&p)?
    } else {
        p
    };
    let start = match &p.reconciliation {
        Some(scan) => scan.start,
        None => match reconciliation::ledger_tip(p.config.ledger).await {
            Ok(start) => start,
            Err(_) => return reconciliation::finish_preparation(&p),
        },
    };
    let p = reconciliation::prepare_dispatch(&p, ic_cdk::api::canister_self(), start)?;
    let outcome = ledger::transfer_from(&p).await;
    complete_payment(&p, outcome)
}

#[ic_cdk::query]
fn list_payments() -> vault_types::Result<Vec<Payment>> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    transaction(|db| {
        let mut statement = db
            .prepare("SELECT record FROM payments WHERE wallet=?1 ORDER BY expires DESC LIMIT 16")
            .map_err(|_| Error::Storage)?;
        let rows: Vec<String> = sql::query_map(&mut statement, params![caller.to_text()], |r| {
            sql::row_get(r, 0)
        })
        .map_err(|_| Error::Storage)?;
        rows.into_iter()
            .map(|r| serde_json::from_str(&r).map_err(|_| Error::Storage))
            .collect()
    })
}
#[ic_cdk::update]
fn cancel_quote(operation: Vec<u8>) -> vault_types::Result<Payment> {
    let caller = ic_cdk::api::msg_caller();
    auth(caller)?;
    if operation.len() != 16 {
        return Err(Error::InvalidInput);
    }
    transaction(|db| {
        let mut p = load(db, caller, &operation)?.ok_or(Error::NotFound)?;
        if !matches!(p.status, Status::Quoted) {
            return Err(Error::Conflict);
        }
        p.status = Status::Expired;
        save(db, &p)?;
        Ok(p)
    })
}

use candid::{CandidType, Principal};
use kinic_sqlite_compat::{self as sql, OptionalExtension, params};

#[derive(CandidType)]
pub(super) enum RefillResult<T> {
    Ok(T),
    Err(String),
}

impl<T> From<Result<T, String>> for RefillResult<T> {
    fn from(result: Result<T, String>) -> Self {
        match result {
            Ok(value) => Self::Ok(value),
            Err(error) => Self::Err(error),
        }
    }
}

#[ic_cdk::update]
fn set_cycles_refill_source(source: Option<Principal>) -> RefillResult<()> {
    configure_source(source).into()
}

fn configure_source(source: Option<Principal>) -> Result<(), String> {
    if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        return Err("forbidden".into());
    }
    if let Some(source) = source
        && (source == Principal::anonymous()
            || source == Principal::management_canister()
            || source == ic_cdk::api::canister_self())
    {
        return Err("invalid refill source".into());
    }
    store_source(source)
}

fn store_source(source: Option<Principal>) -> Result<(), String> {
    crate::state::transaction(|db| {
        if let Some(source) = source {
            db.execute(
                "INSERT INTO global_settings(key,value) VALUES('cycles_refill_source',?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![source.to_text()],
            )
        } else {
            db.execute(
                "DELETE FROM global_settings WHERE key='cycles_refill_source'",
                params![],
            )
        }
        .map_err(|_| vault_types::Error::Storage)?;
        Ok(())
    })
    .map_err(|e| format!("refill source: {e:?}"))
}

#[ic_cdk::update]
fn cycles_balance_for_wiki() -> RefillResult<u128> {
    balance_for_caller().into()
}

fn load_source() -> Result<Option<String>, String> {
    crate::state::read(|db| {
        db.query_row(
            "SELECT value FROM global_settings WHERE key='cycles_refill_source'",
            params![],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| vault_types::Error::Storage)
    })
    .map_err(|e| format!("refill source: {e:?}"))
}

fn balance_for_caller() -> Result<u128, String> {
    let source = load_source()?;
    if source.as_deref() != Some(&ic_cdk::api::msg_caller().to_text()) {
        return Err("forbidden".into());
    }
    Ok(ic_cdk::api::canister_cycle_balance())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_source_succeeds_when_all_seven_other_global_settings_are_present() {
        crate::state::initialize().unwrap();
        crate::state::transaction(|db| {
            for key in [
                "config",
                "funding",
                "generation",
                "quote_fee_serial",
                "gc-owner",
                "serial",
                "bridge",
            ] {
                db.execute(
                    "INSERT INTO global_settings(key,value) VALUES(?1,?2)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![key, format!("seeded:{key}")],
                )
                .unwrap();
            }
            Ok(())
        })
        .unwrap();

        let wiki = Principal::from_slice(&[7; 29]);
        let next_wiki = Principal::from_slice(&[8; 29]);
        store_source(Some(wiki)).unwrap();
        assert_eq!(load_source().unwrap(), Some(wiki.to_text()));
        store_source(Some(next_wiki)).unwrap();
        assert_eq!(load_source().unwrap(), Some(next_wiki.to_text()));
        store_source(None).unwrap();
        assert_eq!(load_source().unwrap(), None);
    }
}

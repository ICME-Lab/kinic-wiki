//! One-time grant receipts shared by Wiki and Vault. The caller owns the outer
//! transaction, so its balance/ledger writes commit or roll back with the receipt.
use kinic_sqlite_compat::{Connection, OptionalExtension, params};
pub const WIKI_INITIAL_CYCLES: u64 = 10_000_000_000;
pub const VAULT_INITIAL_CYCLES: u64 = 10_000_000_000;
#[derive(Clone, Copy)]
pub enum Scope {
    Wiki,
    Vault,
}
impl Scope {
    fn table(self) -> &'static str {
        match self {
            Self::Wiki => "database_free_cycle_grants",
            Self::Vault => "initial_cycle_grants",
        }
    }
}
pub fn recorded(db: &Connection, scope: Scope, principal: &str) -> Result<Option<u64>, String> {
    let amount: Option<i64> = db
        .query_row(
            &format!(
                "SELECT grant_cycles FROM {} WHERE principal=?1",
                scope.table()
            ),
            params![principal],
            |r| kinic_sqlite_compat::row_get(r, 0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    amount
        .map(|n| u64::try_from(n).map_err(|_| "negative initial grant".to_string()))
        .transpose()
}
/// False means a permanent receipt already exists. The unique principal key is
/// authoritative; never infer eligibility from current balance or resource count.
pub fn record_once(
    db: &Connection,
    scope: Scope,
    principal: &str,
    resource: &str,
    cycles: u64,
    now: i64,
) -> Result<bool, String> {
    if principal.is_empty() || principal == "2vxsx-fae" {
        return Err("authenticated grant owner required".into());
    }
    let cycles = i64::try_from(cycles).map_err(|_| "initial grant overflow")?;
    if recorded(db, scope, principal)?.is_some() {
        return Ok(false);
    }
    db.execute(
        &format!(
            "INSERT INTO {}(principal,database_id,grant_cycles,created_at_ms) VALUES(?1,?2,?3,?4)",
            scope.table()
        ),
        params![principal, resource, cycles, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipts_are_once_per_scope_and_rollback_with_credit() {
        let mut db = Connection::open_in_memory().unwrap();
        for table in ["database_free_cycle_grants", "initial_cycle_grants"] {
            db.execute_batch(&format!("CREATE TABLE {table}(principal TEXT PRIMARY KEY,database_id TEXT,grant_cycles INTEGER,created_at_ms INTEGER);" )).unwrap();
        }
        {
            let tx = db.transaction().unwrap();
            assert!(
                record_once(&tx, Scope::Vault, "owner", "vault", VAULT_INITIAL_CYCLES, 1).unwrap()
            );
        }
        assert_eq!(recorded(&db, Scope::Vault, "owner").unwrap(), None);
        assert!(record_once(&db, Scope::Vault, "owner", "vault", VAULT_INITIAL_CYCLES, 2).unwrap());
        assert!(
            !record_once(&db, Scope::Vault, "owner", "vault", VAULT_INITIAL_CYCLES, 3).unwrap()
        );
        assert!(record_once(&db, Scope::Wiki, "owner", "db", WIKI_INITIAL_CYCLES, 3).unwrap());
        assert_eq!(
            recorded(&db, Scope::Vault, "owner").unwrap(),
            Some(10_000_000_000)
        );
        assert!(record_once(&db, Scope::Vault, "2vxsx-fae", "vault", 1, 1).is_err());
    }
}

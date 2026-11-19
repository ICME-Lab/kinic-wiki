//! Private accounting admission and whole-row guards. Existing rows are never
//! rebuilt/deleted on upgrade; constraints apply at allocation/update boundaries.
use kinic_sqlite_compat::{self as sql, Connection, params};
use vault_types::{Error, Result, capacity::*};

fn bytes(name: &str) -> String {
    format!("4+length(CAST(NEW.{name} AS BLOB))")
}
fn guard(
    statements: &mut Vec<String>,
    table: &str,
    variables: &[&str],
    scalars: usize,
    max: usize,
    extra: &str,
) {
    let size = variables
        .iter()
        .map(|v| bytes(v))
        .chain(std::iter::once((scalars * 8).to_string()))
        .collect::<Vec<_>>()
        .join("+");
    for event in ["INSERT", "UPDATE"] {
        statements.push(format!("CREATE TRIGGER IF NOT EXISTS accounting_{table}_{event}_size BEFORE {event} ON {table} WHEN ({size})>{max} {extra} BEGIN SELECT RAISE(ABORT,'accounting row capacity'); END;"));
    }
}
fn count_guard(
    statements: &mut Vec<String>,
    table: &str,
    key: &str,
    limit: usize,
    exception: &str,
) {
    statements.push(format!("CREATE TRIGGER IF NOT EXISTS accounting_{table}_count BEFORE INSERT ON {table} WHEN NOT EXISTS(SELECT 1 FROM {table} WHERE {key}) AND (SELECT count(*) FROM {table})>={limit} {exception} BEGIN SELECT RAISE(ABORT,'accounting count capacity'); END;"));
}
pub(crate) fn schema_statements() -> Vec<String> {
    let mut statements = Vec::new();
    guard(
        &mut statements,
        "accounts",
        &["owner"],
        4,
        SMALL_ROW,
        &format!("OR length(CAST(NEW.owner AS BLOB))>{PRINCIPAL_TEXT}"),
    );
    guard(
        &mut statements,
        "payments",
        &["wallet", "operation", "record"],
        1,
        PAYMENT_ROW,
        "OR length(NEW.operation)<>16 OR length(CAST(NEW.wallet AS BLOB))>63",
    );
    guard(
        &mut statements,
        "quote_fee_flights",
        &["wallet", "operation", "record"],
        3,
        PAYMENT_ROW,
        "OR length(NEW.operation)<>16 OR length(CAST(NEW.wallet AS BLOB))>63",
    );
    count_guard(
        &mut statements,
        "quote_fee_flights",
        "wallet=NEW.wallet AND operation=NEW.operation",
        FEE_FLIGHTS,
        "",
    );
    guard(
        &mut statements,
        "vault_cycle_reservations",
        &["owner", "token"],
        8,
        SMALL_ROW,
        &format!(
            "OR length(CAST(NEW.owner AS BLOB))>{PRINCIPAL_TEXT} OR length(CAST(NEW.token AS BLOB))>{TOKEN} OR length(NEW.token)=0"
        ),
    );
    guard(
        &mut statements,
        "account_ledger",
        &["owner", "kind", "operation"],
        4,
        SMALL_ROW,
        &format!(
            "OR length(CAST(NEW.owner AS BLOB))>{PRINCIPAL_TEXT} OR length(CAST(NEW.kind AS BLOB))>{KIND} OR length(NEW.operation)>16"
        ),
    );
    // Seven fixed global setting slots plus the billing cursor fit the prepaid pool.
    guard(
        &mut statements,
        "global_settings",
        &["key", "value"],
        0,
        SETTING_ROW,
        "",
    );
    count_guard(
        &mut statements,
        "global_settings",
        "key=NEW.key",
        SETTING_SLOTS,
        "",
    );
    guard(
        &mut statements,
        "vault_storage_billing_state",
        &["cursor_owner"],
        2,
        BILLING_CURSOR_ROW,
        "OR length(CAST(NEW.cursor_owner AS BLOB))>63",
    );
    statements
}
/// Allocate the beneficiary account row in the same transaction as dispatch admission.
pub(crate) fn allocate_beneficiary(
    db: &Connection,
    beneficiary: candid::Principal,
    now: u64,
) -> Result<()> {
    db.execute(
        "INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms)
         VALUES(?1,0,0,?2) ON CONFLICT(owner) DO NOTHING",
        params![beneficiary.to_text(), (now / 1_000_000) as i64],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}

pub(crate) const PAYMENT_COMPLETION_BYTES: u64 = 1_048_576;

/// Allocate SQLite pages before a transfer could have been dispatched.
pub(crate) fn reserve_payment_completion(
    db: &Connection,
    wallet: candid::Principal,
    operation: &[u8],
) -> Result<()> {
    db.execute(
        "INSERT INTO payment_completion_reservations(wallet,operation,spare)
         VALUES(?1,?2,zeroblob(?3)) ON CONFLICT(wallet,operation) DO NOTHING",
        params![wallet.to_text(), operation, PAYMENT_COMPLETION_BYTES as i64],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}

/// Release this wallet's expired slots, then make bounded progress on global
/// expiry without turning one new admission into an unbounded delete.
pub(crate) fn collect_expired_payments(
    db: &Connection,
    wallet: candid::Principal,
    now_seconds: i64,
) -> Result<()> {
    db.execute("DELETE FROM payments WHERE rowid IN (SELECT rowid FROM payments WHERE wallet=?1 AND expires<?2 ORDER BY expires LIMIT 16)",params![wallet.to_text(),now_seconds]).map_err(|_|Error::Storage)?;
    db.execute("DELETE FROM payments WHERE rowid IN (SELECT rowid FROM payments WHERE expires<?1 ORDER BY expires LIMIT 128)",params![now_seconds]).map_err(|_|Error::Storage)?;
    Ok(())
}
pub(crate) fn release_payment_completion(
    db: &Connection,
    wallet: candid::Principal,
    operation: &[u8],
) -> Result<()> {
    db.execute(
        "DELETE FROM payment_completion_reservations WHERE wallet=?1 AND operation=?2",
        params![wallet.to_text(), operation],
    )
    .map_err(|_| Error::Storage)?;
    Ok(())
}

/// Sum logical reservations for aggregate reporting. Admission never calls this.
pub(crate) fn accounting_reserved(db: &Connection) -> Result<u64> {
    let mut total = 0u64;
    for (table, row) in [
        ("accounts", SMALL_ROW as u64),
        ("payments", PAYMENT_ROW as u64),
        ("quote_fee_flights", PAYMENT_ROW as u64),
        ("vault_cycle_reservations", SMALL_ROW as u64),
        ("account_ledger", SMALL_ROW as u64),
        ("vault_storage_billing_state", BILLING_CURSOR_ROW as u64),
        ("initial_cycle_grants", GRANT_ROW as u64),
        ("key_subsidies", SUBSIDY_ROW as u64),
        ("payment_completion_reservations", PAYMENT_COMPLETION_BYTES),
    ] {
        let count: i64 = db
            .query_row(&format!("SELECT count(*) FROM {table}"), params![], |r| {
                sql::row_get(r, 0)
            })
            .map_err(|_| Error::Storage)?;
        let bytes = u64::try_from(count)
            .map_err(|_| Error::Storage)?
            .checked_mul(row)
            .ok_or(Error::Storage)?;
        total = total.checked_add(bytes).ok_or(Error::Storage)?;
    }
    Ok(total)
}

/// Receipts are permanent and independently bounded; old DDL remains immutable
/// so a v9 image is validated before migrating it.
pub(crate) fn grant_schema_statements() -> Vec<String> {
    let mut statements = vec![crate::initial_grant::SCHEMA.to_owned()];
    guard(
        &mut statements,
        "initial_cycle_grants",
        &["principal", "database_id"],
        2,
        128,
        "OR length(CAST(NEW.principal AS BLOB))>63 OR length(CAST(NEW.database_id AS BLOB))>5",
    );
    count_guard(
        &mut statements,
        "initial_cycle_grants",
        "principal=NEW.principal",
        vault_types::capacity::GRANT_RECEIPTS,
        "",
    );
    statements
}

pub(crate) fn subsidy_schema_statements() -> Vec<String> {
    let mut statements = vec![crate::key_subsidy::SCHEMA.to_owned()];
    guard(
        &mut statements,
        "key_subsidies",
        &["owner", "token"],
        3,
        vault_types::capacity::SUBSIDY_ROW,
        "OR length(CAST(NEW.owner AS BLOB))>63 OR length(CAST(NEW.token AS BLOB))>128",
    );
    count_guard(
        &mut statements,
        "key_subsidies",
        "owner=NEW.owner",
        vault_types::capacity::SUBSIDIES,
        "",
    );
    statements
}

/// Reserve both bridge and ICRC credits and execution refunds before any external debit.
pub(crate) fn admit_credit(
    db: &Connection,
    owner: candid::Principal,
    wallet: candid::Principal,
    operation: &[u8],
    credits: u64,
) -> Result<()> {
    crate::accounting::admit_credit(
        db,
        &owner.to_text(),
        credits,
        Some((&wallet.to_text(), operation)),
    )
}

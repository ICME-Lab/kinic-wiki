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
    // Confirmed credits replace a durable pending membership. New accounts cannot bypass transfer admission.
    count_guard(
        &mut statements,
        "accounts",
        "owner=NEW.owner",
        ACCOUNTS,
        "AND NOT EXISTS(SELECT 1 FROM payments WHERE json_extract(record,'$.request.beneficiary')=NEW.owner AND json_extract(record,'$.status') IN ('InFlight','Unknown'))",
    );
    guard(
        &mut statements,
        "payments",
        &["wallet", "operation", "record"],
        1,
        PAYMENT_ROW,
        "OR length(NEW.operation)<>16 OR length(CAST(NEW.wallet AS BLOB))>63",
    );
    count_guard(
        &mut statements,
        "payments",
        "wallet=NEW.wallet AND operation=NEW.operation",
        PAYMENTS,
        "",
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
    count_guard(
        &mut statements,
        "vault_cycle_reservations",
        "owner=NEW.owner AND token=NEW.token",
        RESERVATIONS,
        "",
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
    count_guard(&mut statements, "account_ledger", "id=NEW.id", AUDIT, "");
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
/// Pending payments reserve the future beneficiary account before debit.
pub fn admit_beneficiary(db: &Connection, beneficiary: candid::Principal) -> Result<()> {
    let mut owners = std::collections::BTreeSet::<String>::new();
    let mut stmt = db
        .prepare("SELECT owner FROM accounts")
        .map_err(|_| Error::Storage)?;
    owners.extend(
        sql::query_map(&mut stmt, params![], |r| sql::row_get::<String>(r, 0))
            .map_err(|_| Error::Storage)?,
    );
    for payment in crate::funding::all_payments(db)? {
        let p = payment?;
        if matches!(
            p.status,
            crate::funding::Status::InFlight | crate::funding::Status::Unknown
        ) {
            owners.insert(p.request.beneficiary.to_text());
        }
    }
    for (owner, _, _) in crate::bridge::reservations(db)? {
        owners.insert(owner.to_text());
    }
    if !owners.contains(&beneficiary.to_text()) && owners.len() >= ACCOUNTS {
        return Err(Error::QuotaExceeded);
    }
    Ok(())
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

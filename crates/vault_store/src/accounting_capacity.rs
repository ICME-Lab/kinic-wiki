//! Conservative legacy excess above the dedicated accounting pool's admissions.
//! Current-version rows fit the fixed floor. Protected old commitments are never
//! erased to enforce new limits, and their excess must not disappear from usage.
use crate::*;
use vault_types::capacity::*;
fn count(db: &Connection, table: &str) -> Result<u64> {
    let n: i64 = db
        .query_row(&format!("SELECT count(*) FROM {table}"), params![], |r| {
            sql::row_get(r, 0)
        })
        .map_err(|_| Error::Storage)?;
    u64::try_from(n).map_err(|_| Error::Storage)
}
fn excess(
    db: &Connection,
    table: &str,
    variables: &[&str],
    scalars: usize,
    rows: Option<usize>,
    bytes: usize,
) -> Result<u64> {
    // Count the complete logical row, including duplicated columns and nullable
    // scalar widths, with the same canonical encoding used by write guards.
    let size = variables
        .iter()
        .map(|v| format!("4+coalesce(length(CAST({v} AS BLOB)),0)"))
        .chain(std::iter::once((scalars * 8).to_string()))
        .collect::<Vec<_>>()
        .join("+");
    let oversized: i64 = db
        .query_row(
            &format!("SELECT coalesce(sum(max(0,({size})-{bytes})),0) FROM {table}"),
            params![],
            |r| sql::row_get(r, 0),
        )
        .map_err(|_| Error::Storage)?;
    let extra_rows = match rows {
        Some(limit) => count(db, table)?.saturating_sub(limit as u64),
        None => 0,
    };
    Ok(extra_rows
        .saturating_mul(bytes as u64)
        .saturating_add(u64::try_from(oversized).map_err(|_| Error::Storage)?))
}
pub(crate) fn legacy_excess(db: &Connection) -> Result<u64> {
    // Pure store/service fixtures do not own dedicated accounting tables. The
    // dedicated schema creates all these tables atomically before serving calls.
    let exists: i64 = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounts')",
            params![],
            |r| sql::row_get(r, 0),
        )
        .map_err(|_| Error::Storage)?;
    if exists == 0 {
        return Ok(0);
    }
    let commitments:i64=db.query_row("SELECT count(*) FROM (SELECT owner FROM accounts UNION SELECT json_extract(record,'$.request.beneficiary') FROM payments WHERE json_extract(record,'$.status') IN ('InFlight','Unknown'))",params![],|r|sql::row_get(r,0)).map_err(|_|Error::Storage)?;
    // Pending absent beneficiaries already reserve their full future account row;
    // a callback replacing membership with a funded account cannot grow excess.
    let mut total = (commitments as u64)
        .saturating_sub(ACCOUNTS as u64)
        .saturating_mul(SMALL_ROW as u64);
    // Account counts were charged by the commitment union; charge only their
    // oversized encoded values here, without counting existing accounts twice.
    total = total.saturating_add(excess(db, "accounts", &["owner"], 3, None, SMALL_ROW)?);
    for (table, variables, scalars, rows, bytes) in [
        (
            "payments",
            &["wallet", "operation", "record"][..],
            1,
            PAYMENTS,
            PAYMENT_ROW,
        ),
        (
            "quote_fee_flights",
            &["wallet", "operation", "record"][..],
            3,
            FEE_FLIGHTS,
            PAYMENT_ROW,
        ),
        (
            "vault_cycle_reservations",
            &["owner", "token", "account_owner"][..],
            8,
            RESERVATIONS,
            SMALL_ROW,
        ),
        (
            "account_ledger",
            &["owner", "kind", "operation"][..],
            4,
            AUDIT,
            SMALL_ROW,
        ),
        (
            "global_settings",
            &["key", "value"][..],
            0,
            SETTING_SLOTS,
            SETTING_ROW,
        ),
        (
            "vault_storage_billing_state",
            &["cursor_owner"][..],
            2,
            1,
            BILLING_CURSOR_ROW,
        ),
    ] {
        total = total.saturating_add(excess(db, table, variables, scalars, Some(rows), bytes)?);
    }
    Ok(total)
}

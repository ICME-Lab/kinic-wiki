//! Materialized funding and bridge admission totals maintained with the payment journal.
use kinic_sqlite_compat::{self as sql, Connection, OptionalExtension, params};
use vault_types::{Error, Result};

struct Hold {
    name: &'static str,
    kind: &'static str,
    status: &'static str,
    bucket: &'static str,
    amount: &'static str,
}

const HOLDS: [Hold; 4] = [
    Hold {
        name: "purchase_owner",
        kind: "beneficiary",
        status: "json_extract(doc,'$.status') IN ('InFlight','Unknown')",
        bucket: "json_extract(doc,'$.request.beneficiary')",
        amount: "json_extract(doc,'$.credits')",
    },
    Hold {
        name: "bridge_owner",
        kind: "beneficiary",
        status: "json_extract(doc,'$.bridge_v1.Credit.status')='Prepared'",
        bucket: "json_extract(doc,'$.bridge_v1.Credit.offer.vault_owner')",
        amount: "json_extract(doc,'$.bridge_v1.Credit.offer.amount_cycles')",
    },
    Hold {
        name: "bridge_prepared",
        kind: "bridge_prepared",
        status: "json_extract(doc,'$.bridge_v1.Credit.status')='Prepared'",
        bucket: "''",
        amount: "json_extract(doc,'$.bridge_v1.Credit.offer.amount_cycles')",
    },
    Hold {
        name: "bridge_day",
        kind: "bridge_day",
        status: "json_extract(doc,'$.bridge_v1.Credit.status')='Accepted'",
        bucket: "CAST(json_extract(doc,'$.bridge_v1.Credit.day') AS TEXT)",
        amount: "json_extract(doc,'$.bridge_v1.Credit.offer.amount_cycles')",
    },
];

impl Hold {
    fn projection(&self, record: &str) -> (String, String) {
        let status = self.status.replace("doc", record);
        let bucket = self.bucket.replace("doc", record);
        let value = self.amount.replace("doc", record);
        (
            format!("(CASE WHEN {status} THEN {bucket} END)"),
            format!("(CASE WHEN {status} THEN coalesce({value},0) ELSE 0 END)"),
        )
    }
}

pub(crate) fn schema_statements() -> Vec<String> {
    let mut statements = Vec::new();
    for hold in HOLDS {
        let Hold { name, kind, .. } = hold;
        let (new_bucket, new_amount) = hold.projection("NEW.record");
        let (old_bucket, old_amount) = hold.projection("OLD.record");
        let add = format!(
            "INSERT INTO payment_holds(kind,bucket,total)
             SELECT '{kind}',{new_bucket},{new_amount}
             WHERE {new_bucket} IS NOT NULL AND {new_amount}>0
             ON CONFLICT(kind,bucket) DO UPDATE SET total=total+excluded.total;"
        );
        let remove = format!(
            "UPDATE payment_holds SET total=total-{old_amount}
             WHERE kind='{kind}' AND bucket={old_bucket} AND {old_amount}>0;
             DELETE FROM payment_holds WHERE kind='{kind}' AND bucket={old_bucket} AND total=0;"
        );
        statements.extend([
            format!("CREATE TRIGGER hold_{name}_insert AFTER INSERT ON payments BEGIN {add} END;"),
            format!(
                "CREATE TRIGGER hold_{name}_delete AFTER DELETE ON payments BEGIN {remove} END;"
            ),
            // Scan progress, acknowledgments and exact retries must not mutate
            // totals when the same held amount remains in the same bucket.
            format!(
                "CREATE TRIGGER hold_{name}_update AFTER UPDATE OF record ON payments
                WHEN {old_bucket} IS NOT {new_bucket} OR {old_amount} IS NOT {new_amount}
                BEGIN {remove} {add} END;"
            ),
        ]);
    }
    statements
}

/// Run once inside the validated predecessor migration before enabling triggers.
pub(crate) fn initialize(db: &Connection) -> Result<()> {
    for hold in HOLDS {
        let (bucket, amount) = hold.projection("record");
        db.execute_batch(&format!(
            "INSERT INTO payment_holds(kind,bucket,total)
             SELECT '{}',bucket,sum(amount) FROM
                (SELECT {bucket} AS bucket,{amount} AS amount FROM payments)
             WHERE bucket IS NOT NULL AND amount>0 GROUP BY bucket
             ON CONFLICT(kind,bucket) DO UPDATE SET total=total+excluded.total;",
            hold.kind,
        ))
        .map_err(|_| Error::Storage)?;
    }
    db.execute_batch(&schema_statements().join("\n"))
        .map_err(|_| Error::Storage)
}

fn lookup(db: &Connection, kind: &str, bucket: &str) -> Result<u128> {
    let total: Option<i64> = db
        .query_row(
            "SELECT total FROM payment_holds WHERE kind=?1 AND bucket=?2",
            params![kind, bucket],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    u128::try_from(total.unwrap_or_default()).map_err(|_| Error::Storage)
}

pub(crate) fn beneficiary(
    db: &Connection,
    owner: &str,
    exclude_payment: Option<(&str, &[u8])>,
) -> Result<u128> {
    let total = lookup(db, "beneficiary", owner)?;
    let Some((wallet, operation)) = exclude_payment else {
        return Ok(total);
    };
    let (purchase_owner, purchase_amount) = HOLDS[0].projection("record");
    let (bridge_owner, bridge_amount) = HOLDS[1].projection("record");
    let excluded: Option<i64> = db
        .query_row(
            &format!(
                "SELECT (CASE WHEN {purchase_owner}=?3 THEN {purchase_amount} ELSE 0 END)
                      + (CASE WHEN {bridge_owner}=?3 THEN {bridge_amount} ELSE 0 END)
                 FROM payments WHERE wallet=?1 AND operation=?2"
            ),
            params![wallet, operation, owner],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    total
        .checked_sub(u128::try_from(excluded.unwrap_or_default()).map_err(|_| Error::Storage)?)
        .ok_or(Error::Storage)
}

pub(crate) fn bridge_day(db: &Connection, day: u64) -> Result<u128> {
    Ok(lookup(db, "bridge_prepared", "")? + lookup(db, "bridge_day", &day.to_string())?)
}

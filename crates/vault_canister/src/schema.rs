//! Validate old images before atomic v9/v10 -> v11 migration; never repair unknown schemas.
use kinic_sqlite_compat::{self as sql, Connection, params};
use std::collections::BTreeMap;
use vault_types::{Error, Result};

const INDEXES: &str = "CREATE INDEX uploads_expiry ON uploads(owner,expires);";

pub(crate) fn initialize_vault_schema(db: &Connection) -> Result<()> {
    db.execute_batch("SAVEPOINT vault_schema_upgrade")
        .map_err(|_| Error::Storage)?;
    let result = initialize_inner(db);
    if result.is_ok() {
        db.execute_batch("RELEASE vault_schema_upgrade")
            .map_err(|_| Error::Storage)?;
    } else {
        db.execute_batch("ROLLBACK TO vault_schema_upgrade; RELEASE vault_schema_upgrade;")
            .map_err(|_| Error::Storage)?;
    }
    result
}
fn validate(db: &Connection, statements: &[String]) -> Result<()> {
    let expected: BTreeMap<_, _> = statements
        .iter()
        .map(|s| contract(s))
        .collect::<Result<_>>()?;
    let mut query = db
        .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
        .map_err(|_| Error::Storage)?;
    let rows: Vec<(String, String, String)> = sql::query_map(&mut query, params![], |r| {
        Ok((
            sql::row_get(r, 0)?,
            sql::row_get(r, 1)?,
            sql::row_get(r, 2)?,
        ))
    })
    .map_err(|_| Error::Storage)?;
    let actual: BTreeMap<_, _> = rows
        .into_iter()
        .map(|(kind, name, ddl)| ((kind, name), normalize(&ddl)))
        .collect();
    if actual != expected {
        return Err(Error::Storage);
    }
    Ok(())
}
fn initialize_inner(db: &Connection) -> Result<()> {
    let version: i64 = db
        .query_row("PRAGMA user_version", params![], |r| sql::row_get(r, 0))
        .map_err(|_| Error::Storage)?;
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'",
            params![],
            |r| sql::row_get(r, 0),
        )
        .map_err(|_| Error::Storage)?;
    let old = schema_statements();
    let additions = crate::capacity::grant_schema_statements();
    let mut latest = old.clone();
    latest.extend(additions.clone());
    let v10 = latest.clone();
    let subsidy = crate::capacity::subsidy_schema_statements();
    latest.extend(subsidy.clone());
    match version {
        0 if count == 0 => {
            db.execute_batch(&latest.join("\n"))
                .map_err(|_| Error::Storage)?;
            db.execute_batch("PRAGMA user_version=11;")
                .map_err(|_| Error::Storage)?;
        }
        9 => {
            validate(db, &old)?;
            db.execute_batch(&additions.join("\n"))
                .map_err(|_| Error::Storage)?;
            db.execute_batch(&subsidy.join("\n"))
                .map_err(|_| Error::Storage)?;
            exclude_existing(db)?;
            db.execute_batch("PRAGMA user_version=11;")
                .map_err(|_| Error::Storage)?;
        }
        10 => {
            validate(db, &v10)?;
            db.execute_batch(&subsidy.join("\n"))
                .map_err(|_| Error::Storage)?;
            // Seal every participant at the policy boundary without changing
            // existing credits or granting an extra free retrieval.
            exclude_existing(db)?;
            db.execute_batch("PRAGMA user_version=11;")
                .map_err(|_| Error::Storage)?;
        }
        11 => validate(db, &latest)?,
        _ => return Err(Error::Storage),
    }
    db.execute_batch("PRAGMA max_page_count=262144;")
        .map_err(|_| Error::Storage)
}

fn exclude_existing(db: &Connection) -> Result<()> {
    let mut principals = std::collections::BTreeSet::new();
    let mut stmt=db.prepare("SELECT owner FROM accounts UNION SELECT wallet FROM payments UNION SELECT json_extract(record,'$.request.beneficiary') FROM payments UNION SELECT wallet FROM quote_fee_flights UNION SELECT json_extract(record,'$.payment.request.beneficiary') FROM quote_fee_flights").map_err(|_|Error::Storage)?;
    let owners: Vec<String> =
        sql::query_map(&mut stmt, params![], |r| sql::row_get(r, 0)).map_err(|_| Error::Storage)?;
    principals.extend(owners);
    let mut stmt = db
        .prepare("SELECT DISTINCT owner FROM vaults")
        .map_err(|_| Error::Storage)?;
    let owners: Vec<Vec<u8>> =
        sql::query_map(&mut stmt, params![], |r| sql::row_get(r, 0)).map_err(|_| Error::Storage)?;
    for owner in owners {
        principals.insert(
            candid::Principal::try_from_slice(&owner)
                .map_err(|_| Error::Storage)?
                .to_text(),
        );
    }
    for owner in principals {
        kinic_cycle_grants::record_once(
            db,
            kinic_cycle_grants::Scope::Vault,
            &owner,
            "vault",
            0,
            0,
        )
        .map_err(|_| Error::Storage)?;
    }
    Ok(())
}

fn schema_statements() -> Vec<String> {
    // These are trusted compiled DDL scripts, not user SQL. Split ordinary DDL at
    // ';' and keep each trigger body through END;. No duplicated schema manifest.
    let script = [
        vault_store::SCHEMA,
        vault_store::CONTENT_SCHEMA,
        vault_store::EXPIRY_SCHEMA,
        include_str!("accounts.sql"),
        INDEXES,
    ]
    .concat();
    let script = script
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut statements = Vec::new();
    let mut pending = String::new();
    for part in script.split_inclusive(';') {
        pending.push_str(part);
        let ddl = pending.trim();
        if ddl.is_empty() {
            continue;
        }
        if ddl.starts_with("CREATE TRIGGER") && !ddl.ends_with("END;") {
            continue;
        }
        statements.push(ddl.to_owned());
        pending.clear();
    }
    statements.extend(crate::capacity::schema_statements());
    statements
}

fn contract(ddl: &str) -> Result<((String, String), String)> {
    let mut words = ddl.split_whitespace();
    if words.next() != Some("CREATE") {
        return Err(Error::Storage);
    }
    let mut kind = words.next().ok_or(Error::Storage)?;
    if kind == "UNIQUE" {
        kind = words.next().ok_or(Error::Storage)?;
    }
    let mut name = words.next().ok_or(Error::Storage)?;
    if name == "IF" {
        if words.next() != Some("NOT") || words.next() != Some("EXISTS") {
            return Err(Error::Storage);
        }
        name = words.next().ok_or(Error::Storage)?;
    }
    Ok((
        (
            kind.to_ascii_lowercase(),
            name.split('(').next().ok_or(Error::Storage)?.to_owned(),
        ),
        normalize(ddl),
    ))
}

fn normalize(ddl: &str) -> String {
    // Preserve quoted literal bytes: whitespace inside a JSON path or state name
    // must not make a different guard compare equal. Ignore only outside spacing
    // and SQLite's omitted IF NOT EXISTS prefix in persisted CREATE statements.
    let mut quoted = false;
    let mut normalized = String::new();
    for ch in ddl.trim().trim_end_matches(';').chars() {
        if ch == '\'' {
            quoted = !quoted;
        }
        if quoted || !ch.is_ascii_whitespace() {
            normalized.push(ch);
        }
    }
    for kind in ["TABLE", "INDEX", "UNIQUEINDEX", "TRIGGER"] {
        let prefix = format!("CREATE{kind}IFNOTEXISTS");
        if normalized.starts_with(&prefix) {
            return normalized.replacen(&prefix, &format!("CREATE{kind}"), 1);
        }
    }
    normalized
}

#[cfg(test)]
pub(crate) fn legacy_v9_for_test(db: &Connection) {
    db.execute_batch(&schema_statements().join("\n")).unwrap();
    db.execute_batch("PRAGMA user_version=9;").unwrap();
}

#[cfg(test)]
pub(crate) fn legacy_v10_for_test(db: &Connection) {
    legacy_v9_for_test(db);
    db.execute_batch(&crate::capacity::grant_schema_statements().join("\n"))
        .unwrap();
    db.execute_batch("PRAGMA user_version=10;").unwrap();
}

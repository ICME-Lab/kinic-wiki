//! Validate complete, frozen predecessor contracts before migrating either branch to schema 13.
use kinic_sqlite_compat::{self as sql, Connection, params};
use std::collections::BTreeMap;
use vault_types::{Error, Result};

const INDEXES: &str = "CREATE INDEX uploads_expiry ON uploads(owner,expires);";

// Historical DDL from 3a536a54, dec6eac2 (team) and 41db6180 (grants/subsidies).
// Keep these snapshots independent of current schema generators and quota constants.
const COMMON: &str = include_str!("schema_contracts/common.sql");
const ACCOUNTS_V8: &str = include_str!("schema_contracts/accounts_v8.sql");
const ACCOUNTS_V9: &str = include_str!("schema_contracts/accounts_v9.sql");
const TEAM: &str = include_str!("schema_contracts/team_v11.sql");
const GRANT: &str = include_str!("schema_contracts/grant_v10.sql");
const SUBSIDY: &str = include_str!("schema_contracts/subsidy_v11.sql");

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
type Contract = BTreeMap<(String, String), String>;
fn validate(actual: &Contract, statements: &[String]) -> Result<()> {
    let expected: BTreeMap<_, _> = statements
        .iter()
        .map(|s| contract(s))
        .collect::<Result<_>>()?;
    if *actual == expected {
        Ok(())
    } else {
        Err(Error::Storage)
    }
}
fn read_contract(db: &Connection) -> Result<Contract> {
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
    Ok(rows
        .into_iter()
        .map(|(kind, name, ddl)| ((kind, name), normalize(&ddl)))
        .collect())
}
fn initialize_inner(db: &Connection) -> Result<()> {
    let version: i64 = db
        .query_row("PRAGMA user_version", params![], |r| sql::row_get(r, 0))
        .map_err(|_| Error::Storage)?;
    let actual = read_contract(db)?;
    let latest = latest_statements();
    match version {
        0 if actual.is_empty() => execute(db, &latest.join("\n"))?,
        8..=12 => {
            // The branch markers only select the expected contract. Validate every
            // table, index and trigger before touching any predecessor data.
            let team =
                version == 11 && actual.contains_key(&("table".into(), "vault_members".into()));
            let subsidy = matches!(version, 11 | 12) && !team;
            let grant = subsidy
                || (version == 10
                    && actual.contains_key(&("table".into(), "initial_cycle_grants".into())));
            let accounts = if version == 8 {
                ACCOUNTS_V8
            } else {
                ACCOUNTS_V9
            };
            let mut old = split_ddl(&[accounts, COMMON].concat());
            for (present, script) in [(team, TEAM), (grant, GRANT), (subsidy, SUBSIDY)] {
                if present {
                    old.extend(split_ddl(script));
                }
            }
            validate(&actual, &old)?;

            if version == 8 {
                execute(db, "ALTER TABLE accounts ADD COLUMN storage_charge_remainder INTEGER NOT NULL DEFAULT 0 CHECK(storage_charge_remainder>=0 AND storage_charge_remainder<1073741824000);
                    DROP TRIGGER accounting_accounts_INSERT_size;
                    DROP TRIGGER accounting_accounts_UPDATE_size;")?;
                // The CREATE TABLE IF NOT EXISTS leaves the altered table intact.
                execute(db, ACCOUNTS_V9)?;
            }
            if !team {
                execute(db, TEAM)?;
            }
            if !grant {
                execute(db, GRANT)?;
            }
            if !subsidy {
                execute(db, SUBSIDY)?;
                exclude_existing(db)?;
            }
        }
        13 => {
            validate(&actual, &latest)?;
            return execute(db, "PRAGMA max_page_count=262144;");
        }
        _ => return Err(Error::Storage),
    }
    validate(&read_contract(db)?, &latest)?;
    execute(db, "PRAGMA user_version=13; PRAGMA max_page_count=262144;")
}

fn execute(db: &Connection, script: &str) -> Result<()> {
    db.execute_batch(script).map_err(|_| Error::Storage)
}

fn exclude_existing(db: &Connection) -> Result<()> {
    let mut principals = std::collections::BTreeSet::new();
    let mut stmt=db.prepare("SELECT owner FROM accounts UNION SELECT wallet FROM payments UNION SELECT json_extract(record,'$.request.beneficiary') FROM payments WHERE json_extract(record,'$.request.beneficiary') IS NOT NULL UNION SELECT wallet FROM quote_fee_flights UNION SELECT json_extract(record,'$.payment.request.beneficiary') FROM quote_fee_flights WHERE json_extract(record,'$.payment.request.beneficiary') IS NOT NULL").map_err(|_|Error::Storage)?;
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

fn latest_statements() -> Vec<String> {
    let mut statements = split_ddl(
        &[
            vault_store::SCHEMA,
            vault_store::CONTENT_SCHEMA,
            vault_store::EXPIRY_SCHEMA,
            include_str!("accounts.sql"),
            INDEXES,
        ]
        .concat(),
    );
    statements.extend(crate::capacity::schema_statements());
    statements.extend(crate::capacity::grant_schema_statements());
    statements.extend(crate::capacity::subsidy_schema_statements());
    statements
}

fn split_ddl(script: &str) -> Vec<String> {
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
    // SQLite removes IF NOT EXISTS when it stores CREATE statements. ALTER
    // TABLE inserts a space before the last account column on migrated v8.
    // Keep other bytes, including SQL token boundaries and quoted literals.
    let ddl = ddl.trim().trim_end_matches(';');
    let mut ddl = ["TABLE", "INDEX", "UNIQUE INDEX", "TRIGGER"]
        .iter()
        .find_map(|kind| {
            ddl.strip_prefix(&format!("CREATE {kind} IF NOT EXISTS "))
                .map(|rest| format!("CREATE {kind} {rest}"))
        })
        .unwrap_or_else(|| ddl.to_owned());
    if ddl.starts_with("CREATE TABLE accounts(") {
        ddl = ddl.replacen(
            "storage_charged_at_ms INTEGER NOT NULL, storage_charge_remainder",
            "storage_charged_at_ms INTEGER NOT NULL,storage_charge_remainder",
            1,
        );
    }
    ddl
}

#[cfg(test)]
pub(crate) fn initialize_legacy_v8(db: &Connection) {
    db.execute_batch(&[ACCOUNTS_V8, COMMON, "PRAGMA user_version=8;"].concat())
        .unwrap();
}
#[cfg(test)]
pub(crate) fn legacy_v9_for_test(db: &Connection) {
    db.execute_batch(&[ACCOUNTS_V9, COMMON, "PRAGMA user_version=9;"].concat())
        .unwrap();
}
#[cfg(test)]
pub(crate) fn legacy_v10_for_test(db: &Connection) {
    legacy_v9_for_test(db);
    db.execute_batch(&[GRANT, "PRAGMA user_version=10;"].concat())
        .unwrap();
}
#[cfg(test)]
pub(crate) fn subsidy_v11_for_test(db: &Connection) {
    legacy_v10_for_test(db);
    db.execute_batch(&[SUBSIDY, "PRAGMA user_version=11;"].concat())
        .unwrap();
}

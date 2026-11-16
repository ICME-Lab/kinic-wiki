//! Initial release: create v8 once; validate existing v8 without repairing it.
use kinic_sqlite_compat::{self as sql, Connection, params};
use std::collections::BTreeMap;
use vault_types::{Error, Result};

const INDEXES: &str = "CREATE INDEX uploads_expiry ON uploads(owner,expires);";

pub(crate) fn initialize_vault_schema(db: &Connection) -> Result<()> {
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
    let statements = schema_statements();
    match version {
        0 if count == 0 => {
            db.execute_batch(&statements.join("\n"))
                .map_err(|_| Error::Storage)?;
            db.execute_batch("PRAGMA user_version=8;")
                .map_err(|_| Error::Storage)?;
        }
        8 if count == statements.len() as i64 => {
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
        }
        _ => return Err(Error::Storage),
    }
    // Connection-local policy is not persisted in the image. Reapply after
    // validation, without creating/repairing schema or changing stored records.
    db.execute_batch("PRAGMA max_page_count=262144;")
        .map_err(|_| Error::Storage)
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

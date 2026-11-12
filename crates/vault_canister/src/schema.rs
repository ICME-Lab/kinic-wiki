//! Initial release: create v6 once, validate existing v6 without repairing it.
use kinic_sqlite_compat::{self as sql, Connection, params};
use vault_types::{Error, Result};

pub(crate) fn initialize_vault_schema(db: &Connection) -> Result<()> {
    let version: i64 = db
        .query_row("PRAGMA user_version", params![], |r| sql::row_get(r, 0))
        .map_err(|_| Error::Storage)?;
    match version {
        0 => {
            let objects: i64 = db
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                    params![],
                    |r| sql::row_get(r, 0),
                )
                .map_err(|_| Error::Storage)?;
            if objects != 0 {
                return Err(Error::Storage);
            }
            db.execute_batch(&[
                vault_store::SCHEMA, vault_store::CONTENT_SCHEMA,
                vault_store::RESTORE_SCHEMA, vault_store::EXPIRY_SCHEMA,
                include_str!("accounts.sql"),
                "CREATE INDEX uploads_expiry ON uploads(owner,expires); CREATE INDEX exports_expiry ON exports(owner,state,expires); CREATE INDEX restores_expiry ON restores(owner,expires); PRAGMA user_version=6;",
            ].concat()).map_err(|_| Error::Storage)?;
            crate::capacity::initialize(db)?;
            Ok(())
        }
        6 => validate_v6(db),
        _ => Err(Error::Storage),
    }
}

fn object(db: &Connection, kind: &str, name: &str) -> Result<()> {
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type=?1 AND name=?2",
            params![kind, name],
            |r| sql::row_get(r, 0),
        )
        .map_err(|_| Error::Storage)?;
    if count == 1 {
        Ok(())
    } else {
        Err(Error::Storage)
    }
}

fn validate_v6(db: &Connection) -> Result<()> {
    // Static identifiers only. Check every persisted column and primary key before
    // any initialization can write to a purported v6 image.
    for (table, columns, primary) in [
        ("owner_scope", "slot,owner", "slot"),
        ("settings", "owner,key,value", "owner,key"),
        ("vaults", "owner,id,operation,expires,header", "owner,id"),
        ("credentials", "owner,id,value", "owner,id"),
        (
            "receipts",
            "owner,operation,digest,result,expires",
            "owner,operation",
        ),
        ("global_settings", "key,value", "key"),
        (
            "key_flights",
            "owner,token,day,reserved,actual,created,settled,payment,phase,in_flight,generation",
            "owner,token",
        ),
        (
            "revisions",
            "owner,vault,object,revision,born,retired,plain_size,manifest,hashes,deleted,charge",
            "owner,vault,object,revision",
        ),
        ("objects", "owner,vault,object,head", "owner,vault,object"),
        (
            "uploads",
            "owner,id,vault,object,expected,expires,digest,request,reserved,cancel_job",
            "owner,id",
        ),
        ("chunks", "owner,upload,idx,data", "owner,upload,idx"),
        (
            "revision_chunks",
            "owner,vault,object,revision,idx,data",
            "owner,vault,object,revision,idx",
        ),
        (
            "exports",
            "owner,id,vault,snapshot,expires,state",
            "owner,id",
        ),
        (
            "wrapper_slots",
            "owner,vault,object,revision,slot,generation,source_digest,wrapper",
            "owner,vault,object,revision,slot",
        ),
        (
            "restores",
            "owner,vault,operation,expires,expected_count,expected_root,chain,count,last_seq,reserved,pending,digest,working_prepaid",
            "owner,vault",
        ),
        (
            "accounts",
            "owner,balance_cycles,storage_bytes,storage_charged_at_ms",
            "owner",
        ),
        (
            "vault_cycle_reservations",
            "owner,token,account_owner,reserved,actual,created_at_ms,settled_at_ms,in_flight,generation,execution_checkpoint,execution_billed",
            "owner,token",
        ),
        (
            "vault_storage_billing_state",
            "slot,cursor_owner,billing_now_ms",
            "slot",
        ),
        (
            "payments",
            "wallet,operation,record,expires",
            "wallet,operation",
        ),
        (
            "account_ledger",
            "id,owner,kind,amount_cycles,balance_after,at_ms,operation",
            "id",
        ),
        (
            "quote_fee_flights",
            "wallet,operation,token,generation,expires_ns,record",
            "wallet,operation",
        ),
    ] {
        db.prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))
            .map_err(|_| Error::Storage)?;
        let mut statement = db
            .prepare(&format!(
                "SELECT name FROM pragma_table_info('{table}') WHERE pk>0 ORDER BY pk"
            ))
            .map_err(|_| Error::Storage)?;
        let keys: Vec<String> = sql::query_map(&mut statement, params![], |r| sql::row_get(r, 0))
            .map_err(|_| Error::Storage)?;
        if keys.join(",") != primary {
            return Err(Error::Storage);
        }
    }
    for index in [
        "key_flights_day",
        "revision_sequence",
        "one_upload_per_vault",
        "uploads_expiry",
        "exports_expiry",
        "restores_expiry",
        "receipts_global_expiry",
        "uploads_global_expiry",
        "vaults_global_expiry",
        "exports_global_expiry",
        "revisions_global_retired",
        "payments_expiry",
        "account_ledger_owner",
    ] {
        object(db, "index", index)?;
    }
    for trigger in [
        "restore_working_insert",
        "restore_working_update",
        "key_pool_insert_size",
        "key_pool_update_size",
        "key_pool_count",
    ] {
        object(db, "trigger", trigger)?;
    }
    for table in [
        "accounts",
        "payments",
        "quote_fee_flights",
        "vault_cycle_reservations",
        "account_ledger",
        "global_settings",
        "vault_storage_billing_state",
    ] {
        for event in ["INSERT", "UPDATE"] {
            object(db, "trigger", &format!("accounting_{table}_{event}_size"))?;
        }
        if table != "vault_storage_billing_state" {
            object(db, "trigger", &format!("accounting_{table}_count"))?;
        }
    }
    Ok(())
}

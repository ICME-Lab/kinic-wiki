// Where: crates/vfs_runtime/src/accounts.rs
// What: Principal-scoped account deletion across database access and marketplace state.
// Why: Native clients need one retryable operation that removes active Kinic access without deleting retained transaction records.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
struct OwnedDatabaseDeletion {
    database_id: String,
    db_file_name: String,
}

impl VfsService {
    pub fn delete_account(&self, caller: &str, now: i64) -> Result<AccountDeletionOutcome, String> {
        require_account_deletion_principal(caller)?;
        let sole_owned_databases = self.read_index(|conn| {
            let databases = load_sole_owned_databases(conn, caller)?;
            require_no_account_deletion_pending_operations(conn, caller, &databases)?;
            Ok(databases)
        })?;

        for database in &sole_owned_databases {
            self.delete_database_preserving_transaction_records(
                DeleteDatabaseRequest {
                    database_id: database.database_id.clone(),
                },
                caller,
                now,
            )?;
        }

        self.write_index(|tx| {
            tx.execute(
                "DELETE FROM market_listings WHERE seller_principal = ?1",
                params![caller],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM market_entitlements WHERE buyer_principal = ?1",
                params![caller],
            )
            .map_err(|error| error.to_string())?;
            for table in [
                "source_capture_trigger_sessions",
                "ops_answer_sessions",
                "source_run_sessions",
            ] {
                let sql = format!("DELETE FROM {table} WHERE principal = ?1");
                tx.execute(&sql, params![caller])
                    .map_err(|error| error.to_string())?;
            }
            tx.execute(
                "DELETE FROM database_members WHERE principal = ?1",
                params![caller],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })?;

        Ok(AccountDeletionOutcome {
            deleted_database_file_names: sole_owned_databases
                .into_iter()
                .map(|database| database.db_file_name)
                .collect(),
        })
    }
}

fn require_account_deletion_principal(caller: &str) -> Result<(), String> {
    if caller == ANONYMOUS_PRINCIPAL {
        return Err("anonymous caller not allowed".to_string());
    }
    Ok(())
}

fn load_sole_owned_databases(
    conn: &Connection,
    caller: &str,
) -> Result<Vec<OwnedDatabaseDeletion>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT d.database_id, d.db_file_name
             FROM databases d
             JOIN database_members caller_member
               ON caller_member.database_id = d.database_id
              AND caller_member.principal = ?1
              AND caller_member.role = 'owner'
             WHERE (
               SELECT COUNT(*)
               FROM database_members owner_member
               WHERE owner_member.database_id = d.database_id
                 AND owner_member.role = 'owner'
             ) = 1
             ORDER BY d.database_id ASC",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![caller], |row| {
        Ok(OwnedDatabaseDeletion {
            database_id: crate::sqlite::row_get(row, 0)?,
            db_file_name: crate::sqlite::row_get(row, 1)?,
        })
    })
    .map_err(|error| error.to_string())
}

fn require_no_account_deletion_pending_operations(
    conn: &Connection,
    caller: &str,
    sole_owned_databases: &[OwnedDatabaseDeletion],
) -> Result<(), String> {
    let caller_cycle_operation: Option<i64> = conn
        .query_row(
            "SELECT operation_id
             FROM database_cycle_pending_operations
             WHERE caller = ?1
             ORDER BY operation_id ASC
             LIMIT 1",
            params![caller],
            |row| crate::sqlite::row_get(row, 0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(operation_id) = caller_cycle_operation {
        return Err(format!(
            "account has pending cycles operation: operation_id={operation_id}"
        ));
    }

    let caller_market_operation: Option<i64> = conn
        .query_row(
            "SELECT operation_id
             FROM market_purchase_pending_operations
             WHERE buyer_principal = ?1 OR seller_principal = ?1
             ORDER BY operation_id ASC
             LIMIT 1",
            params![caller],
            |row| crate::sqlite::row_get(row, 0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(operation_id) = caller_market_operation {
        return Err(format!(
            "account has pending marketplace operation: operation_id={operation_id}"
        ));
    }

    for database in sole_owned_databases {
        let cycle_operation: Option<i64> = conn
            .query_row(
                "SELECT operation_id
                 FROM database_cycle_pending_operations
                 WHERE database_id = ?1
                 ORDER BY operation_id ASC
                 LIMIT 1",
                params![database.database_id],
                |row| crate::sqlite::row_get(row, 0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(operation_id) = cycle_operation {
            return Err(format!(
                "database has pending cycles operation: {}; operation_id={operation_id}",
                database.database_id
            ));
        }

        let market_operation: Option<i64> = conn
            .query_row(
                "SELECT operation_id
                 FROM market_purchase_pending_operations
                 WHERE database_id = ?1
                 ORDER BY operation_id ASC
                 LIMIT 1",
                params![database.database_id],
                |row| crate::sqlite::row_get(row, 0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(operation_id) = market_operation {
            return Err(format!(
                "database has pending marketplace operation: {}; operation_id={operation_id}",
                database.database_id
            ));
        }
    }
    Ok(())
}

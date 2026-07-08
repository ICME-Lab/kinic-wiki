// Where: crates/vfs_runtime/src/cycles.rs
// What: Database cycles purchase flow and pending cycles operations.
// Why: Mechanical split out of lib.rs; a child module keeps same-crate private access.
use super::*;

impl VfsService {
    pub fn validate_database_cycles_purchase(
        &self,
        database_id: &str,
        payment_amount_e8s: u64,
    ) -> Result<(), String> {
        self.validate_database_cycles_purchase_with_minimum(database_id, payment_amount_e8s, 0)
    }

    pub fn validate_database_cycles_purchase_with_minimum(
        &self,
        database_id: &str,
        payment_amount_e8s: u64,
        min_expected_cycles: u64,
    ) -> Result<(), String> {
        amount_to_i64(payment_amount_e8s)?;
        self.read_index(|conn| {
            let config = load_cycles_billing_config(conn)?;
            let cycles = cycles_for_payment_amount_e8s(payment_amount_e8s, &config)?;
            validate_cycles_purchase_minimum(cycles, min_expected_cycles)?;
            let cycles_i64 = cycles_to_i64(cycles)?;
            validate_database_cycles_purchase_for_conn(conn, database_id, cycles_i64)
        })
    }

    pub fn begin_database_cycles_purchase(
        &self,
        database_id: &str,
        caller: &str,
        payment_amount_e8s: u64,
        now: i64,
    ) -> Result<u64, String> {
        self.begin_database_cycles_purchase_with_ledger_details(
            DatabaseCyclesPurchaseWithLedgerDetails {
                database_id,
                caller,
                payment_amount_e8s,
                min_expected_cycles: 0,
                ledger: CyclesPendingLedgerDetailsInput {
                    from_owner: caller,
                    from_subaccount: None,
                    to_owner: "canister",
                    to_subaccount: None,
                    ledger_fee_e8s: 0,
                    ledger_created_at_time_ns: millis_to_nanos(now)?,
                },
                now,
            },
        )
        .map(|start| start.operation_id)
    }

    pub fn begin_database_cycles_purchase_with_ledger_details(
        &self,
        request: DatabaseCyclesPurchaseWithLedgerDetails<'_>,
    ) -> Result<DatabaseCyclesPurchaseStart, String> {
        let payment_amount_e8s = amount_to_i64(request.payment_amount_e8s)?;
        let ledger_fee = amount_to_i64(request.ledger.ledger_fee_e8s)?;
        let ledger_created_at_time = i64::try_from(request.ledger.ledger_created_at_time_ns)
            .map_err(|_| "ledger created_at_time exceeds i64".to_string())?;
        self.write_index(|tx| {
            let config = load_cycles_billing_config(tx)?;
            let cycles_u64 = cycles_for_payment_amount_e8s(request.payment_amount_e8s, &config)?;
            validate_cycles_purchase_minimum(cycles_u64, request.min_expected_cycles)?;
            let cycles = cycles_to_i64(cycles_u64)?;
            validate_database_cycles_purchase_for_conn(tx, request.database_id, cycles)?;
            ensure_no_pending_cycles_purchase_for_caller(tx, request.database_id, request.caller)?;
            let operation_id = insert_pending_cycles_operation(
                tx,
                PendingCyclesOperationInsert {
                    database_id: request.database_id,
                    kind: "cycles_purchase",
                    caller: request.caller,
                    cycles,
                    payment_amount_e8s,
                    ledger: PendingCyclesLedgerDetails {
                        from_owner: request.ledger.from_owner,
                        from_subaccount: request.ledger.from_subaccount,
                        to_owner: request.ledger.to_owner,
                        to_subaccount: request.ledger.to_subaccount,
                        ledger_fee_e8s: ledger_fee,
                        ledger_created_at_time_ns: ledger_created_at_time,
                    },
                    operation_status: CYCLES_OPERATION_STATUS_IN_FLIGHT,
                    now: request.now,
                },
            )?;
            Ok(DatabaseCyclesPurchaseStart {
                operation_id,
                amount_cycles: cycles_u64,
            })
        })
    }

    pub fn apply_database_cycles_purchase(
        &self,
        operation_id: u64,
        database_id: &str,
        caller: &str,
        cycles: u64,
        _ledger_block_index: u64,
        now: i64,
    ) -> Result<u64, String> {
        let cycles_i64 = cycles_to_i64(cycles)?;
        let config = self.cycles_billing_config()?;
        self.write_index(|tx| {
            let operation = load_required_pending_cycles_operation(
                tx,
                PendingCyclesOperationMatch {
                    operation_id,
                    database_id,
                    kind: "cycles_purchase",
                    caller,
                    cycles: cycles_i64,
                },
            )?;
            require_pending_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_COMPLETED],
                "apply cycle purchase",
            )?;
            let ledger_block_index = operation
                .ledger_block_index
                .ok_or_else(|| "completed cycle purchase missing ledger block index".to_string())?;
            load_database_status(tx, database_id)?;
            complete_pending_database_activation(tx, database_id, now)?;
            let db_balance = database_balance_for_update(tx, database_id)?;
            let next_database = checked_balance_add(db_balance, cycles_i64)?;
            update_database_cycles_balance(tx, database_id, next_database, &config, now)?;
            insert_database_ledger(
                tx,
                DatabaseLedgerInsert {
                    database_id,
                    kind: "cycles_purchase",
                    amount_cycles: cycles_i64,
                    balance_after_cycles: next_database,
                    payment_amount_e8s: Some(operation.payment_amount_e8s),
                    caller,
                    method: Some("purchase_database_cycles"),
                    cycles_delta: None,
                    config: None,
                    ledger_block_index: Some(
                        u64::try_from(ledger_block_index).map_err(|error| error.to_string())?,
                    ),
                    now,
                },
            )?;
            delete_pending_cycles_operation(tx, operation_id)?;
            Ok(next_database as u64)
        })
    }

    pub fn complete_database_cycles_purchase_ledger_transfer(
        &self,
        operation_id: u64,
        database_id: &str,
        caller: &str,
        cycles: u64,
        ledger_block_index: u64,
    ) -> Result<(), String> {
        let cycles_i64 = cycles_to_i64(cycles)?;
        let ledger_block_index = i64::try_from(ledger_block_index)
            .map_err(|_| "ledger block index exceeds i64".to_string())?;
        self.write_index(|tx| {
            let operation = load_required_pending_cycles_operation(
                tx,
                PendingCyclesOperationMatch {
                    operation_id,
                    database_id,
                    kind: "cycles_purchase",
                    caller,
                    cycles: cycles_i64,
                },
            )?;
            require_pending_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "complete cycle purchase ledger transfer",
            )?;
            update_pending_operation_completed(
                tx,
                "database_cycle_pending_operations",
                operation_id,
                ledger_block_index,
            )?;
            Ok(())
        })
    }

    pub fn mark_database_cycles_purchase_ambiguous(
        &self,
        operation_id: u64,
        database_id: &str,
        caller: &str,
        cycles: u64,
    ) -> Result<(), String> {
        let cycles_i64 = cycles_to_i64(cycles)?;
        self.write_index(|tx| {
            let operation = load_required_pending_cycles_operation(
                tx,
                PendingCyclesOperationMatch {
                    operation_id,
                    database_id,
                    kind: "cycles_purchase",
                    caller,
                    cycles: cycles_i64,
                },
            )?;
            require_pending_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "mark cycle purchase ambiguous",
            )?;
            update_pending_operation_status(
                tx,
                "database_cycle_pending_operations",
                operation_id,
                CYCLES_OPERATION_STATUS_AMBIGUOUS,
            )?;
            Ok(())
        })
    }

    pub fn cleanup_database_cycles_purchase_after_no_credit(
        &self,
        operation_id: u64,
        database_id: &str,
        caller: &str,
        cycles: u64,
    ) -> Result<(), String> {
        let cycles_i64 = cycles_to_i64(cycles)?;
        let status = self.write_index(|tx| {
            let operation = load_required_pending_cycles_operation(
                tx,
                PendingCyclesOperationMatch {
                    operation_id,
                    database_id,
                    kind: "cycles_purchase",
                    caller,
                    cycles: cycles_i64,
                },
            )?;
            require_pending_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "cleanup cycle purchase",
            )?;
            load_database_status(tx, database_id)
        })?;
        if status == DatabaseStatus::Pending {
            self.discard_database_reservation(database_id)
        } else {
            self.cancel_database_cycles_purchase(operation_id, database_id, caller, cycles)
        }
    }

    pub fn cancel_database_cycles_purchase(
        &self,
        operation_id: u64,
        database_id: &str,
        caller: &str,
        cycles: u64,
    ) -> Result<(), String> {
        let cycles_i64 = cycles_to_i64(cycles)?;
        self.write_index(|tx| {
            let operation = load_required_pending_cycles_operation(
                tx,
                PendingCyclesOperationMatch {
                    operation_id,
                    database_id,
                    kind: "cycles_purchase",
                    caller,
                    cycles: cycles_i64,
                },
            )?;
            require_pending_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "cancel cycle purchase",
            )?;
            delete_pending_cycles_operation(tx, operation_id)
        })
    }

    pub fn list_database_cycle_entries(
        &self,
        database_id: &str,
        caller: &str,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<DatabaseCycleEntryPage, String> {
        let config = self.cycles_billing_config()?;
        let limit = page_limit(limit);
        let after = i64::try_from(cursor.unwrap_or(0)).map_err(|error| error.to_string())?;
        self.read_index(|conn| {
            let _status = load_database_status(conn, database_id)?;
            let show_principal = if caller == config.billing_authority_id {
                true
            } else {
                let role = load_member_role(conn, database_id, caller)?
                    .ok_or_else(|| format!("principal has no access to database: {database_id}"))?;
                if !role_allows(role, RequiredRole::Writer) {
                    return Err(format!(
                        "principal lacks required database role: {database_id}"
                    ));
                }
                role == DatabaseRole::Owner
            };
            let mut stmt = conn
                .prepare(
                    "SELECT entry_id, database_id, kind, amount_cycles, balance_after_cycles,
                            payment_amount_e8s, caller, method, cycles_delta, cycles_per_kinic,
                            ledger_block_index, created_at_ms
                     FROM database_cycle_ledger
                     WHERE database_id = ?1 AND entry_id > ?2
                     ORDER BY entry_id ASC
                     LIMIT ?3",
                )
                .map_err(|error| error.to_string())?;
            let mut entries = crate::sqlite::query_map(
                &mut stmt,
                params![database_id, after, i64::from(limit) + 1],
                map_database_cycles_entry,
            )
            .map_err(|error| error.to_string())?;
            if !show_principal {
                for entry in &mut entries {
                    entry.caller = "redacted".to_string();
                }
            }
            let next_cursor = if entries.len() > limit as usize {
                entries.pop();
                entries.last().map(|entry| entry.entry_id)
            } else {
                None
            };
            Ok(DatabaseCycleEntryPage {
                entries,
                next_cursor,
            })
        })
    }

    pub fn list_database_cycles_pending_purchases(
        &self,
        database_id: &str,
        caller: &str,
    ) -> Result<Vec<DatabaseCyclesPendingPurchase>, String> {
        let config = self.cycles_billing_config()?;
        self.read_index(|conn| {
            load_database_status(conn, database_id)?;
            let role = load_member_role(conn, database_id, caller)?;
            let show_all =
                caller == config.billing_authority_id || role == Some(DatabaseRole::Owner);
            let mut purchases = load_database_cycles_pending_purchase_statuses(conn, database_id)?;
            if !show_all {
                purchases.retain(|purchase| purchase.caller == caller);
                if purchases.is_empty() {
                    return Err(format!(
                        "principal cannot view pending cycle purchases: {database_id}"
                    ));
                }
            }
            purchases
                .into_iter()
                .map(DatabaseCyclesPendingPurchaseRaw::into_public)
                .collect::<Result<Vec<_>, _>>()
        })
    }
}

struct PendingCyclesOperation {
    database_id: String,
    kind: String,
    caller: String,
    cycles: i64,
    payment_amount_e8s: i64,
    operation_status: String,
    ledger_block_index: Option<i64>,
}

struct DatabaseCyclesPendingPurchaseRaw {
    operation_id: i64,
    database_id: String,
    caller: String,
    status: String,
    amount_cycles: i64,
    payment_amount_e8s: i64,
    ledger_block_index: Option<i64>,
    created_at_ms: i64,
}

impl DatabaseCyclesPendingPurchaseRaw {
    fn into_public(self) -> Result<DatabaseCyclesPendingPurchase, String> {
        let amount_cycles = u64::try_from(self.amount_cycles).map_err(|error| error.to_string())?;
        let payment_amount_e8s =
            u64::try_from(self.payment_amount_e8s).map_err(|error| error.to_string())?;
        let operation_id = u64::try_from(self.operation_id).map_err(|error| error.to_string())?;
        let ledger_block_index = self
            .ledger_block_index
            .map(u64::try_from)
            .transpose()
            .map_err(|error| error.to_string())?;
        Ok(DatabaseCyclesPendingPurchase {
            operation_id,
            database_id: self.database_id,
            status: self.status.clone(),
            amount_cycles,
            payment_amount_e8s,
            ledger_block_index,
            created_at_ms: self.created_at_ms,
            required_action: pending_cycles_required_action(&self.status).to_string(),
        })
    }
}

pub(crate) struct PendingCyclesLedgerDetails<'a> {
    pub(crate) from_owner: &'a str,
    pub(crate) from_subaccount: Option<&'a [u8]>,
    pub(crate) to_owner: &'a str,
    pub(crate) to_subaccount: Option<&'a [u8]>,
    pub(crate) ledger_fee_e8s: i64,
    pub(crate) ledger_created_at_time_ns: i64,
}

struct PendingCyclesOperationInsert<'a> {
    database_id: &'a str,
    kind: &'a str,
    caller: &'a str,
    cycles: i64,
    payment_amount_e8s: i64,
    ledger: PendingCyclesLedgerDetails<'a>,
    operation_status: &'a str,
    now: i64,
}

struct PendingCyclesOperationMatch<'a> {
    operation_id: u64,
    database_id: &'a str,
    kind: &'a str,
    caller: &'a str,
    cycles: i64,
}

fn insert_pending_cycles_operation(
    conn: &Transaction<'_>,
    operation: PendingCyclesOperationInsert<'_>,
) -> Result<u64, String> {
    let values = vec![
        crate::sqlite::text_value(operation.database_id),
        crate::sqlite::text_value(operation.kind),
        crate::sqlite::text_value(operation.caller),
        crate::sqlite::integer_value(operation.cycles),
        crate::sqlite::integer_value(operation.payment_amount_e8s),
        crate::sqlite::text_value(operation.ledger.from_owner),
        crate::sqlite::nullable_blob_value(operation.ledger.from_subaccount.map(Vec::from)),
        crate::sqlite::text_value(operation.ledger.to_owner),
        crate::sqlite::nullable_blob_value(operation.ledger.to_subaccount.map(Vec::from)),
        crate::sqlite::integer_value(operation.ledger.ledger_fee_e8s),
        crate::sqlite::integer_value(operation.ledger.ledger_created_at_time_ns),
        crate::sqlite::text_value(operation.operation_status),
        crate::sqlite::integer_value(operation.now),
    ];
    crate::sqlite::execute_values(
        conn,
        "INSERT INTO database_cycle_pending_operations
         (database_id, kind, caller, cycles, payment_amount_e8s, from_owner, from_subaccount,
          to_owner, to_subaccount, ledger_fee_e8s, ledger_created_at_time_ns, operation_status,
          created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        &values,
    )
    .map_err(|error| error.to_string())?;
    let operation_id = crate::sqlite::last_insert_rowid(conn).map_err(|error| error.to_string())?;
    u64::try_from(operation_id).map_err(|error| error.to_string())
}

fn load_pending_cycles_operation(
    conn: &Connection,
    operation_id: u64,
) -> Result<PendingCyclesOperation, String> {
    let operation_id = i64::try_from(operation_id).map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT database_id, kind, caller, cycles, payment_amount_e8s,
                from_owner, from_subaccount, to_owner, to_subaccount,
                ledger_fee_e8s, ledger_created_at_time_ns, operation_status, ledger_block_index
         FROM database_cycle_pending_operations
         WHERE operation_id = ?1",
        params![operation_id],
        map_pending_cycles_operation,
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "pending cycle operation not found".to_string())
}

fn require_pending_operation_status(
    operation: &PendingCyclesOperation,
    allowed: &[&str],
    action: &str,
) -> Result<(), String> {
    if allowed
        .iter()
        .any(|status| operation.operation_status == *status)
    {
        return Ok(());
    }
    Err(format!(
        "cannot {action}; cycle purchase operation is {}",
        operation.operation_status
    ))
}

fn load_required_pending_cycles_operation(
    conn: &Transaction<'_>,
    expected: PendingCyclesOperationMatch<'_>,
) -> Result<PendingCyclesOperation, String> {
    let operation = load_pending_cycles_operation(conn, expected.operation_id)?;
    if operation.database_id != expected.database_id
        || operation.kind != expected.kind
        || operation.caller != expected.caller
        || operation.cycles != expected.cycles
    {
        return Err("pending cycle operation mismatch".to_string());
    }
    Ok(operation)
}

fn delete_pending_cycles_operation(
    conn: &Transaction<'_>,
    operation_id: u64,
) -> Result<(), String> {
    let operation_id = i64::try_from(operation_id).map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM database_cycle_pending_operations WHERE operation_id = ?1",
        params![operation_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_no_pending_cycles_purchase_for_caller(
    conn: &Connection,
    database_id: &str,
    caller: &str,
) -> Result<(), String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM database_cycle_pending_operations
             WHERE database_id = ?1
               AND caller = ?2
               AND kind = 'cycles_purchase'",
            params![database_id, caller],
            |row| crate::sqlite::row_get(row, 0),
        )
        .map_err(|error| error.to_string())?;
    if count > 0 {
        return Err("cycles purchase already pending for caller".to_string());
    }
    Ok(())
}

fn load_database_cycles_pending_purchase_statuses(
    conn: &Connection,
    database_id: &str,
) -> Result<Vec<DatabaseCyclesPendingPurchaseRaw>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT operation_id, database_id, caller, operation_status, cycles,
                    payment_amount_e8s, ledger_block_index, created_at_ms
             FROM database_cycle_pending_operations
             WHERE database_id = ?1 AND kind = 'cycles_purchase'
             ORDER BY operation_id ASC",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(
        &mut stmt,
        params![database_id],
        map_database_cycles_pending_purchase_raw,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn first_database_cycles_pending_purchase_status(
    conn: &Connection,
    database_id: &str,
) -> Result<Option<DatabaseCyclesPendingPurchase>, String> {
    conn.query_row(
        "SELECT operation_id, database_id, caller, operation_status, cycles,
                payment_amount_e8s, ledger_block_index, created_at_ms
         FROM database_cycle_pending_operations
         WHERE database_id = ?1 AND kind = 'cycles_purchase'
         ORDER BY operation_id ASC
         LIMIT 1",
        params![database_id],
        map_database_cycles_pending_purchase_raw,
    )
    .optional()
    .map_err(|error| error.to_string())?
    .map(DatabaseCyclesPendingPurchaseRaw::into_public)
    .transpose()
}

fn map_database_cycles_pending_purchase_raw(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<DatabaseCyclesPendingPurchaseRaw> {
    Ok(DatabaseCyclesPendingPurchaseRaw {
        operation_id: crate::sqlite::row_get(row, 0)?,
        database_id: crate::sqlite::row_get(row, 1)?,
        caller: crate::sqlite::row_get(row, 2)?,
        status: crate::sqlite::row_get(row, 3)?,
        amount_cycles: crate::sqlite::row_get(row, 4)?,
        payment_amount_e8s: crate::sqlite::row_get(row, 5)?,
        ledger_block_index: crate::sqlite::row_get(row, 6)?,
        created_at_ms: crate::sqlite::row_get(row, 7)?,
    })
}

fn pending_cycles_required_action(status: &str) -> &'static str {
    match status {
        CYCLES_OPERATION_STATUS_IN_FLIGHT => "wait_for_ledger_result",
        CYCLES_OPERATION_STATUS_AMBIGUOUS | CYCLES_OPERATION_STATUS_COMPLETED => {
            "billing_authority_review"
        }
        _ => "billing_authority_review",
    }
}

fn map_pending_cycles_operation(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<PendingCyclesOperation> {
    Ok(PendingCyclesOperation {
        database_id: crate::sqlite::row_get(row, 0)?,
        kind: crate::sqlite::row_get(row, 1)?,
        caller: crate::sqlite::row_get(row, 2)?,
        cycles: crate::sqlite::row_get(row, 3)?,
        payment_amount_e8s: crate::sqlite::row_get(row, 4)?,
        operation_status: crate::sqlite::row_get(row, 11)?,
        ledger_block_index: crate::sqlite::row_get(row, 12)?,
    })
}

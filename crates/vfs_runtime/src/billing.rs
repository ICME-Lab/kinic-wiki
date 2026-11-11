// Where: crates/vfs_runtime/src/billing.rs
// What: Storage billing settlement, metered update charging, and the cycles ledger.
// Why: Mechanical split out of lib.rs; a child module keeps same-crate private access.
use super::*;

impl VfsService {
    pub fn settle_database_storage_charges_batch(
        &self,
        caller: &str,
        request: StorageBillingBatchRequest,
        now: i64,
    ) -> Result<StorageBillingBatchResult, String> {
        let limit = storage_billing_batch_limit(request.limit);
        let cursor = request.cursor_mount_id.unwrap_or(0);
        let batch = self.read_index(|conn| {
            load_active_databases_for_storage_billing_batch(conn, cursor, limit)
        })?;
        self.settle_database_storage_billing_batch(caller, batch, now)
    }

    pub fn settle_database_storage_charges_timer_batch(
        &self,
        caller: &str,
        now: i64,
    ) -> Result<StorageBillingBatchResult, String> {
        let state = self.write_index(|tx| load_or_create_storage_billing_timer_state(tx, now))?;
        let batch = self.read_index(|conn| {
            load_active_databases_for_storage_billing_batch(
                conn,
                state.cursor_mount_id.unwrap_or(0),
                TIMER_STORAGE_BILLING_BATCH_LIMIT,
            )
        })?;
        let result =
            self.settle_database_storage_billing_batch(caller, batch, state.billing_now_ms)?;
        self.write_index(|tx| {
            if let Some(cursor) = result.next_cursor_mount_id {
                update_storage_billing_timer_state(tx, Some(cursor), state.billing_now_ms, now)?;
            } else {
                clear_storage_billing_timer_state(tx)?;
            }
            Ok(())
        })?;
        Ok(result)
    }

    fn settle_database_storage_billing_batch(
        &self,
        caller: &str,
        batch: StorageBillingDatabaseBatch,
        now: i64,
    ) -> Result<StorageBillingBatchResult, String> {
        let next_cursor_mount_id = batch.next_cursor_mount_id;
        let databases = batch.databases;
        self.write_index(|tx| {
            let config = load_cycles_billing_config(tx)?;
            if databases.len() < STORAGE_BILLING_BULK_MIN_BATCH_LEN {
                settle_database_storage_billing_loop_in_tx(
                    tx,
                    caller,
                    databases,
                    now,
                    &config,
                    next_cursor_mount_id,
                )
            } else {
                settle_database_storage_billing_bulk_in_tx(
                    tx,
                    caller,
                    databases,
                    now,
                    &config,
                    next_cursor_mount_id,
                )
            }
        })
    }

    pub fn charge_database_update(
        &self,
        config: &CyclesBillingConfig,
        database_id: &str,
        caller: &str,
        method: &str,
        cycles_delta: u128,
        now: i64,
    ) -> Result<(), String> {
        let computed_charge = compute_update_charge(cycles_delta)?;
        if computed_charge == 0 {
            return Ok(());
        }
        self.write_index(|tx| {
            charge_database_update_in_tx(
                tx,
                DatabaseCharge {
                    database_id,
                    caller,
                    method,
                    cycles_delta,
                    now,
                    config,
                    computed_charge,
                },
            )
        })
    }
}

pub(crate) fn load_storage_cycle_account(
    conn: &Connection,
    database_id: &str,
) -> Result<StorageCycleAccount, String> {
    conn.query_row(
        "SELECT balance_cycles, suspended_at_ms, storage_charged_at_ms
         FROM database_cycle_accounts
         WHERE database_id = ?1",
        params![database_id],
        |row| {
            Ok(StorageCycleAccount {
                balance_cycles: crate::sqlite::row_get(row, 0)?,
                suspended_at_ms: crate::sqlite::row_get(row, 1)?,
                storage_charged_at_ms: crate::sqlite::row_get(row, 2)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("database cycles account not found: {database_id}"))
}

fn update_database_storage_account(
    conn: &Transaction<'_>,
    database_id: &str,
    balance_cycles: i64,
    suspended_at_ms: Option<i64>,
    storage_charged_at_ms: i64,
    now: i64,
) -> Result<(), String> {
    let values = vec![
        crate::sqlite::text_value(database_id),
        crate::sqlite::integer_value(balance_cycles),
        crate::sqlite::nullable_integer_value(suspended_at_ms),
        crate::sqlite::integer_value(storage_charged_at_ms),
        crate::sqlite::integer_value(now),
    ];
    crate::sqlite::execute_values(
        conn,
        "UPDATE database_cycle_accounts
         SET balance_cycles = ?2,
             suspended_at_ms = ?3,
             storage_charged_at_ms = ?4,
             updated_at_ms = ?5
         WHERE database_id = ?1",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) struct DatabaseLedgerInsert<'a> {
    pub(crate) database_id: &'a str,
    pub(crate) kind: &'a str,
    pub(crate) amount_cycles: i64,
    pub(crate) balance_after_cycles: i64,
    pub(crate) payment_amount_e8s: Option<i64>,
    pub(crate) caller: &'a str,
    pub(crate) method: Option<&'a str>,
    pub(crate) cycles_delta: Option<u128>,
    pub(crate) config: Option<&'a CyclesBillingConfig>,
    pub(crate) ledger_block_index: Option<u64>,
    pub(crate) now: i64,
}

struct DatabaseCharge<'a> {
    database_id: &'a str,
    caller: &'a str,
    method: &'a str,
    cycles_delta: u128,
    now: i64,
    config: &'a CyclesBillingConfig,
    computed_charge: i64,
}

struct AppliedDatabaseCharge {
    paid_cycles: i64,
    balance_after_cycles: i64,
}

pub(crate) struct StorageChargeInput<'a> {
    pub(crate) database_id: &'a str,
    pub(crate) caller: &'a str,
    pub(crate) size_bytes: u64,
    pub(crate) now: i64,
    pub(crate) config: &'a CyclesBillingConfig,
}

struct StorageBillingDatabaseBatch {
    databases: Vec<DatabaseMeta>,
    next_cursor_mount_id: Option<u16>,
}

struct StorageBillingTimerState {
    cursor_mount_id: Option<u16>,
    billing_now_ms: i64,
}

struct StorageBillingAccountRow {
    database_id: String,
    size_bytes: u64,
    balance_cycles: i64,
    suspended_at_ms: Option<i64>,
    storage_charged_at_ms: Option<i64>,
}

struct StorageBillingWorkRow {
    database_id: String,
    next_balance: i64,
    suspended_at_ms: Option<i64>,
    storage_charged_at_ms: i64,
    storage_cycles: i64,
    paid_cycles: i64,
    update_account: bool,
    charged: bool,
    newly_suspended: bool,
}

pub(crate) struct StorageChargeOutcome {
    pub(crate) charged: bool,
    pub(crate) suspended: bool,
    pub(crate) paid_cycles: u64,
}

pub(crate) struct StorageCycleAccount {
    pub(crate) balance_cycles: i64,
    pub(crate) suspended_at_ms: Option<i64>,
    pub(crate) storage_charged_at_ms: Option<i64>,
}

pub(crate) fn insert_database_ledger(
    conn: &Transaction<'_>,
    entry: DatabaseLedgerInsert<'_>,
) -> Result<(), String> {
    let values = vec![
        crate::sqlite::text_value(entry.database_id),
        crate::sqlite::text_value(entry.kind),
        crate::sqlite::integer_value(entry.amount_cycles),
        crate::sqlite::integer_value(entry.balance_after_cycles),
        crate::sqlite::nullable_integer_value(entry.payment_amount_e8s),
        crate::sqlite::text_value(entry.caller),
        entry
            .method
            .map(crate::sqlite::text_value)
            .unwrap_or(crate::sqlite::types::Value::Null),
        crate::sqlite::nullable_integer_value(
            entry
                .cycles_delta
                .map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::nullable_integer_value(
            entry
                .config
                .map(|config| i64::try_from(config.cycles_per_kinic).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::nullable_integer_value(
            entry
                .ledger_block_index
                .map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::integer_value(entry.now),
    ];
    crate::sqlite::execute_values(
        conn,
        "INSERT INTO database_cycle_ledger
         (database_id, kind, amount_cycles, balance_after_cycles, payment_amount_e8s,
          caller, method, cycles_delta, cycles_per_kinic, ledger_block_index, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn settle_database_storage_billing_loop_in_tx(
    tx: &Transaction<'_>,
    caller: &str,
    databases: Vec<DatabaseMeta>,
    now: i64,
    config: &CyclesBillingConfig,
    next_cursor_mount_id: Option<u16>,
) -> Result<StorageBillingBatchResult, String> {
    let mut result = StorageBillingBatchResult {
        processed_databases: 0,
        charged_databases: 0,
        suspended_databases: 0,
        paid_cycles: 0,
        next_cursor_mount_id,
    };
    for meta in databases {
        let outcome = settle_database_storage_charge_in_tx(
            tx,
            StorageChargeInput {
                database_id: &meta.database_id,
                caller,
                size_bytes: meta.logical_size_bytes,
                now,
                config,
            },
        )?;
        result.processed_databases += 1;
        if outcome.charged {
            result.charged_databases += 1;
        }
        if outcome.suspended {
            result.suspended_databases += 1;
        }
        result.paid_cycles = result
            .paid_cycles
            .checked_add(outcome.paid_cycles)
            .ok_or_else(|| "storage billing paid cycles overflow".to_string())?;
    }
    Ok(result)
}

fn settle_database_storage_billing_bulk_in_tx(
    tx: &Transaction<'_>,
    caller: &str,
    databases: Vec<DatabaseMeta>,
    now: i64,
    config: &CyclesBillingConfig,
    next_cursor_mount_id: Option<u16>,
) -> Result<StorageBillingBatchResult, String> {
    prepare_storage_billing_input_table(tx)?;
    insert_storage_billing_input_rows(tx, &databases)?;
    let account_rows = load_storage_billing_account_rows(tx)?;
    let min_balance = cycles_to_i64(config.min_update_cycles)?;
    let work_rows = account_rows
        .into_iter()
        .map(|row| storage_billing_work_row(row, now, min_balance))
        .collect::<Result<Vec<_>, String>>()?;
    prepare_storage_billing_work_table(tx)?;
    insert_storage_billing_work_rows(tx, &work_rows)?;
    bulk_update_storage_billing_accounts(tx, now)?;
    bulk_insert_storage_billing_ledger(tx, caller, now, config)?;
    let result = load_storage_billing_bulk_result(tx, next_cursor_mount_id)?;
    drop_storage_billing_temp_tables(tx)?;
    Ok(result)
}

fn prepare_storage_billing_input_table(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute("DROP TABLE IF EXISTS temp_storage_billing_input", params![])
        .map_err(|error| error.to_string())?;
    tx.execute(
        "CREATE TEMP TABLE temp_storage_billing_input (
           database_id TEXT PRIMARY KEY,
           logical_size_bytes INTEGER NOT NULL
         )",
        params![],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_storage_billing_input_rows(
    tx: &Transaction<'_>,
    databases: &[DatabaseMeta],
) -> Result<(), String> {
    for chunk in databases.chunks(250) {
        let placeholders = (0..chunk.len())
            .map(|index| {
                let first = index * 2 + 1;
                format!("(?{first}, ?{})", first + 1)
            })
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO temp_storage_billing_input (database_id, logical_size_bytes)
             VALUES {placeholders}"
        );
        let mut values = Vec::with_capacity(chunk.len() * 2);
        for meta in chunk {
            values.push(crate::sqlite::text_value(meta.database_id.as_str()));
            values.push(crate::sqlite::integer_value(
                i64::try_from(meta.logical_size_bytes).unwrap_or(i64::MAX),
            ));
        }
        crate::sqlite::execute_values(tx, &sql, &values).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn load_storage_billing_account_rows(
    tx: &Transaction<'_>,
) -> Result<Vec<StorageBillingAccountRow>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT i.database_id, i.logical_size_bytes, a.balance_cycles,
                    a.suspended_at_ms, a.storage_charged_at_ms
             FROM temp_storage_billing_input i
             LEFT JOIN database_cycle_accounts a ON a.database_id = i.database_id
             ORDER BY i.rowid ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = crate::sqlite::query_map(&mut stmt, params![], |row| {
        Ok((
            crate::sqlite::row_get::<String>(row, 0)?,
            crate::sqlite::row_get::<i64>(row, 1)?,
            crate::sqlite::row_get::<Option<i64>>(row, 2)?,
            crate::sqlite::row_get::<Option<i64>>(row, 3)?,
            crate::sqlite::row_get::<Option<i64>>(row, 4)?,
        ))
    })
    .map_err(|error| error.to_string())?;
    rows.into_iter()
        .map(
            |(database_id, size_bytes, balance_cycles, suspended_at_ms, storage_charged_at_ms)| {
                let balance_cycles = balance_cycles
                    .ok_or_else(|| format!("database cycles account not found: {database_id}"))?;
                Ok(StorageBillingAccountRow {
                    database_id,
                    size_bytes: size_bytes.max(0) as u64,
                    balance_cycles,
                    suspended_at_ms,
                    storage_charged_at_ms,
                })
            },
        )
        .collect()
}

fn storage_billing_work_row(
    row: StorageBillingAccountRow,
    now: i64,
    min_balance: i64,
) -> Result<StorageBillingWorkRow, String> {
    let Some(charged_at_ms) = row.storage_charged_at_ms else {
        return Ok(StorageBillingWorkRow {
            database_id: row.database_id,
            next_balance: row.balance_cycles,
            suspended_at_ms: row.suspended_at_ms,
            storage_charged_at_ms: now,
            storage_cycles: 0,
            paid_cycles: 0,
            update_account: true,
            charged: false,
            newly_suspended: false,
        });
    };
    let elapsed_ms = now.saturating_sub(charged_at_ms);
    if elapsed_ms < STORAGE_BILLING_INTERVAL_MS {
        return Ok(StorageBillingWorkRow {
            database_id: row.database_id,
            next_balance: row.balance_cycles,
            suspended_at_ms: row.suspended_at_ms,
            storage_charged_at_ms: charged_at_ms,
            storage_cycles: 0,
            paid_cycles: 0,
            update_account: false,
            charged: false,
            newly_suspended: false,
        });
    }
    let storage_cycles_u128 = compute_storage_charge_cycles(row.size_bytes, elapsed_ms)?;
    let storage_cycles = i64::try_from(storage_cycles_u128)
        .map_err(|_| "storage charge exceeds i64 limit".to_string())?;
    if storage_cycles == 0 {
        return Ok(StorageBillingWorkRow {
            database_id: row.database_id,
            next_balance: row.balance_cycles,
            suspended_at_ms: row.suspended_at_ms,
            storage_charged_at_ms: now,
            storage_cycles,
            paid_cycles: 0,
            update_account: true,
            charged: false,
            newly_suspended: false,
        });
    }
    let paid_cycles = row.balance_cycles.min(storage_cycles).max(0);
    let next_balance = row.balance_cycles.saturating_sub(paid_cycles);
    let should_suspend = paid_cycles < storage_cycles || next_balance < min_balance;
    let suspended_at_ms = if should_suspend {
        row.suspended_at_ms.or(Some(now))
    } else {
        None
    };
    let newly_suspended = should_suspend && row.suspended_at_ms.is_none();
    Ok(StorageBillingWorkRow {
        database_id: row.database_id,
        next_balance,
        suspended_at_ms,
        storage_charged_at_ms: now,
        storage_cycles,
        paid_cycles,
        update_account: true,
        charged: paid_cycles > 0,
        newly_suspended,
    })
}

fn prepare_storage_billing_work_table(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute("DROP TABLE IF EXISTS temp_storage_billing_work", params![])
        .map_err(|error| error.to_string())?;
    tx.execute(
        "CREATE TEMP TABLE temp_storage_billing_work (
           database_id TEXT PRIMARY KEY,
           next_balance INTEGER NOT NULL,
           suspended_at_ms INTEGER,
           storage_charged_at_ms INTEGER NOT NULL,
           storage_cycles INTEGER NOT NULL,
           paid_cycles INTEGER NOT NULL,
           update_account INTEGER NOT NULL,
           charged INTEGER NOT NULL,
           newly_suspended INTEGER NOT NULL
         )",
        params![],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_storage_billing_work_rows(
    tx: &Transaction<'_>,
    rows: &[StorageBillingWorkRow],
) -> Result<(), String> {
    for chunk in rows.chunks(100) {
        let placeholders = (0..chunk.len())
            .map(|index| {
                let first = index * 9 + 1;
                format!(
                    "(?{first}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{})",
                    first + 1,
                    first + 2,
                    first + 3,
                    first + 4,
                    first + 5,
                    first + 6,
                    first + 7,
                    first + 8
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO temp_storage_billing_work
             (database_id, next_balance, suspended_at_ms, storage_charged_at_ms,
              storage_cycles, paid_cycles, update_account, charged, newly_suspended)
             VALUES {placeholders}"
        );
        let mut values = Vec::with_capacity(chunk.len() * 9);
        for row in chunk {
            values.push(crate::sqlite::text_value(row.database_id.as_str()));
            values.push(crate::sqlite::integer_value(row.next_balance));
            values.push(crate::sqlite::nullable_integer_value(row.suspended_at_ms));
            values.push(crate::sqlite::integer_value(row.storage_charged_at_ms));
            values.push(crate::sqlite::integer_value(row.storage_cycles));
            values.push(crate::sqlite::integer_value(row.paid_cycles));
            values.push(crate::sqlite::integer_value(if row.update_account {
                1
            } else {
                0
            }));
            values.push(crate::sqlite::integer_value(if row.charged {
                1
            } else {
                0
            }));
            values.push(crate::sqlite::integer_value(if row.newly_suspended {
                1
            } else {
                0
            }));
        }
        crate::sqlite::execute_values(tx, &sql, &values).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn bulk_update_storage_billing_accounts(tx: &Transaction<'_>, now: i64) -> Result<(), String> {
    tx.execute(
        "UPDATE database_cycle_accounts
         SET balance_cycles = (
               SELECT next_balance
               FROM temp_storage_billing_work
               WHERE temp_storage_billing_work.database_id = database_cycle_accounts.database_id
             ),
             suspended_at_ms = (
               SELECT suspended_at_ms
               FROM temp_storage_billing_work
               WHERE temp_storage_billing_work.database_id = database_cycle_accounts.database_id
             ),
             storage_charged_at_ms = (
               SELECT storage_charged_at_ms
               FROM temp_storage_billing_work
               WHERE temp_storage_billing_work.database_id = database_cycle_accounts.database_id
             ),
             updated_at_ms = ?1
         WHERE database_id IN (
             SELECT database_id FROM temp_storage_billing_work WHERE update_account = 1
         )",
        params![now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn bulk_insert_storage_billing_ledger(
    tx: &Transaction<'_>,
    caller: &str,
    now: i64,
    config: &CyclesBillingConfig,
) -> Result<(), String> {
    let cycles_per_kinic = i64::try_from(config.cycles_per_kinic).unwrap_or(i64::MAX);
    tx.execute(
        "INSERT INTO database_cycle_ledger
         (database_id, kind, amount_cycles, balance_after_cycles, payment_amount_e8s,
          caller, method, cycles_delta, cycles_per_kinic, ledger_block_index, created_at_ms)
         SELECT database_id, kind, amount_cycles, next_balance, NULL,
                ?1, 'storage_billing', storage_cycles, ?2, NULL, ?3
         FROM (
             SELECT rowid AS work_order, 0 AS ledger_order, database_id,
                    'storage_charge' AS kind, -paid_cycles AS amount_cycles,
                    next_balance, storage_cycles
             FROM temp_storage_billing_work
             WHERE paid_cycles > 0
             UNION ALL
             SELECT rowid AS work_order, 1 AS ledger_order, database_id,
                    'suspend' AS kind, 0 AS amount_cycles,
                    next_balance, storage_cycles
             FROM temp_storage_billing_work
             WHERE newly_suspended = 1
         )
         ORDER BY work_order ASC, ledger_order ASC",
        params![caller, cycles_per_kinic, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_storage_billing_bulk_result(
    tx: &Transaction<'_>,
    next_cursor_mount_id: Option<u16>,
) -> Result<StorageBillingBatchResult, String> {
    tx.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(charged), 0),
                COALESCE(SUM(newly_suspended), 0),
                COALESCE(SUM(paid_cycles), 0)
         FROM temp_storage_billing_work",
        params![],
        |row| {
            let processed: i64 = crate::sqlite::row_get(row, 0)?;
            let charged: i64 = crate::sqlite::row_get(row, 1)?;
            let suspended: i64 = crate::sqlite::row_get(row, 2)?;
            let paid: i64 = crate::sqlite::row_get(row, 3)?;
            Ok(StorageBillingBatchResult {
                processed_databases: processed.max(0) as u32,
                charged_databases: charged.max(0) as u32,
                suspended_databases: suspended.max(0) as u32,
                paid_cycles: paid.max(0) as u64,
                next_cursor_mount_id,
            })
        },
    )
    .map_err(|error| error.to_string())
}

fn drop_storage_billing_temp_tables(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute("DROP TABLE IF EXISTS temp_storage_billing_work", params![])
        .map_err(|error| error.to_string())?;
    tx.execute("DROP TABLE IF EXISTS temp_storage_billing_input", params![])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn settle_database_storage_charge_in_tx(
    tx: &Transaction<'_>,
    input: StorageChargeInput<'_>,
) -> Result<StorageChargeOutcome, String> {
    let account = load_storage_cycle_account(tx, input.database_id)?;
    let Some(charged_at_ms) = account.storage_charged_at_ms else {
        update_database_storage_account(
            tx,
            input.database_id,
            account.balance_cycles,
            account.suspended_at_ms,
            input.now,
            input.now,
        )?;
        return Ok(StorageChargeOutcome {
            charged: false,
            suspended: false,
            paid_cycles: 0,
        });
    };
    let elapsed_ms = input.now.saturating_sub(charged_at_ms);
    if elapsed_ms < STORAGE_BILLING_INTERVAL_MS {
        return Ok(StorageChargeOutcome {
            charged: false,
            suspended: false,
            paid_cycles: 0,
        });
    }
    let storage_cycles = compute_storage_charge_cycles(input.size_bytes, elapsed_ms)?;
    if storage_cycles == 0 {
        update_database_storage_account(
            tx,
            input.database_id,
            account.balance_cycles,
            account.suspended_at_ms,
            input.now,
            input.now,
        )?;
        return Ok(StorageChargeOutcome {
            charged: false,
            suspended: false,
            paid_cycles: 0,
        });
    }
    let charge_cycles = i64::try_from(storage_cycles)
        .map_err(|_| "storage charge exceeds i64 limit".to_string())?;

    let paid_cycles = account.balance_cycles.min(charge_cycles).max(0);
    let next_balance = account.balance_cycles.saturating_sub(paid_cycles);
    let min_balance = cycles_to_i64(input.config.min_update_cycles)?;
    let should_suspend = paid_cycles < charge_cycles || next_balance < min_balance;
    let suspended_at_ms = if should_suspend {
        account.suspended_at_ms.or(Some(input.now))
    } else {
        None
    };
    let newly_suspended = should_suspend && account.suspended_at_ms.is_none();
    update_database_storage_account(
        tx,
        input.database_id,
        next_balance,
        suspended_at_ms,
        input.now,
        input.now,
    )?;
    if paid_cycles > 0 {
        insert_database_ledger(
            tx,
            DatabaseLedgerInsert {
                database_id: input.database_id,
                kind: "storage_charge",
                amount_cycles: -paid_cycles,
                balance_after_cycles: next_balance,
                payment_amount_e8s: None,
                caller: input.caller,
                method: Some("storage_billing"),
                cycles_delta: Some(storage_cycles),
                config: Some(input.config),
                ledger_block_index: None,
                now: input.now,
            },
        )?;
    }
    if newly_suspended {
        insert_database_ledger(
            tx,
            DatabaseLedgerInsert {
                database_id: input.database_id,
                kind: "suspend",
                amount_cycles: 0,
                balance_after_cycles: next_balance,
                payment_amount_e8s: None,
                caller: input.caller,
                method: Some("storage_billing"),
                cycles_delta: Some(storage_cycles),
                config: Some(input.config),
                ledger_block_index: None,
                now: input.now,
            },
        )?;
    }
    Ok(StorageChargeOutcome {
        charged: paid_cycles > 0,
        suspended: newly_suspended,
        paid_cycles: u64::try_from(paid_cycles).unwrap_or(0),
    })
}

fn charge_database_update_in_tx(
    tx: &Transaction<'_>,
    charge: DatabaseCharge<'_>,
) -> Result<(), String> {
    let applied = apply_database_update_charge(tx, &charge)?;
    insert_database_ledger(
        tx,
        DatabaseLedgerInsert {
            database_id: charge.database_id,
            kind: "charge",
            amount_cycles: -applied.paid_cycles,
            balance_after_cycles: applied.balance_after_cycles,
            payment_amount_e8s: None,
            caller: charge.caller,
            method: Some(charge.method),
            cycles_delta: Some(charge.cycles_delta),
            config: Some(charge.config),
            ledger_block_index: None,
            now: charge.now,
        },
    )?;
    Ok(())
}

fn apply_database_update_charge(
    tx: &Transaction<'_>,
    charge: &DatabaseCharge<'_>,
) -> Result<AppliedDatabaseCharge, String> {
    let min = cycles_to_i64(charge.config.min_update_cycles)?;
    tx.query_row(
        "WITH charge_input AS MATERIALIZED (
             SELECT min(max(balance_cycles, 0), ?2) AS paid_cycles,
                    max(balance_cycles, 0) - min(max(balance_cycles, 0), ?2)
                        AS balance_after_cycles
             FROM database_cycle_accounts
             WHERE database_id = ?1
         )
         UPDATE database_cycle_accounts
         SET balance_cycles = (SELECT balance_after_cycles FROM charge_input),
             suspended_at_ms = CASE
                 WHEN (SELECT balance_after_cycles FROM charge_input) >= ?3 THEN NULL
                 ELSE ?4
             END,
             updated_at_ms = ?4
         WHERE database_id = ?1 AND EXISTS (SELECT 1 FROM charge_input)
         RETURNING (SELECT paid_cycles FROM charge_input), balance_cycles",
        params![charge.database_id, charge.computed_charge, min, charge.now],
        |row| {
            Ok(AppliedDatabaseCharge {
                paid_cycles: crate::sqlite::row_get(row, 0)?,
                balance_after_cycles: crate::sqlite::row_get(row, 1)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("database cycles account not found: {}", charge.database_id))
}

fn compute_update_charge(cycles_delta: u128) -> Result<i64, String> {
    i64::try_from(cycles_delta).map_err(|_| "cycle charge exceeds i64 limit".to_string())
}

pub(crate) fn compute_storage_charge_cycles(
    size_bytes: u64,
    elapsed_ms: i64,
) -> Result<u128, String> {
    if elapsed_ms <= 0 || size_bytes == 0 {
        return Ok(0);
    }
    let elapsed_seconds = u128::try_from(elapsed_ms / 1000)
        .map_err(|_| "storage billing elapsed time is negative".to_string())?;
    let byte_seconds = u128::from(size_bytes)
        .checked_mul(elapsed_seconds)
        .ok_or_else(|| "storage byte seconds overflow".to_string())?;
    byte_seconds
        .checked_mul(STORAGE_CYCLES_PER_GIB_SECOND)
        .ok_or_else(|| "storage charge cycles overflow".to_string())
        .map(|cycles| cycles / GIB_BYTES)
}

fn load_active_databases_for_storage_billing_batch(
    conn: &Connection,
    cursor_mount_id: u16,
    limit: u32,
) -> Result<StorageBillingDatabaseBatch, String> {
    let fetch_limit = i64::from(limit.saturating_add(1));
    let mut stmt = conn
        .prepare(
            "SELECT database_id, name, description, llm_summary, tags_json,
                db_file_name, active_mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE status = 'active'
           AND active_mount_id IS NOT NULL
           AND mount_id > ?1
         ORDER BY mount_id ASC
         LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let mut databases = crate::sqlite::query_map(
        &mut stmt,
        params![i64::from(cursor_mount_id), fetch_limit],
        map_database_meta,
    )
    .map_err(|error| error.to_string())?;
    let next_cursor_mount_id = if databases.len() > limit as usize {
        databases.pop();
        databases.last().map(|meta| meta.mount_id)
    } else {
        None
    };
    Ok(StorageBillingDatabaseBatch {
        databases,
        next_cursor_mount_id,
    })
}

#[cfg(test)]
pub(crate) fn load_active_databases_for_storage_billing(
    conn: &Connection,
) -> Result<Vec<DatabaseMeta>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT database_id, name, description, llm_summary, tags_json,
                db_file_name, active_mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE status = 'active'
           AND active_mount_id IS NOT NULL
         ORDER BY mount_id ASC",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![], map_database_meta)
        .map_err(|error| error.to_string())
}

fn storage_billing_batch_limit(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(DEFAULT_STORAGE_BILLING_BATCH_LIMIT)
        .clamp(1, MAX_STORAGE_BILLING_BATCH_LIMIT)
}

fn load_or_create_storage_billing_timer_state(
    tx: &Transaction<'_>,
    now: i64,
) -> Result<StorageBillingTimerState, String> {
    let existing = tx
        .query_row(
            "SELECT cursor_mount_id, billing_now_ms
             FROM storage_billing_state
             WHERE key = 'timer'",
            params![],
            |row| {
                let cursor: Option<i64> = crate::sqlite::row_get(row, 0)?;
                Ok(StorageBillingTimerState {
                    cursor_mount_id: cursor.map(mount_id_from_db).transpose()?,
                    billing_now_ms: crate::sqlite::row_get(row, 1)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(state) = existing {
        return Ok(state);
    }
    update_storage_billing_timer_state(tx, None, now, now)?;
    Ok(StorageBillingTimerState {
        cursor_mount_id: None,
        billing_now_ms: now,
    })
}

fn update_storage_billing_timer_state(
    tx: &Transaction<'_>,
    cursor_mount_id: Option<u16>,
    billing_now_ms: i64,
    updated_at_ms: i64,
) -> Result<(), String> {
    let values = vec![
        crate::sqlite::nullable_integer_value(cursor_mount_id.map(i64::from)),
        crate::sqlite::integer_value(billing_now_ms),
        crate::sqlite::integer_value(updated_at_ms),
    ];
    crate::sqlite::execute_values(
        tx,
        "INSERT INTO storage_billing_state
         (key, cursor_mount_id, billing_now_ms, updated_at_ms)
         VALUES ('timer', ?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           cursor_mount_id = excluded.cursor_mount_id,
           billing_now_ms = excluded.billing_now_ms,
           updated_at_ms = excluded.updated_at_ms",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

// Where: crates/vfs_runtime/src/metrics.rs
// What: Wiki usage metrics aggregation over the index database.
// Why: Mechanical split out of lib.rs; a child module keeps same-crate private access.
use super::*;

impl VfsService {
    pub fn wiki_metrics(&self, now_ms: i64) -> Result<WikiMetrics, String> {
        let cutoff_30d_ms = now_ms.saturating_sub(WIKI_METRICS_WINDOW_MS).max(0);
        self.read_index(|conn| load_wiki_metrics(conn, cutoff_30d_ms, now_ms))
    }

    pub fn wiki_metrics_series(
        &self,
        now_ms: i64,
        days: u32,
    ) -> Result<Vec<WikiMetricsPoint>, String> {
        let limit = wiki_metrics_series_limit(days);
        let today_start_ms = day_start_ms(now_ms);
        let first_bucket_start_ms =
            today_start_ms.saturating_sub(i64::from(limit.saturating_sub(1)) * DAY_MS);
        self.read_index(|conn| {
            (0..limit)
                .map(|index| {
                    let bucket_start_ms =
                        first_bucket_start_ms.saturating_add(i64::from(index) * DAY_MS);
                    let bucket_end_ms = bucket_start_ms.saturating_add(DAY_MS - 1).min(now_ms);
                    let cutoff_30d_ms = bucket_end_ms.saturating_sub(WIKI_METRICS_WINDOW_MS).max(0);
                    Ok(WikiMetricsPoint {
                        bucket_start_ms,
                        metrics: load_wiki_metrics(conn, cutoff_30d_ms, bucket_end_ms)?,
                    })
                })
                .collect()
        })
    }
}

fn load_wiki_metrics(
    conn: &Connection,
    cutoff_30d_ms: i64,
    as_of_ms: i64,
) -> Result<WikiMetrics, String> {
    let mut last_activity_at_ms = None;
    let principal_activity =
        load_metric_principal_activity(conn, as_of_ms, &mut last_activity_at_ms)?;
    let active_databases = load_metric_active_databases(conn, as_of_ms)?;
    let database_activity =
        load_metric_database_activity(conn, as_of_ms, &active_databases, &mut last_activity_at_ms)?;
    let (charged_kinic_total_e8s, charged_kinic_30d_e8s) =
        load_metric_charged_kinic_e8s(conn, cutoff_30d_ms, as_of_ms)?;

    Ok(WikiMetrics {
        users_total: metric_count(principal_activity.len())?,
        users_active_30d: metric_count(
            principal_activity
                .values()
                .filter(|activity| activity.active_at >= cutoff_30d_ms)
                .count(),
        )?,
        users_new_30d: metric_count(
            principal_activity
                .values()
                .filter(|activity| activity.first_at >= cutoff_30d_ms)
                .count(),
        )?,
        databases_total: metric_count(active_databases.len())?,
        databases_active_30d: metric_count(
            database_activity
                .values()
                .filter(|active_at| **active_at >= cutoff_30d_ms)
                .count(),
        )?,
        databases_new_30d: metric_count(
            active_databases
                .values()
                .filter(|created_at_ms| **created_at_ms >= cutoff_30d_ms)
                .count(),
        )?,
        paid_users_total: load_metric_paid_users_total(conn, as_of_ms)?,
        charged_kinic_total_e8s,
        charged_kinic_30d_e8s,
        last_activity_at_ms,
    })
}

#[derive(Clone, Copy)]
struct MetricActivity {
    first_at: i64,
    active_at: i64,
}

fn load_metric_principal_activity(
    conn: &Connection,
    as_of_ms: i64,
    last_activity_at_ms: &mut Option<i64>,
) -> Result<BTreeMap<String, MetricActivity>, String> {
    let mut activity = BTreeMap::new();
    for sql in [
        "SELECT principal, created_at_ms, created_at_ms FROM database_members WHERE created_at_ms <= ?1",
        "SELECT caller, created_at_ms, created_at_ms FROM database_cycle_ledger WHERE created_at_ms <= ?1",
        "SELECT buyer_principal, created_at_ms, created_at_ms FROM market_orders WHERE created_at_ms <= ?1",
        "SELECT seller_principal, created_at_ms, created_at_ms FROM market_orders WHERE created_at_ms <= ?1",
        "SELECT payout_principal, created_at_ms, created_at_ms FROM market_orders WHERE created_at_ms <= ?1",
        "SELECT seller_principal, created_at_ms, created_at_ms FROM market_listings WHERE created_at_ms <= ?1",
        "SELECT seller_principal, created_at_ms, updated_at_ms FROM market_listings WHERE updated_at_ms <= ?1",
        "SELECT payout_principal, created_at_ms, created_at_ms FROM market_listings WHERE created_at_ms <= ?1",
        "SELECT payout_principal, created_at_ms, updated_at_ms FROM market_listings WHERE updated_at_ms <= ?1",
        "SELECT buyer_principal, purchased_at_ms, purchased_at_ms FROM market_entitlements WHERE purchased_at_ms <= ?1",
        "SELECT principal, created_at_ms, created_at_ms FROM source_capture_trigger_sessions WHERE created_at_ms <= ?1",
        "SELECT principal, created_at_ms, refreshed_at_ms FROM source_capture_trigger_sessions WHERE refreshed_at_ms <= ?1",
        "SELECT principal, created_at_ms, created_at_ms FROM ops_answer_sessions WHERE created_at_ms <= ?1",
        "SELECT principal, created_at_ms, refreshed_at_ms FROM ops_answer_sessions WHERE refreshed_at_ms <= ?1",
        "SELECT principal, created_at_ms, created_at_ms FROM source_run_sessions WHERE created_at_ms <= ?1",
        "SELECT principal, created_at_ms, refreshed_at_ms FROM source_run_sessions WHERE refreshed_at_ms <= ?1",
    ] {
        collect_metric_principal_activity(conn, sql, as_of_ms, &mut activity, last_activity_at_ms)?;
    }
    Ok(activity)
}

fn collect_metric_principal_activity(
    conn: &Connection,
    sql: &str,
    as_of_ms: i64,
    activity: &mut BTreeMap<String, MetricActivity>,
    last_activity_at_ms: &mut Option<i64>,
) -> Result<(), String> {
    let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
    crate::sqlite::query_fold(&mut stmt, params![as_of_ms], (), |(), row| {
        let principal: String = crate::sqlite::row_get(row, 0)?;
        let first_at: i64 = crate::sqlite::row_get(row, 1)?;
        let active_at: i64 = crate::sqlite::row_get(row, 2)?;
        merge_last_activity(last_activity_at_ms, first_at);
        merge_last_activity(last_activity_at_ms, active_at);
        if !principal.is_empty() && principal != ANONYMOUS_PRINCIPAL {
            merge_metric_principal(activity, principal, first_at, active_at);
        }
        Ok(())
    })
    .map_err(|error| error.to_string())
}

fn load_metric_active_databases(
    conn: &Connection,
    as_of_ms: i64,
) -> Result<BTreeMap<String, i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT database_id, created_at_ms
             FROM databases
             WHERE created_at_ms <= ?1
               AND (status <> 'deleted' OR deleted_at_ms IS NULL OR deleted_at_ms > ?1)",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_fold(
        &mut stmt,
        params![as_of_ms],
        BTreeMap::new(),
        |mut databases, row| {
            let database_id: String = crate::sqlite::row_get(row, 0)?;
            let created_at_ms: i64 = crate::sqlite::row_get(row, 1)?;
            databases.insert(database_id, created_at_ms);
            Ok(databases)
        },
    )
    .map_err(|error| error.to_string())
}

fn load_metric_database_activity(
    conn: &Connection,
    as_of_ms: i64,
    active_databases: &BTreeMap<String, i64>,
    last_activity_at_ms: &mut Option<i64>,
) -> Result<BTreeMap<String, i64>, String> {
    let mut activity = BTreeMap::new();
    for sql in [
        "SELECT database_id, created_at_ms FROM databases WHERE created_at_ms <= ?1",
        "SELECT database_id, updated_at_ms FROM databases WHERE updated_at_ms <= ?1",
        "SELECT database_id, created_at_ms FROM database_cycle_ledger WHERE created_at_ms <= ?1",
        "SELECT database_id, created_at_ms FROM market_orders WHERE created_at_ms <= ?1",
        "SELECT database_id, purchased_at_ms FROM market_entitlements WHERE purchased_at_ms <= ?1",
        "SELECT database_id, created_at_ms FROM market_listings WHERE created_at_ms <= ?1",
        "SELECT database_id, updated_at_ms FROM market_listings WHERE updated_at_ms <= ?1",
        "SELECT database_id, created_at_ms FROM source_capture_trigger_sessions WHERE created_at_ms <= ?1",
        "SELECT database_id, refreshed_at_ms FROM source_capture_trigger_sessions WHERE refreshed_at_ms <= ?1",
        "SELECT database_id, created_at_ms FROM ops_answer_sessions WHERE created_at_ms <= ?1",
        "SELECT database_id, refreshed_at_ms FROM ops_answer_sessions WHERE refreshed_at_ms <= ?1",
        "SELECT database_id, created_at_ms FROM source_run_sessions WHERE created_at_ms <= ?1",
        "SELECT database_id, refreshed_at_ms FROM source_run_sessions WHERE refreshed_at_ms <= ?1",
    ] {
        collect_metric_database_activity(
            conn,
            sql,
            as_of_ms,
            active_databases,
            &mut activity,
            last_activity_at_ms,
        )?;
    }
    Ok(activity)
}

fn collect_metric_database_activity(
    conn: &Connection,
    sql: &str,
    as_of_ms: i64,
    active_databases: &BTreeMap<String, i64>,
    activity: &mut BTreeMap<String, i64>,
    last_activity_at_ms: &mut Option<i64>,
) -> Result<(), String> {
    let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
    crate::sqlite::query_fold(&mut stmt, params![as_of_ms], (), |(), row| {
        let database_id: String = crate::sqlite::row_get(row, 0)?;
        let active_at: i64 = crate::sqlite::row_get(row, 1)?;
        merge_last_activity(last_activity_at_ms, active_at);
        if active_databases.contains_key(&database_id) {
            merge_metric_database_activity(activity, database_id, active_at);
        }
        Ok(())
    })
    .map_err(|error| error.to_string())
}

fn load_metric_paid_users_total(conn: &Connection, as_of_ms: i64) -> Result<u64, String> {
    let mut principals = BTreeSet::new();
    for sql in [
        "SELECT caller FROM database_cycle_ledger
         WHERE kind = 'cycles_purchase' AND payment_amount_e8s IS NOT NULL AND created_at_ms <= ?1",
        "SELECT buyer_principal FROM market_orders WHERE created_at_ms <= ?1",
    ] {
        let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
        principals = crate::sqlite::query_fold(
            &mut stmt,
            params![as_of_ms],
            principals,
            |mut principals, row| {
                let principal: String = crate::sqlite::row_get(row, 0)?;
                if !principal.is_empty() && principal != ANONYMOUS_PRINCIPAL {
                    principals.insert(principal);
                }
                Ok(principals)
            },
        )
        .map_err(|error| error.to_string())?;
    }
    metric_count(principals.len())
}

fn load_metric_charged_kinic_e8s(
    conn: &Connection,
    cutoff_30d_ms: i64,
    as_of_ms: i64,
) -> Result<(u64, u64), String> {
    let total = checked_metric_add(
        load_metric_sum_until(
            conn,
            "SELECT COALESCE(SUM(payment_amount_e8s), 0)
             FROM database_cycle_ledger
             WHERE kind = 'cycles_purchase' AND payment_amount_e8s IS NOT NULL AND created_at_ms <= ?1",
            as_of_ms,
        )?,
        load_metric_sum_until(
            conn,
            "SELECT COALESCE(SUM(price_e8s), 0) FROM market_orders WHERE created_at_ms <= ?1",
            as_of_ms,
        )?,
        "charged KINIC total overflows u64",
    )?;
    let recent = checked_metric_add(
        load_metric_sum_between(
            conn,
            "SELECT COALESCE(SUM(payment_amount_e8s), 0)
             FROM database_cycle_ledger
             WHERE kind = 'cycles_purchase' AND payment_amount_e8s IS NOT NULL
               AND created_at_ms BETWEEN ?1 AND ?2",
            cutoff_30d_ms,
            as_of_ms,
        )?,
        load_metric_sum_between(
            conn,
            "SELECT COALESCE(SUM(price_e8s), 0)
             FROM market_orders
             WHERE created_at_ms BETWEEN ?1 AND ?2",
            cutoff_30d_ms,
            as_of_ms,
        )?,
        "charged KINIC 30d overflows u64",
    )?;
    Ok((total, recent))
}

fn load_metric_sum_until(conn: &Connection, sql: &str, as_of_ms: i64) -> Result<u64, String> {
    conn.query_row(sql, params![as_of_ms], |row| metric_u64_value(row, 0))
        .map_err(|error| error.to_string())
}

fn load_metric_sum_between(
    conn: &Connection,
    sql: &str,
    cutoff_30d_ms: i64,
    as_of_ms: i64,
) -> Result<u64, String> {
    conn.query_row(sql, params![cutoff_30d_ms, as_of_ms], |row| {
        metric_u64_value(row, 0)
    })
    .map_err(|error| error.to_string())
}

fn metric_u64_value(row: &crate::sqlite::Row<'_>, index: usize) -> crate::sqlite::Result<u64> {
    let value: i64 = crate::sqlite::row_get(row, index)?;
    u64::try_from(value).map_err(|_| crate::sqlite::integral_value_out_of_range(index, value))
}

fn metric_count(value: usize) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| "metric count exceeds u64".to_string())
}

fn checked_metric_add(left: u64, right: u64, error: &str) -> Result<u64, String> {
    left.checked_add(right).ok_or_else(|| error.to_string())
}

fn merge_metric_principal(
    activity: &mut BTreeMap<String, MetricActivity>,
    principal: String,
    first_at: i64,
    active_at: i64,
) {
    activity
        .entry(principal)
        .and_modify(|stored| {
            stored.first_at = stored.first_at.min(first_at);
            stored.active_at = stored.active_at.max(active_at);
        })
        .or_insert(MetricActivity {
            first_at,
            active_at,
        });
}

fn merge_metric_database_activity(
    activity: &mut BTreeMap<String, i64>,
    database_id: String,
    active_at: i64,
) {
    activity
        .entry(database_id)
        .and_modify(|stored| *stored = (*stored).max(active_at))
        .or_insert(active_at);
}

fn merge_last_activity(last_activity_at_ms: &mut Option<i64>, active_at: i64) {
    *last_activity_at_ms = Some(
        last_activity_at_ms
            .map(|stored| stored.max(active_at))
            .unwrap_or(active_at),
    );
}

fn wiki_metrics_series_limit(days: u32) -> u32 {
    days.clamp(1, WIKI_METRICS_SERIES_LIMIT_MAX)
}

fn day_start_ms(value: i64) -> i64 {
    value.div_euclid(DAY_MS) * DAY_MS
}

// Where: crates/vfs_cli_app/src/bin/local_canister_post_upgrade_smoke.rs
// What: Verify local wiki canister cycles config and DB persistence across upgrade.
// Why: Fresh install requires cycles billing config, and upgrade operators need a small state smoke.
use std::{env, fs};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use vfs_client::{CanisterVfsClient, VfsApi};
use vfs_types::{
    CyclesBillingConfig, CyclesTopUpConfig, DatabaseCyclesPurchaseRequest, DatabaseStatus,
    MkdirNodeRequest, NodeKind, OutgoingLinksRequest, SearchNodesRequest, WriteNodeRequest,
    kinic_base_units_per_token,
};

#[derive(Debug)]
struct SmokeArgs {
    state_output: Option<String>,
    verify_state: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct SmokeState {
    canister_id: String,
    database_id: String,
    active_database_id: String,
    isolation_database_id: String,
    active_balance_cycles: u64,
    active_ledger_entry_count: usize,
    expected_config: CyclesBillingConfig,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
    let replica_host =
        env::var("REPLICA_HOST").unwrap_or_else(|_| "http://127.0.0.1:8011".to_string());
    let canister_id = env::var("CANISTER_ID")
        .or_else(|_| env::var("VFS_CANISTER_ID"))
        .context("CANISTER_ID or VFS_CANISTER_ID is required")?;
    let expected_config = expected_cycles_config()?;
    let client = authenticated_client(&replica_host, &canister_id).await?;

    assert_cycles_config(&client, &expected_config).await?;
    if let Some(path) = args.verify_state {
        let state = read_state(&path)?;
        if state.canister_id != canister_id {
            return Err(anyhow!(
                "state canister id {} does not match current {}",
                state.canister_id,
                canister_id
            ));
        }
        if state.expected_config != expected_config {
            return Err(anyhow!(
                "current cycles config env differs from smoke state"
            ));
        }
        assert_pending_database(&client, &state.database_id).await?;
        assert_active_database(&client, &state).await?;
        assert_vfs_database_behavior(
            &client,
            &state.active_database_id,
            &state.isolation_database_id,
        )
        .await?;
        println!("local_canister_post_upgrade_smoke verify ok");
        println!("canister_id={}", state.canister_id);
        println!("database_id={}", state.database_id);
        println!("active_database_id={}", state.active_database_id);
        return Ok(());
    }

    let warmup_database = client.create_database("Post-upgrade warmup smoke").await?;
    assert_created_database_present(&client, &warmup_database.database_id).await?;
    let active_database = client.create_database("Post-upgrade active smoke").await?;
    let active_database_id = active_database.database_id.clone();
    activate_created_database_if_pending(&client, &active_database, smoke_cycle_purchase_e8s()?)
        .await?;
    let isolation_database = client
        .create_database("Post-upgrade isolation smoke")
        .await?;
    let isolation_database_id = isolation_database.database_id.clone();
    activate_created_database_if_pending(&client, &isolation_database, smoke_cycle_purchase_e8s()?)
        .await?;
    let pending_database_id = client
        .create_database("Post-upgrade pending smoke")
        .await?
        .database_id;
    assert_pending_database(&client, &pending_database_id).await?;
    seed_vfs_database_behavior(&client, &active_database_id, &isolation_database_id).await?;
    let active_balance_cycles = active_database_balance(&client, &active_database_id).await?;
    let active_ledger_entry_count = client
        .list_database_cycle_entries(&active_database_id, None, 10)
        .await?
        .entries
        .len();
    let state = SmokeState {
        canister_id,
        database_id: pending_database_id.clone(),
        active_database_id: active_database_id.clone(),
        isolation_database_id: isolation_database_id.clone(),
        active_balance_cycles,
        active_ledger_entry_count,
        expected_config,
    };
    assert_active_database(&client, &state).await?;
    assert_vfs_database_behavior(&client, &active_database_id, &isolation_database_id).await?;
    if let Some(path) = args.state_output {
        write_state(&path, &state)?;
    }
    println!("local_canister_post_upgrade_smoke ok");
    println!("database_id={pending_database_id}");
    println!("active_database_id={active_database_id}");
    println!("isolation_database_id={isolation_database_id}");
    Ok(())
}

fn parse_args() -> Result<SmokeArgs> {
    let mut state_output = None;
    let mut verify_state = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--state-output" => {
                state_output = Some(
                    args.next()
                        .ok_or_else(|| anyhow!("--state-output requires a path"))?,
                );
            }
            "--verify-state" => {
                verify_state = Some(
                    args.next()
                        .ok_or_else(|| anyhow!("--verify-state requires a path"))?,
                );
            }
            _ => return Err(anyhow!("unknown argument: {arg}")),
        }
    }
    if state_output.is_some() && verify_state.is_some() {
        return Err(anyhow!(
            "--state-output and --verify-state cannot be used together"
        ));
    }
    Ok(SmokeArgs {
        state_output,
        verify_state,
    })
}

async fn authenticated_client(replica_host: &str, canister_id: &str) -> Result<CanisterVfsClient> {
    let pem_path = env::var("VFS_IDENTITY_PEM_PATH")
        .context("VFS_IDENTITY_PEM_PATH is required for authenticated local smoke")?;
    let pem = fs::read(&pem_path).with_context(|| format!("failed to read {pem_path}"))?;
    CanisterVfsClient::new_with_identity_pem(replica_host, canister_id, &pem).await
}

fn expected_cycles_config() -> Result<CyclesBillingConfig> {
    Ok(CyclesBillingConfig {
        kinic_ledger_canister_id: required_env("KINIC_LEDGER_CANISTER_ID")?,
        billing_authority_id: required_env("BILLING_AUTHORITY_ID")?,
        cycles_per_kinic: env_u64("CYCLES_PER_KINIC", 234_500_000_000)?,
        min_update_cycles: env_u64("MIN_UPDATE_CYCLES", 1_000_000)?,
        top_up: CyclesTopUpConfig {
            enabled: env_bool("CYCLES_TOP_UP_ENABLED", true)?,
            launcher_principal: env::var("CYCLES_TOP_UP_LAUNCHER_PRINCIPAL")
                .unwrap_or_else(|_| "xfug4-5qaaa-aaaak-afowa-cai".to_string()),
            threshold_cycles: env_u128("CYCLES_TOP_UP_THRESHOLD", 2_000_000_000_000)?,
        },
    })
}

fn required_env(name: &str) -> Result<String> {
    let value = env::var(name).with_context(|| format!("{name} is required"))?;
    if value.trim().is_empty() {
        return Err(anyhow!("{name} must not be empty"));
    }
    Ok(value)
}

fn env_u64(name: &str, default: u64) -> Result<u64> {
    let Some(value) = env::var(name).ok() else {
        return Ok(default);
    };
    value
        .parse::<u64>()
        .with_context(|| format!("{name} must be a u64"))
        .and_then(|parsed| {
            if parsed == 0 {
                Err(anyhow!("{name} must be positive"))
            } else {
                Ok(parsed)
            }
        })
}

fn env_u128(name: &str, default: u128) -> Result<u128> {
    match env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} must be a u128 integer")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("failed to read {name}")),
    }
}

fn env_bool(name: &str, default: bool) -> Result<bool> {
    match env::var(name) {
        Ok(value) => match value.as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(anyhow!("{name} must be true or false")),
        },
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("failed to read {name}")),
    }
}

async fn assert_cycles_config(
    client: &CanisterVfsClient,
    expected: &CyclesBillingConfig,
) -> Result<()> {
    let actual = client.get_cycles_billing_config().await?;
    if &actual != expected {
        return Err(anyhow!(
            "unexpected cycles config: expected {:?}, got {:?}",
            expected,
            actual
        ));
    }
    Ok(())
}

async fn assert_pending_database(client: &CanisterVfsClient, database_id: &str) -> Result<()> {
    let summary = client
        .list_databases()
        .await?
        .into_iter()
        .find(|database| database.database_id == database_id)
        .ok_or_else(|| anyhow!("pending smoke database missing: {database_id}"))?;
    if summary.status != DatabaseStatus::Pending {
        return Err(anyhow!(
            "smoke database should remain pending, got {:?}",
            summary.status
        ));
    }
    Ok(())
}

async fn assert_created_database_present(
    client: &CanisterVfsClient,
    database_id: &str,
) -> Result<()> {
    client
        .list_databases()
        .await?
        .into_iter()
        .find(|database| database.database_id == database_id)
        .map(|_| ())
        .ok_or_else(|| anyhow!("smoke database missing after create: {database_id}"))
}

async fn activate_created_database_if_pending(
    client: &CanisterVfsClient,
    database: &vfs_types::CreateDatabaseResult,
    payment_amount_e8s: u64,
) -> Result<u64> {
    match database.status {
        DatabaseStatus::Active => active_database_balance(client, &database.database_id).await,
        DatabaseStatus::Pending => {
            activate_smoke_database(client, &database.database_id, payment_amount_e8s).await
        }
        DatabaseStatus::Deleted => Err(anyhow!(
            "created smoke database should not be deleted: {}",
            database.database_id
        )),
    }
}

async fn activate_smoke_database(
    client: &CanisterVfsClient,
    database_id: &str,
    payment_amount_e8s: u64,
) -> Result<u64> {
    let config = client.get_cycles_billing_config().await?;
    let min_expected_cycles = cycles_for_payment_amount_e8s(payment_amount_e8s, &config)?;
    let result = client
        .purchase_database_cycles(DatabaseCyclesPurchaseRequest {
            database_id: database_id.to_string(),
            payment_amount_e8s,
            min_expected_cycles,
        })
        .await
        .with_context(|| format!("failed to purchase cycles for smoke database {database_id}"))?;
    Ok(result.balance_cycles)
}

async fn active_database_balance(client: &CanisterVfsClient, database_id: &str) -> Result<u64> {
    client
        .list_databases()
        .await?
        .into_iter()
        .find(|database| database.database_id == database_id)
        .and_then(|database| database.cycles_balance)
        .ok_or_else(|| anyhow!("active smoke database balance missing: {database_id}"))
}

async fn seed_vfs_database_behavior(
    client: &CanisterVfsClient,
    active_database_id: &str,
    isolation_database_id: &str,
) -> Result<()> {
    write_smoke_node(
        client,
        active_database_id,
        "# Upgrade Smoke\n\nneedle-upgrade-persistence [linked](/Knowledge/linked.md)\n",
    )
    .await?;
    write_smoke_node(
        client,
        isolation_database_id,
        "# Isolation Smoke\n\nneedle-isolation-only\n",
    )
    .await?;
    client
        .write_node(WriteNodeRequest {
            database_id: active_database_id.to_string(),
            path: "/Knowledge/linked.md".to_string(),
            kind: NodeKind::File,
            content: "# Linked\n\nlink target\n".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    Ok(())
}

async fn write_smoke_node(
    client: &CanisterVfsClient,
    database_id: &str,
    content: &str,
) -> Result<()> {
    client
        .mkdir_node(MkdirNodeRequest {
            database_id: database_id.to_string(),
            path: "/Knowledge".to_string(),
        })
        .await?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: "/Knowledge/upgrade-smoke.md".to_string(),
            kind: NodeKind::File,
            content: content.to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    Ok(())
}

async fn assert_vfs_database_behavior(
    client: &CanisterVfsClient,
    active_database_id: &str,
    isolation_database_id: &str,
) -> Result<()> {
    let active = client
        .read_node(active_database_id, "/Knowledge/upgrade-smoke.md")
        .await?
        .ok_or_else(|| anyhow!("active smoke node missing"))?;
    if !active.content.contains("needle-upgrade-persistence") {
        return Err(anyhow!("active smoke node content changed"));
    }
    let isolation = client
        .read_node(isolation_database_id, "/Knowledge/upgrade-smoke.md")
        .await?
        .ok_or_else(|| anyhow!("isolation smoke node missing"))?;
    if isolation.content.contains("needle-upgrade-persistence")
        || !isolation.content.contains("needle-isolation-only")
    {
        return Err(anyhow!("database isolation smoke content mismatch"));
    }
    let hits = client
        .search_nodes(SearchNodesRequest {
            database_id: active_database_id.to_string(),
            query_text: "needle-upgrade-persistence".to_string(),
            prefix: Some("/Knowledge".to_string()),
            top_k: 5,
            preview_mode: None,
        })
        .await?;
    if !hits
        .iter()
        .any(|hit| hit.path == "/Knowledge/upgrade-smoke.md")
    {
        return Err(anyhow!("active smoke search hit missing"));
    }
    let links = client
        .outgoing_links(OutgoingLinksRequest {
            database_id: active_database_id.to_string(),
            path: "/Knowledge/upgrade-smoke.md".to_string(),
            limit: 10,
        })
        .await?;
    if !links
        .iter()
        .any(|link| link.target_path == "/Knowledge/linked.md")
    {
        return Err(anyhow!("active smoke outgoing link missing"));
    }
    Ok(())
}

fn cycles_for_payment_amount_e8s(
    payment_amount_e8s: u64,
    config: &CyclesBillingConfig,
) -> Result<u64> {
    let cycles = u128::from(payment_amount_e8s)
        .checked_mul(u128::from(config.cycles_per_kinic))
        .ok_or_else(|| anyhow!("cycles purchase amount overflow"))?
        / u128::from(kinic_base_units_per_token());
    let cycles =
        u64::try_from(cycles).map_err(|_| anyhow!("cycles purchase amount exceeds u64"))?;
    if cycles == 0 {
        return Err(anyhow!("cycles purchase amount is too small"));
    }
    Ok(cycles)
}

async fn assert_active_database(client: &CanisterVfsClient, state: &SmokeState) -> Result<()> {
    let summary = client
        .list_databases()
        .await?
        .into_iter()
        .find(|database| database.database_id == state.active_database_id)
        .ok_or_else(|| {
            anyhow!(
                "active smoke database missing: {}",
                state.active_database_id
            )
        })?;
    if summary.status != DatabaseStatus::Active {
        return Err(anyhow!(
            "active smoke database should remain active, got {:?}",
            summary.status
        ));
    }
    if summary.cycles_balance != Some(state.active_balance_cycles) {
        return Err(anyhow!(
            "active smoke database balance changed: expected {:?}, got {:?}",
            Some(state.active_balance_cycles),
            summary.cycles_balance
        ));
    }
    let entries = client
        .list_database_cycle_entries(&state.active_database_id, None, 10)
        .await?
        .entries;
    if entries.len() != state.active_ledger_entry_count {
        return Err(anyhow!(
            "active smoke ledger entry count changed: expected {}, got {}",
            state.active_ledger_entry_count,
            entries.len()
        ));
    }
    if !entries.iter().any(|entry| entry.kind == "cycles_purchase") {
        return Err(anyhow!("active smoke cycles purchase ledger entry missing"));
    }
    Ok(())
}

fn smoke_cycle_purchase_e8s() -> Result<u64> {
    env_u64("SMOKE_CYCLE_PURCHASE_E8S", 100_000_000)
}

fn read_state(path: &str) -> Result<SmokeState> {
    let text = fs::read_to_string(path).with_context(|| format!("failed to read {path}"))?;
    serde_json::from_str(&text).with_context(|| format!("failed to parse {path}"))
}

fn write_state(path: &str, state: &SmokeState) -> Result<()> {
    let text = serde_json::to_string_pretty(state).context("failed to encode smoke state")?;
    fs::write(path, text).with_context(|| format!("failed to write {path}"))
}

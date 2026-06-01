// Where: crates/vfs_cli_app/src/bin/local_canister_post_upgrade_smoke.rs
// What: Verify local wiki canister cycles config and pending DB persistence across upgrade.
// Why: Fresh install requires cycles billing config, and upgrade operators need a small state smoke.
use std::{env, fs};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use vfs_client::{CanisterVfsClient, VfsApi};
use vfs_types::{CyclesBillingConfig, DatabaseStatus};

#[derive(Debug)]
struct SmokeArgs {
    state_output: Option<String>,
    verify_state: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct SmokeState {
    canister_id: String,
    database_id: String,
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
        println!("local_canister_post_upgrade_smoke verify ok");
        println!("canister_id={}", state.canister_id);
        println!("database_id={}", state.database_id);
        return Ok(());
    }

    let database_id = client
        .create_database("Post-upgrade smoke")
        .await?
        .database_id;
    assert_pending_database(&client, &database_id).await?;
    if let Some(path) = args.state_output {
        write_state(
            &path,
            &SmokeState {
                canister_id,
                database_id: database_id.clone(),
                expected_config,
            },
        )?;
    }
    println!("local_canister_post_upgrade_smoke ok");
    println!("database_id={database_id}");
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
        cycles_per_kinic: env_u64("CYCLES_PER_KINIC", 1_000)?,
        min_update_cycles: env_u64("MIN_UPDATE_CYCLES", 1)?,
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

fn read_state(path: &str) -> Result<SmokeState> {
    let text = fs::read_to_string(path).with_context(|| format!("failed to read {path}"))?;
    serde_json::from_str(&text).with_context(|| format!("failed to parse {path}"))
}

fn write_state(path: &str, state: &SmokeState) -> Result<()> {
    let text = serde_json::to_string_pretty(state).context("failed to encode smoke state")?;
    fs::write(path, text).with_context(|| format!("failed to write {path}"))
}

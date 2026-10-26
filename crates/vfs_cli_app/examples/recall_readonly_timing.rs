//! One fresh identity + recall sample, without outbox, hook delivery or model calls.
//! Arguments: endpoint canister database principal namespace state-directory task.
use anyhow::{Context, Result, ensure};
use serde_json::json;
use std::time::Instant;
use vfs_cli_app::{
    identity::load_default_identity,
    learning::{RecallOptions, recall},
};
use vfs_client::{CanisterVfsClient, VfsApi};
#[tokio::main]
async fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    ensure!(
        a.len() == 7,
        "endpoint canister database principal namespace state-directory task required"
    );
    let start = Instant::now();
    let identity = load_default_identity(&a[1], true).await?;
    let client = CanisterVfsClient::new_with_boxed_identity(&a[0], &a[1], identity).await?;
    ensure!(
        client.caller_principal().as_deref() == Some(a[3].as_str()),
        "identity changed"
    );
    let identity_ms = start.elapsed().as_millis();
    let opts: RecallOptions = serde_json::from_value(
        json!({"task":a[6],"namespace":a[4],"budget_tokens":2000,"state_dir":a[5],"endpoint":format!("{}:{}",a[0],a[1]),"principal":a[3],"semantic":false}),
    )?;
    let receipt = recall(&client, &a[2], "readonly-timing", &opts)
        .await
        .context("read-only recall failed")?;
    println!(
        "{}",
        json!({"identity_ms":identity_ms,"total_ms":start.elapsed().as_millis(),"context_bytes":receipt.rendered.len()})
    );
    Ok(())
}

// Where: crates/vfs_cli_core/src/commands/database.rs
// What: Database subcommand handlers.
// Why: Mechanical split out of commands.rs by command family.
use super::*;

pub(crate) async fn run_database_command(
    client: &impl VfsApi,
    connection: &ResolvedConnection,
    command: DatabaseCommand,
) -> Result<()> {
    match command {
        DatabaseCommand::Create { name } => {
            let result = client.create_database(&name).await?;
            println!("{}", result.database_id);
        }
        DatabaseCommand::Metadata {
            database_id,
            input,
            json,
        } => {
            let request = read_database_metadata_input(&database_id, &input)?;
            let metadata = client.update_database_metadata(request).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&metadata)?);
            }
        }
        DatabaseCommand::List { json } => {
            let databases = client.list_databases().await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&databases)?);
            } else {
                for database in databases {
                    let name = database
                        .metadata
                        .as_ref()
                        .ok_or_else(|| anyhow!("database metadata is required"))?
                        .name
                        .as_str();
                    println!(
                        "{}\t{}\t{:?}\t{:?}\t{}\t{}\t{}",
                        database.database_id,
                        name,
                        database.role,
                        database.status,
                        database.logical_size_bytes,
                        database.cycles_balance.unwrap_or(0),
                        database
                            .cycles_suspended_at_ms
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "-".to_string())
                    );
                }
            }
        }
        DatabaseCommand::PurchaseCycles { database_id, kinic } => {
            let payment_amount_e8s = parse_kinic_amount_e8s(&kinic)?;
            let config = client.get_cycles_billing_config().await?;
            let min_expected_cycles = cycles_for_payment_amount_e8s(payment_amount_e8s, &config)?;
            let result = client
                .purchase_database_cycles(DatabaseCyclesPurchaseRequest {
                    database_id: database_id.clone(),
                    payment_amount_e8s,
                    min_expected_cycles,
                })
                .await?;
            println!(
                "{database_id}\t{}\t{}\t{}",
                result.block_index, result.amount_cycles, result.balance_cycles
            );
        }
        DatabaseCommand::CyclesHistory { database_id, json } => {
            let page = client
                .list_database_cycle_entries(&database_id, None, 100)
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&page)?);
            } else {
                for entry in page.entries {
                    println!(
                        "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                        entry.entry_id,
                        entry.kind,
                        entry.amount_cycles,
                        entry.balance_after_cycles,
                        entry.caller,
                        entry.method.unwrap_or_else(|| "-".to_string()),
                        entry
                            .ledger_block_index
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "-".to_string()),
                        entry.created_at_ms
                    );
                }
            }
        }
        DatabaseCommand::CyclesPending { database_id, json } => {
            let pending = client
                .list_database_cycles_pending_purchases(&database_id)
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&pending)?);
            } else {
                for purchase in pending {
                    println!(
                        "{}\t{}\t{}\t{}\t{}\t{}\t{}",
                        purchase.operation_id,
                        purchase.status,
                        purchase.amount_cycles,
                        purchase.payment_amount_e8s,
                        purchase
                            .ledger_block_index
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "-".to_string()),
                        purchase.required_action,
                        purchase.created_at_ms
                    );
                }
            }
        }
        DatabaseCommand::Cycles {
            database_id,
            browser_origin,
        } => {
            open_database_cycles_page(browser_origin.as_deref(), &database_id)?;
        }
        DatabaseCommand::Link { database_id } => {
            let path = link_workspace_database(connection, &database_id)?;
            println!("{}", path.display());
        }
        DatabaseCommand::Current { json } => {
            print_database_current(&ResolvedConnectionPreview::from(connection), json)?
        }
        DatabaseCommand::Unlink => {
            run_database_unlink()?;
        }
        DatabaseCommand::Grant {
            database_id,
            principal,
            role,
        } => {
            client
                .grant_database_access(&database_id, &principal, role.to_database_role())
                .await?;
            println!("{database_id}\t{principal}\t{:?}", role.to_database_role());
        }
        DatabaseCommand::GrantCurrentIdentity { database_id, role } => {
            let principal = client
                .caller_principal()
                .ok_or_else(|| anyhow!("current identity principal is not available"))?;
            client
                .grant_database_access(&database_id, &principal, role.to_database_role())
                .await?;
            println!("{database_id}\t{principal}\t{:?}", role.to_database_role());
        }
        DatabaseCommand::Revoke {
            database_id,
            principal,
        } => {
            client
                .revoke_database_access(&database_id, &principal)
                .await?;
            println!("{database_id}\t{principal}");
        }
        DatabaseCommand::Members { database_id, json } => {
            let members = client.list_database_members(&database_id).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&members)?);
            } else {
                for member in members {
                    println!(
                        "{}\t{}\t{:?}\t{}",
                        member.database_id, member.principal, member.role, member.created_at_ms
                    );
                }
            }
        }
    }
    Ok(())
}

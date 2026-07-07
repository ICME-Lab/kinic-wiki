// Where: crates/vfs_cli_core/src/commands/market.rs
// What: Marketplace subcommand handlers.
// Why: Mechanical split out of commands.rs by command family.
use super::*;

pub(crate) async fn run_market_command(client: &impl VfsApi, command: MarketCommand) -> Result<()> {
    match command {
        MarketCommand::Entitlements {
            cursor,
            limit,
            json,
        } => {
            let page = client.market_list_entitlements(cursor, limit).await?;
            print_market_entitlement_page(page, json)?;
        }
    }
    Ok(())
}

pub(crate) fn print_market_entitlement_page(page: MarketEntitlementPage, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(&page)?);
        return Ok(());
    }

    for entitlement in page.entitlements {
        println!(
            "{}\t{}\t{}\t{}\t{}",
            entitlement.database_id,
            entitlement.listing_id,
            entitlement.order_id,
            entitlement.status,
            entitlement.purchased_at_ms
        );
    }
    if let Some(next_cursor) = page.next_cursor {
        println!("next_cursor\t{next_cursor}");
    }
    Ok(())
}

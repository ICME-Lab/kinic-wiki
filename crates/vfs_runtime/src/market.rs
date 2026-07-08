// Where: crates/vfs_runtime/src/market.rs
// What: Marketplace listings, purchases, orders, and entitlements.
// Why: Mechanical split out of lib.rs; a child module keeps same-crate private access.
use super::*;

impl VfsService {
    pub fn market_create_listing(
        &self,
        caller: &str,
        request: MarketCreateListingRequest,
        now: i64,
    ) -> Result<MarketListing, String> {
        require_authenticated_principal(caller)?;
        validate_market_create_listing_request(&request)?;
        self.write_index(|tx| {
            require_market_seller_can_list(tx, caller, &request.database_id)?;
            let listing_id = unique_market_id(
                tx,
                "market_listings",
                "listing_id",
                GENERATED_LISTING_ID_PREFIX,
                caller,
                &request.database_id,
                now,
            )?;
            tx.execute(
                "INSERT INTO market_listings
                 (listing_id, seller_principal, payout_principal, database_id, price_e8s, status,
                  revision, purchase_count, report_count, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 0, ?7, ?7)",
                params![
                    listing_id,
                    caller,
                    request.payout_principal,
                    request.database_id,
                    i64::try_from(request.price_e8s).map_err(|error| error.to_string())?,
                    MARKET_LISTING_STATUS_ACTIVE,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            load_market_listing_by_id(tx, &listing_id)?
                .ok_or_else(|| "market listing insert failed".to_string())
        })
    }

    pub fn market_update_listing(
        &self,
        caller: &str,
        request: MarketUpdateListingRequest,
        now: i64,
    ) -> Result<MarketListing, String> {
        require_authenticated_principal(caller)?;
        validate_market_update_listing_request(&request)?;
        self.write_index(|tx| {
            let listing = load_market_listing_by_id(tx, &request.listing_id)?
                .ok_or_else(|| "market listing not found".to_string())?;
            require_market_listing_seller_or_admin(tx, caller, &listing)?;
            if listing.status == MarketListingStatus::Active {
                require_market_seller_can_list(
                    tx,
                    &listing.seller_principal,
                    &listing.database_id,
                )?;
            }
            tx.execute(
                "UPDATE market_listings
                 SET price_e8s = ?2,
                     payout_principal = ?5,
                     revision = revision + 1,
                     updated_at_ms = ?4
                 WHERE listing_id = ?1
                   AND revision = ?3",
                params![
                    request.listing_id,
                    i64::try_from(request.price_e8s).map_err(|error| error.to_string())?,
                    i64::try_from(request.expected_revision).map_err(|error| error.to_string())?,
                    now,
                    request.payout_principal
                ],
            )
            .map_err(|error| error.to_string())?;
            let updated: i64 = tx
                .query_row("SELECT changes()", params![], |row| {
                    crate::sqlite::row_get(row, 0)
                })
                .map_err(|error| error.to_string())?;
            if updated == 0 {
                return Err("market listing revision mismatch".to_string());
            }
            load_market_listing_by_id(tx, &listing.listing_id)?
                .ok_or_else(|| "market listing update failed".to_string())
        })
    }

    pub fn market_publish_listing(
        &self,
        caller: &str,
        listing_id: &str,
        now: i64,
    ) -> Result<MarketListing, String> {
        self.market_set_listing_status(caller, listing_id, MARKET_LISTING_STATUS_ACTIVE, now)
    }

    pub fn market_pause_listing(
        &self,
        caller: &str,
        listing_id: &str,
        now: i64,
    ) -> Result<MarketListing, String> {
        self.market_set_listing_status(caller, listing_id, MARKET_LISTING_STATUS_PAUSED, now)
    }

    fn market_set_listing_status(
        &self,
        caller: &str,
        listing_id: &str,
        status: &str,
        now: i64,
    ) -> Result<MarketListing, String> {
        require_authenticated_principal(caller)?;
        self.write_index(|tx| {
            let listing = load_market_listing_by_id(tx, listing_id)?
                .ok_or_else(|| "market listing not found".to_string())?;
            require_market_listing_seller_or_admin(tx, caller, &listing)?;
            if status == MARKET_LISTING_STATUS_ACTIVE {
                require_market_seller_can_list(
                    tx,
                    &listing.seller_principal,
                    &listing.database_id,
                )?;
            }
            tx.execute(
                "UPDATE market_listings
                 SET status = ?2,
                     updated_at_ms = ?3
                 WHERE listing_id = ?1",
                params![listing_id, status, now],
            )
            .map_err(|error| error.to_string())?;
            load_market_listing_by_id(tx, listing_id)?
                .ok_or_else(|| "market listing status update failed".to_string())
        })
    }

    pub fn market_list_listings(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<MarketListingPage, String> {
        let limit = page_limit(limit);
        let after = cursor.unwrap_or_default();
        self.read_index(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT l.listing_id, l.seller_principal, l.payout_principal, l.database_id,
                            l.price_e8s, l.status, l.revision, l.purchase_count, l.report_count,
                            l.created_at_ms, l.updated_at_ms,
                            d.name, d.description, d.llm_summary, d.tags_json
                     FROM market_listings l
                     JOIN databases d ON d.database_id = l.database_id
                     JOIN database_members m
                       ON m.database_id = l.database_id
                      AND m.principal = l.seller_principal
                      AND m.role = 'owner'
                     WHERE l.status = ?1
                       AND d.status = ?2
                       AND l.listing_id > ?3
                     ORDER BY l.listing_id ASC
                     LIMIT ?4",
                )
                .map_err(|error| error.to_string())?;
            let mut listings = crate::sqlite::query_map(
                &mut stmt,
                params![
                    MARKET_LISTING_STATUS_ACTIVE,
                    status_to_db(DatabaseStatus::Active),
                    after,
                    i64::from(limit) + 1
                ],
                map_market_listing_view,
            )
            .map_err(|error| error.to_string())?;
            let next_cursor = if listings.len() > limit as usize {
                listings.pop();
                listings.last().map(|view| view.listing.listing_id.clone())
            } else {
                None
            };
            Ok(MarketListingPage {
                listings,
                next_cursor,
            })
        })
    }

    pub fn market_list_seller_listings(
        &self,
        seller_principal: &str,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<MarketListingPage, String> {
        require_authenticated_principal(seller_principal)?;
        let limit = page_limit(limit);
        let after = cursor.unwrap_or_default();
        self.read_index(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT l.listing_id, l.seller_principal, l.payout_principal, l.database_id,
                            l.price_e8s, l.status, l.revision, l.purchase_count, l.report_count,
                            l.created_at_ms, l.updated_at_ms,
                            d.name, d.description, d.llm_summary, d.tags_json
                     FROM market_listings l
                     JOIN databases d ON d.database_id = l.database_id
                     JOIN database_members m
                       ON m.database_id = l.database_id
                      AND m.principal = l.seller_principal
                      AND m.role = 'owner'
                     WHERE l.status = ?1
                       AND d.status = ?2
                       AND l.seller_principal = ?3
                       AND l.listing_id > ?4
                     ORDER BY l.listing_id ASC
                     LIMIT ?5",
                )
                .map_err(|error| error.to_string())?;
            let mut listings = crate::sqlite::query_map(
                &mut stmt,
                params![
                    MARKET_LISTING_STATUS_ACTIVE,
                    status_to_db(DatabaseStatus::Active),
                    seller_principal,
                    after,
                    i64::from(limit) + 1
                ],
                map_market_listing_view,
            )
            .map_err(|error| error.to_string())?;
            let next_cursor = if listings.len() > limit as usize {
                listings.pop();
                listings.last().map(|view| view.listing.listing_id.clone())
            } else {
                None
            };
            Ok(MarketListingPage {
                listings,
                next_cursor,
            })
        })
    }

    pub fn market_list_database_listings(
        &self,
        caller: &str,
        database_id: &str,
    ) -> Result<Vec<MarketListing>, String> {
        require_authenticated_principal(caller)?;
        validate_database_id(database_id)?;
        self.read_index(|conn| {
            let role = load_member_role(conn, database_id, caller)?
                .ok_or_else(|| format!("principal has no access to database: {database_id}"))?;
            if role != DatabaseRole::Owner {
                return Err(format!(
                    "principal lacks required database role: {database_id}"
                ));
            }
            let mut stmt = conn
                .prepare(
                    "SELECT listing_id, seller_principal, payout_principal, database_id,
                            price_e8s, status, revision, purchase_count, report_count,
                            created_at_ms, updated_at_ms
                     FROM market_listings
                     WHERE database_id = ?1
                     ORDER BY updated_at_ms DESC, listing_id ASC",
                )
                .map_err(|error| error.to_string())?;
            crate::sqlite::query_map(&mut stmt, params![database_id], map_market_listing)
                .map_err(|error| error.to_string())
        })
    }

    pub fn market_get_listing(
        &self,
        caller: &str,
        listing_id: &str,
    ) -> Result<MarketListingDetail, String> {
        let listing = self.read_index(|conn| {
            let listing = load_market_listing_by_id(conn, listing_id)?
                .ok_or_else(|| "market listing not found".to_string())?;
            if require_market_listing_purchasable(conn, &listing).is_ok() {
                return Ok(listing);
            }
            require_market_listing_seller_or_admin(conn, caller, &listing)?;
            Ok(listing)
        })?;
        self.market_listing_detail(listing)
    }

    pub fn market_listing_database_name_for_consent(
        &self,
        listing_id: &str,
    ) -> Result<String, String> {
        self.read_index(|conn| load_market_listing_database_name(conn, listing_id))
    }

    fn market_listing_detail(&self, listing: MarketListing) -> Result<MarketListingDetail, String> {
        let meta = self.database_meta(&listing.database_id)?;
        let view = MarketListingView {
            listing: listing.clone(),
            database_metadata: meta.metadata.clone(),
        };
        let store = self.database_store(&meta)?;
        let (verified_stats, mut preview) = store.marketplace_preview()?;
        preview.preview_stale = false;
        Ok(MarketListingDetail {
            listing: view,
            verified_stats,
            preview,
        })
    }

    pub fn market_preview_purchase(
        &self,
        caller: &str,
        listing_id: &str,
    ) -> Result<MarketPurchasePreview, String> {
        require_authenticated_principal(caller)?;
        self.read_index(|conn| {
            let listing = load_market_listing_by_id(conn, listing_id)?
                .ok_or_else(|| "market listing not found".to_string())?;
            require_market_listing_purchasable(conn, &listing)?;
            Ok(MarketPurchasePreview {
                listing_id: listing.listing_id.clone(),
                database_id: listing.database_id.clone(),
                price_e8s: listing.price_e8s,
                already_entitled: has_active_market_entitlement(
                    conn,
                    &listing.database_id,
                    caller,
                )?,
            })
        })
    }

    pub fn begin_market_purchase_with_ledger_details(
        &self,
        caller: &str,
        request: MarketPurchaseRequest,
        ledger: CyclesPendingLedgerDetailsInput<'_>,
        now: i64,
    ) -> Result<MarketPurchaseStart, String> {
        require_authenticated_principal(caller)?;
        self.write_index(|tx| {
            let validation = validate_market_purchase_input(tx, request)?;
            let request = validation.request;
            let listing = validation.listing;
            if !ledger.to_owner.is_empty() && ledger.to_owner != listing.payout_principal {
                return Err(
                    "market purchase ledger recipient must match listing payout principal"
                        .to_string(),
                );
            }
            let price_e8s = amount_to_i64(request.price_e8s)?;
            let ledger_fee_e8s = amount_to_i64(ledger.ledger_fee_e8s)?;
            let ledger_created_at_time_ns = i64::try_from(ledger.ledger_created_at_time_ns)
                .map_err(|_| "ledger created_at_time exceeds i64".to_string())?;
            let operation_id = insert_pending_market_purchase_operation(
                tx,
                PendingMarketPurchaseInsert {
                    listing_id: &listing.listing_id,
                    database_id: &listing.database_id,
                    buyer_principal: &request.access_principal,
                    seller_principal: &listing.seller_principal,
                    price_e8s,
                    ledger: PendingCyclesLedgerDetails {
                        from_owner: ledger.from_owner,
                        from_subaccount: ledger.from_subaccount,
                        to_owner: &listing.payout_principal,
                        to_subaccount: ledger.to_subaccount,
                        ledger_fee_e8s,
                        ledger_created_at_time_ns,
                    },
                    operation_status: CYCLES_OPERATION_STATUS_IN_FLIGHT,
                    now,
                },
            )?;
            Ok(MarketPurchaseStart {
                operation_id,
                listing_id: listing.listing_id,
                database_id: listing.database_id,
                seller_principal: listing.seller_principal,
                payout_principal: listing.payout_principal,
                price_e8s: request.price_e8s,
                access_principal: request.access_principal,
            })
        })
    }

    pub fn validate_market_purchase_for_consent(
        &self,
        payer: &str,
        request: &MarketPurchaseRequest,
    ) -> Result<MarketPurchaseValidation, String> {
        require_authenticated_principal(payer)?;
        self.read_index(|conn| validate_market_purchase_input(conn, request.clone()))
    }

    pub fn market_purchase_access(
        &self,
        caller: &str,
        request: MarketPurchaseRequest,
        now: i64,
    ) -> Result<MarketOrder, String> {
        let price_e8s = request.price_e8s;
        let listing_id = request.listing_id.clone();
        let start = self.begin_market_purchase_with_ledger_details(
            caller,
            request,
            CyclesPendingLedgerDetailsInput {
                from_owner: caller,
                from_subaccount: None,
                to_owner: "",
                to_subaccount: None,
                ledger_fee_e8s: 0,
                ledger_created_at_time_ns: millis_to_nanos(now)?,
            },
            now,
        )?;
        self.complete_market_purchase_ledger_transfer(
            start.operation_id,
            &start.access_principal,
            &listing_id,
            price_e8s,
            0,
        )?;
        self.apply_market_purchase(
            start.operation_id,
            &start.access_principal,
            &listing_id,
            price_e8s,
            now,
        )
    }

    pub fn complete_market_purchase_ledger_transfer(
        &self,
        operation_id: u64,
        access_principal: &str,
        listing_id: &str,
        price_e8s: u64,
        ledger_block_index: u64,
    ) -> Result<(), String> {
        let price_e8s = amount_to_i64(price_e8s)?;
        let ledger_block_index = i64::try_from(ledger_block_index)
            .map_err(|_| "ledger block index exceeds i64".to_string())?;
        self.write_index(|tx| {
            let operation = load_required_pending_market_purchase(
                tx,
                PendingMarketPurchaseMatch {
                    operation_id,
                    buyer_principal: access_principal,
                    listing_id,
                    price_e8s,
                },
            )?;
            require_market_purchase_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "complete market purchase ledger transfer",
            )?;
            update_pending_operation_completed(
                tx,
                "market_purchase_pending_operations",
                operation_id,
                ledger_block_index,
            )?;
            Ok(())
        })
    }

    pub fn apply_market_purchase(
        &self,
        operation_id: u64,
        access_principal: &str,
        listing_id: &str,
        price_e8s: u64,
        now: i64,
    ) -> Result<MarketOrder, String> {
        let price_e8s = amount_to_i64(price_e8s)?;
        self.write_index(|tx| {
            let operation = load_required_pending_market_purchase(
                tx,
                PendingMarketPurchaseMatch {
                    operation_id,
                    buyer_principal: access_principal,
                    listing_id,
                    price_e8s,
                },
            )?;
            require_market_purchase_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_COMPLETED],
                "apply market purchase",
            )?;
            let ledger_block_index = operation.ledger_block_index.ok_or_else(|| {
                "completed market purchase missing ledger block index".to_string()
            })?;
            if has_active_market_entitlement(tx, &operation.database_id, access_principal)? {
                return Err("active entitlement already exists".to_string());
            }
            let order_id = unique_market_id(
                tx,
                "market_orders",
                "order_id",
                GENERATED_ORDER_ID_PREFIX,
                access_principal,
                &operation.listing_id,
                now,
            )?;
            tx.execute(
                "INSERT INTO market_orders
                 (order_id, listing_id, database_id, buyer_principal, seller_principal,
                  payout_principal, price_e8s, ledger_block_index, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    order_id,
                    operation.listing_id,
                    operation.database_id,
                    access_principal,
                    operation.seller_principal,
                    operation.payout_principal,
                    price_e8s,
                    ledger_block_index,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO market_entitlements
                 (database_id, buyer_principal, listing_id, order_id, purchased_at_ms, status)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    operation.database_id,
                    access_principal,
                    operation.listing_id,
                    order_id,
                    now,
                    MARKET_ENTITLEMENT_STATUS_ACTIVE
                ],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE market_listings
                 SET purchase_count = purchase_count + 1,
                     updated_at_ms = ?2
                 WHERE listing_id = ?1",
                params![operation.listing_id, now],
            )
            .map_err(|error| error.to_string())?;
            delete_pending_market_purchase(tx, operation_id)?;
            load_market_order_by_id(tx, &order_id)?
                .ok_or_else(|| "market order insert failed".to_string())
        })
    }

    pub fn cancel_market_purchase(
        &self,
        operation_id: u64,
        access_principal: &str,
        listing_id: &str,
        price_e8s: u64,
    ) -> Result<(), String> {
        let price_e8s = amount_to_i64(price_e8s)?;
        self.write_index(|tx| {
            let operation = load_required_pending_market_purchase(
                tx,
                PendingMarketPurchaseMatch {
                    operation_id,
                    buyer_principal: access_principal,
                    listing_id,
                    price_e8s,
                },
            )?;
            require_market_purchase_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "cancel market purchase",
            )?;
            delete_pending_market_purchase(tx, operation_id)
        })
    }

    pub fn mark_market_purchase_ambiguous(
        &self,
        operation_id: u64,
        access_principal: &str,
        listing_id: &str,
        price_e8s: u64,
    ) -> Result<(), String> {
        let price_e8s = amount_to_i64(price_e8s)?;
        self.write_index(|tx| {
            let operation = load_required_pending_market_purchase(
                tx,
                PendingMarketPurchaseMatch {
                    operation_id,
                    buyer_principal: access_principal,
                    listing_id,
                    price_e8s,
                },
            )?;
            require_market_purchase_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "mark market purchase ambiguous",
            )?;
            update_pending_operation_status(
                tx,
                "market_purchase_pending_operations",
                operation_id,
                CYCLES_OPERATION_STATUS_AMBIGUOUS,
            )?;
            Ok(())
        })
    }

    pub fn market_list_entitlements(
        &self,
        caller: &str,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<MarketEntitlementPage, String> {
        require_authenticated_principal(caller)?;
        let limit = page_limit(limit);
        let after = cursor.unwrap_or_default();
        self.read_index(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT database_id, buyer_principal, listing_id, order_id,
                            purchased_at_ms, status
                     FROM market_entitlements
                     WHERE buyer_principal = ?1
                       AND database_id > ?2
                       AND status = ?3
                     ORDER BY database_id ASC
                     LIMIT ?4",
                )
                .map_err(|error| error.to_string())?;
            let mut entitlements = crate::sqlite::query_map(
                &mut stmt,
                params![
                    caller,
                    after,
                    MARKET_ENTITLEMENT_STATUS_ACTIVE,
                    i64::from(limit) + 1
                ],
                map_market_entitlement,
            )
            .map_err(|error| error.to_string())?;
            let next_cursor = if entitlements.len() > limit as usize {
                entitlements.pop();
                entitlements
                    .last()
                    .map(|entitlement| entitlement.database_id.clone())
            } else {
                None
            };
            Ok(MarketEntitlementPage {
                entitlements,
                next_cursor,
            })
        })
    }

    pub fn market_list_database_entitlements(
        &self,
        caller: &str,
        database_id: &str,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<MarketEntitlementPage, String> {
        require_authenticated_principal(caller)?;
        let limit = page_limit(limit);
        let after = cursor.unwrap_or_default();
        self.read_index(|conn| {
            require_database_owner_or_billing_admin(conn, caller, database_id)?;
            let mut stmt = conn
                .prepare(
                    "SELECT database_id, buyer_principal, listing_id, order_id,
                            purchased_at_ms, status
                     FROM market_entitlements
                     WHERE database_id = ?1
                       AND buyer_principal > ?2
                       AND status = ?3
                     ORDER BY buyer_principal ASC
                     LIMIT ?4",
                )
                .map_err(|error| error.to_string())?;
            let mut entitlements = crate::sqlite::query_map(
                &mut stmt,
                params![
                    database_id,
                    after,
                    MARKET_ENTITLEMENT_STATUS_ACTIVE,
                    i64::from(limit) + 1
                ],
                map_market_entitlement,
            )
            .map_err(|error| error.to_string())?;
            let next_cursor = if entitlements.len() > limit as usize {
                entitlements.pop();
                entitlements
                    .last()
                    .map(|entitlement| entitlement.buyer_principal.clone())
            } else {
                None
            };
            Ok(MarketEntitlementPage {
                entitlements,
                next_cursor,
            })
        })
    }

    pub fn market_list_orders(
        &self,
        caller: &str,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<MarketOrderPage, String> {
        require_authenticated_principal(caller)?;
        let limit = page_limit(limit);
        let after = cursor.unwrap_or_default();
        self.read_index(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT order_id, listing_id, database_id, buyer_principal, seller_principal,
                            payout_principal, price_e8s, ledger_block_index, created_at_ms
                     FROM market_orders
                     WHERE buyer_principal = ?1 AND order_id > ?2
                     ORDER BY order_id ASC
                     LIMIT ?3",
                )
                .map_err(|error| error.to_string())?;
            let mut orders = crate::sqlite::query_map(
                &mut stmt,
                params![caller, after, i64::from(limit) + 1],
                map_market_order,
            )
            .map_err(|error| error.to_string())?;
            let next_cursor = if orders.len() > limit as usize {
                orders.pop();
                orders.last().map(|order| order.order_id.clone())
            } else {
                None
            };
            Ok(MarketOrderPage {
                orders,
                next_cursor,
            })
        })
    }

    pub fn market_count_active_entitlements(
        &self,
        caller: &str,
        database_id: &str,
    ) -> Result<u64, String> {
        require_authenticated_principal(caller)?;
        self.read_index(|conn| {
            load_database_status(conn, database_id)?;
            let config = load_cycles_billing_config(conn)?;
            if caller != config.billing_authority_id {
                let role = load_member_role(conn, database_id, caller)?
                    .ok_or_else(|| format!("principal has no access to database: {database_id}"))?;
                if role != DatabaseRole::Owner {
                    return Err(format!(
                        "principal lacks required database role: {database_id}"
                    ));
                }
            }
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*)
                     FROM market_entitlements
                     WHERE database_id = ?1
                       AND status = ?2",
                    params![database_id, MARKET_ENTITLEMENT_STATUS_ACTIVE],
                    |row| crate::sqlite::row_get(row, 0),
                )
                .map_err(|error| error.to_string())?;
            u64::try_from(count).map_err(|error| error.to_string())
        })
    }
}

pub struct MarketPurchaseStart {
    pub operation_id: u64,
    pub listing_id: String,
    pub database_id: String,
    pub seller_principal: String,
    pub payout_principal: String,
    pub price_e8s: u64,
    pub access_principal: String,
}

pub struct MarketPurchaseValidation {
    pub request: MarketPurchaseRequest,
    pub listing: MarketListing,
}

struct PendingMarketPurchase {
    listing_id: String,
    database_id: String,
    buyer_principal: String,
    seller_principal: String,
    payout_principal: String,
    price_e8s: i64,
    operation_status: String,
    ledger_block_index: Option<i64>,
}

struct PendingMarketPurchaseInsert<'a> {
    listing_id: &'a str,
    database_id: &'a str,
    buyer_principal: &'a str,
    seller_principal: &'a str,
    price_e8s: i64,
    ledger: PendingCyclesLedgerDetails<'a>,
    operation_status: &'a str,
    now: i64,
}

struct PendingMarketPurchaseMatch<'a> {
    operation_id: u64,
    buyer_principal: &'a str,
    listing_id: &'a str,
    price_e8s: i64,
}

fn insert_pending_market_purchase_operation(
    conn: &Transaction<'_>,
    operation: PendingMarketPurchaseInsert<'_>,
) -> Result<u64, String> {
    let values = vec![
        crate::sqlite::text_value(operation.listing_id),
        crate::sqlite::text_value(operation.database_id),
        crate::sqlite::text_value(operation.buyer_principal),
        crate::sqlite::text_value(operation.seller_principal),
        crate::sqlite::integer_value(operation.price_e8s),
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
        "INSERT INTO market_purchase_pending_operations
         (listing_id, database_id, buyer_principal, seller_principal, price_e8s,
          from_owner, from_subaccount, to_owner, to_subaccount, ledger_fee_e8s,
          ledger_created_at_time_ns, operation_status, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        &values,
    )
    .map_err(|error| error.to_string())?;
    let operation_id = crate::sqlite::last_insert_rowid(conn).map_err(|error| error.to_string())?;
    u64::try_from(operation_id).map_err(|error| error.to_string())
}

fn load_pending_market_purchase(
    conn: &Connection,
    operation_id: u64,
) -> Result<PendingMarketPurchase, String> {
    let operation_id = i64::try_from(operation_id).map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT listing_id, database_id, buyer_principal, seller_principal, to_owner,
                price_e8s, operation_status, ledger_block_index
         FROM market_purchase_pending_operations
         WHERE operation_id = ?1",
        params![operation_id],
        |row| {
            Ok(PendingMarketPurchase {
                listing_id: crate::sqlite::row_get(row, 0)?,
                database_id: crate::sqlite::row_get(row, 1)?,
                buyer_principal: crate::sqlite::row_get(row, 2)?,
                seller_principal: crate::sqlite::row_get(row, 3)?,
                payout_principal: crate::sqlite::row_get(row, 4)?,
                price_e8s: crate::sqlite::row_get(row, 5)?,
                operation_status: crate::sqlite::row_get(row, 6)?,
                ledger_block_index: crate::sqlite::row_get(row, 7)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "pending market purchase not found".to_string())
}

fn load_required_pending_market_purchase(
    conn: &Transaction<'_>,
    expected: PendingMarketPurchaseMatch<'_>,
) -> Result<PendingMarketPurchase, String> {
    let operation = load_pending_market_purchase(conn, expected.operation_id)?;
    if operation.buyer_principal != expected.buyer_principal
        || operation.listing_id != expected.listing_id
        || operation.price_e8s != expected.price_e8s
    {
        return Err("pending market purchase mismatch".to_string());
    }
    Ok(operation)
}

fn require_market_purchase_operation_status(
    operation: &PendingMarketPurchase,
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
        "cannot {action}; market purchase operation is {}",
        operation.operation_status
    ))
}

fn ensure_no_pending_market_purchase_for_buyer(
    conn: &Connection,
    listing_id: &str,
    buyer_principal: &str,
) -> Result<(), String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM market_purchase_pending_operations
             WHERE listing_id = ?1
               AND buyer_principal = ?2",
            params![listing_id, buyer_principal],
            |row| crate::sqlite::row_get(row, 0),
        )
        .map_err(|error| error.to_string())?;
    if count > 0 {
        return Err("market purchase already pending for buyer".to_string());
    }
    Ok(())
}

fn delete_pending_market_purchase(conn: &Transaction<'_>, operation_id: u64) -> Result<(), String> {
    let operation_id = i64::try_from(operation_id).map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM market_purchase_pending_operations WHERE operation_id = ?1",
        params![operation_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn require_authenticated_principal(caller: &str) -> Result<(), String> {
    if caller == ANONYMOUS_PRINCIPAL {
        return Err("anonymous caller not allowed".to_string());
    }
    Ok(())
}

fn normalize_authenticated_principal_text(value: &str) -> Result<String, String> {
    let principal = Principal::from_text(value)
        .map_err(|error| format!("principal text is invalid: {error}"))?;
    if principal == Principal::anonymous() {
        return Err("principal must not be anonymous".to_string());
    }
    Ok(principal.to_text())
}

fn normalize_market_purchase_request(
    mut request: MarketPurchaseRequest,
) -> Result<MarketPurchaseRequest, String> {
    request.access_principal = normalize_authenticated_principal_text(&request.access_principal)?;
    if request.listing_id.trim().is_empty() {
        return Err("market listing id is required".to_string());
    }
    if request.price_e8s == 0 {
        return Err("market listing price must be positive".to_string());
    }
    Ok(request)
}

fn require_market_seller_can_list(
    conn: &Connection,
    seller: &str,
    database_id: &str,
) -> Result<(), String> {
    let status = load_database_status(conn, database_id)?;
    if status != DatabaseStatus::Active {
        return Err(format!(
            "database is {}: {database_id}",
            status_to_db(status)
        ));
    }
    let role = load_member_role(conn, database_id, seller)?
        .ok_or_else(|| format!("principal has no access to database: {database_id}"))?;
    if role != DatabaseRole::Owner {
        return Err("market seller must be database owner".to_string());
    }
    Ok(())
}

fn require_market_listing_seller_or_admin(
    conn: &Connection,
    caller: &str,
    listing: &MarketListing,
) -> Result<(), String> {
    let config = load_cycles_billing_config(conn)?;
    if caller == listing.seller_principal || caller == config.billing_authority_id {
        return Ok(());
    }
    Err("market listing seller or admin required".to_string())
}

fn require_database_owner_or_billing_admin(
    conn: &Connection,
    caller: &str,
    database_id: &str,
) -> Result<(), String> {
    let config = load_cycles_billing_config(conn)?;
    if caller == config.billing_authority_id {
        return Ok(());
    }
    if load_member_role(conn, database_id, caller)? == Some(DatabaseRole::Owner) {
        return Ok(());
    }
    Err("database owner or admin required".to_string())
}

fn require_market_listing_purchasable(
    conn: &Connection,
    listing: &MarketListing,
) -> Result<(), String> {
    if listing.status != MarketListingStatus::Active {
        return Err("market listing is not active".to_string());
    }
    require_market_seller_can_list(conn, &listing.seller_principal, &listing.database_id)
}

fn validate_market_purchase_request(
    conn: &Connection,
    request: &MarketPurchaseRequest,
) -> Result<MarketListing, String> {
    let listing = load_market_listing_by_id(conn, &request.listing_id)?
        .ok_or_else(|| "market listing not found".to_string())?;
    require_market_listing_purchasable(conn, &listing)?;
    if listing.price_e8s != request.price_e8s {
        return Err("market listing price mismatch".to_string());
    }
    if request.access_principal == listing.seller_principal {
        return Err("market seller cannot purchase own listing".to_string());
    }
    if has_active_market_entitlement(conn, &listing.database_id, &request.access_principal)? {
        return Err("active entitlement already exists".to_string());
    }
    ensure_no_pending_market_purchase_for_buyer(
        conn,
        &listing.listing_id,
        &request.access_principal,
    )?;
    Ok(listing)
}

fn validate_market_purchase_input(
    conn: &Connection,
    request: MarketPurchaseRequest,
) -> Result<MarketPurchaseValidation, String> {
    let request = normalize_market_purchase_request(request)?;
    let listing = validate_market_purchase_request(conn, &request)?;
    Ok(MarketPurchaseValidation { request, listing })
}

pub(crate) fn has_active_market_entitlement(
    conn: &Connection,
    database_id: &str,
    caller: &str,
) -> Result<bool, String> {
    if caller == ANONYMOUS_PRINCIPAL {
        return Ok(false);
    }
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM market_entitlements
             WHERE database_id = ?1
               AND buyer_principal = ?2
               AND status = ?3",
            params![database_id, caller, MARKET_ENTITLEMENT_STATUS_ACTIVE],
            |row| crate::sqlite::row_get(row, 0),
        )
        .map_err(|error| error.to_string())?;
    Ok(count > 0)
}

fn load_market_listing_by_id(
    conn: &Connection,
    listing_id: &str,
) -> Result<Option<MarketListing>, String> {
    conn.query_row(
        "SELECT listing_id, seller_principal, payout_principal, database_id, price_e8s, status,
                revision, purchase_count, report_count, created_at_ms, updated_at_ms
         FROM market_listings
         WHERE listing_id = ?1",
        params![listing_id],
        map_market_listing,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_market_listing_database_name(
    conn: &Connection,
    listing_id: &str,
) -> Result<String, String> {
    conn.query_row(
        "SELECT d.name
         FROM market_listings l
         JOIN databases d ON d.database_id = l.database_id
         WHERE l.listing_id = ?1",
        params![listing_id],
        |row| crate::sqlite::row_get(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn map_market_listing(row: &crate::sqlite::Row<'_>) -> crate::sqlite::Result<MarketListing> {
    let price_e8s: i64 = crate::sqlite::row_get(row, 4)?;
    let revision: i64 = crate::sqlite::row_get(row, 6)?;
    let purchase_count: i64 = crate::sqlite::row_get(row, 7)?;
    let report_count: i64 = crate::sqlite::row_get(row, 8)?;
    Ok(MarketListing {
        listing_id: crate::sqlite::row_get(row, 0)?,
        seller_principal: crate::sqlite::row_get(row, 1)?,
        payout_principal: crate::sqlite::row_get(row, 2)?,
        database_id: crate::sqlite::row_get(row, 3)?,
        price_e8s: u64::try_from(price_e8s)
            .map_err(|_| crate::sqlite::integral_value_out_of_range(4, price_e8s))?,
        status: market_listing_status_from_db(&crate::sqlite::row_get::<String>(row, 5)?)?,
        revision: u64::try_from(revision)
            .map_err(|_| crate::sqlite::integral_value_out_of_range(6, revision))?,
        purchase_count: u64::try_from(purchase_count)
            .map_err(|_| crate::sqlite::integral_value_out_of_range(7, purchase_count))?,
        report_count: u64::try_from(report_count)
            .map_err(|_| crate::sqlite::integral_value_out_of_range(8, report_count))?,
        created_at_ms: crate::sqlite::row_get(row, 9)?,
        updated_at_ms: crate::sqlite::row_get(row, 10)?,
    })
}

fn map_market_listing_view(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<MarketListingView> {
    Ok(MarketListingView {
        listing: map_market_listing(row)?,
        database_metadata: DatabaseMetadata {
            name: crate::sqlite::row_get(row, 11)?,
            description: crate::sqlite::row_get(row, 12)?,
            llm_summary: crate::sqlite::row_get(row, 13)?,
            tags_json: crate::sqlite::row_get(row, 14)?,
        },
    })
}

fn load_market_order_by_id(
    conn: &Connection,
    order_id: &str,
) -> Result<Option<MarketOrder>, String> {
    conn.query_row(
        "SELECT order_id, listing_id, database_id, buyer_principal, seller_principal,
                payout_principal, price_e8s, ledger_block_index, created_at_ms
         FROM market_orders
         WHERE order_id = ?1",
        params![order_id],
        map_market_order,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn map_market_order(row: &crate::sqlite::Row<'_>) -> crate::sqlite::Result<MarketOrder> {
    let price_e8s: i64 = crate::sqlite::row_get(row, 6)?;
    let ledger_block_index: i64 = crate::sqlite::row_get(row, 7)?;
    Ok(MarketOrder {
        order_id: crate::sqlite::row_get(row, 0)?,
        listing_id: crate::sqlite::row_get(row, 1)?,
        database_id: crate::sqlite::row_get(row, 2)?,
        buyer_principal: crate::sqlite::row_get(row, 3)?,
        seller_principal: crate::sqlite::row_get(row, 4)?,
        payout_principal: crate::sqlite::row_get(row, 5)?,
        price_e8s: u64::try_from(price_e8s)
            .map_err(|_| crate::sqlite::integral_value_out_of_range(6, price_e8s))?,
        ledger_block_index: u64::try_from(ledger_block_index)
            .map_err(|_| crate::sqlite::integral_value_out_of_range(7, ledger_block_index))?,
        created_at_ms: crate::sqlite::row_get(row, 8)?,
    })
}

fn map_market_entitlement(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<MarketEntitlement> {
    Ok(MarketEntitlement {
        database_id: crate::sqlite::row_get(row, 0)?,
        buyer_principal: crate::sqlite::row_get(row, 1)?,
        listing_id: crate::sqlite::row_get(row, 2)?,
        order_id: crate::sqlite::row_get(row, 3)?,
        purchased_at_ms: crate::sqlite::row_get(row, 4)?,
        status: crate::sqlite::row_get(row, 5)?,
    })
}

fn market_listing_status_from_db(value: &str) -> crate::sqlite::Result<MarketListingStatus> {
    match value {
        MARKET_LISTING_STATUS_ACTIVE => Ok(MarketListingStatus::Active),
        MARKET_LISTING_STATUS_PAUSED => Ok(MarketListingStatus::Paused),
        _ => Err(crate::sqlite::invalid_query()),
    }
}

fn validate_market_create_listing_request(
    request: &MarketCreateListingRequest,
) -> Result<(), String> {
    validate_database_id(&request.database_id)?;
    validate_principal_text(&request.payout_principal)?;
    validate_market_listing_price(request.price_e8s)
}

fn validate_market_update_listing_request(
    request: &MarketUpdateListingRequest,
) -> Result<(), String> {
    validate_principal_text(&request.payout_principal)?;
    validate_market_listing_price(request.price_e8s)
}

fn validate_market_listing_price(price_e8s: u64) -> Result<(), String> {
    if price_e8s == 0 {
        return Err("market listing price must be positive".to_string());
    }
    amount_to_i64(price_e8s)?;
    Ok(())
}

fn unique_market_id(
    conn: &Connection,
    table: &str,
    column: &str,
    prefix: &str,
    caller: &str,
    seed: &str,
    now: i64,
) -> Result<String, String> {
    for attempt in 0..16_u32 {
        let id = generated_market_id(prefix, caller, seed, now, attempt);
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?1");
        let count: i64 = conn
            .query_row(&sql, params![id], |row| crate::sqlite::row_get(row, 0))
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(id);
        }
    }
    Err("failed to allocate market id".to_string())
}

fn generated_market_id(prefix: &str, caller: &str, seed: &str, now: i64, attempt: u32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prefix.as_bytes());
    hasher.update(caller.as_bytes());
    hasher.update(seed.as_bytes());
    hasher.update(now.to_be_bytes());
    hasher.update(attempt.to_be_bytes());
    format!(
        "{prefix}{}",
        &base32_lower(&hasher.finalize())[..GENERATED_MARKET_ID_HASH_CHARS]
    )
}

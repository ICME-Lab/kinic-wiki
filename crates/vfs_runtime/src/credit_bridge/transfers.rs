use super::*;

impl VfsService {
    pub fn quote_vault_transfer(
        &self,
        p: Principal,
        db: &str,
        amount: TransferAmount,
        operation: Vec<u8>,
        now: u64,
        estimate: u64,
    ) -> R<VaultTransfer> {
        auth(p)?;
        id(&operation)?;
        if db.len() > 128 {
            return Err("InvalidInput".into());
        }
        self.write_index(|c| {
            owner(c, db, p)?;
            let mut cfg = enabled(c)?;
            let l = active_link(c, p)?;
            let existing = match load(c, &operation) {
                Ok(t) => Some(t),
                Err(e) if e == "NotFound" => None,
                Err(e) => return Err(e),
            };
            if let Some(t) = existing {
                if t.view.database_id != db
                    || t.view.offer.wiki_owner != p
                    || t.view.requested != amount
                {
                    return Err("Conflict".into());
                }
                return Ok(t.view);
            }
            let mut transfer_count = 0;
            for old in all(c)? {
                if terminal(&old)
                    && !old.view.receiver_cleanup_pending
                    && now >= old.view.offer.expires_at_ns
                    && old.settled_day < now / DAY
                {
                    c.execute(
                        "DELETE FROM credit_bridge_transfers WHERE operation=?1",
                        params![id(&old.view.offer.operation)?],
                    )
                    .map_err(|e| e.to_string())?;
                } else {
                    transfer_count += 1;
                }
            }
            if transfer_count >= CAP as usize {
                return Err("Capacity".into());
            }
            settle_storage(c, db, p, now)?;
            let balance = database_balance_for_update(c, db)? as u64;
            let n = match amount {
                TransferAmount::All => balance,
                TransferAmount::Exact(n) => n,
            };
            if n == 0 || n > balance {
                return Err("InvalidInput".into());
            }
            cfg.serial = cfg.serial.checked_add(1).ok_or("Capacity")?;
            save_settings(c, &cfg)?;
            let t = Transfer {
                view: VaultTransfer {
                    offer: CreditOffer {
                        operation,
                        wiki_owner: p,
                        vault_owner: l.proof.challenge.vault_owner,
                        amount_cycles: n,
                        expires_at_ns: now.checked_add(TTL).ok_or("InvalidInput")?,
                        link_generation: l.proof.challenge.generation,
                    },
                    database_id: db.into(),
                    requested: amount,
                    phase: TransferPhase::Quoted,
                    balance_at_quote: balance,
                    estimated_execution_fee_cycles: estimate,
                    collected_execution_fee_cycles: 0,
                    receiver_cleanup_pending: false,
                },
                peer: cfg.config.peer,
                sequence: cfg.serial,
                attempt: 0,
                dispatched: false,
                held: false,
                published: false,
                settled_day: 0,
            };
            save(c, &t)?;
            Ok(t.view)
        })
    }
    /// Explicit AllAvailable consent authorizes the post-settlement balance. Each hold charges once.
    pub fn confirm_vault_transfer(
        &self,
        p: Principal,
        op: &[u8],
        approval: TransferApproval,
        charge: u128,
        now: u64,
    ) -> R<VaultTransfer> {
        self.write_index(|c| {
            let mut t = load(c, op)?;
            owner(c, &t.view.database_id, p)?;
            let s = enabled(c)?;
            validate_link(c, &t)?;
            check_approval(&t, &approval)?;
            if t.view.offer.expires_at_ns <= now {
                if !t.dispatched && !terminal(&t) {
                    refund(c, &mut t, now)?;
                }
                return Ok(t.view);
            }
            if t.view.phase != TransferPhase::Quoted {
                return Ok(t.view);
            }
            settle_storage(c, &t.view.database_id, p, now)?;
            let cfg = load_cycles_billing_config(c)?;
            let before = database_balance_for_update(c, &t.view.database_id)?;
            billing::charge_database_update_in_tx(
                c,
                billing::DatabaseCharge {
                    database_id: &t.view.database_id,
                    caller: &p.to_text(),
                    method: "execute_vault_transfer",
                    cycles_delta: charge,
                    now: (now / 1_000_000) as i64,
                    config: &cfg,
                    computed_charge: i64::try_from(charge).map_err(|_| "InvalidInput")?,
                },
            )?;
            let balance = database_balance_for_update(c, &t.view.database_id)? as u64;
            t.view.collected_execution_fee_cycles = before as u64 - balance;
            let n = match t.view.requested {
                TransferAmount::All => balance,
                TransferAmount::Exact(n) => n,
            };
            if n == 0 || n > balance {
                return Err("Capacity".into());
            }
            if daily(c, now)? + u128::from(n) > u128::from(s.config.daily_limit_cycles) {
                return Err("Capacity".into());
            }
            t.view.offer.amount_cycles = n;
            t.held = true;
            t.view.phase = TransferPhase::Offered;
            t.published = true;
            update_database_cycles_balance(
                c,
                &t.view.database_id,
                (balance - n) as i64,
                &cfg,
                (now / 1_000_000) as i64,
            )?;
            ledger(
                c,
                &t,
                "bridge_reserve",
                -(n as i64),
                (balance - n) as i64,
                now,
            )?;
            save(c, &t)?;
            Ok(t.view)
        })
    }
    pub fn validate_vault_transfer_approval(
        &self,
        p: Principal,
        op: &[u8],
        approval: &TransferApproval,
    ) -> R<()> {
        self.read_index(|c| {
            let t = load(c, op)?;
            allowed(c, &t, p)?;
            check_approval(&t, approval)
        })
    }
    pub fn pending_vault_transfer(
        &self,
        p: Principal,
        db: Option<&str>,
        now: u64,
    ) -> R<Option<VaultTransfer>> {
        auth(p)?;
        if db.is_some_and(|db| db.len() > 128) {
            return Err("InvalidInput".into());
        }
        let operation=self.read_index(|c| {
            let row:Option<String>=if let Some(db)=db {
                owner(c,db,p)?;
                c.query_row("SELECT record FROM credit_bridge_transfers WHERE database_id=?1 AND unresolved=1",params![db],|r|crate::sqlite::row_get(r,0)).optional().map_err(|e|e.to_string())?
            } else {
                c.query_row("SELECT record FROM credit_bridge_transfers WHERE payer=?1 AND unresolved=1",params![p.to_text()],|r|crate::sqlite::row_get(r,0)).optional().map_err(|e|e.to_string())?
            };
            row.map(|s|decode::<Transfer>(s).map(|t|t.view.offer.operation)).transpose()
        })?;
        operation
            .map(|op| self.get_vault_transfer(p, &op, now))
            .transpose()
    }
    pub fn collect_vault_execution_fee(
        &self,
        p: Principal,
        op: &[u8],
        delta: u128,
        now: u64,
    ) -> R<VaultTransfer> {
        self.write_index(|c| {
            let mut t = load(c, op)?;
            owner(c, &t.view.database_id, p)?;
            if t.dispatched || !t.held {
                return Err("Conflict".into());
            }
            let cfg = load_cycles_billing_config(c)?;
            let before = database_balance_for_update(c, &t.view.database_id)?;
            if delta > 0 {
                billing::charge_database_update_in_tx(
                    c,
                    billing::DatabaseCharge {
                        database_id: &t.view.database_id,
                        caller: &p.to_text(),
                        method: "execute_vault_transfer",
                        cycles_delta: delta,
                        now: (now / 1_000_000) as i64,
                        config: &cfg,
                        computed_charge: i64::try_from(delta).map_err(|_| "InvalidInput")?,
                    },
                )?;
            }
            let after = database_balance_for_update(c, &t.view.database_id)?;
            t.view.collected_execution_fee_cycles = t
                .view
                .collected_execution_fee_cycles
                .checked_add((before - after) as u64)
                .ok_or("Capacity")?;
            save(c, &t)?;
            Ok(t.view)
        })
    }
    pub fn get_vault_transfer(&self, p: Principal, op: &[u8], now: u64) -> R<VaultTransfer> {
        self.write_index(|c| {
            let mut t = load(c, op)?;
            allowed(c, &t, p)?;
            if !t.dispatched && !terminal(&t) && t.view.offer.expires_at_ns <= now {
                refund(c, &mut t, now)?;
            }
            Ok(t.view)
        })
    }
    pub fn cancel_vault_transfer(&self, p: Principal, op: &[u8], now: u64) -> R<VaultTransfer> {
        self.write_index(|c| {
            let mut t = load(c, op)?;
            allowed(c, &t, p)?;
            if t.dispatched && !terminal(&t) {
                return Err("Conflict".into());
            }
            if !terminal(&t) {
                refund(c, &mut t, now)?;
            }
            Ok(t.view)
        })
    }
    pub fn bridge_credit_offer(
        &self,
        peer: Principal,
        op: &[u8],
        vault: Principal,
        now: u64,
    ) -> R<CreditOffer> {
        self.vault_bridge_peer(peer)?;
        self.read_index(|c| {
            let t = load(c, op)?;
            enabled(c)?;
            validate_link(c, &t)?;
            if t.view.phase != TransferPhase::Offered || t.view.offer.vault_owner != vault {
                return Err("Conflict".into());
            }
            if t.view.offer.expires_at_ns <= now {
                return Err("Expired".into());
            }
            Ok(t.view.offer)
        })
    }
    pub fn vault_transfer_dispatch_context(&self, p: Principal, op: &[u8]) -> R<Dispatch> {
        self.read_index(|c| {
            let t = load(c, op)?;
            allowed(c, &t, p)?;
            Ok(Dispatch {
                offer: t.view.offer,
                peer: t.peer,
                sequence: t.sequence,
                attempt: t.attempt,
                generation: settings(c)?.generation,
                config_epoch: settings(c)?.epoch,
            })
        })
    }
    /// Called after status await, directly before dispatch. The measured cost includes attached cycles.
    pub fn begin_vault_dispatch(
        &self,
        p: Principal,
        d: &Dispatch,
        receipt: &CreditReceipt,
        liquid: u128,
        cost: u128,
        now: u64,
    ) -> R<Dispatch> {
        self.write_index(|c| {
            let mut t = load(c, &d.offer.operation)?;
            owner(c, &t.view.database_id, p)?;
            let s = enabled(c)?;
            validate_link(c, &t)?;
            if s.epoch != d.config_epoch {
                return Err("Conflict".into());
            }
            if settings(c)?.generation != d.generation
                || t.sequence != d.sequence
                || t.attempt != d.attempt
                || t.view.offer != d.offer
                || receipt.offer != d.offer
                || receipt.status != CreditStatus::Prepared
                || t.view.phase != TransferPhase::Offered
                || !t.held
                || t.dispatched
            {
                return Err("Conflict".into());
            }
            if now >= t.view.offer.expires_at_ns {
                return Err("Expired".into());
            }
            if daily(c, now)? > u128::from(s.config.daily_limit_cycles)
                || all(c)?
                    .iter()
                    .filter(|t| t.dispatched && !terminal(t))
                    .count()
                    >= 8
            {
                return Err("Capacity".into());
            }
            if cost < u128::from(t.view.offer.amount_cycles)
                || liquid
                    < cost
                        .checked_add(u128::from(s.config.physical_reserve_cycles))
                        .ok_or("Capacity")?
            {
                return Err("Capacity".into());
            }
            t.attempt = t.attempt.checked_add(1).ok_or("Capacity")?;
            t.dispatched = true;
            t.view.phase = TransferPhase::Unknown;
            save(c, &t)?;
            Ok(Dispatch {
                offer: t.view.offer,
                peer: t.peer,
                sequence: t.sequence,
                attempt: t.attempt,
                generation: settings(c)?.generation,
                config_epoch: settings(c)?.epoch,
            })
        })
    }
    pub fn settle_vault_receipt(
        &self,
        d: &Dispatch,
        receipt: &CreditReceipt,
        now: u64,
    ) -> R<VaultTransfer> {
        self.write_index(|c| {
            let mut t = load(c, &d.offer.operation)?;
            if settings(c)?.generation != d.generation
                || t.sequence != d.sequence
                || t.attempt != d.attempt
                || t.view.offer != d.offer
                || receipt.offer != d.offer
            {
                return Err("Conflict".into());
            }
            if terminal(&t) {
                return Ok(t.view);
            }
            match receipt.status {
                CreditStatus::Prepared => {}
                CreditStatus::Accepted => {
                    if !t.dispatched || !t.held {
                        return Err("Conflict".into());
                    }
                    t.held = false;
                    t.view.phase = TransferPhase::Paid;
                    t.view.receiver_cleanup_pending = true;
                    t.settled_day = now / DAY;
                    let bal = database_balance_for_update(c, &t.view.database_id)?;
                    ledger(c, &t, "bridge_paid", 0, bal, now)?;
                    save(c, &t)?;
                }
                CreditStatus::NotAccepted => {
                    refund(c, &mut t, now)?;
                }
            }
            Ok(t.view)
        })
    }
    pub fn finish_vault_cleanup(&self, d: &Dispatch, now: u64, not_found: bool) -> R<bool> {
        self.write_index(|c| {
            let mut t = load(c, &d.offer.operation)?;
            if settings(c)?.generation != d.generation
                || t.sequence != d.sequence
                || t.attempt != d.attempt
                || t.view.offer != d.offer
                || !terminal(&t)
            {
                return Err("Conflict".into());
            }
            if not_found {
                // Absence retires cleanup only for an already durable terminal
                // proof. It cannot settle Unknown or create a refund.
                let retirement = if t.view.phase == TransferPhase::Paid {
                    t.view.offer.expires_at_ns.max(
                        t.settled_day
                            .checked_add(1)
                            .and_then(|d| d.checked_mul(DAY))
                            .ok_or("Capacity")?,
                    )
                } else {
                    t.view.offer.expires_at_ns
                };
                if now < retirement {
                    return Ok(false);
                }
            }
            t.view.receiver_cleanup_pending = false;
            save(c, &t)?;
            Ok(true)
        })
    }
}

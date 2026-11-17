use tempfile::tempdir;
use vfs_runtime::VfsService;
#[test]
fn wiki6_migrates_to_private_bridge7_disabled() {
    let root = tempdir().unwrap();
    let svc = VfsService::new(root.path().join("index.sqlite3"), root.path().join("db"));
    svc.run_index_migrations().unwrap();
    let db = rusqlite::Connection::open(root.path().join("index.sqlite3")).unwrap();
    let found:i64=db.query_row("SELECT count(*) FROM schema_migrations WHERE version='database_index:007_credit_bridge'",[],|r|r.get(0)).unwrap();
    assert_eq!(found, 1);
    let configs: i64 = db
        .query_row("SELECT count(*) FROM credit_bridge_settings", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(configs, 0);
}
use candid::Principal;
use credit_bridge_types::*;
use vfs_runtime::credit_bridge::*;
use vfs_types::{DatabaseRole, DeleteDatabaseRequest};
fn p(n: u8) -> Principal {
    Principal::from_slice(&[n])
}
struct Fixture {
    _root: tempfile::TempDir,
    svc: VfsService,
    db: rusqlite::Connection,
}
impl Fixture {
    fn new() -> Self {
        let root = tempdir().unwrap();
        let svc = VfsService::new(root.path().join("index.sqlite3"), root.path().join("db"));
        svc.run_index_migrations().unwrap();
        svc.create_database("one", &p(1).to_text(), 0).unwrap();
        let db = rusqlite::Connection::open(root.path().join("index.sqlite3")).unwrap();
        let f = Self {
            _root: root,
            svc,
            db,
        };
        f.balance(1_000_000_000);
        f.svc
            .configure_vault_bridge(BridgeConfig {
                peer: p(9),
                enabled: true,
                daily_limit_cycles: i64::MAX as u64,
                physical_reserve_cycles: 100,
            })
            .unwrap();
        f.link(1);
        f
    }
    fn balance(&self, n: u64) {
        self.db
            .execute(
                "UPDATE database_cycle_accounts SET balance_cycles=?1 WHERE database_id='one'",
                [n as i64],
            )
            .unwrap();
    }
    fn bal(&self) -> u64 {
        self.db
            .query_row(
                "SELECT balance_cycles FROM database_cycle_accounts WHERE database_id='one'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap() as u64
    }
    fn link(&self, g: u64) {
        let snap = self.svc.vault_link_snapshot(p(1), 1).unwrap();
        let proof = self
            .svc
            .vault_link_begin(
                p(1),
                LinkChallenge {
                    challenge: vec![g as u8; 16],
                    vault_owner: p(2),
                    generation: g,
                    expires_at_ns: 300_000_000_000,
                },
                &snap,
                1,
            )
            .unwrap();
        self.svc.vault_link_finish(&proof, &snap).unwrap();
    }
    fn quote(&self, amount: TransferAmount) -> VaultTransfer {
        self.svc
            .quote_vault_transfer(p(1), "one", amount, vec![4; 16], 1, 20_000_000)
            .unwrap()
    }
    fn hold(&self, n: u64) -> VaultTransfer {
        self.quote(TransferAmount::Exact(n));
        self.svc
            .confirm_vault_transfer(p(1), &[4; 16], TransferApproval::Exact(n), 20_000_000, 2)
            .unwrap()
    }
    fn dispatch(&self) -> Dispatch {
        let d = self
            .svc
            .vault_transfer_dispatch_context(p(1), &[4; 16])
            .unwrap();
        self.svc
            .begin_vault_dispatch(
                p(1),
                &d,
                &CreditReceipt {
                    offer: d.offer.clone(),
                    status: CreditStatus::Prepared,
                },
                u128::MAX,
                u128::from(d.offer.amount_cycles) + 100,
                3,
            )
            .unwrap()
    }
}
#[test]
fn all_available_consent_reserves_current_balance_once() {
    let f = Fixture::new();
    let q = f.quote(TransferAmount::All);
    assert_eq!(f.bal(), q.balance_at_quote);
    assert!(
        f.svc
            .confirm_vault_transfer(
                p(1),
                &[4; 16],
                TransferApproval::Exact(q.offer.amount_cycles),
                20_000_000,
                2
            )
            .is_err()
    );
    let held = f
        .svc
        .confirm_vault_transfer(
            p(1),
            &[4; 16],
            TransferApproval::AllAvailable,
            20_000_000,
            2,
        )
        .unwrap();
    assert_eq!(held.phase, TransferPhase::Offered);
    assert_eq!(held.offer.amount_cycles, 980_000_000);
    assert_eq!(f.bal(), 0);
    assert_eq!(held.collected_execution_fee_cycles, 20_000_000);
    let fixed = f
        .svc
        .confirm_vault_transfer(p(1), &[4; 16], TransferApproval::AllAvailable, u128::MAX, 3)
        .unwrap();
    assert_eq!(fixed.offer, held.offer);
    let d = f.dispatch();
    assert_eq!(f.bal(), 0);
    let paid = f
        .svc
        .settle_vault_receipt(
            &d,
            &CreditReceipt {
                offer: d.offer.clone(),
                status: CreditStatus::Accepted,
            },
            4,
        )
        .unwrap();
    assert_eq!(paid.phase, TransferPhase::Paid);
    assert_eq!(f.bal(), 0);
}
#[test]
fn revoked_prepared_intent_never_dispatches_but_keeps_cleanup() {
    let f = Fixture::new();
    let held = f.hold(50);
    let d = f
        .svc
        .vault_transfer_dispatch_context(p(1), &[4; 16])
        .unwrap();
    f.svc
        .revoke_link_from_vault(
            p(9),
            BridgeRevocation {
                vault_owner: p(2),
                through_generation: 1,
            },
        )
        .unwrap();
    assert!(
        f.svc
            .begin_vault_dispatch(
                p(1),
                &d,
                &CreditReceipt {
                    offer: held.offer,
                    status: CreditStatus::Prepared
                },
                u128::MAX,
                150,
                3
            )
            .is_err()
    );
    let canceled = f.svc.cancel_vault_transfer(p(1), &[4; 16], 4).unwrap();
    assert!(canceled.receiver_cleanup_pending);
    assert_eq!(f.bal(), 980_000_000);
    assert!(!f.svc.finish_vault_cleanup(&d, 4, true).unwrap());
    assert!(
        f.svc
            .get_vault_transfer(p(1), &[4; 16], 4)
            .unwrap()
            .receiver_cleanup_pending
    );
    f.svc
        .finish_vault_cleanup(&d, 400_000_000_000, true)
        .unwrap();
}
#[test]
fn unknown_never_refunds_on_expiry_and_authoritative_refund_is_once() {
    let f = Fixture::new();
    f.hold(500);
    let d = f.dispatch();
    assert!(f.svc.cancel_vault_transfer(p(1), &[4; 16], 4).is_err());
    assert_eq!(
        f.svc
            .get_vault_transfer(p(1), &[4; 16], 400_000_000_000)
            .unwrap()
            .phase,
        TransferPhase::Unknown
    );
    let before = f.bal();
    let receipt = CreditReceipt {
        offer: d.offer.clone(),
        status: CreditStatus::NotAccepted,
    };
    f.svc
        .settle_vault_receipt(&d, &receipt, 400_000_000_001)
        .unwrap();
    f.svc
        .settle_vault_receipt(&d, &receipt, 400_000_000_002)
        .unwrap();
    assert_eq!(f.bal(), before + 500);
}
#[test]
fn changed_owner_cannot_redirect_and_old_owner_can_reconcile() {
    let f = Fixture::new();
    f.hold(500);
    let d = f
        .svc
        .vault_transfer_dispatch_context(p(1), &[4; 16])
        .unwrap();
    f.svc
        .grant_database_access(
            "one",
            &p(1).to_text(),
            &p(3).to_text(),
            DatabaseRole::Owner,
            1,
        )
        .unwrap();
    f.svc
        .grant_database_access(
            "one",
            &p(3).to_text(),
            &p(1).to_text(),
            DatabaseRole::Reader,
            1,
        )
        .unwrap();
    let receipt = CreditReceipt {
        offer: d.offer.clone(),
        status: CreditStatus::Prepared,
    };
    assert!(
        f.svc
            .begin_vault_dispatch(p(1), &d, &receipt, u128::MAX, 600, 3)
            .is_err()
    );
    let sent = f
        .svc
        .begin_vault_dispatch(p(3), &d, &receipt, u128::MAX, 600, 3)
        .unwrap();
    assert_eq!(sent.offer.vault_owner, p(2));
    assert_eq!(
        f.svc.get_vault_transfer(p(1), &[4; 16], 4).unwrap().phase,
        TransferPhase::Unknown
    );
}
#[test]
fn late_link_ack_after_revoke_rejected_and_new_pair_only() {
    let f = Fixture::new();
    let snap = f.svc.vault_link_snapshot(p(1), 1).unwrap();
    let ch = LinkChallenge {
        challenge: vec![2; 16],
        vault_owner: p(2),
        generation: 2,
        expires_at_ns: 300_000_000_000,
    };
    let proof = f.svc.vault_link_begin(p(1), ch, &snap, 1).unwrap();
    f.svc.revoke_vault_link(p(1)).unwrap();
    assert!(f.svc.vault_link_finish(&proof, &snap).is_err());
    f.link(3);
    f.svc
        .revoke_link_from_vault(
            p(9),
            BridgeRevocation {
                vault_owner: p(2),
                through_generation: 2,
            },
        )
        .unwrap();
    assert!(f.svc.get_vault_link(p(1)).unwrap().unwrap().active);
    let snap = f.svc.vault_link_snapshot(p(3), 1).unwrap();
    assert!(
        f.svc
            .vault_link_begin(
                p(3),
                LinkChallenge {
                    challenge: vec![4; 16],
                    vault_owner: p(2),
                    generation: 4,
                    expires_at_ns: 300_000_000_000
                },
                &snap,
                1
            )
            .is_err()
    );
}
#[test]
fn final_liquid_and_daily_reserve_checked() {
    let f = Fixture::new();
    f.hold(500);
    let d = f
        .svc
        .vault_transfer_dispatch_context(p(1), &[4; 16])
        .unwrap();
    let receipt = CreditReceipt {
        offer: d.offer.clone(),
        status: CreditStatus::Prepared,
    };
    assert!(
        f.svc
            .begin_vault_dispatch(p(1), &d, &receipt, 699, 600, 3)
            .is_err()
    );
    assert!(
        f.svc
            .begin_vault_dispatch(p(1), &d, &receipt, 10_000, 499, 3)
            .is_err()
    );
    assert!(
        f.svc
            .begin_vault_dispatch(p(1), &d, &receipt, 700, 600, 3)
            .is_ok()
    );
}
#[test]
fn pending_hold_blocks_database_and_account_deletion() {
    let f = Fixture::new();
    f.hold(500);
    assert!(
        f.svc
            .delete_database(
                DeleteDatabaseRequest {
                    database_id: "one".into()
                },
                &p(1).to_text(),
                4
            )
            .is_err()
    );
    assert!(f.svc.delete_account(&p(1).to_text(), 4).is_err());
}
#[test]
fn private_link_tables_denied_even_to_index_sql() {
    let f = Fixture::new();
    for name in [
        "credit_bridge_links",
        "credit_bridge_fences",
        "credit_bridge_owners",
        "credit_bridge_settings",
        "credit_bridge_transfers",
    ] {
        assert!(
            f.svc
                .query_index_sql_json(
                    &format!("SELECT json_object('private',1) FROM \"{name}\" LIMIT 1"),
                    1
                )
                .is_err(),
            "{name}"
        );
    }
}
#[test]
fn incoming_purchase_must_preserve_refund_headroom() {
    let f = Fixture::new();
    f.balance(i64::MAX as u64);
    f.quote(TransferAmount::Exact(2345));
    f.svc
        .confirm_vault_transfer(p(1), &[4; 16], TransferApproval::Exact(2345), 0, 2)
        .unwrap();
    assert!(f.svc.validate_database_cycles_purchase("one", 1).is_err());
}
#[test]
fn config_aba_during_prepared_status_blocks_dispatch() {
    let f = Fixture::new();
    f.hold(500);
    let d = f
        .svc
        .vault_transfer_dispatch_context(p(1), &[4; 16])
        .unwrap();
    let mut cfg = f.svc.vault_bridge_config().unwrap().unwrap();
    cfg.enabled = false;
    f.svc.configure_vault_bridge(cfg.clone()).unwrap();
    cfg.enabled = true;
    f.svc.configure_vault_bridge(cfg).unwrap();
    assert!(
        f.svc
            .begin_vault_dispatch(
                p(1),
                &d,
                &CreditReceipt {
                    offer: d.offer.clone(),
                    status: CreditStatus::Prepared
                },
                u128::MAX,
                600,
                3
            )
            .is_err()
    );
}
#[test]
fn upgrade_fences_late_callback_but_user_reconciles_exact_receipt() {
    let f = Fixture::new();
    f.hold(500);
    let d = f.dispatch();
    f.svc.fence_vault_bridge_upgrade().unwrap();
    let receipt = CreditReceipt {
        offer: d.offer.clone(),
        status: CreditStatus::Accepted,
    };
    assert!(f.svc.settle_vault_receipt(&d, &receipt, 4).is_err());
    let current = f
        .svc
        .vault_transfer_dispatch_context(p(1), &[4; 16])
        .unwrap();
    assert_eq!(
        f.svc
            .settle_vault_receipt(&current, &receipt, 5)
            .unwrap()
            .phase,
        TransferPhase::Paid
    );
}
#[test]
fn execution_requires_current_owner_even_with_writer_credit() {
    let f = Fixture::new();
    f.svc
        .grant_database_access(
            "one",
            &p(1).to_text(),
            &p(3).to_text(),
            DatabaseRole::Writer,
            1,
        )
        .unwrap();
    assert!(
        f.svc
            .quote_vault_transfer(
                p(3),
                "one",
                TransferAmount::Exact(1),
                vec![8; 16],
                1,
                20_000_000
            )
            .is_err()
    );
    f.hold(500);
    assert!(
        f.svc
            .confirm_vault_transfer(p(3), &[4; 16], TransferApproval::Exact(500), 0, 3)
            .is_err()
    );
}
#[test]
fn quote_and_wrong_approval_do_not_debit() {
    let f = Fixture::new();
    let initial = f.bal();
    f.quote(TransferAmount::Exact(50));
    assert_eq!(f.bal(), initial);
    assert!(
        f.svc
            .confirm_vault_transfer(
                p(1),
                &[4; 16],
                TransferApproval::AllAvailable,
                20_000_000,
                2
            )
            .is_err()
    );
    assert!(
        f.svc
            .confirm_vault_transfer(p(1), &[4; 16], TransferApproval::Exact(51), 20_000_000, 2)
            .is_err()
    );
    assert_eq!(f.bal(), initial);
}
#[test]
fn new_grant_during_all_quote_is_included_only_at_confirmation() {
    let f = Fixture::new();
    let q = f.quote(TransferAmount::All);
    f.balance(q.balance_at_quote + 123);
    let h = f
        .svc
        .confirm_vault_transfer(
            p(1),
            &[4; 16],
            TransferApproval::AllAvailable,
            20_000_000,
            2,
        )
        .unwrap();
    assert_eq!(
        h.offer.amount_cycles,
        q.offer.amount_cycles + 123 - 20_000_000
    );
    f.balance(999);
    let again = f
        .svc
        .confirm_vault_transfer(p(1), &[4; 16], TransferApproval::AllAvailable, 0, 3)
        .unwrap();
    assert_eq!(h.offer, again.offer);
    assert_eq!(f.bal(), 999);
}
#[test]
fn one_pending_per_database_and_account_and_full_tuple_identity() {
    let f = Fixture::new();
    f.hold(500);
    assert!(
        f.svc
            .quote_vault_transfer(p(1), "one", TransferAmount::Exact(50), vec![5; 16], 3, 0)
            .is_err()
    );
    let d = f.dispatch();
    let mut wrong = d.offer.clone();
    wrong.amount_cycles += 1;
    assert!(
        f.svc
            .settle_vault_receipt(
                &d,
                &CreditReceipt {
                    offer: wrong,
                    status: CreditStatus::NotAccepted
                },
                4
            )
            .is_err()
    );
    assert_eq!(
        f.svc.get_vault_transfer(p(1), &[4; 16], 4).unwrap().phase,
        TransferPhase::Unknown
    );
}
#[test]
fn disabled_config_allows_settlement_but_not_new_dispatch_or_peer_change() {
    let f = Fixture::new();
    f.hold(500);
    let d = f.dispatch();
    let mut cfg = f.svc.vault_bridge_config().unwrap().unwrap();
    cfg.enabled = false;
    f.svc.configure_vault_bridge(cfg.clone()).unwrap();
    cfg.peer = p(8);
    assert!(f.svc.configure_vault_bridge(cfg).is_err());
    let paid = f
        .svc
        .settle_vault_receipt(
            &d,
            &CreditReceipt {
                offer: d.offer.clone(),
                status: CreditStatus::Accepted,
            },
            4,
        )
        .unwrap();
    assert_eq!(paid.phase, TransferPhase::Paid);
}
#[test]
fn migration6_preserves_balance_members_and_grants() {
    let f = Fixture::new();
    let before = f.bal();
    f.db.execute_batch("DROP TABLE credit_bridge_links; DROP TABLE credit_bridge_fences; DROP TABLE credit_bridge_owners; DROP TABLE credit_bridge_settings; DROP TABLE credit_bridge_transfers; DELETE FROM schema_migrations WHERE version='database_index:007_credit_bridge';").unwrap();
    f.svc.run_index_migrations_for_upgrade(None).unwrap();
    assert_eq!(f.bal(), before);
    assert!(f.svc.vault_bridge_config().unwrap().is_none());
    f.svc.run_index_migrations_for_upgrade(None).unwrap();
    assert_eq!(f.bal(), before);
}
#[test]
fn incoming_iap_must_preserve_refund_and_purchase_reservations() {
    let f = Fixture::new();
    f.balance(i64::MAX as u64);
    f.quote(TransferAmount::Exact(2345));
    f.svc
        .confirm_vault_transfer(p(1), &[4; 16], TransferApproval::Exact(2345), 0, 2)
        .unwrap();
    f.db.execute("INSERT INTO cycles_billing_config(key,value) VALUES('iap_authority_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[p(8).to_text()]).unwrap();
    let grant = vfs_types::DatabaseCyclesIapGrantRequest {
        database_id: "one".into(),
        amount_cycles: 2345,
        provider: "apple_iap".into(),
        external_payment_id: "credit-bridge-max".into(),
        product_id: "cycles".into(),
        purchaser_principal: p(1).to_text(),
    };
    assert!(
        f.svc
            .grant_database_cycles_from_iap(grant, &p(8).to_text(), 3)
            .is_err()
    );
    let d = f
        .svc
        .vault_transfer_dispatch_context(p(1), &[4; 16])
        .unwrap();
    f.svc.cancel_vault_transfer(p(1), &[4; 16], 4).unwrap();
    assert_eq!(f.bal(), i64::MAX as u64);
    f.svc
        .finish_vault_cleanup(&d, 400_000_000_000, true)
        .unwrap();
}
#[test]
fn sqlite_single_quoted_table_name_cannot_expose_link_principals() {
    let f = Fixture::new();
    assert!(
        f.svc
            .query_index_sql_json(
                "SELECT json_object('pair',record) FROM 'credit_bridge_links' LIMIT 1",
                1
            )
            .is_err()
    );
}
#[test]
fn pending_discovery_is_private_and_survives_owner_change() {
    let f = Fixture::new();
    f.hold(500);
    assert_eq!(
        f.svc
            .pending_vault_transfer(p(1), None, 3)
            .unwrap()
            .unwrap()
            .offer
            .operation,
        vec![4; 16]
    );
    assert!(
        f.svc
            .pending_vault_transfer(p(3), None, 3)
            .unwrap()
            .is_none()
    );
    assert!(f.svc.pending_vault_transfer(p(3), Some("one"), 3).is_err());
    f.svc
        .grant_database_access(
            "one",
            &p(1).to_text(),
            &p(3).to_text(),
            DatabaseRole::Owner,
            3,
        )
        .unwrap();
    f.svc
        .grant_database_access(
            "one",
            &p(3).to_text(),
            &p(1).to_text(),
            DatabaseRole::Reader,
            3,
        )
        .unwrap();
    assert!(
        f.svc
            .pending_vault_transfer(p(3), Some("one"), 4)
            .unwrap()
            .is_some()
    );
    assert!(
        f.svc
            .pending_vault_transfer(p(1), None, 4)
            .unwrap()
            .is_some()
    );
}
#[test]
fn execution_charge_after_hold_caps_at_remaining_balance() {
    let f = Fixture::new();
    f.quote(TransferAmount::All);
    let h = f
        .svc
        .confirm_vault_transfer(
            p(1),
            &[4; 16],
            TransferApproval::AllAvailable,
            20_000_000,
            2,
        )
        .unwrap();
    let charged = f
        .svc
        .collect_vault_execution_fee(p(1), &[4; 16], 999_999, 2)
        .unwrap();
    assert_eq!(h.offer, charged.offer);
    assert_eq!(charged.collected_execution_fee_cycles, 20_000_000);
    assert_eq!(f.bal(), 0);
}
impl Fixture {
    fn another(&self, n: u8, amount: u64, now: u64) -> Dispatch {
        let user = p(n);
        let db = format!("db{n}");
        self.svc.create_database(&db, &user.to_text(), 0).unwrap();
        self.db
            .execute(
                "UPDATE database_cycle_accounts SET balance_cycles=1000000000 WHERE database_id=?1",
                [&db],
            )
            .unwrap();
        let snap = self.svc.vault_link_snapshot(user, now).unwrap();
        let proof = self
            .svc
            .vault_link_begin(
                user,
                LinkChallenge {
                    challenge: vec![n; 16],
                    vault_owner: p(n + 40),
                    generation: u64::from(n) + 1,
                    expires_at_ns: now + 300_000_000_000,
                },
                &snap,
                now,
            )
            .unwrap();
        self.svc.vault_link_finish(&proof, &snap).unwrap();
        self.svc
            .quote_vault_transfer(
                user,
                &db,
                TransferAmount::Exact(amount),
                vec![n; 16],
                now,
                0,
            )
            .unwrap();
        self.svc
            .confirm_vault_transfer(user, &[n; 16], TransferApproval::Exact(amount), 0, now)
            .unwrap();
        self.svc
            .vault_transfer_dispatch_context(user, &[n; 16])
            .unwrap()
    }
}
#[test]
fn eight_unknown_physical_sends_bound_global_dispatch() {
    let f = Fixture::new();
    for n in 10..19 {
        let d = f.another(n, 500, 1);
        let result = f.svc.begin_vault_dispatch(
            p(n),
            &d,
            &CreditReceipt {
                offer: d.offer.clone(),
                status: CreditStatus::Prepared,
            },
            u128::MAX,
            600,
            2,
        );
        assert_eq!(result.is_ok(), n < 18);
    }
}
#[test]
fn prior_day_unknown_and_unsent_holds_remain_in_daily_cap() {
    let f = Fixture::new();
    let mut cfg = f.svc.vault_bridge_config().unwrap().unwrap();
    cfg.daily_limit_cycles = 500;
    f.svc.configure_vault_bridge(cfg).unwrap();
    let day = 86_400_000_000_000;
    let d = f.another(10, 400, day - 1);
    f.svc
        .begin_vault_dispatch(
            p(10),
            &d,
            &CreditReceipt {
                offer: d.offer.clone(),
                status: CreditStatus::Prepared,
            },
            u128::MAX,
            500,
            day - 1,
        )
        .unwrap();
    f.another(11, 100, day + 1);
    let q = f
        .svc
        .quote_vault_transfer(
            p(1),
            "one",
            TransferAmount::Exact(1),
            vec![4; 16],
            day + 1,
            0,
        )
        .unwrap();
    assert!(
        f.svc
            .confirm_vault_transfer(
                p(1),
                &q.offer.operation,
                TransferApproval::Exact(1),
                0,
                day + 1
            )
            .is_err()
    );
}
#[test]
fn free_kinic_and_iap_credit_are_all_transferable() {
    let f = Fixture::new();
    let outcome = f
        .svc
        .create_generated_database_with_initial_free_grant_or_pending("free", &p(1).to_text(), 1)
        .unwrap();
    assert!(outcome.initial_free_grant_applied);
    let db = outcome.meta.database_id;
    let purchase = f
        .svc
        .begin_database_cycles_purchase(&db, &p(1).to_text(), 1, 2)
        .unwrap();
    let cycles = 2345;
    f.svc
        .complete_database_cycles_purchase_ledger_transfer(
            purchase,
            &db,
            &p(1).to_text(),
            cycles,
            42,
        )
        .unwrap();
    f.svc
        .apply_database_cycles_purchase(purchase, &db, &p(1).to_text(), cycles, 42, 2)
        .unwrap();
    f.db.execute("INSERT INTO cycles_billing_config(key,value) VALUES('iap_authority_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[p(8).to_text()]).unwrap();
    f.svc
        .grant_database_cycles_from_iap(
            vfs_types::DatabaseCyclesIapGrantRequest {
                database_id: db.clone(),
                amount_cycles: 100,
                provider: "apple_iap".into(),
                external_payment_id: "credit-bridge-positive".into(),
                product_id: "cycles".into(),
                purchaser_principal: p(1).to_text(),
            },
            &p(8).to_text(),
            3,
        )
        .unwrap();
    let q = f
        .svc
        .quote_vault_transfer(p(1), &db, TransferAmount::All, vec![4; 16], 3_000_000, 0)
        .unwrap();
    assert_eq!(q.offer.amount_cycles, 10_000_000_000 + 2345 + 100);
    let held = f
        .svc
        .confirm_vault_transfer(p(1), &[4; 16], TransferApproval::AllAvailable, 0, 3_000_000)
        .unwrap();
    assert_eq!(held.offer.amount_cycles, q.offer.amount_cycles);
}
#[test]
fn delayed_older_link_preview_cannot_replace_newer_link() {
    let f = Fixture::new();
    let snap = f.svc.vault_link_snapshot(p(1), 1).unwrap();
    f.link(3);
    assert!(
        f.svc
            .vault_link_begin(
                p(1),
                LinkChallenge {
                    challenge: vec![2; 16],
                    vault_owner: p(2),
                    generation: 2,
                    expires_at_ns: 300_000_000_000
                },
                &snap,
                2
            )
            .is_err()
    );
    assert_eq!(f.svc.get_vault_link(p(1)).unwrap().unwrap().generation, 3);
}
#[test]
fn full_fence_quota_still_allows_existing_owner_and_peer_revocation() {
    let f = Fixture::new();
    for table in ["credit_bridge_owners", "credit_bridge_fences"] {
        let count: i64 =
            f.db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
        let (key, value) = if table.ends_with("owners") {
            ("wiki_owner", "epoch")
        } else {
            ("vault_owner", "generation")
        };
        for n in 0..(1024 - count) {
            let user = Principal::from_slice(&(n as u32 + 1000).to_be_bytes()).to_text();
            f.db.execute(
                &format!("INSERT INTO {table}({key},{value}) VALUES(?1,0)"),
                [user],
            )
            .unwrap();
        }
    }
    f.svc.revoke_vault_link(p(1)).unwrap();
    f.svc
        .revoke_link_from_vault(
            p(9),
            BridgeRevocation {
                vault_owner: p(2),
                through_generation: 1,
            },
        )
        .unwrap();
    assert!(!f.svc.get_vault_link(p(1)).unwrap().unwrap().active);
}

#[test]
fn terminal_ack_loss_then_receiver_gc_releases_cleanup_without_money_change() {
    for status in [CreditStatus::Accepted, CreditStatus::NotAccepted] {
        let f = Fixture::new();
        f.hold(500);
        let d = f.dispatch();
        let terminal = f
            .svc
            .settle_vault_receipt(
                &d,
                &CreditReceipt {
                    offer: d.offer.clone(),
                    status,
                },
                4,
            )
            .unwrap();
        let balance = f.bal();
        let ledger: i64 =
            f.db.query_row("SELECT count(*) FROM database_cycle_ledger", [], |r| {
                r.get(0)
            })
            .unwrap();
        // Receiver committed ACK, its response was lost, and its retention expired.
        f.svc
            .finish_vault_cleanup(&d, 86_400_000_000_001, true)
            .unwrap();
        let after = f
            .svc
            .get_vault_transfer(p(1), &[4; 16], 86_400_000_000_001)
            .unwrap();
        assert_eq!(after.phase, terminal.phase);
        assert!(!after.receiver_cleanup_pending);
        assert_eq!(f.bal(), balance);
        assert_eq!(
            f.db.query_row("SELECT count(*) FROM database_cycle_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            ledger
        );
        assert!(
            f.svc
                .pending_vault_transfer(p(1), None, 86_400_000_000_001)
                .unwrap()
                .is_none()
        );
        f.svc
            .quote_vault_transfer(
                p(1),
                "one",
                TransferAmount::Exact(1),
                vec![5; 16],
                86_400_000_000_002,
                0,
            )
            .unwrap();
        f.svc
            .cancel_vault_transfer(p(1), &[5; 16], 86_400_000_000_003)
            .unwrap();
        f.svc.delete_account(&p(1).to_text(), 86_400_001).unwrap();
    }
}

#[test]
fn abandoned_preview_leases_expire_and_old_callbacks_cannot_reuse_a_principal() {
    let f = Fixture::new();
    let principal = Principal::from_slice(&1000u32.to_be_bytes());
    let old = f.svc.vault_link_snapshot(principal, 1).unwrap();
    for n in 1001..2023u32 {
        f.svc
            .vault_link_snapshot(Principal::from_slice(&n.to_be_bytes()), 1)
            .unwrap();
    }
    assert!(f.svc.vault_link_snapshot(p(20), 2).is_err());
    let now = 300_000_000_002;
    let fresh = f.svc.vault_link_snapshot(principal, now).unwrap();
    assert_ne!(fresh.owner_epoch, old.owner_epoch);
    assert!(
        f.svc
            .validate_vault_link_snapshot(principal, &old, now)
            .is_err()
    );
    f.svc.release_vault_link_snapshot(principal, &old).unwrap();
    f.svc
        .validate_vault_link_snapshot(principal, &fresh, now)
        .unwrap();
    let ch = LinkChallenge {
        challenge: vec![20; 16],
        vault_owner: p(21),
        generation: 20,
        expires_at_ns: now + 300_000_000_000,
    };
    assert!(
        f.svc
            .vault_link_begin(principal, ch.clone(), &old, now)
            .is_err()
    );
    let proof = f.svc.vault_link_begin(principal, ch, &fresh, now).unwrap();
    f.svc
        .release_vault_link_snapshot(principal, &fresh)
        .unwrap();
    assert!(f.svc.vault_link_finish(&proof, &fresh).unwrap().active);
}
#[test]
fn concurrent_owner_leases_release_only_their_own_token_and_do_not_cancel_other_users() {
    let f = Fixture::new();
    let a = f.svc.vault_link_snapshot(p(20), 1).unwrap();
    let unrelated = f.svc.vault_link_snapshot(p(30), 1).unwrap();
    let b = f.svc.vault_link_snapshot(p(20), 2).unwrap();
    assert_ne!(a.owner_epoch, b.owner_epoch);
    f.svc.release_vault_link_snapshot(p(20), &a).unwrap();
    assert!(f.svc.validate_vault_link_snapshot(p(20), &a, 3).is_err());
    f.svc.validate_vault_link_snapshot(p(20), &b, 3).unwrap();
    f.svc.revoke_vault_link(p(20)).unwrap();
    assert!(f.svc.validate_vault_link_snapshot(p(20), &b, 3).is_err());
    f.svc
        .validate_vault_link_snapshot(p(30), &unrelated, 3)
        .unwrap();
    let c = f.svc.vault_link_snapshot(p(20), 4).unwrap();
    f.svc.release_vault_link_snapshot(p(20), &b).unwrap();
    f.svc.validate_vault_link_snapshot(p(20), &c, 4).unwrap();
}
#[test]
fn upgrade_releases_only_unconfirmed_leases_and_fences_their_callbacks() {
    let f = Fixture::new();
    let old = f.svc.vault_link_snapshot(p(20), 1).unwrap();
    let count = || {
        f.db.query_row("SELECT count(*) FROM credit_bridge_owners", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap()
    };
    assert_eq!(count(), 2);
    f.svc.fence_vault_bridge_upgrade().unwrap();
    assert_eq!(count(), 1);
    let fresh = f.svc.vault_link_snapshot(p(20), 2).unwrap();
    assert!(f.svc.validate_vault_link_snapshot(p(20), &old, 2).is_err());
    f.svc.release_vault_link_snapshot(p(20), &old).unwrap();
    f.svc
        .validate_vault_link_snapshot(p(20), &fresh, 2)
        .unwrap();
    assert!(f.svc.get_vault_link(p(1)).unwrap().unwrap().active);
}
#[test]
fn unknown_absence_and_stale_terminal_cleanup_never_release_a_hold() {
    let f = Fixture::new();
    f.hold(500);
    let d = f.dispatch();
    let balance = f.bal();
    assert!(
        f.svc
            .finish_vault_cleanup(&d, 86_400_000_000_001, true)
            .is_err()
    );
    assert_eq!(f.bal(), balance);
    assert_eq!(
        f.svc
            .get_vault_transfer(p(1), &[4; 16], 86_400_000_000_001)
            .unwrap()
            .phase,
        TransferPhase::Unknown
    );
    f.svc
        .settle_vault_receipt(
            &d,
            &CreditReceipt {
                offer: d.offer.clone(),
                status: CreditStatus::Accepted,
            },
            4,
        )
        .unwrap();
    f.svc.fence_vault_bridge_upgrade().unwrap();
    assert!(
        f.svc
            .finish_vault_cleanup(&d, 86_400_000_000_001, true)
            .is_err()
    );
    let current = f
        .svc
        .vault_transfer_dispatch_context(p(1), &[4; 16])
        .unwrap();
    f.svc
        .finish_vault_cleanup(&current, 86_400_000_000_001, true)
        .unwrap();
    assert_eq!(f.bal(), balance);
}
#[test]
fn prerelease_index7_without_lease_column_is_rejected_without_reinitializing_data() {
    let f = Fixture::new();
    let balance = f.bal();
    f.db.execute_batch("ALTER TABLE credit_bridge_owners DROP COLUMN expires_at_ns")
        .unwrap();
    assert!(f.svc.run_index_migrations_for_upgrade(None).is_err());
    assert_eq!(f.bal(), balance);
}

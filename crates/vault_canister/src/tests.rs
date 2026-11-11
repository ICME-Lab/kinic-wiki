use super::*;
use candid::Principal;
use funding::*;
fn p(n: u8) -> Principal {
    Principal::from_slice(&[n])
}
#[test]
fn prepaid_payment_is_caller_bound_idempotent_and_no_read_allocation() {
    state::initialize().unwrap();
    for n in 1..100 {
        assert_eq!(state::State.balance(&p(n).to_text()).unwrap(), 0);
    }
    state::transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();
    let req = PurchaseRequest {
        operation: vec![1; 16],
        beneficiary: p(2),
        amount_e8s: 100_000_000,
        min_credits: 100,
        created_at_time: 1_000_000_000,
    };
    let cfg = FundingConfig {
        ledger: p(3),
        recipient: p(4),
        cycles_per_kinic: 1_000_000_000,
    };
    let quote = record_quote(p(1), req.clone(), cfg.clone(), 10, 1_000_000_000).unwrap();
    assert_eq!(quote.wallet, p(1));
    assert!(begin_payment(p(2), &req.operation, 1_000_000_000).is_err());
    let sent = begin_payment(p(1), &req.operation, 1_000_000_000).unwrap();
    assert_eq!(sent.wallet, p(1));
    assert!(begin_payment(p(1), &req.operation, 1_000_000_000).is_err());
    complete_payment(&sent, Outcome::Unknown).unwrap();
    let retried = begin_payment(p(1), &req.operation, 2_000_000_000).unwrap();
    assert_eq!(sent.memo, retried.memo);
    assert_eq!(sent.created_at_time, retried.created_at_time);
    complete_payment(&retried, Outcome::Paid(7)).unwrap();
    complete_payment(&retried, Outcome::Paid(7)).unwrap();
    assert_eq!(
        state::State.balance(&p(2).to_text()).unwrap(),
        1_000_000_000
    );
    assert_eq!(state::State.balance(&p(1).to_text()).unwrap(), 0);
    assert!(begin_payment(p(1), &req.operation, 2_000_000_000).is_err());
    let mut conflicting = req.clone();
    conflicting.beneficiary = p(5);
    assert!(record_quote(p(1), conflicting, cfg, 10, 1_000_000_000).is_err());
}
#[test]
fn exact_origin_validation() {
    for (origin, rp, valid) in [
        ("https://vault.kinic.xyz", "vault.kinic.xyz", true),
        ("https://wiki.kinic.xyz", "kinic.xyz", false),
        ("https://vault.kinic.xyz", "kinic.xyz", false),
        ("http://vault.localhost:3024", "vault.localhost", true),
    ] {
        assert_eq!(
            accounting::validate_vault_config(&vault_types::VaultConfig {
                origin: origin.into(),
                rp_id: rp.into(),
                key_name: "test_key_1".into(),
                minimum_cycles: 100_000_000_000
            })
            .is_ok(),
            valid
        );
    }
}
fn fund(owner: Principal, amount: u64) {
    let req = PurchaseRequest {
        operation: vec![owner.as_slice()[0]; 16],
        beneficiary: owner,
        amount_e8s: 100_000_000,
        min_credits: 1,
        created_at_time: 0,
    };
    let q = record_quote(
        owner,
        req,
        FundingConfig {
            ledger: p(80),
            recipient: p(81),
            cycles_per_kinic: amount,
        },
        10,
        0,
    )
    .unwrap();
    let sent = begin_payment(owner, &q.request.operation, 0).unwrap();
    complete_payment(&sent, Outcome::Paid(1)).unwrap();
}
#[test]
fn reservations_checkpoint_refund_generation_and_storage_are_exact() {
    state::initialize().unwrap();
    let owner = p(10).to_text();
    fund(p(10), 1_000_000_000);
    let s = state::State;
    s.vault_reserve_cycles(&owner, "challenge:1", 20_000_000, 0)
        .unwrap();
    s.vault_reserve_cycles(&owner, "challenge:1", 20_000_000, 0)
        .unwrap();
    assert_eq!(s.balance(&owner).unwrap(), 980_000_000);
    s.vault_checkpoint_execution(&owner, "challenge:1", 7_000_000)
        .unwrap();
    s.vault_start_generation().unwrap();
    assert_eq!(
        s.vault_recover_orphan_execution(&owner, 1000).unwrap(),
        vec![1]
    );
    assert_eq!(s.balance(&owner).unwrap(), 993_000_000);
    s.vault_recover_orphan_execution(&owner, 1000).unwrap();
    assert_eq!(s.balance(&owner).unwrap(), 993_000_000);
    s.vault_reserve_cycles(&owner, "derive:2", 100_000_000, 1000)
        .unwrap();
    s.vault_cancel_reserved_cycles(&owner, "derive:2", 80_000_000, false, 1100)
        .unwrap();
    s.vault_reconcile_refunded_cycles(&owner, "derive:2", 40_000_000, 1200)
        .unwrap();
    s.vault_reconcile_refunded_cycles(&owner, "derive:2", 40_000_000, 1200)
        .unwrap();
    assert_eq!(s.balance(&owner).unwrap(), 953_000_000);
    s.vault_track_storage(&owner, 1_073_741_824, 2000).unwrap();
    s.vault_settle_storage_timer_batch(3000).unwrap();
    assert_eq!(s.balance(&owner).unwrap(), 952_873_000);
}
#[test]
fn uncertain_payment_never_becomes_safe_to_reissue_after_error_or_upgrade() {
    state::initialize().unwrap();
    let req = PurchaseRequest {
        operation: vec![44; 16],
        beneficiary: p(22),
        amount_e8s: 100_000_000,
        min_credits: 1,
        created_at_time: 1_000_000_000,
    };
    record_quote(
        p(21),
        req.clone(),
        FundingConfig {
            ledger: p(80),
            recipient: p(81),
            cycles_per_kinic: 90_000_000,
        },
        10,
        1_000_000_000,
    )
    .unwrap();
    let first = begin_payment(p(21), &req.operation, 1_000_000_000).unwrap();
    state::State.vault_start_generation().unwrap();
    let retry = begin_payment(p(21), &req.operation, 2_000_000_000).unwrap();
    assert!(retry.uncertain);
    assert!(complete_payment(&first, Outcome::Paid(1)).is_err());
    let unknown = complete_payment(&retry, Outcome::Rejected(Status::BadFee(20))).unwrap();
    assert_eq!(unknown.status, Status::Unknown);
    assert!(begin_payment(p(21), &req.operation, 24 * 3600 * 1_000_000_000).is_err());
    assert_eq!(state::State.balance(&p(22).to_text()).unwrap(), 0);
}
#[test]
fn quota_limits_pin_quotes_and_fee_failures_do_not_credit() {
    state::initialize().unwrap();
    for i in 0..16 {
        let req = PurchaseRequest {
            operation: vec![i; 16],
            beneficiary: p(52),
            amount_e8s: 100_000_000,
            min_credits: 100,
            created_at_time: 0,
        };
        record_quote(
            p(51),
            req,
            FundingConfig {
                ledger: p(80),
                recipient: p(81),
                cycles_per_kinic: 100_000_000,
            },
            10,
            0,
        )
        .unwrap();
    }
    let req = PurchaseRequest {
        operation: vec![17; 16],
        beneficiary: p(52),
        amount_e8s: 100_000_000,
        min_credits: 100,
        created_at_time: 0,
    };
    assert!(
        record_quote(
            p(51),
            req,
            FundingConfig {
                ledger: p(80),
                recipient: p(81),
                cycles_per_kinic: 100_000_000
            },
            10,
            0
        )
        .is_err()
    );
    let sent = begin_payment(p(51), &[0; 16], 0).unwrap();
    assert_eq!(
        complete_payment(&sent, Outcome::Rejected(Status::BadFee(20)))
            .unwrap()
            .status,
        Status::BadFee(20)
    );
    assert_eq!(state::State.balance(&p(52).to_text()).unwrap(), 0);
    assert!(begin_payment(p(51), &[0; 16], 0).is_err());
}
#[test]
fn private_state_owner_isolation_and_usage_commit_atomically() {
    use kinic_sqlite_compat::params;
    use vault_types::{Error, Reserve, VaultConfig};
    state::initialize().unwrap();
    fund(p(61), 100_000_000);
    fund(p(62), 100_000_000);
    state::State
        .vault_set_config(Some(VaultConfig {
            origin: "https://vault.kinic.xyz".into(),
            rp_id: "vault.kinic.xyz".into(),
            key_name: "key_1".into(),
            minimum_cycles: 100_000_000_000,
        }))
        .unwrap();
    let a = vault_store::OwnerContext::authenticated(p(61)).unwrap();
    let b = vault_store::OwnerContext::authenticated(p(62)).unwrap();
    let reserve = || Reserve {
        vault: vec![8; 16],
        operation: vec![9; 16],
    };
    let failure: Result<(), Error> = state::transaction(|db| {
        a.run(db, |db| {
            vault_store::reserve(db, p(61), reserve(), 1)?;
            accounting::track_storage_in(db, &p(61).to_text(), 123, 1000)?;
            Err(Error::Conflict)
        })
    });
    assert!(failure.is_err());
    state::transaction(|db| {
        a.run(db, |db| {
            assert!(vault_store::header(db, &[8; 16]).is_err());
            let bytes: i64 = db
                .query_row(
                    "SELECT storage_bytes FROM accounts WHERE owner=?1",
                    params![p(61).to_text()],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(bytes, 0);
            vault_store::reserve(db, p(61), reserve(), 1)?;
            Ok(())
        })
    })
    .unwrap();
    state::transaction(|db| {
        b.run(db, |db| {
            assert!(vault_store::header(db, &[8; 16]).is_err());
            vault_store::reserve(db, p(62), reserve(), 1)?;
            Ok(())
        })
    })
    .unwrap();
    state::State.vault_start_generation().unwrap();
    for context in [a, b] {
        state::transaction(|db| {
            context.run(db, |db| {
                assert_eq!(vault_store::header(db, &[8; 16])?.id, vec![8; 16]);
                Ok(())
            })
        })
        .unwrap();
    }
}
#[test]
fn certified_asset_policy_rejects_embedding_without_breaking_ii_popup() {
    let h = http::security_headers();
    let header = |name: &str| h.iter().find(|(n, _)| n == name).unwrap().1.as_str();
    assert!(header("Content-Security-Policy").contains("frame-ancestors 'none'"));
    assert_eq!(header("Referrer-Policy"), "no-referrer");
    assert_eq!(
        header("Cross-Origin-Opener-Policy"),
        "same-origin-allow-popups"
    );
    for (_, _, bytes) in http::ASSETS {
        assert!(bytes.len() < 1_900_000, "asset needs streaming");
    }
}
#[test]
fn fee_admission_precedes_io_and_fences_cleanup_expiry_and_upgrade() {
    state::initialize().unwrap();
    let cfg = FundingConfig {
        ledger: p(70),
        recipient: p(71),
        cycles_per_kinic: 100_000_000,
    };
    let req = |n| PurchaseRequest {
        operation: vec![n; 16],
        beneficiary: p(72),
        amount_e8s: 100_000_000,
        min_credits: 20_000_000,
        created_at_time: 0,
    };
    let mut invalid = req(1);
    invalid.amount_e8s = 0;
    assert!(admit_quote(p(73), invalid, cfg.clone(), 0).is_err());
    let first = match admit_quote(p(73), req(1), cfg.clone(), 0).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(admit_quote(p(73), req(2), cfg.clone(), 0).is_err());
    let mut flights = vec![first.clone()];
    for n in 74..81 {
        match admit_quote(p(n), req(n), cfg.clone(), 0).unwrap() {
            QuoteAdmission::Fee(f) => flights.push(f),
            _ => panic!("fee slot expected"),
        }
    }
    assert!(admit_quote(p(81), req(81), cfg.clone(), 0).is_err());
    assert!(finish_quote(&first, Err(vault_types::Error::KeyService), 1).is_err());
    let replacement = match admit_quote(p(73), req(1), cfg.clone(), 2).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(finish_quote(&first, Ok(10), 3).is_err()); // old failed callback cannot clear a replacement
    assert!(admit_quote(p(73), req(3), cfg.clone(), 3).is_err());
    state::State.vault_start_generation().unwrap();
    let fresh = match admit_quote(p(73), req(1), cfg.clone(), 4).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(finish_quote(&replacement, Ok(10), 5).is_err());
    assert_eq!(finish_quote(&fresh, Ok(20), 6).unwrap().fee, 20);
    assert!(matches!(
        admit_quote(p(73), req(1), cfg.clone(), 7).unwrap(),
        QuoteAdmission::Existing(_)
    ));
    let expired = match admit_quote(p(74), req(4), cfg.clone(), 8).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(finish_quote(&expired, Ok(10), 120_000_000_009).is_err());
    assert!(matches!(
        admit_quote(p(74), req(4), cfg, 120_000_000_010).unwrap(),
        QuoteAdmission::Fee(_)
    ));
}
#[test]
fn pending_fee_reserves_global_payment_capacity_before_dispatch() {
    state::initialize().unwrap();
    let cfg = FundingConfig {
        ledger: p(90),
        recipient: p(91),
        cycles_per_kinic: 100_000_000,
    };
    let req = |id| PurchaseRequest {
        operation: vec![id; 16],
        beneficiary: p(92),
        amount_e8s: 100_000_000,
        min_credits: 20_000_000,
        created_at_time: 0,
    };
    for owner in 128..=191 {
        for id in 0..if owner == 191 { 15 } else { 16 } {
            record_quote(p(owner), req(id), cfg.clone(), 10, 0).unwrap();
        }
    }
    let last = match admit_quote(p(192), req(1), cfg.clone(), 0).unwrap() {
        QuoteAdmission::Fee(f) => f,
        _ => panic!("fee slot expected"),
    };
    assert!(matches!(
        admit_quote(p(193), req(1), cfg.clone(), 0),
        Err(vault_types::Error::QuotaExceeded)
    ));
    finish_quote(&last, Ok(10), 1).unwrap();
    assert!(matches!(
        admit_quote(p(193), req(1), cfg, 2),
        Err(vault_types::Error::QuotaExceeded)
    ));
}

#[test]
fn signed_cleanup_accounting_is_atomic_scoped_bounded_and_preserves_sent_cost() {
    use kinic_sqlite_compat::params;
    state::initialize().unwrap();
    let owner = p(95);
    fund(owner, 100_000_000_000);
    let context = vault_store::OwnerContext::authenticated(owner).unwrap();
    state::transaction(|db|context.run(db,|db|{
  vault_store::keys::reserve(db,1,0,20_000_000_000)?;vault_store::keys::mark_sent(db,1,20_000_000_000)?;
  vault_store::save(db,"control",&serde_json::json!({"serial":1,"derive":{"token":1,"vault":vec![1;16]},"random":null}))
 })).unwrap();
    let s = state::State;
    s.vault_reserve_cycles(&owner.to_text(), "derive:1", 30_000_000_000, 0)
        .unwrap();
    s.vault_checkpoint_execution(&owner.to_text(), "derive:1", 2_000_000)
        .unwrap();
    state::transaction(|db| {
        db.execute(
            "UPDATE accounts SET balance_cycles=0 WHERE owner=?1",
            params![owner.to_text()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let run = |targets: &[Vec<u8>], rollback: bool| {
        state::transaction(|db| {
            context.run(db, |db| {
                let result = accounting::recover_pending_in(db, owner, targets, true, 200)?;
                if rollback {
                    return Err(vault_types::Error::Conflict);
                }
                Ok(result)
            })
        })
    };
    assert!(!run(&[vec![2; 16]], false).unwrap());
    assert_eq!(s.balance(&owner.to_text()).unwrap(), 0);
    assert!(run(&[vec![1; 16]], true).is_err());
    assert_eq!(s.balance(&owner.to_text()).unwrap(), 0);
    assert!(!run(&[vec![1; 16]], false).unwrap());
    assert_eq!(s.balance(&owner.to_text()).unwrap(), 9_998_000_000);
    assert!(!run(&[vec![1; 16]], false).unwrap());
    assert_eq!(s.balance(&owner.to_text()).unwrap(), 9_998_000_000);
    s.vault_start_generation().unwrap();
    assert!(run(&[vec![1; 16]], false).unwrap());
    assert_eq!(s.balance(&owner.to_text()).unwrap(), 9_998_000_000);
    // Tiny positive cleanup balances cap execution debit; no affordability gate or trap.
    state::transaction(|db| {
        db.execute(
            "UPDATE accounts SET balance_cycles=1 WHERE owner=?1",
            params![owner.to_text()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    s.vault_charge_execution(&owner.to_text(), 20_000_000, 200_000)
        .unwrap();
    assert_eq!(s.balance(&owner.to_text()).unwrap(), 0);
}

#[test]
fn unresolved_creation_rejects_semantic_configuration_change() {
    use vault_types::*;
    state::initialize().unwrap();
    let config = VaultConfig {
        origin: "http://localhost:5173".into(),
        rp_id: "localhost".into(),
        key_name: "test_key_1".into(),
        minimum_cycles: 100_000_000_000,
    };
    state::State.vault_set_config(Some(config.clone())).unwrap();
    state::transaction(|db| {
        vault_store::OwnerContext::authenticated(p(51))?.run(db, |db| {
            vault_store::reserve(
                db,
                p(51),
                Reserve {
                    vault: vec![1; 16],
                    operation: vec![2; 16],
                },
                1,
            )
            .map(|_| ())
        })
    })
    .unwrap();
    let mut changed = config.clone();
    changed.key_name = "other_key".into();
    assert_eq!(
        state::State.vault_set_config(Some(changed)),
        Err(Error::Conflict)
    );
    assert_eq!(state::State.vault_set_config(None), Err(Error::Conflict));
    let mut operational = config;
    operational.minimum_cycles += 1;
    assert!(state::State.vault_set_config(Some(operational)).is_ok());
}

#[test]
fn transition_reservation_migration_is_idempotent_and_preserves_overcommitted_owners() {
    use kinic_sqlite_compat::{Connection, params};
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        &[
            vault_store::SCHEMA,
            vault_store::CONTENT_SCHEMA,
            vault_store::RESTORE_SCHEMA,
            "PRAGMA user_version=3;",
        ]
        .concat(),
    )
    .unwrap();
    db.execute(
        "INSERT INTO settings VALUES(?1,'cleanup','null')",
        params![p(11).as_slice()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO settings VALUES(?1,'cleanup','null')",
        params![p(12).as_slice()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO revisions VALUES(?1,?2,?3,1,1,NULL,0,?4,'[]',1,?5)",
        params![
            p(11).as_slice(),
            vec![1u8; 16],
            vec![2u8; 16],
            Vec::<u8>::new(),
            vault_types::TOTAL_MAX as i64
        ],
    )
    .unwrap();
    let before = vault_store::content::global_usage(&db).unwrap();
    crate::schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(
        vault_store::content::global_usage(&db).unwrap(),
        before + 2 * 65536
    );
    assert!(
        vault_store::content::global_capacity(&db)
            .unwrap()
            .overcommitted
    );
    crate::schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(
        vault_store::content::global_usage(&db).unwrap(),
        before + 2 * 65536
    );
    let (count, charge): (i64, i64) = db
        .query_row(
            "SELECT count(*),sum(charge) FROM revisions",
            params![],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((count, charge), (1, vault_types::TOTAL_MAX as i64));
}

#[test]
fn global_key_settlement_survives_configuration_removal_without_allocating_authority() {
    use kinic_sqlite_compat::params;
    state::initialize().unwrap();
    state::transaction(|db|{
        db.execute("INSERT INTO key_flights(owner,token,day,reserved,created,payment) VALUES(?1,7,0,30000000000,1,30000000000)",params![p(15).as_slice()]).unwrap();
        Ok(())
    }).unwrap();
    let owner = vault_store::OwnerContext::authenticated(p(15)).unwrap();
    assert!(!api::settle_key_reservation_for_owner(owner, 7, 2, 0).unwrap());
    assert!(!api::settle_key_reservation_for_owner(owner, 7, 2, 0).unwrap());
    assert_eq!(
        api::settle_key_reservation_for_owner(
            vault_store::OwnerContext::authenticated(p(16)).unwrap(),
            7,
            2,
            0
        ),
        Err(vault_types::Error::NotFound)
    );
    state::transaction(|db| {
        let (actual, flight): (i64, i64) = db
            .query_row(
                "SELECT actual,in_flight FROM key_flights WHERE token=7",
                params![],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((actual, flight), (0, 0));
        let settings: i64 = db
            .query_row("SELECT count(*) FROM settings", params![], |r| r.get(0))
            .unwrap();
        assert_eq!(settings, 0);
        Ok(())
    })
    .unwrap();
}

#[test]
fn restore_transition_without_header_blocks_configuration_and_malformed_state_fails_closed() {
    use vault_types::*;
    state::initialize().unwrap();
    let config = VaultConfig {
        origin: "http://localhost:5173".into(),
        rp_id: "localhost".into(),
        key_name: "test_key_1".into(),
        minimum_cycles: 100_000_000_000,
    };
    state::State.vault_set_config(Some(config.clone())).unwrap();
    state::transaction(|db| {
        vault_store::OwnerContext::authenticated(p(52))?.run(db, |db| {
            vault_store::transition::save_state(
                db,
                &TransitionState {
                    namespace_flight: Some(RestoreNamespaceFlight {
                        operation: vec![1; 16],
                        token: 1,
                        expires: 120,
                        fence: vec![2; 32],
                        ready: true,
                    }),
                    ..Default::default()
                },
            )
        })
    })
    .unwrap();
    assert_eq!(state::State.vault_set_config(None), Err(Error::Conflict));
    let mut changed = config;
    changed.key_name = "other_key".into();
    assert_eq!(
        state::State.vault_set_config(Some(changed)),
        Err(Error::Conflict)
    );
    state::transaction(|db| {
        db.execute(
            "UPDATE settings SET value='{\"version\":1}' WHERE key='transition'",
            [],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    assert_eq!(state::State.vault_set_config(None), Err(Error::Storage));
}

#[test]
fn restore_challenge_completion_waits_for_exact_owner_token_and_checkpoint() {
    state::initialize().unwrap();
    let owner = p(91);
    fund(owner, 1_000_000_000);
    let s = state::State;
    s.vault_reserve_cycles(&owner.to_text(), "challenge:1", 20_000_000, 0)
        .unwrap();
    s.vault_reserve_cycles(&owner.to_text(), "challenge:2", 20_000_000, 0)
        .unwrap();
    s.vault_checkpoint_execution(&owner.to_text(), "challenge:1", 7_000_000)
        .unwrap();
    state::transaction(|db| {
        assert!(accounting::challenge_pending_in(db, owner, 1)?);
        assert!(!accounting::challenge_pending_in(db, p(92), 1)?);
        assert!(!accounting::challenge_pending_in(db, owner, 3)?);
        Ok(())
    })
    .unwrap();
    s.vault_settle_cycles(&owner.to_text(), "challenge:1", 0, 1000)
        .unwrap();
    state::transaction(|db| {
        assert!(accounting::challenge_pending_in(db, owner, 1)?);
        Ok(())
    })
    .unwrap();
    s.vault_finish_execution(&owner.to_text(), "challenge:1", 7_000_000, 1000)
        .unwrap();
    state::transaction(|db| {
        assert!(!accounting::challenge_pending_in(db, owner, 1)?);
        assert!(accounting::challenge_pending_in(db, owner, 2)?);
        Ok(())
    })
    .unwrap();
    assert_eq!(s.balance(&owner.to_text()).unwrap(), 973_000_000);
}

#[test]
fn restore_working_migration_preserves_old_pending_and_bills_only_forward() {
    use kinic_sqlite_compat::params;
    state::initialize().unwrap();
    state::transaction(|db| {
        let owner=p(17);
        db.execute("INSERT INTO settings VALUES(?1,'cleanup','null')",params![owner.as_slice()]).unwrap();
        db.execute("INSERT INTO accounts VALUES(?1,1000000000,1048576,1000)",params![owner.to_text()]).unwrap();
        db.execute("INSERT INTO restores VALUES(?1,?2,?3,99999,1,?4,?4,0,0,12345,'legacy-pending',?4,0)",params![owner.as_slice(),vec![1u8;16],vec![2u8;16],vec![3u8;32]]).unwrap();
        let fill=vault_types::TOTAL_MAX-vault_store::content::global_usage(db)?;
        db.execute("INSERT INTO revisions VALUES(?1,?2,?3,1,1,NULL,0,X'','[]',1,?4)",params![p(18).as_slice(),vec![1u8;16],vec![2u8;16],fill as i64]).unwrap();
        db.execute("INSERT INTO vault_cycle_reservations(owner,token,account_owner,reserved,created_at_ms,execution_checkpoint) VALUES(?1,'challenge:77',?1,1234,1000,321)",params![owner.to_text()]).unwrap();
        crate::accounting::migrate_restore_working(db,11_000)?;
        let global=vault_store::content::global_capacity(db)?;
        assert!(global.overcommitted);
        assert_eq!(global.overage,524288);
        let protected:(i64,i64,i64)=db.query_row("SELECT reserved,in_flight,execution_checkpoint FROM vault_cycle_reservations",params![],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(protected,(1234,1,321));
        let row:(i64,i64,i64)=db.query_row("SELECT balance_cycles,storage_bytes,storage_charged_at_ms FROM accounts WHERE owner=?1",params![owner.to_text()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(row.0,999998760); // 1 MiB * 10 s at 127000 cycles/GiB/s.
        assert_eq!(row.2,11_000);
        vault_store::OwnerContext::authenticated(owner)?.run(db,|db| {
            assert_eq!(row.1 as u64,vault_store::content::usage(db)?);
            assert!(vault_store::restore_working::available(db)?);
            let old:(i64,String,Vec<u8>,i64)=db.query_row("SELECT reserved,pending,digest,working_prepaid FROM restores",params![],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
            assert_eq!(old,(12345,"legacy-pending".into(),vec![3u8;32],0));
            Ok(())
        })?;
        crate::accounting::migrate_restore_working(db,21_000)?;
        let balance:i64=db.query_row("SELECT balance_cycles FROM accounts WHERE owner=?1",params![owner.to_text()],|r|r.get(0)).unwrap();
        assert_eq!(balance,row.0); // Already migrated: no duplicate boundary charge.
        Ok(())
    }).unwrap();
}

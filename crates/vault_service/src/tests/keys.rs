use super::*;

#[test]
fn creation_retry_keeps_nonce_and_owner_key_input_isolated() {
    let e = Env::new();
    e.fail_public.set(true);
    assert!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![2; 16]
            }
        ))
        .is_err()
    );
    let h = e.create();
    assert_eq!(e.randoms.get(), 1);
    assert_eq!(h.nonce, vec![1; 32]);
    assert_eq!(e.create(), h);
    assert_eq!(e.randoms.get(), 1);
    let input = key_input(e.canister(), e.owner(), &h).unwrap();
    e.owner.set(Principal::from_slice(&[2]));
    assert!(e.transaction(store::list).unwrap().is_empty());
    let other = e.create();
    assert_ne!(key_input(e.canister(), e.owner(), &other).unwrap(), input);
    e.owner.set(Principal::anonymous());
    assert!(matches!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![2; 16]
            }
        )),
        Err(Error::Unauthorized)
    ));
}
#[test]
fn key_replay_is_transport_bound_and_callback_deletion_discards_key() {
    let e = Env::new();
    e.create();
    let transport = ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
        .unwrap()
        .public_key();
    let r = DeriveKey {
        vault: vec![1; 16],
        operation: vec![8; 16],
        transport: transport.clone(),
    };
    let first = block_on(derive_vault_key(&e, r.clone())).unwrap();
    assert_eq!(e.paid.get(), 12);
    assert_eq!(block_on(derive_vault_key(&e, r.clone())).unwrap(), first);
    assert_eq!(e.derives.get(), 1);
    let mut different = r.clone();
    different.transport = ic_vetkeys::TransportSecretKey::from_seed(vec![9; 32])
        .unwrap()
        .public_key();
    assert_eq!(
        block_on(derive_vault_key(&e, different)),
        Err(Error::Conflict)
    );
    e.hook.replace(Some(Box::new(|e| {
        e.change(40, Action::DeleteVault { vault: vec![1; 16] })
            .unwrap();
    })));
    let mut next = r;
    next.operation = vec![9; 16];
    assert_eq!(block_on(derive_vault_key(&e, next)), Err(Error::Expired));
    assert_eq!(e.paid.get(), 12);
    let pending = e
        .transaction(|db| {
            db.query_row(
                "SELECT count(*) FROM key_flights WHERE in_flight=1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|_| Error::Storage)
        })
        .unwrap();
    assert_eq!(pending, 0);
}
#[test]
fn deleting_other_vault_does_not_cancel_this_key_flight() {
    let e = Env::new();
    e.create();
    block_on(create_vault(
        &e,
        CreateVault {
            vault: vec![2; 16],
            operation: vec![12; 16],
        },
    ))
    .unwrap();
    e.hook.replace(Some(Box::new(|e| {
        e.change(40, Action::DeleteVault { vault: vec![2; 16] })
            .unwrap();
    })));
    let transport = ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
        .unwrap()
        .public_key();
    assert!(
        block_on(derive_vault_key(
            &e,
            DeriveKey {
                vault: vec![1; 16],
                operation: vec![8; 16],
                transport
            }
        ))
        .is_ok()
    );
}
#[test]
fn expired_creation_random_and_public_callbacks_cannot_replace_resumed_attempt() {
    for at_public in [false, true] {
        let e = Env::new();
        let hook: Hook = Box::new(|e| {
            e.now.set(e.now() + 301);
            create_vault(
                e,
                CreateVault {
                    vault: vec![1; 16],
                    operation: vec![2; 16],
                },
            )
            .now_or_never()
            .unwrap()
            .unwrap();
        });
        if at_public {
            e.public_hook.replace(Some(hook));
        } else {
            e.random_hook.replace(Some(hook));
        }
        let r = CreateVault {
            vault: vec![1; 16],
            operation: vec![2; 16],
        };
        assert_eq!(block_on(create_vault(&e, r.clone())), Err(Error::Expired));
        let final_header = block_on(create_vault(&e, r)).unwrap();
        assert_eq!(final_header.nonce, vec![if at_public { 1 } else { 2 }; 32]);
        assert_eq!(final_header.state, VaultState::Active);
        assert_eq!(e.transaction(store::list).unwrap().len(), 1);
    }
}
#[test]
fn disabling_configuration_during_callbacks_retains_accounting_but_withholds_keys() {
    let e = Env::new();
    e.public_hook.replace(Some(Box::new(|e| {
        e.db.borrow()
            .execute("DELETE FROM global_settings WHERE key='config'", [])
            .unwrap();
    })));
    assert_eq!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![2; 16]
            }
        )),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        e.transaction(|db| store::header(db, &[1; 16]))
            .unwrap()
            .state,
        VaultState::Pending
    );
    let e = Env::new();
    e.create();
    e.hook.replace(Some(Box::new(|e| {
        e.db.borrow()
            .execute("DELETE FROM global_settings WHERE key='config'", [])
            .unwrap();
    })));
    let transport = ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
        .unwrap()
        .public_key();
    assert_eq!(
        block_on(derive_vault_key(
            &e,
            DeriveKey {
                vault: vec![1; 16],
                operation: vec![8; 16],
                transport
            }
        )),
        Err(Error::Unauthorized)
    );
    assert_eq!(e.paid.get(), 12);
    assert_eq!(e.transaction(store::keys::current).unwrap(), None);
}
#[test]
fn changing_default_key_does_not_change_existing_vault_context() {
    let e = Env::new();
    let h = e.create();
    e.hook.replace(Some(Box::new(|e|{e.db.borrow().execute("UPDATE global_settings SET value=json_set(value,'$.key_name','next-key') WHERE key='config'",[]).unwrap();})));
    let transport = ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
        .unwrap()
        .public_key();
    let reply = block_on(derive_vault_key(
        &e,
        DeriveKey {
            vault: vec![1; 16],
            operation: vec![8; 16],
            transport,
        },
    ))
    .unwrap();
    assert_eq!(reply.input, key_input(e.canister(), e.owner(), &h).unwrap());
    assert_eq!(e.transaction(|db| store::header(db, &h.id)).unwrap(), h);
}
#[test]
fn fresh_key_admission_at_full_shared_content_and_ordinary_receipts() {
    let e = Env::new();
    e.create();
    e.owner.set(Principal::from_slice(&[2]));
    e.create();
    e.owner.set(Principal::from_slice(&[1]));
    e.transaction(|db| {
        // Fill both the owner's and global ordinary row limit; the other owner's
        // live revision below consumes the shared content headroom independently.
        db.execute("DELETE FROM operations WHERE owner=X'02'", []).unwrap();
        db.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999) INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,admission) SELECT (SELECT owner FROM owner_scope WHERE slot=1),CAST(printf('%016d',x) AS BLOB),zeroblob(32),X'00',999999,x+100,0,0 FROM n", []).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND admission=0",[],|r|r.get::<_,i64>(0)).unwrap(),10000);
        assert_eq!(store::content::check_receipt_capacity(db, e.now()), Err(Error::QuotaExceeded));
        let extra = TOTAL_MAX - store::content::global_usage(db)?;
        db.execute("INSERT INTO revisions VALUES(X'02',?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vec![1u8;16],vec![3u8;16],vec![0u8;64],extra as i64]).unwrap();
        assert_eq!(store::content::global_usage(db)?, TOTAL_MAX);
        assert!(store::keys::current(db)?.is_none());
        Ok(())
    }).unwrap();
    let request = DeriveKey {
        vault: vec![1; 16],
        operation: vec![99; 16],
        transport: ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
            .unwrap()
            .public_key(),
    };
    let first = block_on(derive_vault_key(&e, request.clone())).unwrap();
    assert_eq!(
        block_on(derive_vault_key(&e, request.clone())).unwrap(),
        first
    );
    assert_eq!(e.derives.get(), 1);
    assert_eq!(e.paid.get(), 12);
    let mut changed = request;
    changed.transport = ic_vetkeys::TransportSecretKey::from_seed(vec![9; 32])
        .unwrap()
        .public_key();
    assert_eq!(
        block_on(derive_vault_key(&e, changed)),
        Err(Error::Conflict)
    );
    e.transaction(|db| {
        assert_eq!(store::content::global_usage(db)?, TOTAL_MAX);
        assert!(store::content::usage(db)? <= TOTAL_MAX);
        Ok(())
    })
    .unwrap();
}

#[test]
fn normal_key_admission_preserves_rates_and_reuses_transient_control_across_owners() {
    let e = Env::new();
    let transport = ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
        .unwrap()
        .public_key();
    for owner in 1..=9 {
        e.owner.set(Principal::from_slice(&[owner + 10]));
        e.create();
        for n in 0..if owner == 1 { 100 } else { 1 } {
            block_on(derive_vault_key(
                &e,
                DeriveKey {
                    vault: vec![1; 16],
                    operation: vec![n + 20; 16],
                    transport: transport.clone(),
                },
            ))
            .unwrap();
            assert!(e.transaction(store::keys::current).unwrap().is_none());
        }
    }
    e.owner.set(Principal::from_slice(&[11]));
    assert_eq!(
        block_on(derive_vault_key(
            &e,
            DeriveKey {
                vault: vec![1; 16],
                operation: vec![200; 16],
                transport
            }
        )),
        Err(Error::QuotaExceeded)
    );
    assert_eq!(
        e.db.borrow()
            .query_row(
                "SELECT count(*) FROM operations WHERE admission=3",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn protected_key_callback_is_bounded_and_cannot_publish_after_cancellation() {
    let e = Env::new();
    e.create();
    e.transaction(|db| {
        let extra = TOTAL_MAX - store::content::global_usage(db)?;
        db.execute(
            "INSERT INTO revisions VALUES(X'02',?1,?2,1,1,NULL,1,?3,'[]',0,?4)",
            params![vec![1u8; 16], vec![3u8; 16], vec![0u8; 64], extra as i64],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    e.hook.replace(Some(Box::new(|e| {
        e.transaction(|db| {
            assert_eq!(store::content::global_usage(db)?, TOTAL_MAX);
            let (token, _) = store::keys::current(db)?.unwrap();
            assert_eq!(
                store::keys::cancel_pending(db, e.now())?,
                Some((token, 20, false))
            );
            Ok(())
        })
        .unwrap();
    })));
    let request = DeriveKey {
        vault: vec![1; 16],
        operation: vec![90; 16],
        transport: ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
            .unwrap()
            .public_key(),
    };
    assert_eq!(
        block_on(derive_vault_key(&e, request.clone())),
        Err(Error::Expired)
    );
    assert_eq!(e.paid.get(), 12);
    assert_eq!(
        e.transaction(|db| ops::replay::<KeyReply>(
            db,
            &request.operation,
            &ops::digest(b"derive-vault-key/v1", &request)?,
            e.now()
        ))
        .unwrap(),
        None
    );
}

#[test]
fn protected_key_admission_keeps_combined_rates_inflight_credit_and_owner_checks_atomic() {
    let e = Env::new();
    e.create();
    e.transaction(|db| {
        db.execute("WITH RECURSIVE n(x) AS (SELECT 1000 UNION ALL SELECT x+1 FROM n WHERE x<1098) INSERT INTO key_flights(owner,vault,token,day,reserved,actual,created,settled,in_flight) SELECT X'01',zeroblob(16),x,0,30000000000,0,100,100,0 FROM n",[]).unwrap();
        let extra=TOTAL_MAX-store::content::global_usage(db)?;
        db.execute("INSERT INTO revisions VALUES(X'02',?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vec![1u8;16],vec![3u8;16],vec![0u8;64],extra as i64]).unwrap();
        Ok(())
    }).unwrap();
    let request = DeriveKey {
        vault: vec![1; 16],
        operation: vec![90; 16],
        transport: ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
            .unwrap()
            .public_key(),
    };
    e.funded.set(false);
    assert_eq!(
        block_on(derive_vault_key(&e, request.clone())),
        Err(Error::QuotaExceeded)
    );
    e.funded.set(true);
    e.owner.set(Principal::from_slice(&[2]));
    assert_eq!(
        block_on(derive_vault_key(&e, request.clone())),
        Err(Error::NotFound)
    );
    e.owner.set(Principal::anonymous());
    assert_eq!(
        block_on(derive_vault_key(&e, request.clone())),
        Err(Error::Unauthorized)
    );
    e.owner.set(Principal::from_slice(&[1]));
    let mut invalid = request.clone();
    invalid.transport = vec![0; 48];
    assert_eq!(
        block_on(derive_vault_key(&e, invalid)),
        Err(Error::InvalidInput)
    );
    assert_eq!(
        e.db.borrow()
            .query_row(
                "SELECT count(*) FROM operations WHERE admission=3",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let mut next = request.clone();
    next.operation = vec![91; 16];
    let competing = next.clone();
    e.hook.replace(Some(Box::new(move |e| {
        assert_eq!(
            derive_vault_key(e, competing).now_or_never().unwrap(),
            Err(Error::Busy)
        );
        assert_eq!(
            e.db.borrow()
                .query_row(
                    "SELECT count(*) FROM operations WHERE admission=3",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    })));
    block_on(derive_vault_key(&e, request)).unwrap();
    assert_eq!(
        block_on(derive_vault_key(&e, next)),
        Err(Error::QuotaExceeded)
    );
    assert_eq!(e.derives.get(), 1);
    assert_eq!(
        e.db.borrow()
            .query_row(
                "SELECT count(*) FROM operations WHERE admission=3",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert!(e.transaction(store::keys::current).unwrap().is_none());
}

#[test]
fn settled_old_key_callback_cannot_clear_new_target_after_schema_generation_change() {
    let e = Env::new();
    e.transaction(|db| {
        store::keys::reserve(db, &[1; 16], 1, 1, 20)?;
        store::keys::mark_sent(db, 1, 20)?;
        db.execute("INSERT INTO global_settings VALUES('generation','1')", [])
            .unwrap();
        assert_eq!(store::keys::cancel_pending(db, 122)?, Some((1, 20, true)));
        assert!(!runtime::settle_key_reservation_in(db, 1, 123, 12)?);
        store::keys::reserve(db, &[2; 16], 2, 124, 20)?;
        assert!(!runtime::settle_key_reservation_in(db, 1, 125, 12)?);
        assert_eq!(store::keys::current(db)?, Some((2, vec![2; 16])));
        assert!(runtime::settle_key_reservation_in(db, 2, 126, 12)?);
        assert_eq!(store::keys::current(db)?, None);
        Ok(())
    })
    .unwrap();
}

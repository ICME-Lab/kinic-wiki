use super::*;

#[test]
fn three_vault_limit_and_exact_creation_replay() {
    let e = Env::new();
    let h = e.create();
    assert_eq!(e.create(), h);
    for n in 2..=3 {
        block_on(create_vault(
            &e,
            CreateVault {
                operation: vec![n + 10; 16],
            },
        ))
        .unwrap();
    }
    assert!(matches!(
        block_on(create_vault(
            &e,
            CreateVault {
                operation: vec![14; 16]
            }
        )),
        Err(Error::QuotaExceeded)
    ));
}
#[test]
fn zero_balance_cancel_retries_are_bounded_even_when_capacity_is_full() {
    let e = Env::new();
    e.create();
    let r = e.begin();
    e.change(
        6,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 0,
            bytes: vec![7; 17],
        },
    )
    .unwrap();
    e.funded.set(false);
    e.transaction(|db| {
        db.execute("UPDATE uploads SET reserved=?1", params![TOTAL_MAX as i64])
            .unwrap();
        Ok(())
    })
    .unwrap();
    let action = Action::CancelUpload {
        vault: r.vault.clone(),
        upload: r.operation.clone(),
        job: vec![22; 16],
    };
    assert!(matches!(
        e.change(23, action.clone()),
        Ok(MutationResult::Progress(false))
    ));
    assert!(matches!(
        e.change(23, action.clone()),
        Ok(MutationResult::Progress(false))
    ));
    assert!(matches!(
        e.change(24, action),
        Ok(MutationResult::Progress(true))
    ));
    assert!(matches!(
        e.transaction(|db| store::content::upload_status(db, &r.operation, e.now()))
            .unwrap(),
        UploadStatus::Cancelled
    ));
}
#[test]
fn review_creation_failure_keeps_identity_and_cross_method_binding() {
    let e = Env::new();
    let r = CreateVault {
        operation: vec![2; 16],
    };
    e.fail_public.set(true);
    assert_eq!(
        block_on(create_vault(&e, r.clone())),
        Err(Error::KeyService)
    );
    let pending = e.transaction(store::list).unwrap().remove(0);
    assert_eq!(pending.id, vault_id(1));
    assert!(matches!(e.change(2, Action::Collect), Err(Error::Conflict)));
    let h = block_on(create_vault(&e, r)).unwrap();
    assert_eq!(h.nonce, vec![1; 32]);
    assert_eq!(h.id, vault_id(1));
    assert_eq!(e.randoms.get(), 1);
    assert_eq!(e.transaction(store::list).unwrap().len(), 1);
}
#[test]
fn review_creation_lease_gc_keeps_binding_and_saved_nonce() {
    let e = Env::new();
    e.public_hook.replace(Some(Box::new(|e| {
        e.now.set(e.now() + 301);
        e.transaction(|db| ops::collect(db, e.now())).unwrap();
        assert!(matches!(e.change(2, Action::Collect), Err(Error::Conflict)));
    })));
    assert_eq!(
        block_on(create_vault(
            &e,
            CreateVault {
                operation: vec![2; 16]
            }
        )),
        Err(Error::Expired)
    );
    let h = e.create();
    assert_eq!(h.nonce, vec![1; 32]);
    assert_eq!(h.id, vault_id(1));
    assert_eq!(e.randoms.get(), 1);
    assert_eq!(e.transaction(store::list).unwrap().len(), 1);
}

// Catches trusting caller-selected identity or allocating a second/reset counter.
#[test]
fn server_identity_uses_global_operation_serial_across_owners_and_intervening_work() {
    let e = Env::new();
    let first = e.create();
    assert_eq!(first.id, 1u128.to_be_bytes());
    e.transaction(|db| {
        let token = ops::begin(db, &[90; 16], &[7; 32], e.now())?;
        assert_eq!(token, 2);
        ops::complete(db, &[90; 16], token, &MutationResult::Done, e.now())
    })
    .unwrap();
    e.owner.set(Principal::from_slice(&[2]));
    let other = e.create();
    assert_eq!(other.id, 3u128.to_be_bytes());
}

// Catches leaving tombstones at global capacity or reusing a deleted identity.
#[test]
fn physical_deletion_recovers_global_capacity_without_reusing_identity() {
    let e = Env::new();
    let h = e.create();
    e.transaction(|db| {
        // Seed the other 9999 allocated identities without management calls.
        for serial in 2..=10000 {
            let mut fixture = h.clone();
            fixture.id = vault_id(serial);
            db.execute(
                "INSERT INTO vaults(owner,id,operation,header) VALUES(X'50',?1,?2,?3)",
                params![
                    fixture.id,
                    fixture.id,
                    serde_json::to_string(&fixture).unwrap()
                ],
            )
            .unwrap();
        }
        db.execute(
            "UPDATE global_settings SET value='10000' WHERE key='serial'",
            [],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let request = CreateVault {
        operation: vec![3; 16],
    };
    assert_eq!(
        block_on(create_vault(&e, request.clone())),
        Err(Error::QuotaExceeded)
    );
    let delete = Action::DeleteVault {
        vault: h.id.clone(),
    };
    assert!(matches!(
        e.change(80, delete.clone()),
        Ok(MutationResult::Progress(true))
    ));
    assert_eq!(
        e.transaction(|db| store::header(db, &h.id)),
        Err(Error::NotFound)
    );
    assert!(matches!(
        e.change(80, delete.clone()),
        Ok(MutationResult::Progress(true))
    ));
    let next = block_on(create_vault(&e, request)).unwrap();
    assert_ne!(next.id, h.id);
    assert!(matches!(e.change(81, delete.clone()), Err(Error::NotFound)));
    e.now.set(e.now() + DAY + 1);
    assert!(matches!(e.change(80, delete.clone()), Err(Error::Expired)));
    e.transaction(|db| ops::collect(db, e.now())).unwrap();
    assert!(matches!(e.change(80, delete), Err(Error::NotFound)));
    assert_eq!(
        e.transaction(|db| store::header(db, &next.id)).unwrap(),
        next
    );
}

// Catches counter wrap/negative IDs and leaking an allocation after failed admission.
#[test]
fn last_positive_serial_allocates_once_then_exhaustion_is_atomic() {
    let e = Env::new();
    e.transaction(|db| {
        db.execute(
            "INSERT INTO global_settings VALUES('serial',?1)",
            params![(i64::MAX - 1).to_string()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let h = e.create();
    assert_eq!(h.id, (i64::MAX as u128).to_be_bytes());
    assert_eq!(
        block_on(create_vault(
            &e,
            CreateVault {
                operation: vec![3; 16]
            }
        )),
        Err(Error::QuotaExceeded)
    );
    assert_eq!(e.transaction(store::list).unwrap(), vec![h]);
}

// Catches stale randomness/public-key callbacks mutating a newly allocated row.
#[test]
fn deleted_pending_callback_cannot_publish_into_replacement_vault() {
    for at_public in [false, true] {
        let e = Env::new();
        let hook: Hook = Box::new(|e| {
            let old = e.transaction(store::list).unwrap().remove(0);
            assert!(matches!(
                e.change(
                    80,
                    Action::DeleteVault {
                        vault: old.id.clone()
                    }
                ),
                Ok(MutationResult::Progress(true))
            ));
            let next = create_vault(
                e,
                CreateVault {
                    operation: vec![3; 16],
                },
            )
            .now_or_never()
            .unwrap()
            .unwrap();
            assert_ne!(old.id, next.id);
            assert_eq!(
                e.transaction(|db| store::header(db, &old.id)),
                Err(Error::NotFound)
            );
        });
        if at_public {
            e.public_hook.replace(Some(hook));
        } else {
            e.random_hook.replace(Some(hook));
        }
        assert_eq!(
            block_on(create_vault(
                &e,
                CreateVault {
                    operation: vec![2; 16]
                }
            )),
            Err(Error::NotFound)
        );
        let rows = e.transaction(store::list).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, VaultState::Active);
    }
}

// Catches allocating a new Vault for a failed initial raw_rand call.
#[test]
fn randomness_failure_retains_pending_identity_and_completed_reply_replays_unfunded() {
    let e = Env::new();
    e.fail_random.set(true);
    let request = CreateVault {
        operation: vec![2; 16],
    };
    assert_eq!(
        block_on(create_vault(&e, request.clone())),
        Err(Error::KeyService)
    );
    let pending = e.transaction(store::list).unwrap().remove(0);
    assert_eq!(pending.id, vault_id(1));
    assert_eq!(pending.state, VaultState::Pending);
    assert!(pending.nonce.is_empty());
    let h = block_on(create_vault(&e, request.clone())).unwrap();
    assert_eq!(h.id, pending.id);
    assert_eq!(h.nonce, vec![1; 32]);
    e.funded.set(false);
    assert_eq!(block_on(create_vault(&e, request.clone())), Ok(h.clone()));
    assert_eq!(e.randoms.get(), 1);
    e.now.set(e.now() + DAY + 1);
    e.transaction(|db| ops::collect(db, e.now())).unwrap();
    assert!(matches!(e.change(2, Action::Collect), Err(Error::Conflict)));
    e.funded.set(true);
    assert_eq!(block_on(create_vault(&e, request)), Err(Error::Conflict));
    assert_eq!(e.transaction(store::list).unwrap(), vec![h]);
}

// Catches permitting extra Vaults while admitted rows are pending or deleting.
#[test]
fn pending_and_deleting_vaults_consume_owner_slots_until_physical_cleanup() {
    let e = Env::new();
    let first = e.create();
    e.begin();
    assert!(matches!(
        e.change(80, Action::DeleteVault { vault: first.id }),
        Ok(MutationResult::Progress(false))
    ));
    for n in [20, 21] {
        e.fail_public.set(true);
        assert_eq!(
            block_on(create_vault(
                &e,
                CreateVault {
                    operation: vec![n; 16]
                }
            )),
            Err(Error::KeyService)
        );
    }
    let rows = e.transaction(store::list).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter()
            .filter(|h| h.state == VaultState::Pending)
            .count(),
        2
    );
    assert_eq!(
        block_on(create_vault(
            &e,
            CreateVault {
                operation: vec![22; 16]
            }
        )),
        Err(Error::QuotaExceeded)
    );
}

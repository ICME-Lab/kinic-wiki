use super::*;

#[test]
fn three_vault_limit_and_changed_create_payload_conflict() {
    let e = Env::new();
    e.create();
    assert!(matches!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![9; 16],
                operation: vec![2; 16]
            }
        )),
        Err(Error::Conflict)
    ));
    for n in 2..=3 {
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![n; 16],
                operation: vec![n + 10; 16],
            },
        ))
        .unwrap();
    }
    assert!(matches!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![4; 16],
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
fn review_creation_failure_keeps_cross_vault_and_cross_method_binding() {
    let e = Env::new();
    let r = CreateVault {
        vault: vec![1; 16],
        operation: vec![2; 16],
    };
    e.fail_public.set(true);
    assert_eq!(
        block_on(create_vault(&e, r.clone())),
        Err(Error::KeyService)
    );
    assert_eq!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![3; 16],
                operation: r.operation.clone()
            }
        )),
        Err(Error::Conflict)
    );
    assert!(matches!(e.change(2, Action::Collect), Err(Error::Conflict)));
    let h = block_on(create_vault(&e, r)).unwrap();
    assert_eq!(h.nonce, vec![1; 32]);
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
        assert_eq!(
            create_vault(
                e,
                CreateVault {
                    vault: vec![3; 16],
                    operation: vec![2; 16]
                }
            )
            .now_or_never()
            .unwrap(),
            Err(Error::Conflict)
        );
    })));
    assert_eq!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![2; 16]
            }
        )),
        Err(Error::Expired)
    );
    let h = e.create();
    assert_eq!(h.nonce, vec![1; 32]);
    assert_eq!(e.randoms.get(), 1);
    assert_eq!(e.transaction(store::list).unwrap().len(), 1);
}

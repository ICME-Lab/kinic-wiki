use super::*;
use store::sharing;

fn grant(e: &Env, v: &[u8], member: Principal, role: AccessRole) -> Result<()> {
    e.transaction(|db| sharing::set_member(db, e.owner(), v, member, role))
}

#[test]
fn membership_limit_owner_immutability_and_cleanup_accounting() {
    let e = Env::new();
    let h = e.create();
    let before = e.transaction(store::content::usage).unwrap();
    for n in 0..100 {
        grant(
            &e,
            &h.id,
            Principal::from_slice(&[n, 1]),
            AccessRole::Viewer,
        )
        .unwrap();
    }
    assert!(e.transaction(store::content::usage).unwrap() > before);
    let m = Principal::from_slice(&[0, 1]);
    grant(&e, &h.id, m, AccessRole::Editor).unwrap();
    assert_eq!(
        grant(
            &e,
            &h.id,
            Principal::from_slice(&[101, 1]),
            AccessRole::Editor
        ),
        Err(Error::QuotaExceeded)
    );
    assert!(grant(&e, &h.id, e.owner(), AccessRole::Viewer).is_err());
    assert!(grant(&e, &h.id, m, AccessRole::Owner).is_err());
    assert!(grant(&e, &h.id, Principal::anonymous(), AccessRole::Editor).is_err());
    assert!(
        e.transaction(|db| sharing::remove_member(db, m, &h.id, m))
            .is_err()
    );
    assert!(e.transaction(|db| sharing::members(db, m, &h.id)).is_err());
    assert_eq!(
        e.transaction(|db| sharing::members(db, e.owner(), &h.id))
            .unwrap()
            .len(),
        100
    );
    assert_eq!(
        e.transaction(|db| sharing::accessible(db, m, &[]))
            .unwrap()
            .entries[0]
            .owner,
        e.owner()
    );
    e.change(
        190,
        Action::DeleteVault {
            vault: h.id.clone(),
        },
    )
    .unwrap();
    assert!(e.transaction(|db| sharing::access(db, m, &h.id)).is_err());
    assert!(
        e.transaction(|db| sharing::accessible(db, m, &[]))
            .unwrap()
            .entries
            .is_empty()
    );
    assert_eq!(
        e.db.borrow()
            .query_row("SELECT count(*) FROM vault_members", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn shared_upload_retries_are_caller_and_vault_bound_with_original_wire_ids() {
    let e = Env::new();
    let h = e.create();
    let other = block_on(create_vault(
        &e,
        CreateVault {
            operation: vec![80; 16],
        },
    ))
    .unwrap();
    let editor = Principal::from_slice(&[31]);
    let viewer = Principal::from_slice(&[32]);
    grant(&e, &h.id, editor, AccessRole::Editor).unwrap();
    grant(&e, &h.id, viewer, AccessRole::Viewer).unwrap();
    let change = |caller, v: &[u8], n, action| {
        shared_mutate(
            &e,
            caller,
            v,
            Mutation {
                operation: vec![n; 16],
                action,
            },
        )
    };
    let r = BeginRevision {
        vault: h.id.clone(),
        object: vec![3; 16],
        operation: vec![4; 16],
        expected_revision: 0,
        plain_size: 1,
        manifest: vec![1; 64],
        chunk_hashes: vec![Sha256::digest([7; 17]).to_vec()],
    };
    assert!(matches!(
        change(viewer, &h.id, 21, Action::BeginRevision(r.clone())),
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        change(editor, &other.id, 21, Action::BeginRevision(r.clone())),
        Err(Error::Unauthorized)
    ));
    let mut wrong = r.clone();
    wrong.vault = other.id.clone();
    assert!(matches!(
        change(editor, &h.id, 21, Action::BeginRevision(wrong)),
        Err(Error::Unauthorized)
    ));
    assert!(
        matches!(change(editor,&h.id,21,Action::BeginRevision(r.clone())), Ok(MutationResult::Upload(u)) if u.id==r.operation)
    );
    let pending = e
        .transaction(|db| sharing::pending_uploads(db, editor, &h.id, &[]))
        .unwrap();
    assert_eq!(pending.entries[0].upload, r.operation);
    assert!(
        matches!(e.transaction(|db|sharing::upload_status(db,editor,&h.id,&r.operation,100)),Ok(UploadStatus::Pending(p)) if p.request.operation==r.operation)
    );
    let own_upload = r.operation.clone();
    let mut other_r = r.clone();
    other_r.vault = other.id.clone();
    e.change(71, Action::BeginRevision(other_r)).unwrap();
    assert!(matches!(
        change(
            editor,
            &h.id,
            22,
            Action::PutChunk {
                upload: own_upload.clone(),
                index: 0,
                bytes: vec![7; 17]
            }
        ),
        Ok(MutationResult::Done)
    ));
    let commit = Action::CommitRevision {
        upload: r.operation.clone(),
    };
    assert!(
        matches!(change(editor,&h.id,23,commit.clone()),Ok(MutationResult::Revision(rev)) if rev.vault==h.id)
    );
    assert!(
        matches!(e.transaction(|db|sharing::upload_status(db,editor,&h.id,&r.operation,100)),Ok(UploadStatus::Committed(c)) if c.vault==h.id)
    );
    assert!(
        matches!(e.transaction(|db|store::content::upload_status(db,&own_upload,100)),Ok(UploadStatus::Pending(p)) if p.received.is_empty())
    );
    assert!(matches!(
        change(
            editor,
            &h.id,
            25,
            Action::PurgeObject {
                vault: h.id.clone(),
                object: r.object,
                expected_revision: 1
            }
        ),
        Err(Error::Unauthorized)
    ));
    grant(&e, &h.id, editor, AccessRole::Viewer).unwrap();
    assert!(matches!(
        change(editor, &h.id, 23, commit),
        Err(Error::Unauthorized)
    ));
}

#[test]
fn shared_key_uses_owner_context_and_revocation_fences_replay_and_callback_after_settlement() {
    let e = Env::new();
    let h = e.create();
    let member = Principal::from_slice(&[31]);
    grant(&e, &h.id, member, AccessRole::Viewer).unwrap();
    let mut req = DeriveKey {
        vault: h.id.clone(),
        operation: vec![8; 16],
        transport: ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
            .unwrap()
            .public_key(),
    };
    let first = block_on(shared_derive_vault_key(&e, member, req.clone())).unwrap();
    assert_eq!(first.input, key_input(e.canister(), e.owner(), &h).unwrap());
    e.transaction(|db| sharing::remove_member(db, e.owner(), &h.id, member))
        .unwrap();
    assert_eq!(
        block_on(shared_derive_vault_key(&e, member, req.clone())),
        Err(Error::Unauthorized)
    );
    grant(&e, &h.id, member, AccessRole::Viewer).unwrap();
    req.operation = vec![9; 16];
    e.hook.replace(Some(Box::new(move |e| {
        e.transaction(|db| sharing::remove_member(db, e.owner(), &h.id, member))
            .unwrap();
    })));
    assert_eq!(
        block_on(shared_derive_vault_key(&e, member, req)),
        Err(Error::Unauthorized)
    );
    assert_eq!(e.derives.get(), 2);
    assert_eq!(e.paid.get(), 12);
    assert_eq!(e.transaction(store::keys::current).unwrap(), None);
}

#[test]
fn shared_quota_excludes_reservations_and_metadata_from_other_vaults() {
    let e = Env::new();
    let h = e.create();
    let other = block_on(create_vault(
        &e,
        CreateVault {
            operation: vec![88; 16],
        },
    ))
    .unwrap();
    let member = Principal::from_slice(&[91]);
    grant(&e, &h.id, member, AccessRole::Viewer).unwrap();
    let before = e
        .transaction(|db| store::content::vault_quota(db, &h.id))
        .unwrap();
    e.change(
        89,
        Action::BeginRevision(BeginRevision {
            vault: other.id,
            object: vec![3; 16],
            operation: vec![90; 16],
            expected_revision: 0,
            plain_size: 1,
            manifest: vec![1; 64],
            chunk_hashes: vec![vec![2; 32]],
        }),
    )
    .unwrap();
    let after = e
        .transaction(|db| store::content::vault_quota(db, &h.id))
        .unwrap();
    assert_eq!(after.reserved, 0);
    assert_eq!(after.charged, before.charged);
    assert!(
        e.transaction(|db| store::content::quota(db, &h.id))
            .unwrap()
            .reserved
            > 0
    );
}

#[test]
fn accessible_pages_include_owned_and_shared_vaults_without_duplicate_or_revoked_entries() {
    let e = Env::new();
    let member = e.owner();
    let mut ids = vec![e.create().id];
    for n in 20..45 {
        e.owner.set(Principal::from_slice(&[n]));
        let h = e.create();
        grant(&e, &h.id, member, AccessRole::Viewer).unwrap();
        ids.push(h.id);
    }
    let last = ids.pop().unwrap();
    e.transaction(|db| sharing::remove_member(db, e.owner(), &last, member))
        .unwrap();
    let mut after = vec![];
    let mut found = vec![];
    loop {
        let page = e
            .transaction(|db| sharing::accessible(db, member, &after))
            .unwrap();
        found.extend(page.entries.into_iter().map(|a| a.header.id));
        match page.next {
            Some(next) => {
                assert!(next > after);
                after = next;
            }
            None => break,
        }
    }
    assert_eq!(found, ids);
    assert!(!after.is_empty());
}

#[test]
fn legacy_journal_cannot_replay_as_a_shared_request_even_at_identical_database_ids() {
    let e = Env::new();
    let h = e.create();
    let member = Principal::from_slice(&[91]);
    grant(&e, &h.id, member, AccessRole::Viewer).unwrap();
    let mut request = DeriveKey {
        vault: h.id.clone(),
        operation: vec![42; 16],
        transport: ic_vetkeys::TransportSecretKey::from_seed(vec![42; 32])
            .unwrap()
            .public_key(),
    };
    let wire = request.operation.clone();
    request.operation = sharing::scoped_id(b"operation", member, &h.id, &wire).unwrap();
    block_on(derive_vault_key(&e, request.clone())).unwrap();
    request.operation = wire;
    assert_eq!(
        block_on(shared_derive_vault_key(&e, member, request)),
        Err(Error::Conflict)
    );
}

#[test]
fn editors_can_reuse_each_others_wire_identifiers_without_replaying_each_others_uploads() {
    let e = Env::new();
    let h = e.create();
    let mut previous = vec![];
    for n in [31, 32] {
        let caller = Principal::from_slice(&[n]);
        grant(&e, &h.id, caller, AccessRole::Editor).unwrap();
        let change = |op, action| {
            shared_mutate(
                &e,
                caller,
                &h.id,
                Mutation {
                    operation: vec![op; 16],
                    action,
                },
            )
        };
        let r = BeginRevision {
            vault: h.id.clone(),
            object: vec![n; 16],
            operation: vec![41; 16],
            expected_revision: 0,
            plain_size: 1,
            manifest: vec![n; 32],
            chunk_hashes: vec![Sha256::digest([n; 17]).to_vec()],
        };
        assert!(matches!(
            e.transaction(|db| sharing::upload_status(db, caller, &h.id, &r.operation, 100)),
            Ok(UploadStatus::Absent)
        ));
        assert!(
            matches!(change(42,Action::BeginRevision(r.clone())),Ok(MutationResult::Upload(u)) if u.id==r.operation)
        );
        change(
            43,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![n; 17],
            },
        )
        .unwrap();
        assert!(
            matches!(change(44,Action::CommitRevision{upload:r.operation.clone()}),Ok(MutationResult::Revision(rev)) if rev.object==r.object)
        );
        previous.push((caller, r.object));
    }
    for (caller, object) in previous {
        assert!(
            matches!(e.transaction(|db|sharing::upload_status(db,caller,&h.id,&[41;16],100)),Ok(UploadStatus::Committed(c)) if c.object==object)
        );
    }
}

#[test]
fn foreign_pending_and_terminal_uploads_are_rejected_before_returning_any_status() {
    let e = Env::new();
    let shared = e.create();
    let other = block_on(create_vault(
        &e,
        CreateVault {
            operation: vec![81; 16],
        },
    ))
    .unwrap();
    let caller = Principal::from_slice(&[30]);
    grant(&e, &shared.id, caller, AccessRole::Editor).unwrap();
    let wire = vec![43; 16];
    let upload = sharing::scoped_id(b"upload", caller, &shared.id, &wire).unwrap();
    let request = BeginRevision {
        vault: other.id,
        object: vec![5; 16],
        operation: upload.clone(),
        expected_revision: 0,
        plain_size: 1,
        manifest: vec![10; 64],
        chunk_hashes: vec![Sha256::digest([7; 17]).to_vec()],
    };
    e.change(71, Action::BeginRevision(request)).unwrap();
    let status = || e.transaction(|db| sharing::upload_status(db, caller, &shared.id, &wire, 100));
    assert!(matches!(status(), Err(Error::Unauthorized)));
    let commit = || {
        shared_mutate(
            &e,
            caller,
            &shared.id,
            Mutation {
                operation: vec![72; 16],
                action: Action::CommitRevision {
                    upload: wire.clone(),
                },
            },
        )
    };
    assert!(matches!(commit(), Err(Error::Unauthorized)));
    e.change(
        73,
        Action::PutChunk {
            upload: upload.clone(),
            index: 0,
            bytes: vec![7; 17],
        },
    )
    .unwrap();
    e.change(74, Action::CommitRevision { upload }).unwrap();
    assert!(matches!(status(), Err(Error::Unauthorized)));
    assert!(matches!(commit(), Err(Error::Unauthorized)));
}

#[test]
fn revoking_a_member_releases_owner_capacity_at_the_limit() {
    let e = Env::new();
    let v = e.create().id;
    let caller = Principal::from_slice(&[91]);
    let baseline = e
        .transaction(|db| {
            Ok((
                store::content::usage(db)?,
                store::content::global_usage(db)?,
            ))
        })
        .unwrap();
    grant(&e, &v, caller, AccessRole::Viewer).unwrap();
    let (local, global) = e
        .transaction(|db| {
            Ok((
                store::content::usage(db)?,
                store::content::global_usage(db)?,
            ))
        })
        .unwrap();
    assert_eq!((local - baseline.0, global - baseline.1), (1024, 1024));
    e.transaction(|db| {
        db.execute(
            "INSERT INTO revisions VALUES(?1,?2,?3,1,1,NULL,1,?4,'[]',0,?5)",
            params![
                e.owner().as_slice(),
                v,
                vec![3u8; 16],
                vec![0u8; 64],
                (TOTAL_MAX - local) as i64
            ],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    assert_eq!(
        grant(&e, &v, Principal::from_slice(&[92]), AccessRole::Editor),
        Err(Error::QuotaExceeded)
    );
    e.transaction(|db| sharing::remove_member(db, e.owner(), &v, caller))
        .unwrap();
    assert_eq!(
        e.transaction(store::content::usage).unwrap(),
        TOTAL_MAX - 1024
    );
    grant(&e, &v, Principal::from_slice(&[92]), AccessRole::Editor).unwrap();
}

fn matching_legacy_upload(e: &Env, caller: Principal, vault: &[u8]) -> (BeginRevision, Id) {
    let wire = vec![43; 16];
    let id = sharing::scoped_id(b"upload", caller, vault, &wire).unwrap();
    let mut r = BeginRevision {
        vault: vault.to_vec(),
        object: vec![5; 16],
        operation: id.clone(),
        expected_revision: 0,
        plain_size: 1,
        manifest: vec![10; 64],
        chunk_hashes: vec![Sha256::digest([7; 17]).to_vec()],
    };
    e.change(71, Action::BeginRevision(r.clone())).unwrap();
    r.operation = wire;
    (r, id)
}

#[test]
fn same_vault_legacy_pending_upload_cannot_supply_shared_status_or_accept_shared_writes() {
    let e = Env::new();
    let h = e.create();
    let caller = Principal::from_slice(&[30]);
    grant(&e, &h.id, caller, AccessRole::Editor).unwrap();
    let (r, physical) = matching_legacy_upload(&e, caller, &h.id);
    assert!(matches!(
        e.transaction(|db| sharing::upload_status(db, caller, &h.id, &r.operation, 100)),
        Err(Error::Unauthorized)
    ));
    let actions = [
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 0,
            bytes: vec![7; 17],
        },
        Action::CancelUpload {
            vault: h.id.clone(),
            upload: r.operation.clone(),
            job: vec![88; 16],
        },
        Action::CommitRevision {
            upload: r.operation,
        },
    ];
    for action in actions {
        assert!(matches!(
            shared_mutate(
                &e,
                caller,
                &h.id,
                Mutation {
                    operation: vec![76; 16],
                    action
                }
            ),
            Err(Error::Unauthorized)
        ));
    }
    assert!(
        matches!(e.transaction(|db|store::content::upload_status(db,&physical,100)),Ok(UploadStatus::Pending(p)) if p.received.is_empty() && p.cancel_job.is_none())
    );
}

#[test]
fn same_vault_matching_begin_cannot_adopt_a_legacy_upload() {
    let e = Env::new();
    let h = e.create();
    let caller = Principal::from_slice(&[30]);
    grant(&e, &h.id, caller, AccessRole::Editor).unwrap();
    let (r, _) = matching_legacy_upload(&e, caller, &h.id);
    let change = Mutation {
        operation: vec![74; 16],
        action: Action::BeginRevision(r),
    };
    assert!(matches!(
        shared_mutate(&e, caller, &h.id, change),
        Err(Error::Unauthorized)
    ));
    assert!(
        e.transaction(|db| sharing::pending_uploads(db, caller, &h.id, &[]))
            .unwrap()
            .entries
            .is_empty()
    );
}

#[test]
fn same_vault_legacy_terminal_outcomes_cannot_supply_shared_status_or_receipts() {
    for cancel in [false, true] {
        let e = Env::new();
        let h = e.create();
        let caller = Principal::from_slice(&[30]);
        grant(&e, &h.id, caller, AccessRole::Editor).unwrap();
        let (r, physical) = matching_legacy_upload(&e, caller, &h.id);
        if cancel {
            e.change(
                72,
                Action::CancelUpload {
                    vault: h.id.clone(),
                    upload: physical,
                    job: vec![1; 16],
                },
            )
            .unwrap();
        } else {
            e.change(
                72,
                Action::PutChunk {
                    upload: physical.clone(),
                    index: 0,
                    bytes: vec![7; 17],
                },
            )
            .unwrap();
            e.change(73, Action::CommitRevision { upload: physical })
                .unwrap();
        }
        assert!(matches!(
            e.transaction(|db| sharing::upload_status(db, caller, &h.id, &r.operation, 100)),
            Err(Error::Unauthorized)
        ));
        for action in [
            Action::CommitRevision {
                upload: r.operation.clone(),
            },
            Action::BeginRevision(r),
        ] {
            assert!(matches!(
                shared_mutate(
                    &e,
                    caller,
                    &h.id,
                    Mutation {
                        operation: vec![75; 16],
                        action
                    }
                ),
                Err(Error::Unauthorized)
            ));
        }
    }
}

#[test]
fn owner_cancellation_of_shared_upload_preserves_uploader_status_until_outcome_collection() {
    let e = Env::new();
    let h = e.create();
    let caller = Principal::from_slice(&[30]);
    grant(&e, &h.id, caller, AccessRole::Editor).unwrap();
    let wire = vec![41; 16];
    let r = BeginRevision {
        vault: h.id.clone(),
        object: vec![5; 16],
        operation: wire.clone(),
        expected_revision: 0,
        plain_size: 1,
        manifest: vec![10; 64],
        chunk_hashes: vec![Sha256::digest([7; 17]).to_vec()],
    };
    shared_mutate(
        &e,
        caller,
        &h.id,
        Mutation {
            operation: vec![60; 16],
            action: Action::BeginRevision(r),
        },
    )
    .unwrap();
    let physical = e
        .transaction(|db| store::content::pending_uploads(db, &[]))
        .unwrap()
        .entries[0]
        .upload
        .clone();
    e.change(
        72,
        Action::CancelUpload {
            vault: h.id.clone(),
            upload: physical,
            job: vec![1; 16],
        },
    )
    .unwrap();
    let status = || e.transaction(|db| sharing::upload_status(db, caller, &h.id, &wire, e.now()));
    assert!(matches!(status(), Ok(UploadStatus::Cancelled)));
    e.now.set(e.now() + DAY + 1);
    e.transaction(|db| store::content::collect_expired_upload_outcomes(db, e.now()))
        .unwrap();
    assert!(matches!(status(), Ok(UploadStatus::Absent)));
}

#[test]
fn shared_wrapper_permits_editor_soft_delete_and_reserves_vault_deletion_for_owner() {
    let e = Env::new();
    let r = committed_document(&e);
    let editor = Principal::from_slice(&[30]);
    grant(&e, &r.vault, editor, AccessRole::Editor).unwrap();
    let mutate = |caller, n, action| {
        shared_mutate(
            &e,
            caller,
            &r.vault,
            Mutation {
                operation: vec![n; 16],
                action,
            },
        )
    };
    assert!(
        matches!(mutate(editor,20,Action::DeleteObject{vault:r.vault.clone(),object:r.object,expected_revision:1}),Ok(MutationResult::Revision(rev)) if rev.deleted)
    );
    let action = Action::DeleteVault {
        vault: r.vault.clone(),
    };
    assert!(matches!(
        mutate(editor, 21, action.clone()),
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        mutate(e.owner(), 21, action),
        Ok(MutationResult::Progress(_))
    ));
}

#[test]
fn integration_shared_rename_requires_owner_and_matches_explicit_vault() {
    let e = Env::new();
    let h = e.create();
    let other = block_on(create_vault(
        &e,
        CreateVault {
            operation: vec![61; 16],
        },
    ))
    .unwrap();
    let member = Principal::from_slice(&[31]);
    let rename = |caller, target: &Id| {
        shared_mutate(
            &e,
            caller,
            &h.id,
            Mutation {
                operation: vec![60; 16],
                action: Action::RenameVault {
                    vault: target.clone(),
                    name: "Team".into(),
                    expected_sequence: 0,
                },
            },
        )
    };
    for role in [AccessRole::Viewer, AccessRole::Editor] {
        grant(&e, &h.id, member, role).unwrap();
        assert!(matches!(rename(member, &h.id), Err(Error::Unauthorized)));
    }
    assert!(matches!(
        rename(e.owner(), &other.id),
        Err(Error::Unauthorized)
    ));
    rename(e.owner(), &h.id).unwrap();
    assert_eq!(
        e.transaction(|db| store::header(db, &h.id))
            .unwrap()
            .name
            .as_deref(),
        Some("Team")
    );
}

#[test]
fn integration_pre_rename_shared_receipt_replays_only_for_current_editor_and_exact_payload() {
    let e = Env::new();
    let h = e.create();
    let caller = Principal::from_slice(&[31]);
    grant(&e, &h.id, caller, AccessRole::Editor).unwrap();
    // Captured with dec6eac2's scoped ID and nested Candid digest, before RenameVault.
    let operation = hex::decode("db9fadbb171746a2a5d5baeca64c7841").unwrap();
    let digest =
        hex::decode("9b7ca5f1a465b585829aac55f9062441569a8b7fda70799d67299108e0cf9759").unwrap();
    e.transaction(|db| {
        let token = ops::begin(db, &operation, &digest, e.now())?;
        ops::complete(db, &operation, token, &MutationResult::Done, e.now())
    })
    .unwrap();
    let retry = |revision| {
        shared_mutate(
            &e,
            caller,
            &h.id,
            Mutation {
                operation: vec![44; 16],
                action: Action::DeleteObject {
                    vault: h.id.clone(),
                    object: vec![3; 16],
                    expected_revision: revision,
                },
            },
        )
    };
    e.funded.set(false);
    assert!(matches!(retry(7), Ok(MutationResult::Done)));
    assert!(matches!(retry(8), Err(Error::Conflict)));
    grant(&e, &h.id, caller, AccessRole::Viewer).unwrap();
    assert!(matches!(retry(7), Err(Error::Unauthorized)));
}

use super::*;
fn fixture(
    count: u8,
) -> (
    TestEnvironment,
    ed25519_dalek::SigningKey,
    GrantInfo,
    IncidentPreparation,
) {
    let (env, key, normal) = signed_fixture(GrantPurpose::Normal);
    let request=env.transaction(|db|{
        grants::prepay(db)?;
        let mut all=authorization::authorities(db)?;
        all.credentials.push(authorization::Authority{id:vec![42],version:1,revoked:false,scope:CredentialScope::Global});
        store::save(db,"authorities",&all)?;
        for i in 2..=count {
            let mut h=store::header(db,&[1;16])?;h.id=vec![i;16];h.generation.as_mut().unwrap().vault=h.id.clone();
            db.execute("INSERT INTO vaults VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,0,?3)",params![h.id,vec![i+10;16],serde_json::to_string(&h).unwrap()]).unwrap();
        }
        let sources:Vec<Generation>=store::list(db)?.into_iter().map(|h|h.generation.unwrap()).collect();
        Ok(IncidentPreparation{job:vec![70;16],namespace:vec![51;32],compromised:vec![CredentialRevocation{credential:vec![42],version:1}],targets:sources.iter().enumerate().map(|(i,s)|PendingCreation{namespace:vec![51;32],vault:s.vault.clone(),attempt:vec![71+i as u8;16]}).collect(),sources})
    }).unwrap();
    let pre = grant(
        &env,
        &key,
        &normal,
        GrantPurpose::IncidentPrepare(request.clone()),
        73,
    );
    (env, key, pre, request)
}
fn grant(
    env: &TestEnvironment,
    key: &ed25519_dalek::SigningKey,
    base: &GrantInfo,
    purpose: GrantPurpose,
    n: u8,
) -> GrantInfo {
    env.transaction(|db| {
        let mut g = grants::load(db, &base.id)?;
        g.info.id = vec![n; 32];
        g.info.purpose = purpose;
        g.info.next_counter = 0;
        g.info.expires = env.now() + 300;
        g.fence = grants::fence(db)?;
        g.last_digest.clear();
        g.last_result = None;
        g.work = None;
        g.revoked = false;
        g.public_key = key.verifying_key().to_bytes().to_vec();
        if let GrantPurpose::IncidentPrepare(r) = &g.info.purpose {
            g.info.generations = r.sources.clone();
        }
        grants::save(db, &g)?;
        Ok(g.info)
    })
    .unwrap()
}
fn allocate(
    env: &TestEnvironment,
    key: &ed25519_dalek::SigningKey,
    pre: &GrantInfo,
    r: &IncidentPreparation,
) -> IncidentStatus {
    signed_call(env, key, pre, 0, MutationOperation::IncidentStart).unwrap();
    for (i, t) in r.targets.iter().enumerate() {
        signed_call(
            env,
            key,
            pre,
            1 + i as u64,
            MutationOperation::IncidentAllocate {
                vault: t.vault.clone(),
                attempt: t.attempt.clone(),
            },
        )
        .unwrap();
    }
    incident::status(env).unwrap().unwrap()
}
fn post(
    env: &TestEnvironment,
    key: &ed25519_dalek::SigningKey,
    pre: &GrantInfo,
    j: &IncidentStatus,
) -> GrantInfo {
    grant(
        env,
        key,
        pre,
        GrantPurpose::Incident {
            job: j.job.clone(),
            vector_digest: j.vector_digest.clone(),
        },
        74,
    )
}
fn transport() -> Vec<u8> {
    ic_bls12_381::G1Affine::generator().to_compressed().to_vec()
}
#[test]
fn incident_exact_scope_and_quiescence_precede_revocation() {
    for bad in 0..6 {
        let (env, key, pre, r) = fixture(3);
        env.transaction(|db| {
            match bad {
                0 => {
                    let mut a = authorization::authorities(db)?;
                    a.credentials[0].scope = CredentialScope::Instances(vec![Instance {
                        vault: r.sources[0].vault.clone(),
                        nonce: r.sources[0].nonce.clone(),
                    }]);
                    store::save(db, "authorities", &a)?;
                }
                1 => {
                    let mut g = grants::load(db, &pre.id)?;
                    g.credential = vec![42];
                    g.credential_version = 1;
                    grants::save(db, &g)?;
                }
                2 => {
                    let mut h = store::header(db, &[3; 16])?;
                    h.state = VaultState::Pending;
                    store::put_header(db, &h)?;
                }
                3 => {
                    let mut n = cleanup::namespace(db)?;
                    n.job = Some(CleanupProgress {
                        job: vec![5; 16],
                        cursor: 0,
                        complete: false,
                    });
                    cleanup::save(db, &n)?;
                }
                4 => {
                    store::keys::reserve(db, 99, env.now(), 30_000_000_000)?;
                }
                _ => {
                    let mut g = grants::load(db, &pre.id)?;
                    if let GrantPurpose::IncidentPrepare(ref mut p) = g.info.purpose {
                        p.sources.pop();
                        p.targets.pop();
                        g.info.generations = p.sources.clone();
                    }
                    grants::save(db, &g)?;
                }
            }
            Ok(())
        })
        .unwrap();
        assert!(signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).is_err());
        env.transaction(|db| {
            assert!(!authorization::authority(db, &[42])?.revoked);
            assert_eq!(store::header(db, &[1; 16])?.state, VaultState::Active);
            assert!(store::incident::status(db)?.is_none());
            Ok(())
        })
        .unwrap();
    }
}
#[test]
fn incident_three_sources_three_targets_roles_reset_and_upgrade() {
    let (env, key, pre, r) = fixture(3);
    let j = allocate(&env, &key, &pre, &r);
    assert_eq!(j.targets.len(), 3);
    assert!(
        j.targets
            .iter()
            .all(|t| t.target.as_ref().unwrap().epoch == 1)
    );
    let post = post(&env, &key, &pre, &j);
    let mut wrong = IncidentDerive {
        job: j.job.clone(),
        attempt: j.targets[0].attempt.clone(),
        role: IncidentRole::Source,
        generation: j.targets[0].target.clone().unwrap(),
        transport: transport(),
    };
    assert_eq!(
        signed_call(
            &env,
            &key,
            &post,
            0,
            MutationOperation::IncidentDerive(wrong.clone())
        )
        .unwrap_err(),
        Error::Unauthorized
    );
    wrong.role = IncidentRole::Target;
    wrong.attempt = j.targets[1].attempt.clone();
    assert_eq!(
        signed_call(
            &env,
            &key,
            &post,
            0,
            MutationOperation::IncidentDerive(wrong)
        )
        .unwrap_err(),
        Error::Unauthorized
    );
    let v = ed25519_dalek::SigningKey::from_bytes(&[4; 32])
        .verifying_key()
        .to_bytes()
        .to_vec();
    let e = |n| Envelope {
        version: 2,
        nonce: vec![n; 12],
        ciphertext: vec![7; 48],
    };
    signed_call(
        &env,
        &key,
        &post,
        0,
        MutationOperation::IncidentStage {
            vault: vec![1; 16],
            attempt: vec![71; 16],
            normal: e(1),
            recovery: e(2),
            recovery_verifier: v,
        },
    )
    .unwrap();
    let staged = incident::status(&env).unwrap().unwrap();
    assert_eq!(staged.vector_digest, j.vector_digest);
    assert_eq!(
        signed_call(
            &env,
            &key,
            &post,
            1,
            MutationOperation::IncidentConfirmKit {
                vault: vec![1; 16],
                attempt: vec![71; 16],
                envelope_digest: vec![0; 32]
            }
        )
        .unwrap_err(),
        Error::Conflict
    );
    signed_call(
        &env,
        &key,
        &post,
        1,
        MutationOperation::IncidentConfirmKit {
            vault: vec![1; 16],
            attempt: vec![71; 16],
            envelope_digest: staged.targets[0].envelope_digest.clone(),
        },
    )
    .unwrap();
    env.db
        .borrow()
        .execute(
            "INSERT INTO global_settings VALUES('generation','1')",
            params![],
        )
        .unwrap();
    assert!(signed_call(&env, &key, &post, 2, MutationOperation::IncidentCancel).is_err());
    let current = incident::status(&env).unwrap().unwrap();
    assert_eq!(current.targets[0].phase, PreparationPhase::KitConfirmed);
    let renewed = grant(&env, &key, &post, post.purpose.clone(), 75);
    signed_call(
        &env,
        &key,
        &renewed,
        0,
        MutationOperation::IncidentReset {
            vault: vec![1; 16],
            attempt: vec![71; 16],
            next_attempt: vec![99; 16],
        },
    )
    .unwrap();
    let reset = incident::status(&env).unwrap().unwrap();
    assert_ne!(reset.vector_digest, j.vector_digest);
    assert!(reset.targets[0].target.is_none());
    assert!(reset.targets[0].kit_ack.is_none());
    assert!(reset.targets[1].target.is_some());
    assert!(signed_call(&env, &key, &renewed, 1, MutationOperation::IncidentCancel).is_err());
    env.transaction(|db| {
        assert_eq!(
            store::header(db, &[1; 16])?.state,
            VaultState::IncidentRequired
        );
        assert_eq!(store::incident::snapshot(db, &[1; 16])?, (1, 1));
        Ok(())
    })
    .unwrap();
}
#[test]
fn incident_callbacks_settle_after_grant_revocation_runtime_reset_and_expiry() {
    for at_derive in [false, true] {
        for change in 0..4 {
            let (env, key, pre, r) = fixture(1);
            let j = allocate(&env, &key, &pre, &r);
            let post = post(&env, &key, &pre, &j);
            let gid = post.id.clone();
            let hook: TestHook = Box::new(move |env| {
                env.transaction(|db| {
                    match change {
                        0 => {
                            let mut a = authorization::authorities(db)?;
                            a.credentials[0].revoked = true;
                            store::save(db, "authorities", &a)?;
                        }
                        1 => {
                            db.execute(
                                "INSERT INTO global_settings VALUES('generation','1')",
                                params![],
                            )
                            .unwrap();
                        }
                        2 => {
                            incident::reset(db, env, &[1; 16], &[71; 16], &[99; 16])?;
                        }
                        _ => {
                            env.time.set(400);
                        }
                    }
                    assert!(grants::current(db, env, &grants::load(db, &gid)?).is_err());
                    Ok(())
                })
                .unwrap();
            });
            if at_derive {
                *env.derive_hook.borrow_mut() = Some(hook);
            } else {
                *env.public_hook.borrow_mut() = Some(hook);
            }
            let request = IncidentDerive {
                job: j.job.clone(),
                attempt: vec![71; 16],
                role: IncidentRole::Target,
                generation: j.targets[0].target.clone().unwrap(),
                transport: transport(),
            };
            signed_call(
                &env,
                &key,
                &post,
                0,
                MutationOperation::IncidentDerive(request),
            )
            .unwrap();
            let expected = if at_derive { 30_000_000_000 } else { 0 };
            assert_eq!(env.settled.get(), Some(expected));
            env.transaction(|db| {
                let (actual, flight): (i64, i64) = db
                    .query_row(
                        "SELECT actual,in_flight FROM key_flights ORDER BY token DESC LIMIT 1",
                        params![],
                        |r| {
                            Ok((
                                kinic_sqlite_compat::row_get(r, 0)?,
                                kinic_sqlite_compat::row_get(r, 1)?,
                            ))
                        },
                    )
                    .unwrap();
                assert_eq!((actual, flight), (expected as i64, 0));
                assert!(control(db)?.derive.is_none());
                Ok(())
            })
            .unwrap();
        }
    }
}
#[test]
fn incident_fresh_webauthn_and_semantic_mismatch_fail_closed() {
    let (env, key, pre, r) = fixture(1);
    let passkey = install_test_passkey(&env);
    env.time.set(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    let request = GrantRequest {
        operation: vec![8; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        purpose: pre.purpose.clone(),
        generations: r.sources.clone(),
    };
    let ch = futures::executor::block_on(ceremonies::begin(&env, request.clone())).unwrap();
    let proof = passkey_assertion(&env, &passkey, &ch);
    let fresh = ceremonies::finish(&env, request.operation, proof).unwrap();
    signed_call(&env, &key, &fresh, 0, MutationOperation::IncidentStart).unwrap();
    env.db.borrow().execute("UPDATE global_settings SET value=json_set(value,'$.origin','https://other.test') WHERE key='config'",params![]).unwrap();
    assert!(
        signed_call(
            &env,
            &key,
            &fresh,
            1,
            MutationOperation::IncidentAllocate {
                vault: vec![1; 16],
                attempt: vec![71; 16]
            }
        )
        .is_err()
    );
    assert!(!incident::status(&env).unwrap().unwrap().complete);
    env.transaction(|db| {
        assert_eq!(
            store::header(db, &[1; 16])?.state,
            VaultState::IncidentRequired
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn incident_pins_snapshot_and_zero_balance_terminal_cleanup() {
    let (env, key, pre, r) = fixture(1);
    env.transaction(|db|{
        db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,2,0,?3,'[]',1,4096)",params![vec![1u8;16],vec![9u8;16],Vec::<u8>::new()]).unwrap();Ok(())
    }).unwrap();
    allocate(&env, &key, &pre, &r);
    env.time.set(DAY * 10);
    env.transaction(|db| {
        assert_eq!(store::content::gc(db, env.now())?, 0);
        assert_eq!(store::incident::snapshot(db, &[1; 16])?, (1, 1));
        let count: i64 = db
            .query_row("SELECT count(*) FROM revisions", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(count, 1);
        Ok(())
    })
    .unwrap();
    let cleanup_grant = grant(
        &env,
        &key,
        &pre,
        GrantPurpose::Cleanup { job: vec![91; 16] },
        92,
    );
    env.transaction(|db| {
        let mut n = cleanup::namespace(db)?;
        n.grant = Some(grants::load(db, &cleanup_grant.id)?);
        cleanup::save(db, &n)
    })
    .unwrap();
    env.funded.set(false);
    for cursor in 0..10 {
        let result = signed_call(
            &env,
            &key,
            &cleanup_grant,
            cursor,
            MutationOperation::Cleanup {
                job: vec![91; 16],
                cursor,
                action: CleanupAction::Purge,
            },
        )
        .unwrap();
        if let MutationResult::Cleanup(p) = result {
            if p.complete {
                break;
            }
        }
    }
    assert!(incident::status(&env).unwrap().unwrap().complete);
}
#[test]
fn incident_multi_revocation_union_and_64k_bound() {
    let (env, key, pre, mut r) = fixture(3);
    env.transaction(|db| {
        let mut a = authorization::authorities(db)?;
        a.credentials[1].scope = CredentialScope::Instances(vec![Instance {
            vault: vec![1; 16],
            nonce: vec![6; 32],
        }]);
        a.credentials.push(authorization::Authority {
            id: vec![43],
            version: 2,
            revoked: false,
            scope: CredentialScope::Instances(vec![Instance {
                vault: vec![2; 16],
                nonce: vec![6; 32],
            }]),
        });
        store::save(db, "authorities", &a)
    })
    .unwrap();
    r.compromised.push(CredentialRevocation {
        credential: vec![43],
        version: 2,
    });
    r.sources.pop();
    r.targets.pop();
    let pre = grant(&env, &key, &pre, GrantPurpose::IncidentPrepare(r), 77);
    signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap();
    env.transaction(|db| {
        assert!(authorization::authority(db, &[42])?.revoked);
        assert!(authorization::authority(db, &[43])?.revoked);
        assert_eq!(store::header(db, &[3; 16])?.state, VaultState::Active);
        let mut j = store::incident::status(db)?.unwrap();
        assert_eq!(j.targets.len(), 2);
        j.compromised = (0..9)
            .map(|n| CredentialRevocation {
                credential: vec![n; 1024],
                version: i64::MAX as u64,
            })
            .collect();
        assert!(serde_json::to_vec(&j).unwrap().len() < 65536);
        store::save(db, "transition", &j)?;
        j.compromised[0].credential = vec![255; 65536];
        assert_eq!(store::save(db, "transition", &j), Err(Error::QuotaExceeded));
        Ok(())
    })
    .unwrap();
}
#[test]
fn incident_pending_random_upgrade_requires_fresh_proof_and_retains_same_attempt() {
    let (env, key, pre, r) = fixture(1);
    signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap();
    env.upgrade_random.set(true);
    let result = signed_call(
        &env,
        &key,
        &pre,
        1,
        MutationOperation::IncidentAllocate {
            vault: vec![1; 16],
            attempt: vec![71; 16],
        },
    )
    .unwrap();
    assert!(matches!(result, MutationResult::Handle(_)));
    let j = incident::status(&env).unwrap().unwrap();
    assert!(j.targets[0].target.is_none());
    assert_eq!(j.targets[0].attempt, vec![71; 16]);
    env.time.set(122);
    let fresh = grant(&env, &key, &pre, GrantPurpose::IncidentPrepare(r), 79);
    signed_call(
        &env,
        &key,
        &fresh,
        0,
        MutationOperation::IncidentAllocate {
            vault: vec![1; 16],
            attempt: vec![71; 16],
        },
    )
    .unwrap();
    assert!(
        incident::status(&env).unwrap().unwrap().targets[0]
            .target
            .is_some()
    );
}

#[test]
fn incident_maximum_selected_ids_fit_prepaid_record_and_small_receipts() {
    let (env, key, pre, mut r) = fixture(3);
    r.compromised = (0..9)
        .map(|i| {
            let mut id = vec![255; 1024];
            id[0] = i;
            CredentialRevocation {
                credential: id,
                version: i as u64 + 10,
            }
        })
        .collect();
    env.transaction(|db| {
        let mut all = authorization::authorities(db)?;
        all.credentials.truncate(1);
        for c in &r.compromised {
            all.credentials.push(authorization::Authority {
                id: c.credential.clone(),
                version: c.version,
                revoked: false,
                scope: CredentialScope::Global,
            });
        }
        store::save(db, "authorities", &all)
    })
    .unwrap();
    let pre = grant(&env, &key, &pre, GrantPurpose::IncidentPrepare(r), 88);
    let result = signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap();
    assert!(matches!(result, MutationResult::Unit));
    env.transaction(|db| {
        let j = store::incident::status(db)?.unwrap();
        assert!(serde_json::to_vec(&j).unwrap().len() < 65536);
        let g = grants::load(db, &pre.id)?;
        assert!(serde_json::to_vec(&g).unwrap().len() < 65536);
        assert_eq!(
            authorization::authorities(db)?
                .credentials
                .iter()
                .filter(|a| !a.revoked)
                .count(),
            1
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn incident_scoped_remaining_authority_covers_sources_without_becoming_global() {
    let (env, key, pre, r) = fixture(3);
    let scope = CredentialScope::Instances(
        r.sources
            .iter()
            .map(|g| Instance {
                vault: g.vault.clone(),
                nonce: g.nonce.clone(),
            })
            .collect(),
    );
    env.transaction(|db| {
        let mut a = authorization::authorities(db)?;
        a.credentials[0].scope = scope.clone();
        store::save(db, "authorities", &a)
    })
    .unwrap();
    let j = allocate(&env, &key, &pre, &r);
    let post = post(&env, &key, &pre, &j);
    env.transaction(|db| {
        grants::current(db, &env, &grants::load(db, &post.id)?)?;
        let a = authorization::authority(db, &[41])?;
        assert_eq!(a.scope, scope);
        assert!(!authorization::covers(
            &a.scope,
            j.targets[0].target.as_ref().unwrap()
        ));
        incident::role(
            db,
            &env,
            &IncidentDerive {
                job: j.job.clone(),
                attempt: j.targets[0].attempt.clone(),
                role: IncidentRole::Target,
                generation: j.targets[0].target.clone().unwrap(),
                transport: transport(),
            },
        )?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn incident_legacy_key_pool_gc_commits_before_failed_admission() {
    let (env, key, pre, _) = fixture(1);
    env.transaction(|db|{
        db.execute_batch("DROP TRIGGER key_pool_count;").unwrap();
        for n in 0..700 {db.execute("INSERT INTO key_flights(owner,token,day,reserved,actual,created,settled,phase,in_flight) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,0,0,0,0,1,'cancelled_done',0)",params![n as i64+100]).unwrap();}
        db.execute_batch(store::KEY_CAPACITY_SCHEMA).unwrap();Ok(())
    }).unwrap();
    env.time.set(DAY * 2);
    let pre = grant(&env, &key, &pre, pre.purpose.clone(), 93);
    assert_eq!(
        signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap_err(),
        Error::QuotaExceeded
    );
    env.transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM key_flights", params![], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 572);
        assert!(!authorization::authority(db, &[42])?.revoked);
        assert_eq!(grants::load(db, &pre.id)?.info.next_counter, 0);
        assert_eq!(env.derive_calls.get(), 0);
        Ok(())
    })
    .unwrap();
    // A later signed attempt finishes the bounded cleanup, then performs the atomic freeze.
    signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap();
    assert!(incident::status(&env).unwrap().is_some());
}

#[test]
fn ordinary_derive_gc_progress_retains_protected_rows_and_only_consumes_operation_receipt() {
    let (env, key, base) = signed_fixture(GrantPurpose::Normal);
    env.transaction(|db|{
        db.execute_batch("DROP TRIGGER key_pool_count;").unwrap();
        for n in 0..700 {db.execute("INSERT INTO key_flights(owner,token,day,reserved,actual,created,settled,phase,in_flight) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,0,0,0,0,1,'cancelled_done',0)",params![n as i64+100]).unwrap();}
        db.execute("INSERT INTO key_flights(owner,token,day,reserved,created,phase,in_flight) VALUES(?1,1,0,30000000000,0,'cancelled',1)",params![vec![99u8]]).unwrap();
        db.execute_batch(store::KEY_CAPACITY_SCHEMA).unwrap();Ok(())
    }).unwrap();
    env.time.set(DAY * 2);
    let g = grant(&env, &key, &base, GrantPurpose::Normal, 94);
    let request = Derive {
        vault: vec![1; 16],
        attempt: None,
        epoch: 0,
        transport: transport(),
        assertion: None,
    };
    signed_call(
        &env,
        &key,
        &g,
        0,
        MutationOperation::Derive(request.clone()),
    )
    .unwrap();
    env.transaction(|db| {
        let current = grants::load(db, &g.id)?;
        assert_eq!(current.info.next_counter, 1); // One accepted async handle; GC adds no counter.
        assert!(matches!(
            current.work.unwrap().result,
            Some(Err(Error::QuotaExceeded))
        ));
        let count: i64 = db
            .query_row("SELECT count(*) FROM key_flights", params![], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 573);
        assert_eq!(env.derive_calls.get(), 0);
        Ok(())
    })
    .unwrap();
    signed_call(&env, &key, &g, 1, MutationOperation::Derive(request)).unwrap();
    assert_eq!(env.derive_calls.get(), 1);
    env.transaction(|db| {
        let protected: i64 = db
            .query_row(
                "SELECT in_flight FROM key_flights WHERE owner=?1",
                params![vec![99u8]],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(protected, 1);
        Ok(())
    })
    .unwrap();
}

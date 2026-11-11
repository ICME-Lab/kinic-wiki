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

fn cleanup_grant_for(
    env: &TestEnvironment,
    key: &ed25519_dalek::SigningKey,
    base: &GrantInfo,
    targets: Vec<Generation>,
    job: u8,
) -> GrantInfo {
    let info = grant(
        env,
        key,
        base,
        GrantPurpose::Cleanup { job: vec![job; 16] },
        job,
    );
    env.transaction(|db| {
        let mut g = grants::load(db, &info.id)?;
        g.info.generations = targets;
        let mut n = cleanup::namespace(db)?;
        n.grant = Some(g.clone());
        cleanup::save(db, &n)?;
        Ok(g.info)
    })
    .unwrap()
}
#[test]
fn incident_subset_purge_preserves_remaining_job() {
    let (env, key, pre, r) = fixture(3);
    allocate(&env, &key, &pre, &r);
    env.transaction(|db| { db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,2,0,?3,'[]',1,4096)",params![vec![1u8;16],vec![9u8;16],Vec::<u8>::new()]).unwrap(); Ok(()) }).unwrap();
    let cg = cleanup_grant_for(&env, &key, &pre, vec![r.sources[0].clone()], 90);
    env.funded.set(false);
    let result = signed_call(
        &env,
        &key,
        &cg,
        0,
        MutationOperation::Cleanup {
            job: vec![90; 16],
            cursor: 0,
            action: CleanupAction::Purge,
        },
    )
    .unwrap();
    assert!(matches!(
        result,
        MutationResult::Cleanup(CleanupProgress {
            complete: false,
            ..
        })
    ));
    let passkey = install_test_passkey(&env);
    env.time.set(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    env.db
        .borrow()
        .execute(
            "INSERT INTO global_settings VALUES('generation','1')",
            params![],
        )
        .unwrap();
    assert!(
        signed_call(
            &env,
            &key,
            &cg,
            1,
            MutationOperation::Cleanup {
                job: vec![90; 16],
                cursor: 1,
                action: CleanupAction::Purge
            }
        )
        .is_err()
    );
    let req = GrantRequest {
        operation: vec![88; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        purpose: cg.purpose.clone(),
        generations: cg.generations.clone(),
    };
    let ch = cleanup::begin(&env, req.clone()).unwrap();
    let cg = cleanup::finish(&env, req.operation, passkey_assertion(&env, &passkey, &ch)).unwrap();
    let op = MutationOperation::Cleanup {
        job: vec![90; 16],
        cursor: 1,
        action: CleanupAction::Purge,
    };
    assert!(matches!(
        signed_call(&env, &key, &cg, 0, op.clone()).unwrap(),
        MutationResult::Cleanup(CleanupProgress { complete: true, .. })
    ));
    assert!(signed_call(&env, &key, &cg, 0, op).is_ok());
    env.transaction(|db| {
        let j = incident::load(db, &env)?;
        assert_eq!(j.targets.len(), 3);
        assert!(!j.complete);
        assert!(store::header(db, &[1; 16]).is_err());
        for v in [2, 3] {
            assert!(store::incident::pinned(db, &[v; 16])?);
            assert_eq!(
                store::header(db, &[v; 16])?.state,
                VaultState::IncidentRequired
            );
        }
        Ok(())
    })
    .unwrap();
    env.funded.set(true);
    let mut remaining = r.clone();
    remaining.sources.remove(0);
    remaining.targets.remove(0);
    let req = GrantRequest {
        operation: vec![87; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        purpose: GrantPurpose::IncidentPrepare(remaining.clone()),
        generations: remaining.sources.clone(),
    };
    let ch = futures::executor::block_on(ceremonies::begin(&env, req.clone())).unwrap();
    let fresh =
        ceremonies::finish(&env, req.operation, passkey_assertion(&env, &passkey, &ch)).unwrap();
    assert!(
        signed_call(
            &env,
            &key,
            &fresh,
            0,
            MutationOperation::IncidentAllocate {
                vault: vec![1; 16],
                attempt: vec![71; 16]
            }
        )
        .is_err()
    );
    signed_call(
        &env,
        &key,
        &fresh,
        0,
        MutationOperation::IncidentAllocate {
            vault: vec![2; 16],
            attempt: vec![72; 16],
        },
    )
    .unwrap();
    env.transaction(|db| {
        let j = incident::load(db, &env)?;
        incident::validate(
            db,
            &env,
            &[41],
            &GrantPurpose::Incident {
                job: j.job.clone(),
                vector_digest: j.vector_digest.clone(),
            },
            &remaining.sources,
        )?;
        assert!(
            incident::role(
                db,
                &env,
                &IncidentDerive {
                    job: j.job.clone(),
                    attempt: r.targets[0].attempt.clone(),
                    role: IncidentRole::Source,
                    generation: r.sources[0].clone(),
                    transport: transport()
                }
            )
            .is_err()
        );
        assert!(store::incident::snapshot(db, &[1; 16]).is_err());
        assert!(incident::reset(db, &env, &[1; 16], &r.targets[0].attempt, &[99; 16]).is_err());
        Ok(())
    })
    .unwrap();
    let unrelated = cleanup_grant_for(&env, &key, &fresh, vec![r.sources[1].clone()], 89);
    env.transaction(|db| {
        let mut a = authorization::authorities(db)?;
        a.credentials[0].scope = CredentialScope::Instances(vec![Instance {
            vault: vec![1; 16],
            nonce: r.sources[0].nonce.clone(),
        }]);
        store::save(db, "authorities", &a)
    })
    .unwrap();
    assert!(
        signed_call(
            &env,
            &key,
            &unrelated,
            0,
            MutationOperation::Cleanup {
                job: vec![89; 16],
                cursor: 0,
                action: CleanupAction::Purge
            }
        )
        .is_err()
    );
    assert!(env.transaction(|db| store::header(db, &[2; 16])).is_ok());
}
#[test]
fn incident_paid_cancel_discards_allocated_preparation() {
    let (env, key, pre, r) = fixture(1);
    let j = allocate(&env, &key, &pre, &r);
    let post = post(&env, &key, &pre, &j);
    signed_call(&env, &key, &post, 0, MutationOperation::IncidentCancel).unwrap();
    let j = incident::status(&env).unwrap().unwrap();
    assert!(j.targets[0].target.is_none());
    assert_ne!(j.targets[0].attempt, r.targets[0].attempt);
    assert_eq!(format!("{:?}", j.targets[0].phase), "Cancelled");
    assert!(!j.complete);
}

#[test]
fn incident_zero_balance_cancel_batches_renew_upgrade_and_fresh_paid_restart() {
    let (env, key, pre, r) = fixture(3);
    let mut j = allocate(&env, &key, &pre, &r);
    env.transaction(|db| {
        // Seed future inactive bytes solely in the native fixture to prove bounded discard.
        for i in 0..101 { db.execute("INSERT INTO wrapper_slots VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,0,?4,?4,?4)",params![vec![1u8;16],vec![9u8;16],i,vec![0u8;32]]).unwrap(); }
        for (i,t) in j.targets.iter_mut().enumerate() { t.phase=if i==0 {PreparationPhase::KitConfirmed} else {PreparationPhase::EnvelopesStaged};t.normal=Some(Envelope{version:2,nonce:vec![1;12],ciphertext:vec![2;48]}); t.recovery=t.normal.clone();t.recovery_verifier=vec![4;32];t.kit_ack=Some(vec![5;32]); }
        incident::save(db,&mut j)
    }).unwrap();
    let action = CleanupAction::CancelIncident {
        incident: j.job.clone(),
        vector_digest: j.vector_digest.clone(),
    };
    let cg = cleanup_grant_for(&env, &key, &pre, r.sources.clone(), 90);
    env.funded.set(false);
    for bad in [
        CleanupAction::CancelIncident {
            incident: vec![99; 16],
            vector_digest: j.vector_digest.clone(),
        },
        CleanupAction::CancelIncident {
            incident: j.job.clone(),
            vector_digest: vec![99; 32],
        },
    ] {
        assert!(
            signed_call(
                &env,
                &key,
                &cg,
                0,
                MutationOperation::Cleanup {
                    job: vec![90; 16],
                    cursor: 0,
                    action: bad
                }
            )
            .is_err()
        );
    }
    let op = MutationOperation::Cleanup {
        job: vec![90; 16],
        cursor: 0,
        action: action.clone(),
    };
    let first = signed_call(&env, &key, &cg, 0, op.clone()).unwrap();
    assert!(matches!(
        first,
        MutationResult::Cleanup(CleanupProgress {
            complete: false,
            ..
        })
    ));
    assert!(signed_call(&env, &key, &cg, 0, op).is_ok());
    let cancelled = incident::status(&env).unwrap().unwrap();
    assert!(cancelled.targets.iter().all(|t| t.target.is_none()
        && t.normal.is_none()
        && t.recovery.is_none()
        && t.kit_ack.is_none()));
    env.transaction(|db| {
        let count: i64 = db
            .query_row("SELECT count(*) FROM wrapper_slots", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(count, 1);
        assert!(grants::current(db, &env, &grants::load(db, &pre.id)?).is_err());
        Ok(())
    })
    .unwrap();
    let passkey = install_test_passkey(&env);
    env.time.set(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    env.time.set(env.now() + 400);
    env.db
        .borrow()
        .execute(
            "INSERT INTO global_settings VALUES('generation','1')",
            params![],
        )
        .unwrap();
    let req = GrantRequest {
        operation: vec![88; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        purpose: cg.purpose.clone(),
        generations: r.sources.clone(),
    };
    let ch = cleanup::begin(&env, req.clone()).unwrap();
    let cg = cleanup::finish(&env, req.operation, passkey_assertion(&env, &passkey, &ch)).unwrap();
    for cursor in 1..=3 {
        let result = signed_call(
            &env,
            &key,
            &cg,
            cursor - 1,
            MutationOperation::Cleanup {
                job: vec![90; 16],
                cursor,
                action: action.clone(),
            },
        )
        .unwrap();
        assert!(
            matches!(result,MutationResult::Cleanup(CleanupProgress{complete,..}) if complete==(cursor==3))
        );
    }
    let done = incident::status(&env).unwrap().unwrap();
    assert!(
        done.targets
            .iter()
            .all(|t| t.phase == PreparationPhase::Cancelled)
    );
    let mut resumed = r.clone();
    for (p, t) in resumed.targets.iter_mut().zip(&done.targets) {
        p.attempt = t.attempt.clone();
    }
    let req = GrantRequest {
        operation: vec![87; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        purpose: GrantPurpose::IncidentPrepare(resumed.clone()),
        generations: r.sources.clone(),
    };
    assert!(futures::executor::block_on(ceremonies::begin(&env, req.clone())).is_err());
    env.funded.set(true);
    let ch = futures::executor::block_on(ceremonies::begin(&env, req.clone())).unwrap();
    let fresh =
        ceremonies::finish(&env, req.operation, passkey_assertion(&env, &passkey, &ch)).unwrap();
    assert!(
        signed_call(
            &env,
            &key,
            &fresh,
            0,
            MutationOperation::IncidentAllocate {
                vault: vec![1; 16],
                attempt: done.targets[0].attempt.clone()
            }
        )
        .is_err()
    );
    signed_call(
        &env,
        &key,
        &fresh,
        0,
        MutationOperation::IncidentReset {
            vault: vec![1; 16],
            attempt: done.targets[0].attempt.clone(),
            next_attempt: vec![99; 16],
        },
    )
    .unwrap();
    let status = incident::status(&env).unwrap().unwrap();
    assert!(status.cancel_digest.is_none());
    assert!(status.targets[0].next_epoch > j.targets[0].target.as_ref().unwrap().epoch);
    env.transaction(|db| {
        for v in 1..=3 {
            assert!(store::incident::pinned(db, &[v; 16])?);
            assert_eq!(
                store::header(db, &[v; 16])?.state,
                VaultState::IncidentRequired
            );
        }
        assert!(authorization::authority(db, &[42])?.revoked);
        Ok(())
    })
    .unwrap();
    assert_eq!(env.derive_calls.get(), 0);
}
#[test]
fn incident_cancel_fences_nonce_and_both_key_awaits_with_exact_settlement() {
    for at in 0..3 {
        let (env, key, pre, r) = fixture(1);
        let j = if at == 0 {
            signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap();
            incident::status(&env).unwrap().unwrap()
        } else {
            allocate(&env, &key, &pre, &r)
        };
        let cg = cleanup_grant_for(&env, &key, &pre, r.sources.clone(), 90);
        let action = CleanupAction::CancelIncident {
            incident: j.job.clone(),
            vector_digest: j.vector_digest.clone(),
        };
        let hook_key = key.clone();
        let cancel_action = action.clone();
        let cancel_grant = cg.clone();
        let hook: TestHook = Box::new(move |env| {
            env.funded.set(false);
            env.cleanup_settled.set(false);
            let result = signed_call(
                env,
                &hook_key,
                &cg,
                0,
                MutationOperation::Cleanup {
                    job: vec![90; 16],
                    cursor: 0,
                    action,
                },
            )
            .unwrap();
            assert!(matches!(
                result,
                MutationResult::Cleanup(CleanupProgress {
                    complete: false,
                    ..
                })
            ));
        });
        if at == 0 {
            *env.random_hook.borrow_mut() = Some(hook);
            signed_call(
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
        } else {
            let pg = post(&env, &key, &pre, &j);
            if at == 1 {
                *env.public_hook.borrow_mut() = Some(hook);
            } else {
                *env.derive_hook.borrow_mut() = Some(hook);
            }
            signed_call(
                &env,
                &key,
                &pg,
                0,
                MutationOperation::IncidentDerive(IncidentDerive {
                    job: j.job.clone(),
                    attempt: vec![71; 16],
                    role: IncidentRole::Target,
                    generation: j.targets[0].target.clone().unwrap(),
                    transport: transport(),
                }),
            )
            .unwrap();
            assert_eq!(
                env.settled.get(),
                Some(if at == 2 { 30_000_000_000 } else { 0 })
            );
        }
        env.transaction(|db| {
            let operation_grant = if at == 0 {
                pre.id.clone()
            } else {
                vec![74; 32]
            };
            assert!(
                grants::load(db, &operation_grant)?
                    .work
                    .unwrap()
                    .result
                    .unwrap()
                    .is_err()
            );
            assert!(!cleanup::namespace(db)?.job.unwrap().complete);
            Ok(())
        })
        .unwrap();
        env.cleanup_settled.set(true);
        assert!(matches!(
            signed_call(
                &env,
                &key,
                &cancel_grant,
                1,
                MutationOperation::Cleanup {
                    job: vec![90; 16],
                    cursor: 1,
                    action: cancel_action
                }
            )
            .unwrap(),
            MutationResult::Cleanup(CleanupProgress { complete: true, .. })
        ));
        let end = incident::status(&env).unwrap().unwrap();
        assert_eq!(end.targets[0].phase, PreparationPhase::Cancelled);
        assert!(end.targets[0].target.is_none());
        assert!(signed_call(&env, &key, &pre, 2, MutationOperation::IncidentStart).is_err());
    }
}

#[test]
fn incident_purge_can_include_explicitly_authorized_unaffected_source() {
    let (env, key, pre, mut r) = fixture(3);
    r.sources.pop();
    r.targets.pop();
    env.transaction(|db| {
        let mut a = authorization::authorities(db)?;
        a.credentials[1].scope = CredentialScope::Instances(
            r.sources
                .iter()
                .map(|g| Instance {
                    vault: g.vault.clone(),
                    nonce: g.nonce.clone(),
                })
                .collect(),
        );
        store::save(db, "authorities", &a)
    })
    .unwrap();
    let pre = grant(
        &env,
        &key,
        &pre,
        GrantPurpose::IncidentPrepare(r.clone()),
        80,
    );
    allocate(&env, &key, &pre, &r);
    let all = env
        .transaction(|db| {
            Ok(store::list(db)?
                .into_iter()
                .map(|h| h.generation.unwrap())
                .collect())
        })
        .unwrap();
    let cg = cleanup_grant_for(&env, &key, &pre, all, 90);
    env.funded.set(false);
    assert!(matches!(
        signed_call(
            &env,
            &key,
            &cg,
            0,
            MutationOperation::Cleanup {
                job: vec![90; 16],
                cursor: 0,
                action: CleanupAction::Purge
            }
        )
        .unwrap(),
        MutationResult::Cleanup(CleanupProgress { complete: true, .. })
    ));
    let j = incident::status(&env).unwrap().unwrap();
    assert!(j.complete);
    assert_eq!(j.targets.len(), 2);
    assert!(
        j.targets
            .iter()
            .all(|t| t.phase == PreparationPhase::Purged)
    );
    assert!(env.transaction(store::list).unwrap().is_empty());
}

#[test]
fn incident_existing_v2_vectors_and_missing_optional_cancel_state_survive_upgrade() {
    let (env, key, pre, r) = fixture(1);
    let j = allocate(&env, &key, &pre, &r);
    let mut bytes = b"kinic-vault/incident-vector/v2\0".to_vec();
    sized(&mut bytes, &j.namespace);
    sized(&mut bytes, &j.job);
    for t in &j.targets {
        sized(
            &mut bytes,
            &t.source.generation.as_ref().unwrap().bytes().unwrap(),
        );
        sized(&mut bytes, &t.attempt);
        bytes.push(1);
        sized(&mut bytes, &t.target.as_ref().unwrap().bytes().unwrap());
    }
    assert_eq!(j.vector_digest, Sha256::digest(bytes).to_vec());
    env.transaction(|db| {
        let mut old = serde_json::to_value(&j).unwrap();
        old.as_object_mut().unwrap().remove("cancel_digest");
        store::save(db, "transition", &old)?;
        let mut loaded = incident::load(db, &env)?;
        assert!(loaded.cancel_digest.is_none());
        incident::save(db, &mut loaded)?;
        assert_eq!(loaded.vector_digest, j.vector_digest);
        Ok(())
    })
    .unwrap();
}

#[test]
fn incident_pending_cancel_settlement_blocks_paid_restart_without_stranding_cleanup() {
    for restart_with_cancel in [false, true] {
        let (env, key, pre, r) = fixture(1);
        let j = allocate(&env, &key, &pre, &r);
        let passkey = install_test_passkey(&env);
        env.time.set(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        );
        let pg = post(&env, &key, &pre, &j);
        let cg = cleanup_grant_for(&env, &key, &pre, r.sources.clone(), 90);
        let action = CleanupAction::CancelIncident {
            incident: j.job.clone(),
            vector_digest: j.vector_digest.clone(),
        };
        let first = MutationOperation::Cleanup {
            job: vec![90; 16],
            cursor: 0,
            action: action.clone(),
        };
        let hook_key = key.clone();
        let hook_passkey = passkey.clone();
        let hook_request = r.clone();
        let hook_grant = cg.clone();
        *env.derive_hook.borrow_mut() = Some(Box::new(move |env| {
            env.cleanup_settled.set(false);
            env.funded.set(false);
            assert!(matches!(
                signed_call(env, &hook_key, &hook_grant, 0, first.clone()).unwrap(),
                MutationResult::Cleanup(CleanupProgress {
                    complete: false,
                    ..
                })
            ));
            assert!(signed_call(env, &hook_key, &hook_grant, 0, first).is_ok());
            let cancelled = incident::status(env).unwrap().unwrap();
            assert_eq!(cancelled.targets[0].phase, PreparationPhase::Cancelled);
            env.funded.set(true);
            let mut preparation = hook_request;
            preparation.targets[0].attempt = cancelled.targets[0].attempt.clone();
            let request = GrantRequest {
                operation: vec![88; 16],
                public_key: hook_key.verifying_key().to_bytes().to_vec(),
                credential: vec![41],
                purpose: GrantPurpose::IncidentPrepare(preparation.clone()),
                generations: preparation.sources.clone(),
            };
            let challenge =
                futures::executor::block_on(ceremonies::begin(env, request.clone())).unwrap();
            let fresh = ceremonies::finish(
                env,
                request.operation,
                passkey_assertion(env, &hook_passkey, &challenge),
            )
            .unwrap();
            let op = if restart_with_cancel {
                MutationOperation::IncidentCancel
            } else {
                MutationOperation::IncidentReset {
                    vault: vec![1; 16],
                    attempt: cancelled.targets[0].attempt.clone(),
                    next_attempt: vec![99; 16],
                }
            };
            assert!(matches!(
                signed_call(env, &hook_key, &fresh, 0, op),
                Err(Error::Busy)
            ));
            let retained = incident::status(env).unwrap().unwrap();
            assert_eq!(retained.cancel_digest, cancelled.cancel_digest);
            assert_eq!(retained.vector_digest, cancelled.vector_digest);
            assert_eq!(retained.targets[0].attempt, cancelled.targets[0].attempt);
        }));
        signed_call(
            &env,
            &key,
            &pg,
            0,
            MutationOperation::IncidentDerive(IncidentDerive {
                job: j.job,
                attempt: vec![71; 16],
                role: IncidentRole::Target,
                generation: j.targets[0].target.clone().unwrap(),
                transport: transport(),
            }),
        )
        .unwrap();
        assert_eq!(env.settled.get(), Some(30_000_000_000));
        env.transaction(|db| {
            let live: i64 = db
                .query_row(
                    "SELECT count(*) FROM key_flights WHERE in_flight=1",
                    params![],
                    |r| kinic_sqlite_compat::row_get(r, 0),
                )
                .unwrap();
            assert_eq!(live, 0);
            assert!(!cleanup::namespace(db)?.job.unwrap().complete);
            Ok(())
        })
        .unwrap();
        env.cleanup_settled.set(true);
        env.funded.set(false);
        env.db
            .borrow()
            .execute(
                "INSERT INTO global_settings VALUES('generation','1')",
                params![],
            )
            .unwrap();
        let continuation = MutationOperation::Cleanup {
            job: vec![90; 16],
            cursor: 1,
            action,
        };
        assert!(signed_call(&env, &key, &cg, 1, continuation.clone()).is_err());
        let request = GrantRequest {
            operation: vec![87; 16],
            public_key: key.verifying_key().to_bytes().to_vec(),
            credential: vec![41],
            purpose: cg.purpose.clone(),
            generations: r.sources.clone(),
        };
        let challenge = cleanup::begin(&env, request.clone()).unwrap();
        let renewed = cleanup::finish(
            &env,
            request.operation,
            passkey_assertion(&env, &passkey, &challenge),
        )
        .unwrap();
        assert!(matches!(
            signed_call(&env, &key, &renewed, 0, continuation.clone()).unwrap(),
            MutationResult::Cleanup(CleanupProgress { complete: true, .. })
        ));
        assert!(signed_call(&env, &key, &renewed, 0, continuation).is_ok());
        let next = GrantRequest {
            operation: vec![86; 16],
            public_key: key.verifying_key().to_bytes().to_vec(),
            credential: vec![41],
            purpose: GrantPurpose::Cleanup { job: vec![91; 16] },
            generations: r.sources.clone(),
        };
        let challenge = cleanup::begin(&env, next.clone()).unwrap();
        let next = cleanup::finish(
            &env,
            next.operation,
            passkey_assertion(&env, &passkey, &challenge),
        )
        .unwrap();
        assert!(matches!(
            signed_call(
                &env,
                &key,
                &next,
                0,
                MutationOperation::Cleanup {
                    job: vec![91; 16],
                    cursor: 0,
                    action: CleanupAction::Expired
                }
            )
            .unwrap(),
            MutationResult::Cleanup(CleanupProgress { complete: true, .. })
        ));
        env.transaction(|db| {
            let status = incident::load(db, &env)?;
            incident::reset(db, &env, &[1; 16], &status.targets[0].attempt, &[99; 16])?;
            assert!(store::incident::pinned(db, &[1; 16])?);
            assert_eq!(
                store::header(db, &[1; 16])?.state,
                VaultState::IncidentRequired
            );
            Ok(())
        })
        .unwrap();
    }
}

#[test]
fn incident_cutover_requires_all_verified_targets_and_fresh_digest() {
    let (env, key, pre, r) = fixture(3);
    let j = allocate(&env, &key, &pre, &r);
    assert!(
        env.transaction(|db| incident_cutover::digest(db, &env))
            .is_err()
    );
    let post = post(&env, &key, &pre, &j);
    assert!(
        signed_call(
            &env,
            &key,
            &post,
            0,
            MutationOperation::IncidentCutover {
                digest: vec![0; 32]
            }
        )
        .is_err()
    );
    env.transaction(|db| {
        for t in &j.targets {
            assert_eq!(
                store::header(db, &t.source.id)?.state,
                VaultState::IncidentRequired
            );
        }
        Ok(())
    })
    .unwrap();
}

fn seed_incident_history(env: &TestEnvironment, vault: u8, count: u64) {
    env.transaction(|db| {
        for n in 1..=count {
            let object = (n as u128).to_be_bytes().to_vec();
            let deleted = n == count;
            let manifest = if deleted { vec![] } else { test_manifest() };
            let hashes = if deleted { "[]".to_string() } else { serde_json::to_string(&vec![vec![7u8;32]]).unwrap() };
            db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,?3,NULL,0,?4,?5,?6,8192)",params![vec![vault;16],object,n as i64,manifest,hashes,deleted as i64]).unwrap();
            if !deleted { db.execute("INSERT INTO revision_chunks VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,0,?3)",params![vec![vault;16],object,vec![7u8;16]]).unwrap(); }
        }
        let mut h = store::header(db,&[vault;16])?; h.sequence = count; store::put_header(db,&h)
    }).unwrap();
}
fn confirm_target(env: &TestEnvironment, vault: &[u8], attempt: &[u8]) {
    env.transaction(|db| {
        let verifier = ed25519_dalek::SigningKey::from_bytes(&[45; 32])
            .verifying_key()
            .to_bytes();
        let j = incident::stage(
            db,
            env,
            vault,
            attempt,
            &Envelope {
                version: 2,
                nonce: vec![1; 12],
                ciphertext: vec![2; 48],
            },
            &Envelope {
                version: 2,
                nonce: vec![3; 12],
                ciphertext: vec![4; 48],
            },
            &verifier,
        )?;
        incident::confirm(
            db,
            env,
            vault,
            attempt,
            &j.targets
                .iter()
                .find(|t| t.source.id == vault)
                .unwrap()
                .envelope_digest,
        )?;
        Ok(())
    })
    .unwrap();
}
fn wrappers(page: &ExportPage, nonce: u8) -> Vec<IncidentWrapper> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
    page.entries
        .iter()
        .map(|r| {
            let wrapper = if r.deleted {
                vec![]
            } else {
                let mut w = store::format::parse(&r.manifest, r.chunk_hashes.len())
                    .unwrap()
                    .dek;
                w.nonce = B64.encode([nonce; 12]);
                w.version = 2;
                serde_json::to_vec(&w).unwrap()
            };
            IncidentWrapper {
                object: r.object.clone(),
                revision: r.revision,
                sequence: r.sequence,
                source_digest: Sha256::digest(&r.manifest).to_vec(),
                wrapper,
            }
        })
        .collect()
}
fn prepare_and_ack(
    env: &TestEnvironment,
    vault: &[u8],
    attempt: &[u8],
    export: u8,
) -> IncidentRead {
    env.transaction(|db| {
        incident_export::prepare(db, env, vault, attempt, &[export; 16])?;
        let j = incident::load(db, env)?;
        let t = j.targets.iter().find(|t| t.source.id == vault).unwrap();
        let e = t.staged_export.as_ref().unwrap();
        incident_export::confirm(
            db,
            env,
            vault,
            attempt,
            &IncidentBackupAck {
                descriptor_digest: e.descriptor_digest.clone(),
                commitment: e.commitment.clone(),
                archive_hash: vec![9; 32],
                archive_length: 1000,
                recovery_verifier: t.recovery_verifier.clone(),
                sequence: e.export.sequence,
            },
        )?;
        Ok(IncidentRead {
            descriptor_digest: e.descriptor_digest.clone(),
            job: j.job,
            vault: vault.to_vec(),
            attempt: attempt.to_vec(),
            export: vec![export; 16],
        })
    })
    .unwrap()
}
#[test]
fn incident_ordered_coverage_staged_reads_and_atomic_fresh_uv_cutover() {
    let (env, key, pre, r) = fixture(3);
    env.time.set(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    let pre = grant(&env, &key, &pre, pre.purpose.clone(), 73);

    seed_incident_history(&env, 1, 101);
    // Restore the pre-grant generations (sequence is not a generation component).
    let j = allocate(&env, &key, &pre, &r);
    let g = post(&env, &key, &pre, &j);
    let source_export = env
        .transaction(|db| store::content::begin_export(db, &[1; 16], &[99; 16], env.now()))
        .unwrap();
    let read = IncidentRead {
        descriptor_digest: vec![0; 32],
        job: j.job.clone(),
        vault: vec![1; 16],
        attempt: vec![71; 16],
        export: vec![98; 16],
    };
    assert!(incident_export::descriptor(&env, read.clone()).is_err());
    let before = env.transaction(store::content::usage).unwrap();
    for t in &j.targets {
        confirm_target(&env, &t.source.id, &t.attempt);
    }
    let page =
        incident_wrapping::source_index(&env, j.job.clone(), vec![1; 16], vec![71; 16], 0).unwrap();
    assert_eq!(page.entries.len(), 100);
    let rows = wrappers(&page, 13);
    let mut wrong = rows.clone();
    wrong[0].source_digest[0] ^= 1;
    assert!(
        signed_call(
            &env,
            &key,
            &g,
            0,
            MutationOperation::IncidentWrap {
                vault: vec![1; 16],
                attempt: vec![71; 16],
                after: 0,
                rows: wrong
            }
        )
        .is_err()
    );
    let op = MutationOperation::IncidentWrap {
        vault: vec![1; 16],
        attempt: vec![71; 16],
        after: 0,
        rows: rows.clone(),
    };
    signed_call(&env, &key, &g, 0, op.clone()).unwrap();
    signed_call(&env, &key, &g, 0, op.clone()).unwrap();
    signed_call(&env, &key, &g, 1, op).unwrap(); // exact batch retry with a renewed counter
    assert!(
        env.transaction(|db| incident_export::prepare(db, &env, &[1; 16], &[71; 16], &[98; 16]))
            .is_err()
    );
    let last = incident_wrapping::source_index(&env, j.job.clone(), vec![1; 16], vec![71; 16], 100)
        .unwrap();
    assert!(last.entries[0].deleted);
    signed_call(
        &env,
        &key,
        &g,
        2,
        MutationOperation::IncidentWrap {
            vault: vec![1; 16],
            attempt: vec![71; 16],
            after: 100,
            rows: wrappers(&last, 13),
        },
    )
    .unwrap();
    let read = prepare_and_ack(&env, &[1; 16], &[71; 16], 98);
    let staged = incident_export::descriptor(&env, read.clone()).unwrap();
    assert_eq!(staged.export.record_count, 101);
    assert_eq!(staged.export.sequence, 102);
    assert_eq!(
        incident_export::chunk(&env, read.clone(), vec![0; 16], 1, 0).unwrap_err(),
        Error::NotFound
    );
    assert_eq!(
        incident_export::chunk(&env, read.clone(), 1u128.to_be_bytes().to_vec(), 1, 0).unwrap(),
        vec![7; 16]
    );
    assert!(incident_cutover::ready_digest(&env).is_err());
    for t in &j.targets[1..] {
        env.transaction(|db| incident_wrapping::wrap(db, &env, &t.source.id, &t.attempt, 0, &[]))
            .unwrap();
        prepare_and_ack(&env, &t.source.id, &t.attempt, t.source.id[0] + 90);
    }
    assert_eq!(env.transaction(store::content::usage).unwrap(), before);
    let digest = incident_cutover::ready_digest(&env).unwrap();
    let bound = env
        .transaction(|db| {
            let mut bound = grants::load(db, &pre.id)?;
            bound.info.purpose = GrantPurpose::IncidentCutover {
                job: j.job.clone(),
                digest: digest.clone(),
            };
            Ok(bound)
        })
        .unwrap();
    env.transaction(|db| {
        let original = incident::load(db, &env)?.targets[0]
            .backup_ack
            .clone()
            .unwrap();
        let mut changed = original.clone();
        changed.archive_hash[0] ^= 1;
        incident_export::confirm(db, &env, &[1; 16], &[71; 16], &changed)?;
        assert!(grants::current(db, &env, &bound).is_err());
        assert!(incident_cutover::publish(db, &env, &digest).is_err());
        incident_export::confirm(db, &env, &[1; 16], &[71; 16], &original)
    })
    .unwrap();

    assert!(
        signed_call(
            &env,
            &key,
            &g,
            3,
            MutationOperation::IncidentCutover {
                digest: digest.clone()
            }
        )
        .is_err()
    );
    // Real fresh final WebAuthn ceremony; scoped surviving authority is carried exactly.
    env.transaction(|db| {
        let mut a = authorization::authorities(db)?;
        a.credentials[0].scope = CredentialScope::Instances(
            r.sources
                .iter()
                .map(|g| Instance {
                    vault: g.vault.clone(),
                    nonce: g.nonce.clone(),
                })
                .collect(),
        );
        store::save(db, "authorities", &a)
    })
    .unwrap();
    let passkey = install_test_passkey(&env);
    env.time.set(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    let request = GrantRequest {
        operation: vec![97; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        purpose: GrantPurpose::IncidentCutover {
            job: j.job.clone(),
            digest: digest.clone(),
        },
        generations: r.sources.clone(),
    };
    let ch = futures::executor::block_on(ceremonies::begin(&env, request.clone())).unwrap();
    let final_grant = ceremonies::finish(
        &env,
        request.operation,
        passkey_assertion(&env, &passkey, &ch),
    )
    .unwrap();
    signed_call(
        &env,
        &key,
        &final_grant,
        0,
        MutationOperation::IncidentCutover {
            digest: digest.clone(),
        },
    )
    .unwrap();
    let completed = incident::status(&env).unwrap().unwrap();
    assert!(completed.complete);
    assert_eq!(completed.completed_digest, Some(digest));
    env.transaction(|db| {
        assert!(grants::load(db, &final_grant.id)?.revoked);
        assert!(grants::load(db, &g.id)?.revoked);
        grants::admission(db, env.now())
    })
    .unwrap();
    assert!(incident_export::index(&env, read, 0).is_err());
    env.transaction(|db| {
        assert!(store::content::export_index(db, &source_export.id, 0, env.now()).is_err());
        for t in &completed.targets {
            let h = store::header(db, &t.source.id)?;
            assert_eq!(h.state, VaultState::Active);
            assert_eq!(h.generation, t.target);
            assert_eq!(h.backup_sequence, Some(h.sequence));
            assert!(authorization::covers(
                &authorization::authority(db, &[41])?.scope,
                h.generation.as_ref().unwrap()
            ));
        }
        Ok(())
    })
    .unwrap();
    assert!(signed_call(&env, &key, &g, 3, MutationOperation::IncidentCancel).is_err());
}

#[test]
fn incident_reset_cancel_and_partial_purge_fence_staged_exports() {
    for mode in 0..3 {
        let (env, key, pre, r) = fixture(3);
        seed_incident_history(&env, 1, 102);
        let j = allocate(&env, &key, &pre, &r);
        for t in &j.targets {
            confirm_target(&env, &t.source.id, &t.attempt);
            let mut cursor = 0;
            loop {
                let page = incident_wrapping::source_index(
                    &env,
                    j.job.clone(),
                    t.source.id.clone(),
                    t.attempt.clone(),
                    cursor,
                )
                .unwrap();
                env.transaction(|db| {
                    incident_wrapping::wrap(
                        db,
                        &env,
                        &t.source.id,
                        &t.attempt,
                        cursor,
                        &wrappers(&page, 33),
                    )
                })
                .unwrap();
                if let Some(next) = page.next {
                    cursor = next;
                } else {
                    break;
                }
            }
        }
        let read = prepare_and_ack(&env, &[1; 16], &[71; 16], 98);
        assert!(incident_export::descriptor(&env, read.clone()).is_ok());
        env.transaction(|db| {
            match mode {
                0 => {
                    incident::reset(db, &env, &[1; 16], &[71; 16], &[91; 16])?;
                }
                1 => {
                    incident::cancel(db, &env, &j.job, &j.vector_digest, &r.sources)?;
                }
                _ => {
                    incident::purge(db, &[vec![1; 16]], false)?;
                }
            }
            Ok(())
        })
        .unwrap();
        assert!(incident_export::descriptor(&env, read.clone()).is_err());
        let pending = incident::status(&env).unwrap().unwrap();
        assert!(pending.targets[0].coverage.is_none());
        assert!(pending.targets[0].backup_ack.is_none());
        assert!(pending.targets[0].staged_export.is_none());
        assert!(incident_cutover::ready_digest(&env).is_err());
        env.transaction(|db| {
            assert_eq!(
                store::header(db, &[2; 16])?.state,
                VaultState::IncidentRequired
            );
            Ok(())
        })
        .unwrap();
        if mode == 2 {
            env.transaction(|db| {
                while !store::cleanup::purge_batch(db, &[vec![1; 16]])? {}
                incident::purge(db, &[vec![1; 16]], true)
            })
            .unwrap();
            for t in &j.targets[1..] {
                prepare_and_ack(&env, &t.source.id, &t.attempt, t.source.id[0] + 90);
            }
            let digest = incident_cutover::ready_digest(&env).unwrap();
            env.transaction(|db| incident_cutover::publish(db, &env, &digest))
                .unwrap();
            let done = incident::status(&env).unwrap().unwrap();
            assert_eq!(done.targets[0].phase, PreparationPhase::Purged);
            assert!(env.transaction(|db| store::header(db, &[1; 16])).is_err());
        }
    }
}

#[test]
fn incident_second_rotation_uses_published_effective_source_and_prepaid_slots() {
    let (env, key, pre, r) = fixture(1);
    seed_incident_history(&env, 1, 102);
    let j = allocate(&env, &key, &pre, &r);
    for round in 0..2 {
        let j = incident::status(&env).unwrap().unwrap();
        let t = &j.targets[0];
        confirm_target(&env, &t.source.id, &t.attempt);
        let before = env.transaction(store::content::global_usage).unwrap();
        let mut cursor = 0;
        loop {
            let page = incident_wrapping::source_index(
                &env,
                j.job.clone(),
                t.source.id.clone(),
                t.attempt.clone(),
                cursor,
            )
            .unwrap();
            if round == 1 && cursor == 0 {
                assert_ne!(
                    page.entries[0].manifest,
                    store::format::effective(&test_manifest(), 1, None).unwrap()
                );
                let mut bad = wrappers(&page, 44);
                bad[0].source_digest =
                    Sha256::digest(store::format::effective(&test_manifest(), 1, None).unwrap())
                        .to_vec();
                assert!(
                    env.transaction(|db| incident_wrapping::wrap(
                        db,
                        &env,
                        &t.source.id,
                        &t.attempt,
                        cursor,
                        &bad
                    ))
                    .is_err()
                );
            }
            env.transaction(|db| {
                incident_wrapping::wrap(
                    db,
                    &env,
                    &t.source.id,
                    &t.attempt,
                    cursor,
                    &wrappers(&page, 40 + round),
                )
            })
            .unwrap();
            if let Some(next) = page.next {
                cursor = next;
            } else {
                break;
            }
        }
        prepare_and_ack(&env, &t.source.id, &t.attempt, 98);
        assert_eq!(
            env.transaction(store::content::global_usage).unwrap(),
            before
        );
        let digest = incident_cutover::ready_digest(&env).unwrap();
        env.transaction(|db| incident_cutover::publish(db, &env, &digest))
            .unwrap();
        let h = env.transaction(|db| store::header(db, &[1; 16])).unwrap();
        assert_eq!(h.published_slot, Some(round));
        if round == 0 {
            // A new compromised registration is scoped to the current instance; no globals minted.
            env.transaction(|db| {
                let mut a = authorization::authorities(db)?;
                a.credentials.push(authorization::Authority {
                    id: vec![43],
                    version: 1,
                    revoked: false,
                    scope: CredentialScope::Instances(vec![Instance {
                        vault: h.id.clone(),
                        nonce: h.generation.as_ref().unwrap().nonce.clone(),
                    }]),
                });
                store::save(db, "authorities", &a)
            })
            .unwrap();
            let request = IncidentPreparation {
                job: vec![75; 16],
                namespace: j.namespace,
                compromised: vec![CredentialRevocation {
                    credential: vec![43],
                    version: 1,
                }],
                sources: vec![h.generation.clone().unwrap()],
                targets: vec![PendingCreation {
                    namespace: vec![51; 32],
                    vault: h.id.clone(),
                    attempt: vec![76; 16],
                }],
            };
            let pre2 = grant(
                &env,
                &key,
                &pre,
                GrantPurpose::IncidentPrepare(request.clone()),
                77,
            );
            allocate(&env, &key, &pre2, &request);
        }
    }
    // Old slot still exists, and the next rotation must reclaim it in bounded batches.
    let h = env.transaction(|db| store::header(db, &[1; 16])).unwrap();
    assert!(
        !env.transaction(|db| store::overlays::clear_inactive(db, &h, 0))
            .unwrap()
    );
    assert!(
        env.transaction(|db| store::overlays::clear_inactive(db, &h, 0))
            .unwrap()
    );
    assert!(
        env.transaction(|db| store::overlays::clear_inactive(db, &h, 0))
            .unwrap()
    );
    assert!(incident::status(&env).unwrap().unwrap().complete);
    assert_eq!(j.targets[0].source.id, vec![1; 16]);
}

#[test]
fn incident_prepared_expiry_and_source_saved_flag_preserve_freeze() {
    let (env, key, pre, r) = fixture(1);
    let j = allocate(&env, &key, &pre, &r);
    confirm_target(&env, &[1; 16], &[71; 16]);
    env.transaction(|db| incident_wrapping::wrap(db, &env, &[1; 16], &[71; 16], 0, &[]))
        .unwrap();
    let read = prepare_and_ack(&env, &[1; 16], &[71; 16], 98);
    let before = incident::status(&env).unwrap().unwrap();
    env.transaction(|db| {
        let e = store::content::begin_export(db, &[1; 16], &[97; 16], env.now())?;
        let h = store::content::finish_export(db, &e.id, true, env.now())?;
        assert_eq!(h.state, VaultState::IncidentRequired);
        assert!(store::incident::pinned(db, &[1; 16])?);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        serde_json::to_vec(&before).unwrap(),
        serde_json::to_vec(&incident::status(&env).unwrap().unwrap()).unwrap()
    );
    env.time.set(env.now() + DAY + 1);
    assert_eq!(
        incident_export::descriptor(&env, read.clone()).unwrap_err(),
        Error::Expired
    );
    assert!(incident_cutover::ready_digest(&env).is_ok()); // already-verified saved archive is durable evidence
    env.transaction(|db| incident_export::prepare(db, &env, &[1; 16], &[71; 16], &[96; 16]))
        .unwrap();
    assert!(incident_export::descriptor(&env, read.clone()).is_err());
    env.time.set(env.now() + DAY + 1);
    env.transaction(|db| incident_export::prepare(db, &env, &[1; 16], &[71; 16], &[98; 16]))
        .unwrap();
    assert!(incident_export::descriptor(&env, read).is_err()); // reused export ID cannot revive an expired descriptor
    assert!(incident_cutover::ready_digest(&env).is_err()); // changed descriptor needs a new acknowledgment
    assert_eq!(incident::status(&env).unwrap().unwrap().job, j.job);
}

use super::*;

#[test]
fn create_empty_fresh_registered_uv_admits_only_provisional_job() {
    let (env, key) = scoped_fixture();
    let source = env
        .transaction(|db| Ok(store::header(db, &[1; 16])?.generation.unwrap()))
        .unwrap();
    let r = GrantRequest {
        purpose: GrantPurpose::CreateEmpty {
            job: vec![120; 16],
            target: PendingCreation {
                namespace: vec![51; 32],
                vault: vec![2; 16],
                attempt: vec![121; 16],
            },
            authorizer_instance: source.clone(),
        },
        ..normal_request(&source, 123)
    };
    let ch = futures::executor::block_on(ceremonies::begin(&env, r.clone())).unwrap();
    let g = ceremonies::finish(&env, r.operation, counter_proof(&env, &key, &ch, 1)).unwrap();
    let j = create_empty::status(&env)
        .unwrap()
        .expect("fresh scoped UV must create its exact provisional job before nonce allocation");
    assert_eq!(j.phase, CreateEmptyPhase::Admitted);
    assert!(j.generation.is_none());
    env.transaction(|db| {
        assert!(store::header(db, &[2; 16]).is_err());
        assert_eq!(credentials(db)?.len(), 1);
        assert!(!authorization::covers(
            &authorization::authority(db, &[41])?.scope,
            &Generation {
                vault: vec![2; 16],
                ..source.clone()
            }
        ));
        grants::current(db, &env, &grants::load(db, &g.id)?)
    })
    .unwrap();
}
fn setup() -> (
    TestEnvironment,
    ed25519_dalek::SigningKey,
    Generation,
    GrantRequest,
) {
    let (env, key) = scoped_fixture();
    let source = env
        .transaction(|db| Ok(store::header(db, &[1; 16])?.generation.unwrap()))
        .unwrap();
    let r = GrantRequest {
        purpose: GrantPurpose::CreateEmpty {
            job: vec![120; 16],
            target: PendingCreation {
                namespace: vec![51; 32],
                vault: vec![2; 16],
                attempt: vec![121; 16],
            },
            authorizer_instance: source.clone(),
        },
        ..normal_request(&source, 123)
    };
    (env, key, source, r)
}
fn grant(
    env: &TestEnvironment,
    key: &ed25519_dalek::SigningKey,
    r: GrantRequest,
    counter: u32,
) -> GrantInfo {
    let ch = futures::executor::block_on(ceremonies::begin(env, r.clone())).unwrap();
    ceremonies::finish(env, r.operation, counter_proof(env, key, &ch, counter)).unwrap()
}
fn call(
    env: &TestEnvironment,
    g: &GrantInfo,
    n: u64,
    op: MutationOperation,
) -> Result<MutationResult> {
    signed_call(
        env,
        &ed25519_dalek::SigningKey::from_bytes(&[81; 32]),
        g,
        n,
        op,
    )
}
fn allocated(env: &TestEnvironment, g: &GrantInfo) -> CreateEmptyStatus {
    call(env, g, 0, MutationOperation::CreateEmptyAllocate).unwrap();
    create_empty::status(env).unwrap().unwrap()
}
fn stage(env: &TestEnvironment, g: &GrantInfo, n: u64) {
    call(
        env,
        g,
        n,
        MutationOperation::CreateEmptyStage {
            normal: Envelope {
                version: 2,
                nonce: vec![1; 12],
                ciphertext: vec![1; 48],
            },
            recovery: Envelope {
                version: 2,
                nonce: vec![2; 12],
                ciphertext: vec![2; 48],
            },
            recovery_verifier: ed25519_dalek::SigningKey::from_bytes(&[75; 32])
                .verifying_key()
                .to_bytes()
                .to_vec(),
        },
    )
    .unwrap();
    let j = create_empty::status(env).unwrap().unwrap();
    call(
        env,
        g,
        n + 1,
        MutationOperation::CreateEmptyConfirmKit {
            envelope_digest: j.envelope_digest,
        },
    )
    .unwrap();
}
#[test]
fn create_empty_activation_preserves_same_key_and_source_revokes_old_grants_and_requires_fresh_normal()
 {
    let (env, key, source, r) = setup();
    let normal = normal_grant(&env, &key, &source, 124, 1);
    let g = grant(&env, &key, r, 2);
    let j = allocated(&env, &g);
    let target = j.generation.unwrap();
    assert!(call(&env, &g, 1, MutationOperation::RestoreBeginImport).is_err());
    assert!(
        call(
            &env,
            &g,
            1,
            MutationOperation::Create(Reserve {
                vault: vec![3; 16],
                operation: vec![4; 16]
            })
        )
        .is_err()
    );
    env.transaction(|db| {
        // Even Global credentials cannot use the provisional target via Normal.
        let mut all = authorization::authorities(db)?;
        all.credentials[0].scope = CredentialScope::Global;
        store::save(db, "authorities", &all)?;
        assert!(ceremonies::validate_request(db, &env, &normal_request(&target, 122)).is_err());
        all.credentials[0].scope = CredentialScope::Instances(vec![Instance {
            vault: source.vault.clone(),
            nonce: source.nonce.clone(),
        }]);
        store::save(db, "authorities", &all)
    })
    .unwrap();
    stage(&env, &g, 1);
    call(&env, &g, 3, MutationOperation::CreateEmptyActivate).unwrap();
    env.transaction(|db| {
        let a = authorization::authority(db, &[41])?;
        assert_eq!(credentials(db)?.len(), 1);
        assert!(a.version > 1);
        assert!(matches!(a.scope, CredentialScope::Instances(_)));
        assert!(authorization::covers(&a.scope, &source));
        assert!(authorization::covers(&a.scope, &target));
        assert!(grants::current(db, &env, &grants::load(db, &normal.id)?).is_err());
        assert!(grants::current(db, &env, &grants::load(db, &g.id)?).is_err());
        assert_eq!(store::header(db, &target.vault)?.state, VaultState::Active);
        Ok(())
    })
    .unwrap();
    env.time.set(env.now() + 421);
    let fresh = normal_grant(&env, &key, &target, 125, 3);
    env.transaction(|db| grants::current(db, &env, &grants::load(db, &fresh.id)?))
        .unwrap();
    assert!(create_empty::cancel(&env, j.job, j.target, Some(target), 0).is_err());
}
#[test]
fn create_empty_admission_rejects_existing_pending_unrelated_scope_global_and_owner_jobs() {
    let (env, _, source, r) = setup();
    env.transaction(|db| {
        for change in 0..4 {
            let mut bad = r.clone();
            if let GrantPurpose::CreateEmpty {
                target,
                authorizer_instance,
                ..
            } = &mut bad.purpose
            {
                match change {
                    0 => target.vault = source.vault.clone(),
                    1 => target.namespace = vec![99; 32],
                    2 => authorizer_instance.nonce = vec![99; 32],
                    _ => bad.generations.clear(),
                }
            }
            assert!(ceremonies::validate_request(db, &env, &bad).is_err());
        }
        let mut all = authorization::authorities(db)?;
        all.credentials[0].scope = CredentialScope::Global;
        store::save(db, "authorities", &all)?;
        assert!(ceremonies::validate_request(db, &env, &r).is_err());
        all.credentials[0].scope = CredentialScope::Instances(vec![Instance {
            vault: source.vault.clone(),
            nonce: source.nonce.clone(),
        }]);
        store::save(db, "authorities", &all)?;
        store::reserve(
            db,
            env.owner(),
            Reserve {
                vault: vec![3; 16],
                operation: vec![4; 16],
            },
            env.now(),
        )?;
        assert!(ceremonies::validate_request(db, &env, &r).is_err());
        Ok(())
    })
    .unwrap();
}
#[test]
fn create_empty_cancel_zero_balance_exact_pre_nonce_and_source_deleted_after_nonce() {
    for allocated_target in [false, true] {
        let (env, key, _, r) = setup();
        let g = grant(&env, &key, r, 1);
        let j = if allocated_target {
            allocated(&env, &g)
        } else {
            create_empty::status(&env).unwrap().unwrap()
        };
        env.transaction(|db|{
            db.execute("DELETE FROM credentials WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",params![]).unwrap();
            db.execute("DELETE FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?1",params![vec![1u8;16]]).unwrap();
            assert!(grants::current(db,&env,&grants::load(db,&g.id)?).is_err()); Ok(())
        }).unwrap();
        env.funded.set(false);
        let mut bad = j.target.clone();
        bad.attempt = vec![88; 16];
        assert!(create_empty::cancel(&env, j.job.clone(), bad, j.generation.clone(), 0).is_err());
        let owner = env.owner();
        env.owner
            .set(candid::Principal::self_authenticating([88; 32]));
        assert!(
            create_empty::cancel(
                &env,
                j.job.clone(),
                j.target.clone(),
                j.generation.clone(),
                0
            )
            .is_err()
        );
        env.owner.set(owner);
        let p = create_empty::cancel(
            &env,
            j.job.clone(),
            j.target.clone(),
            j.generation.clone(),
            0,
        )
        .unwrap();
        assert!(p.complete);
        assert!(
            create_empty::cancel(&env, j.job, j.target, j.generation, 0)
                .unwrap()
                .complete
        );
    }
}
#[test]
fn create_empty_random_callback_rechecks_source_and_retains_exact_unsettled_token() {
    let (env, key, _, r) = setup();
    let g = grant(&env, &key, r, 1);
    env.defer_challenge_execution.set(true);
    *env.random_hook.borrow_mut() = Some(Box::new(|env| {
        env.transaction(|db| {
            let mut h = store::header(db, &[1; 16])?;
            h.state = VaultState::IncidentRequired;
            store::put_header(db, &h)
        })
        .unwrap();
    }));
    call(&env, &g, 0, MutationOperation::CreateEmptyAllocate).unwrap();
    let j = create_empty::status(&env).unwrap().unwrap();
    assert!(j.generation.is_none());
    assert!(j.allocation_token.is_some());
    env.funded.set(false);
    let p = create_empty::cancel(&env, j.job.clone(), j.target.clone(), None, 0).unwrap();
    assert!(!p.complete);
    assert_eq!(
        create_empty::status(&env)
            .unwrap()
            .unwrap()
            .allocation_token,
        j.allocation_token
    );
    env.challenge_rows.borrow_mut().clear();
    assert!(
        create_empty::cancel(&env, j.job, j.target, None, p.cursor)
            .unwrap()
            .complete
    );
}
#[test]
fn create_empty_target_derive_roles_callbacks_and_upgrade_fence() {
    for edge in 0..6 {
        let (env, key, source, r) = setup();
        let g = grant(&env, &key, r.clone(), 1);
        let j = allocated(&env, &g);
        let target = j.generation.unwrap();
        let mut d = IncidentDerive {
            job: j.job,
            attempt: j.target.attempt,
            role: IncidentRole::Target,
            generation: target,
            transport: ic_bls12_381::G1Affine::generator().to_compressed().to_vec(),
        };
        d.role = IncidentRole::Source;
        assert!(call(&env, &g, 1, MutationOperation::CreateEmptyDerive(d.clone())).is_err());
        d.role = IncidentRole::Target;
        d.generation = source;
        assert!(call(&env, &g, 1, MutationOperation::CreateEmptyDerive(d.clone())).is_err());
        d.generation = create_empty::status(&env)
            .unwrap()
            .unwrap()
            .generation
            .unwrap();
        let hook: TestHook = Box::new(move |env| {
            env.transaction(|db|{
            if edge==0 {let mut a=authorization::authorities(db)?;a.credentials[0].revoked=true;store::save(db,"authorities",&a)}
            else if edge==1 {let mut h=store::header(db,&[1;16])?;h.generation.as_mut().unwrap().nonce=vec![77;32];store::put_header(db,&h)}
            else if edge==3 {
                let mut c=restore_candidate::credential(db,&[41])?;
                let n=c.public_key_cose.0.len();c.public_key_cose.0[n-32..].copy_from_slice(&ed25519_dalek::SigningKey::from_bytes(&[99;32]).verifying_key().to_bytes());
                db.execute("UPDATE credentials SET value=?1 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND id=?2",params![serde_json::to_string(&c).unwrap(),vec![41u8]]).unwrap();Ok(())
            } else if edge==4 {
                let mut a=authorization::authorities(db)?;a.credentials[0].version+=1;store::save(db,"authorities",&a)
            } else if edge==5 {
                let mut a=authorization::authorities(db)?;
                let CredentialScope::Instances(xs)=&mut a.credentials[0].scope else {panic!()};xs.push(Instance{vault:vec![9;16],nonce:vec![9;32]});store::save(db,"authorities",&a)
            }
            else {db.execute("INSERT INTO global_settings VALUES('generation','new') ON CONFLICT(key) DO UPDATE SET value='new'",params![]).unwrap();Ok(())}
        }).unwrap()
        });
        if edge == 1 {
            *env.derive_hook.borrow_mut() = Some(hook)
        } else {
            *env.public_hook.borrow_mut() = Some(hook)
        }
        let MutationResult::Handle(handle) =
            call(&env, &g, 1, MutationOperation::CreateEmptyDerive(d)).unwrap()
        else {
            panic!()
        };
        assert!(call(&env, &g, 2, MutationOperation::KeyResult { handle }).is_err());
        if edge == 2 {
            env.time.set(env.now() + 421);
            let fresh = grant(
                &env,
                &key,
                GrantRequest {
                    operation: vec![129; 16],
                    ..r
                },
                2,
            );
            env.transaction(|db| grants::current(db, &env, &grants::load(db, &fresh.id)?))
                .unwrap();
        }
    }
}
#[test]
fn create_empty_prunes_only_unreferenced_tuples_preserves_other_live_scopes_at_ten_physical_keys() {
    let (env, key, source, r) = setup();
    let unrelated=env.transaction(|db|{
        let mut h=store::header(db,&[1;16])?; h.id=vec![3;16];h.generation.as_mut().unwrap().vault=h.id.clone();h.generation.as_mut().unwrap().nonce=vec![33;32];
        db.execute("INSERT INTO vaults(owner,id,operation,expires,header) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,0,?3)",params![h.id,vec![44u8;16],serde_json::to_string(&h).unwrap()]).unwrap();
        let unrelated=h.generation.unwrap();
        let mut all=authorization::authorities(db)?;
        all.credentials[0].scope=CredentialScope::Instances(vec![Instance{vault:source.vault.clone(),nonce:source.nonce.clone()},Instance{vault:unrelated.vault.clone(),nonce:unrelated.nonce.clone()},Instance{vault:vec![2;16],nonce:vec![99;32]}]);
        store::save(db,"authorities",&all)?;
        let c=credentials(db)?[0].clone();
        for n in 50..59 {let mut c=c.clone();c.id.0=vec![n];authorization::insert(db,&c,CredentialScope::Global)?;}
        Ok(unrelated)
    }).unwrap();
    let g = grant(&env, &key, r, 1);
    let j = allocated(&env, &g);
    stage(&env, &g, 1);
    call(&env, &g, 3, MutationOperation::CreateEmptyActivate).unwrap();
    env.transaction(|db| {
        assert_eq!(credentials(db)?.len(), 10);
        let a = authorization::authority(db, &[41])?;
        assert!(authorization::covers(&a.scope, &source));
        assert!(authorization::covers(&a.scope, &unrelated));
        assert!(authorization::covers(
            &a.scope,
            j.generation.as_ref().unwrap()
        ));
        let CredentialScope::Instances(xs) = a.scope else {
            panic!("Global escalation")
        };
        assert_eq!(xs.len(), 3);
        assert!(!xs.iter().any(|x| x.nonce == vec![99; 32]));
        Ok(())
    })
    .unwrap();
}
#[test]
fn create_empty_empty_data_guard_overcommit_and_counter_rollback() {
    let (env, key, _, r) = setup();
    let g = grant(&env, &key, r, 1);
    let j = allocated(&env, &g);
    stage(&env, &g, 1);
    env.transaction(|db|{
        db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,0,X'','[]',1,4096)",params![j.target.vault,vec![31u8;16]]).unwrap();
        assert!(create_empty::current(db,&env,&j).is_err());
        Ok(())
    }).unwrap();
    assert!(call(&env, &g, 3, MutationOperation::CreateEmptyActivate).is_err());
    assert!(create_empty::cancel(&env, j.job, j.target.clone(), j.generation, 0).is_err());
    env.transaction(|db|{
        db.execute("DELETE FROM revisions WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND vault=?1",params![j.target.vault]).unwrap();
        let mut n=cleanup::namespace(db)?;n.serial=i64::MAX as u64;cleanup::save(db,&n)
    }).unwrap();
    assert!(call(&env, &g, 3, MutationOperation::CreateEmptyActivate).is_err());
    env.transaction(|db| {
        assert_eq!(
            store::header(db, &j.target.vault)?.state,
            VaultState::Pending
        );
        Ok(())
    })
    .unwrap();
    let (env, _, _, r) = setup();
    env.transaction(|db| {
        let usage = store::content::global_usage(db)?;
        db.execute(
            "INSERT INTO revisions VALUES(?1,?2,?3,1,1,NULL,0,X'','[]',1,?4)",
            params![
                candid::Principal::self_authenticating([99; 32]).as_slice(),
                vec![1u8; 16],
                vec![2u8; 16],
                (TOTAL_MAX - usage + 1) as i64
            ],
        )
        .unwrap();
        assert_eq!(
            create_empty::validate(db, &env, &r),
            Err(Error::QuotaExceeded)
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn create_empty_shared_busy_slot_and_unknown_transition_fail_closed() {
    let (env, key, _, r) = setup();
    let _g = grant(&env, &key, r, 1);
    assert!(restore_admission::begin(&env, request(3)).is_err());
    env.transaction(|db| {
        let s = store::transition::load_state(db)?;
        assert!(store::transition::pending_state(&s));
        assert!(store::transition::restore_pending(db)?);
        assert!(store::transition::any_pending(db)?);
        assert_eq!(store::content::gc(db, env.now() + DAY * 2)?, 0);
        assert!(store::incident::owner_change_allowed(db).is_err());
        let raw = serde_json::to_string(&s).unwrap();
        assert!(raw.len() < 65536);
        let mut invalid: serde_json::Value = serde_json::from_str(&raw).unwrap();
        invalid["version"] = 2.into();
        assert!(store::transition::decode(&invalid.to_string()).is_err());
        invalid["version"] = 1.into();
        invalid["creation"]["phase"] = "Unknown".into();
        assert!(store::transition::decode(&invalid.to_string()).is_err());
        assert!(store::transition::decode(&format!("{}{}", raw, " ".repeat(65536))).is_err());
        Ok(())
    })
    .unwrap();
}
#[test]
fn create_empty_cancellation_at_each_key_await_fences_reply_and_preserves_source() {
    for encrypted in [false, true] {
        let (env, key, source, r) = setup();
        let g = grant(&env, &key, r, 1);
        let j = allocated(&env, &g);
        let d = IncidentDerive {
            job: j.job.clone(),
            attempt: j.target.attempt.clone(),
            generation: j.generation.clone().unwrap(),
            role: IncidentRole::Target,
            transport: ic_bls12_381::G1Affine::generator().to_compressed().to_vec(),
        };
        let hook: TestHook = Box::new(move |env| {
            env.funded.set(false);
            assert!(
                create_empty::cancel(env, j.job, j.target, j.generation, 0)
                    .unwrap()
                    .complete
            );
        });
        if encrypted {
            *env.derive_hook.borrow_mut() = Some(hook)
        } else {
            *env.public_hook.borrow_mut() = Some(hook)
        }
        let MutationResult::Handle(handle) =
            call(&env, &g, 1, MutationOperation::CreateEmptyDerive(d)).unwrap()
        else {
            panic!()
        };
        assert!(call(&env, &g, 2, MutationOperation::KeyResult { handle }).is_err());
        assert_eq!(env.derive_calls.get(), u64::from(encrypted));
        env.transaction(|db| {
            assert_eq!(store::header(db, &source.vault)?.generation, Some(source));
            assert!(store::header(db, &[2; 16]).is_err());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            create_empty::status(&env).unwrap().unwrap().phase,
            CreateEmptyPhase::Cancelled
        );
    }
}

#[test]
fn create_empty_source_retains_key_a_after_default_changes_to_b() {
    let (env, key, source, r) = setup();
    env.transaction(|db| {
        let mut config = store::config(db)?;
        assert_ne!(source.key_name, "key_1");
        config.key_name = "key_1".into();
        db.execute(
            "UPDATE global_settings SET value=?1 WHERE key='config'",
            params![serde_json::to_string(&config).unwrap()],
        )
        .unwrap();
        let mut forged = r.clone();
        forged.generations[0].key_name = "key_1".into();
        if let GrantPurpose::CreateEmpty {
            authorizer_instance,
            ..
        } = &mut forged.purpose
        {
            authorizer_instance.key_name = "key_1".into();
        }
        assert_eq!(
            create_empty::validate(db, &env, &forged),
            Err(Error::Unauthorized)
        );
        Ok(())
    })
    .unwrap();
    let g = grant(&env, &key, r, 1);
    let j = allocated(&env, &g);
    assert_eq!(j.generation.as_ref().unwrap().key_name, "key_1");
    stage(&env, &g, 1);
    call(&env, &g, 3, MutationOperation::CreateEmptyActivate).unwrap();
    let normal = normal_grant(&env, &key, &source, 124, 2);
    let result = call(
        &env,
        &normal,
        0,
        MutationOperation::Derive(Derive {
            vault: source.vault.clone(),
            epoch: source.epoch,
            transport: ic_bls12_381::G1Affine::generator().to_compressed().to_vec(),
            assertion: None,
            attempt: None,
        }),
    )
    .unwrap();
    assert!(matches!(result, MutationResult::Handle(_)));
    assert_eq!(*env.public_names.borrow(), vec![source.key_name.clone()]);
    env.transaction(|db| {
        assert_eq!(
            store::header(db, &source.vault)?.generation,
            Some(source.clone())
        );
        Ok(())
    })
    .unwrap();
}

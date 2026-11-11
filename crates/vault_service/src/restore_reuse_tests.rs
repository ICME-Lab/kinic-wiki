use super::*;
use ed25519_dalek::Signer;

fn scoped_fixture() -> (TestEnvironment, ed25519_dalek::SigningKey) {
    let env = fixture();
    let key = install_test_passkey(&env);
    env.transaction(|db| {
        let mut all = authorization::authorities(db)?;
        let mut h = store::header(db, &[1; 16])?;
        h.recovery_verifier = ed25519_dalek::SigningKey::from_bytes(&[88; 32])
            .verifying_key()
            .to_bytes()
            .to_vec();
        store::put_header(db, &h)?;
        all.credentials[0].version = 1;
        all.credentials[0].scope = CredentialScope::Instances(vec![Instance {
            vault: vec![1; 16],
            nonce: store::header(db, &[1; 16])?.generation.unwrap().nonce,
        }]);
        let mut n = cleanup::namespace(db)?;
        n.serial = 1;
        cleanup::save(db, &n)?;
        store::save(db, "authorities", &all)
    })
    .unwrap();
    (env, key)
}
fn reuse_request(v: u8) -> RestoreAdmissionRequest {
    let mut r = request(v);
    r.job = vec![100 + v; 16];
    r.target.attempt = vec![110 + v; 16];
    r.candidate_mode = Some(RestoreCandidateMode::ExistingInstances(vec![41]));
    r
}
fn counter_proof(
    env: &TestEnvironment,
    key: &ed25519_dalek::SigningKey,
    ch: &Challenge,
    counter: u32,
) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
    let mut p: serde_json::Value = serde_json::from_str(&passkey_assertion(env, key, ch)).unwrap();
    let client = B64.decode(p["clientDataJSON"].as_str().unwrap()).unwrap();
    let mut auth = B64
        .decode(p["authenticatorData"].as_str().unwrap())
        .unwrap();
    auth[33..37].copy_from_slice(&counter.to_be_bytes());
    p["signature"] = B64
        .encode(
            key.sign(&[auth.clone(), Sha256::digest(client).to_vec()].concat())
                .to_bytes(),
        )
        .into();
    p["authenticatorData"] = B64.encode(auth).into();
    p.to_string()
}
fn normal_request(g: &Generation, n: u8) -> GrantRequest {
    GrantRequest {
        operation: vec![n; 16],
        public_key: ed25519_dalek::SigningKey::from_bytes(&[81; 32])
            .verifying_key()
            .to_bytes()
            .to_vec(),
        credential: vec![41],
        generations: vec![g.clone()],
        purpose: GrantPurpose::Normal,
    }
}
fn normal_grant(
    env: &TestEnvironment,
    key: &ed25519_dalek::SigningKey,
    g: &Generation,
    n: u8,
    counter: u32,
) -> GrantInfo {
    let r = normal_request(g, n);
    let ch = futures::executor::block_on(ceremonies::begin(env, r.clone())).unwrap();
    ceremonies::finish(env, r.operation, counter_proof(env, key, &ch, counter)).unwrap()
}
fn finish_empty(env: &TestEnvironment, key: &ed25519_dalek::SigningKey) -> Generation {
    let j = restore_admission::status(env).unwrap().unwrap();
    let (signing, grant) = pipeline_grant(
        env,
        key,
        GrantPurpose::RestorePrepare {
            job: j.request.job.clone(),
            target: j.request.target.clone(),
        },
    );
    signed_call(env, &signing, &grant, 0, MutationOperation::RestoreAllocate).unwrap();
    let target = restore_admission::status(env)
        .unwrap()
        .unwrap()
        .pipeline
        .unwrap()
        .target;
    let (signing, grant) = pipeline_grant(
        env,
        key,
        GrantPurpose::RestoreTarget {
            job: j.request.job.clone(),
            generation: target.clone(),
        },
    );
    stage_pipeline(env, target.vault[0], &signing, &grant, &target);
    if let Some(current) = j.current_live {
        let (s, g) = pipeline_grant(
            env,
            key,
            GrantPurpose::RestoreCleanup {
                job: j.request.job.clone(),
                target: j.request.target,
            },
        );
        for cursor in 0..20 {
            signed_call(
                env,
                &s,
                &g,
                cursor,
                MutationOperation::RestoreDiscard {
                    current: current.clone(),
                    cursor,
                },
            )
            .unwrap();
            if restore_admission::status(env)
                .unwrap()
                .unwrap()
                .pipeline
                .unwrap()
                .old_removed
            {
                break;
            }
        }
    }
    signed_call(
        env,
        &signing,
        &grant,
        3,
        MutationOperation::RestoreBeginImport,
    )
    .unwrap();
    let d = restore_pipeline::descriptor(env, j.request.job, target.clone()).unwrap();
    signed_call(
        env,
        &signing,
        &grant,
        4,
        MutationOperation::RestoreConfirmBackup(IncidentBackupAck {
            descriptor_digest: d.descriptor_digest,
            commitment: d.commitment,
            archive_hash: vec![1; 32],
            archive_length: 1000,
            recovery_verifier: d.export.header.recovery_verifier,
            sequence: 0,
        }),
    )
    .unwrap();
    signed_call(env, &signing, &grant, 5, MutationOperation::RestoreActivate).unwrap();
    target
}
#[test]
fn restore_reuse_sequential_nested_a_b_c_at_ten_preserves_live_scopes_and_parent() {
    let (env, signing, pre, _) = super::super::incident_tests::fixture(3);
    signed_call(&env, &signing, &pre, 0, MutationOperation::IncidentStart).unwrap();
    env.time.set(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    let key = admit_pipeline(&env, 1);
    env.transaction(|db| {
        // Incident fixture has authority-only stubs; replace them with nine actual physical rows.
        let mut all = authorization::authorities(db)?;
        all.credentials.clear();
        store::save(db, "authorities", &all)?;
        let c: passkey_auth::PasskeyCredential = serde_json::from_str(
            restore_admission::load(db, &request(1).job)?
                .candidate
                .as_ref()
                .unwrap(),
        )
        .unwrap();
        for n in 0..9 {
            let mut c = c.clone();
            c.id.0 = vec![150 + n];
            authorization::insert(db, &c, CredentialScope::Global)?;
        }
        for v in 2..=3 {
            let mut h = store::header(db, &[v; 16])?;
            h.recovery_verifier = ed25519_dalek::SigningKey::from_bytes(&[88 + v; 32])
                .verifying_key()
                .to_bytes()
                .to_vec();
            store::put_header(db, &h)?;
        }
        assert_eq!(restore_admission::physical(db)?, 9);
        Ok(())
    })
    .unwrap();
    let a = finish_empty(&env, &key);
    let old_normal = normal_grant(&env, &key, &a, 130, 0);
    let version = env
        .transaction(|db| Ok(authorization::authority(db, &[41])?.version))
        .unwrap();
    let before = incident::status(&env).unwrap().unwrap();
    let mut new = request(2);
    new.job = vec![201; 16];
    new.target.attempt = vec![202; 16];
    assert!(matches!(
        restore_admission::begin(&env, new),
        Err(Error::QuotaExceeded)
    ));
    let r = reuse_request(2);
    let ch = restore_admission::begin(&env, r.clone()).unwrap();
    let j = restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch))
        .unwrap();
    assert_eq!(j.phase, RestoreAdmissionPhase::CurrentProof);
    assert!(
        restore_admission::prove_current(
            &env,
            r.job.clone(),
            ed25519_dalek::SigningKey::from_bytes(&[88; 32])
                .sign(&j.recovery_message)
                .to_bytes()
                .to_vec()
        )
        .is_err()
    );
    restore_admission::prove_current(
        &env,
        r.job.clone(),
        ed25519_dalek::SigningKey::from_bytes(&[90; 32])
            .sign(&j.recovery_message)
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    let b = finish_empty(&env, &key);
    env.transaction(|db| {
        let auth = authorization::authority(db, &[41])?;
        assert_eq!(
            auth.scope,
            CredentialScope::Instances(vec![
                Instance {
                    vault: a.vault.clone(),
                    nonce: a.nonce.clone()
                },
                Instance {
                    vault: b.vault.clone(),
                    nonce: b.nonce.clone()
                }
            ])
        );
        assert!(auth.version > version);
        assert_eq!(restore_admission::physical(db)?, 10);
        assert!(grants::current(db, &env, &grants::load(db, &old_normal.id)?).is_err());
        let c = store::header(db, &[3; 16])?;
        assert!(!authorization::covers(
            &auth.scope,
            c.generation.as_ref().unwrap()
        ));
        assert!(
            ceremonies::validate_request(
                db,
                &env,
                &normal_request(c.generation.as_ref().unwrap(), 131)
            )
            .is_err()
        );
        assert_eq!(c.state, VaultState::IncidentRequired);
        assert!(store::incident::pinned(db, &[3; 16])?);
        let parent = store::incident::status(db)?.unwrap();
        assert_eq!(
            serde_json::to_string(&parent.targets[2]).unwrap(),
            serde_json::to_string(&before.targets[2]).unwrap()
        );
        assert_eq!(parent.compromised, before.compromised);
        assert_eq!(
            parent.targets[0].source.generation,
            before.targets[0].source.generation
        );
        assert_eq!(
            parent.targets[0].restore_child,
            before.targets[0].restore_child
        );
        let raw = serde_json::to_string(&store::transition::load_state(db)?).unwrap();
        assert!(raw.len() <= 65536);
        Ok(())
    })
    .unwrap();
    normal_grant(&env, &key, &a, 132, 0);
    // Advance beyond retained receipts, allowing normal bounded grant GC before the third job.
    env.time.set(env.now() + 421);
    let r = reuse_request(3);
    let ch = restore_admission::begin(&env, r.clone()).unwrap();
    let j = restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch))
        .unwrap();
    assert!(
        restore_admission::prove_current(
            &env,
            r.job.clone(),
            ed25519_dalek::SigningKey::from_bytes(&[90; 32])
                .sign(&j.recovery_message)
                .to_bytes()
                .to_vec()
        )
        .is_err()
    );
    restore_admission::prove_current(
        &env,
        r.job,
        ed25519_dalek::SigningKey::from_bytes(&[91; 32])
            .sign(&j.recovery_message)
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    let c = finish_empty(&env, &key);
    env.transaction(|db| {
        let auth = authorization::authority(db, &[41])?;
        assert!(matches!(&auth.scope,CredentialScope::Instances(xs) if xs.len()==3));
        for g in [&a, &b, &c] {
            assert!(authorization::covers(&auth.scope, g));
        }
        assert_eq!(restore_admission::physical(db)?, 10);
        Ok(())
    })
    .unwrap();
    // Matching VaultID and the archived old kit cannot reset the fresh A verifier.
    let r = reuse_request(1);
    let ch = restore_admission::begin(&env, r.clone()).unwrap();
    let j = restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch))
        .unwrap();
    assert!(
        restore_admission::prove_current(
            &env,
            r.job,
            ed25519_dalek::SigningKey::from_bytes(&[88; 32])
                .sign(&j.recovery_message)
                .to_bytes()
                .to_vec()
        )
        .is_err()
    );
}
#[test]
fn restore_reuse_shared_counter_uses_live_sql_across_normal_and_restore_assertions() {
    let (env, key) = scoped_fixture();
    let r = reuse_request(2);
    let ch = restore_admission::begin(&env, r.clone()).unwrap();
    let g = env
        .transaction(|db| Ok(store::header(db, &[1; 16])?.generation.unwrap()))
        .unwrap();
    normal_grant(&env, &key, &g, 120, 5);
    assert!(
        restore_admission::possess(&env, r.job.clone(), counter_proof(&env, &key, &ch, 4)).is_err()
    );
    let j =
        restore_admission::possess(&env, r.job.clone(), counter_proof(&env, &key, &ch, 6)).unwrap();
    let bound = j.existing_candidate.clone();
    let digest = j.candidate_digest.clone();
    let r = GrantRequest {
        operation: vec![121; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        generations: vec![],
        purpose: GrantPurpose::RestorePrepare {
            job: r.job,
            target: r.target,
        },
    };
    let ch = restore_grants::begin(&env, r.clone()).unwrap();
    // A different normal assertion can advance the same physical row while restore waits.
    env.transaction(|db| {
        let c = Ceremony {
            request: BeginUnlock {
                vault: vec![1; 16],
                attempt: None,
                epoch: g.epoch,
                purpose: Purpose::Unlock,
                transport: vec![0; 48],
                target: vec![],
            },
            challenge: Challenge {
                bytes: vec![77; 32],
                expires: env.now() + 120,
                registration: false,
                credential_ids: vec![vec![41]],
            },
            created: env.now(),
            configuration: grants::fence(db)?,
        };
        authorization::assertion(db, &c, &[41], &counter_proof(&env, &key, &c.challenge, 8))
    })
    .unwrap();
    assert!(
        restore_grants::finish(
            &env,
            r.operation.clone(),
            counter_proof(&env, &key, &ch, 7),
            false
        )
        .is_err()
    );
    let g = restore_grants::finish(&env, r.operation, counter_proof(&env, &key, &ch, 9), false)
        .unwrap();
    env.transaction(|db| {
        assert_eq!(credentials(db)?[0].counter, 9);
        let j = restore_admission::load(db, restore_grants::job(&g.purpose)?)?;
        assert_eq!(j.existing_candidate, bound);
        assert_eq!(j.candidate_digest, digest);
        grants::current(db, &env, &grants::load(db, &g.id)?)
    })
    .unwrap();
    assert!(
        restore_grants::finish(
            &env,
            vec![121; 16],
            counter_proof(&env, &key, &ch, 10),
            false
        )
        .is_err()
    );
}
#[test]
fn restore_reuse_rechecks_key_scope_version_and_revocation_before_effect_and_callback() {
    for change in 0..5 {
        let (env, key) = scoped_fixture();
        let r = reuse_request(2);
        let ch = restore_admission::begin(&env, r.clone()).unwrap();
        restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch))
            .unwrap();
        let (sign, g) = pipeline_grant(
            &env,
            &key,
            GrantPurpose::RestorePrepare {
                job: r.job.clone(),
                target: r.target,
            },
        );
        let alter = move |env: &TestEnvironment| {
            env.transaction(|db| {
                let mut all = authorization::authorities(db)?;
                match change {
                    0 => all.credentials[0].revoked = true,
                    1 => all.credentials[0].version += 1,
                    2 => all.credentials[0].scope = CredentialScope::Global,
                    3 => {
                        if let CredentialScope::Instances(xs) = &mut all.credentials[0].scope {
                            xs[0].nonce = vec![98; 32];
                        }
                    }
                    _ => {
                        let mut c = credentials(db)?[0].clone();
                        c.public_key_cose.0[12] ^= 1;
                        db.execute(
                            "UPDATE credentials SET value=?1 WHERE id=?2",
                            params![serde_json::to_string(&c).unwrap(), c.id.0],
                        )
                        .unwrap();
                    }
                }
                store::save(db, "authorities", &all)
            })
            .unwrap();
        };
        *env.random_hook.borrow_mut() = Some(Box::new(alter));
        signed_call(&env, &sign, &g, 0, MutationOperation::RestoreAllocate).unwrap();
        env.transaction(|db| {
            assert!(matches!(
                grants::load(db, &g.id)?.work.unwrap().result,
                Some(Err(_))
            ));
            Ok(())
        })
        .unwrap();
        assert!(
            restore_admission::status(&env)
                .unwrap()
                .unwrap()
                .pipeline
                .is_none()
        );
        assert!(restore_admission::resume(&env, r.job).is_err());
        assert!(signed_call(&env, &sign, &g, 1, MutationOperation::RestoreAllocate).is_err());
    }
}
#[test]
fn restore_reuse_expiry_upgrade_and_zero_balance_cancel_preserve_physical_key() {
    let (env, key) = scoped_fixture();
    let r = reuse_request(2);
    let ch = restore_admission::begin(&env, r.clone()).unwrap();
    env.time.set(ch.expires);
    assert!(
        restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch))
            .is_err()
    );
    let ch = restore_admission::resume(&env, r.job.clone()).unwrap();
    restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch)).unwrap();
    let (_, old) = pipeline_grant(
        &env,
        &key,
        GrantPurpose::RestorePrepare {
            job: r.job.clone(),
            target: r.target.clone(),
        },
    );
    env.transaction(|db| {
        db.execute(
            "INSERT INTO global_settings VALUES('generation','2')",
            params![],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    env.funded.set(false);
    let ch = restore_admission::resume(&env, r.job.clone()).unwrap();
    restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch)).unwrap();
    env.transaction(|db| {
        assert!(grants::current(db, &env, &grants::load(db, &old.id)?).is_err());
        Ok(())
    })
    .unwrap();
    let (sign, g) = pipeline_grant(
        &env,
        &key,
        GrantPurpose::RestoreCleanup {
            job: r.job.clone(),
            target: r.target,
        },
    );
    signed_call(
        &env,
        &sign,
        &g,
        0,
        MutationOperation::RestoreCancel { cursor: 0 },
    )
    .unwrap();
    assert!(
        restore_admission::status(&env)
            .unwrap()
            .unwrap()
            .cancel_complete
    );
    env.transaction(|db| {
        assert_eq!(credentials(db)?.len(), 1);
        assert!(!authorization::authority(db, &[41])?.revoked);
        assert_eq!(store::header(db, &[1; 16])?.state, VaultState::Active);
        Ok(())
    })
    .unwrap();
}
#[test]
fn restore_reuse_decoder_and_capacity_bind_exact_nonce_and_pending_references() {
    let (env, _) = scoped_fixture();
    env.transaction(|db| {
        let mut all=authorization::authorities(db)?;
        let base=store::header(db,&[1;16])?;
        let mut xs=match all.credentials[0].scope.clone(){CredentialScope::Instances(xs)=>xs,_=>unreachable!()};
        for v in 2..=3 {let mut h=base.clone(); h.id=vec![v;16];h.generation.as_mut().unwrap().vault=h.id.clone();db.execute("INSERT INTO vaults VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,0,?3)",params![h.id,vec![v;16],serde_json::to_string(&h).unwrap()]).unwrap();xs.push(Instance{vault:h.id,nonce:h.generation.unwrap().nonce});}
        all.credentials[0].scope=CredentialScope::Instances(xs);store::save(db,"authorities",&all)
    }).unwrap();
    // Exact live source replacement fits three, including same content VaultID.
    let ch = restore_admission::begin(&env, reuse_request(2)).unwrap();
    assert!(!ch.registration);
    env.transaction(|db| {
        let mut s = store::transition::load_state(db)?;
        let j = s.restore.as_mut().unwrap();
        let old = j.current_live.clone();
        j.current_live.as_mut().unwrap().nonce = vec![98; 32];
        assert_eq!(restore_candidate::current(db, j), Err(Error::QuotaExceeded));
        j.current_live = old;
        let raw = serde_json::to_value(&s).unwrap();
        for field in ["existing_candidate", "candidate_mode"] {
            let mut bad = raw.clone();
            if field == "candidate_mode" {
                bad["restore"]["request"][field] = serde_json::Value::Null;
            } else {
                bad["restore"][field] = serde_json::Value::Null;
            }
            assert!(store::transition::decode(&bad.to_string()).is_err());
        }
        let mut oversized = s.clone();
        oversized.restore.as_mut().unwrap().recovery_message = vec![255; 65536];
        assert!(store::transition::save_state(db, &oversized).is_err());
        Ok(())
    })
    .unwrap();
}

#[test]
fn restore_reuse_prunes_only_unreferenced_scopes_and_counter_advance_keeps_callback_valid() {
    let (env, key) = scoped_fixture();
    env.transaction(|db| {
        let mut all = authorization::authorities(db)?;
        if let CredentialScope::Instances(xs) = &mut all.credentials[0].scope {
            xs.push(Instance {
                vault: vec![1; 16],
                nonce: vec![98; 32],
            });
            xs.push(Instance {
                vault: vec![4; 16],
                nonce: vec![99; 32],
            });
        }
        store::save(db, "authorities", &all)
    })
    .unwrap();
    let r = reuse_request(2);
    let ch = restore_admission::begin(&env, r.clone()).unwrap();
    restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch)).unwrap();
    let (sign, g) = pipeline_grant(
        &env,
        &key,
        GrantPurpose::RestorePrepare {
            job: r.job.clone(),
            target: r.target,
        },
    );
    *env.random_hook.borrow_mut() = Some(Box::new(|env| {
        env.transaction(|db| {
            let mut c = credentials(db)?[0].clone();
            c.counter = 7;
            db.execute(
                "UPDATE credentials SET value=?1 WHERE id=?2",
                params![serde_json::to_string(&c).unwrap(), c.id.0],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    }));
    signed_call(&env, &sign, &g, 0, MutationOperation::RestoreAllocate).unwrap();
    env.transaction(|db| {
        let j = restore_admission::load(db, &r.job)?;
        let target = &j.pipeline.as_ref().unwrap().target;
        let original = store::header(db, &[1; 16])?.generation.unwrap();
        // Exercise exact promotion merge independently of the separately tested full pipeline.
        restore_candidate::promote(db, &j, target)?;
        let a = authorization::authority(db, &[41])?;
        assert_eq!(
            a.scope,
            CredentialScope::Instances(vec![
                Instance {
                    vault: original.vault,
                    nonce: original.nonce
                },
                Instance {
                    vault: target.vault.clone(),
                    nonce: target.nonce.clone()
                }
            ])
        );
        assert_eq!(credentials(db)?[0].counter, 7);
        Ok(())
    })
    .unwrap();
}
#[test]
fn restore_reuse_pending_target_scope_cannot_be_pruned_to_admit_fourth_tuple() {
    let (env, sign, pre, _) = super::super::incident_tests::fixture(3);
    signed_call(&env, &sign, &pre, 0, MutationOperation::IncidentStart).unwrap();
    install_test_passkey(&env);
    env.time.set(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    env.transaction(|db| {
        let mut p = store::incident::status(db)?.unwrap();
        let mut pending = p.targets[1].source.generation.clone().unwrap();
        pending.nonce = vec![98; 32];
        pending.epoch += 1;
        p.targets[1].target = Some(pending.clone());
        incident::save(db, &mut p)?;
        let mut h = store::header(db, &[2; 16])?;
        h.recovery_verifier = ed25519_dalek::SigningKey::from_bytes(&[88; 32])
            .verifying_key()
            .to_bytes()
            .to_vec();
        store::put_header(db, &h)?;
        let mut a = authorization::authorities(db)?;
        a.credentials[0].version = 1;
        a.credentials[0].scope = CredentialScope::Instances(vec![
            Instance {
                vault: vec![1; 16],
                nonce: p.targets[0]
                    .source
                    .generation
                    .as_ref()
                    .unwrap()
                    .nonce
                    .clone(),
            },
            Instance {
                vault: pending.vault,
                nonce: pending.nonce,
            },
            Instance {
                vault: vec![3; 16],
                nonce: p.targets[2]
                    .source
                    .generation
                    .as_ref()
                    .unwrap()
                    .nonce
                    .clone(),
            },
        ]);
        store::save(db, "authorities", &a)
    })
    .unwrap();
    assert!(matches!(
        restore_admission::begin(&env, reuse_request(2)),
        Err(Error::QuotaExceeded)
    ));
    env.transaction(|db| {
        assert!(store::transition::load_state(db)?.restore.is_none());
        for v in 1..=3 {
            assert!(store::incident::pinned(db, &[v; 16])?);
            assert_eq!(
                store::header(db, &[v; 16])?.state,
                VaultState::IncidentRequired
            );
        }
        Ok(())
    })
    .unwrap();
}

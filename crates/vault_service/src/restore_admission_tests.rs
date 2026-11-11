use super::*;
fn request(vault: u8) -> RestoreAdmissionRequest {
    RestoreAdmissionRequest {
        job: vec![91; 16],
        target: PendingCreation {
            namespace: vec![51; 32],
            vault: vec![vault; 16],
            attempt: vec![92; 16],
        },
        archive_digest: vec![93; 32],
        source_commitment: vec![94; 32],
        source_epoch: 2,
        source_generation: None,
        archive_length: 1000,
        records: 0,
        reserved_bytes: 0,
    }
}
fn fixture() -> TestEnvironment {
    let (env, _, _) = signed_fixture(GrantPurpose::Normal);
    env.transaction(|db| {
        grants::prepay(db)?;
        store::save(db, "control", &control(db)?)
    })
    .unwrap();
    env.time.set(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    env
}
fn registration(ch: &Challenge, key: &ed25519_dalek::SigningKey) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
    let cose = [
        vec![0xa4, 1, 1, 3, 0x27, 0x20, 6, 0x21, 0x58, 0x20],
        key.verifying_key().to_bytes().to_vec(),
    ]
    .concat();
    let auth = [
        Sha256::digest(b"localhost").to_vec(),
        vec![0x45, 0, 0, 0, 0],
        vec![0; 16],
        vec![0, 1, 41],
        cose,
    ]
    .concat();
    let att = [
        vec![0xa3, 0x63],
        b"fmt".to_vec(),
        vec![0x64],
        b"none".to_vec(),
        vec![0x68],
        b"authData".to_vec(),
        vec![0x58, auth.len() as u8],
        auth,
        vec![0x67],
        b"attStmt".to_vec(),
        vec![0xa0],
    ]
    .concat();
    let client=serde_json::to_vec(&serde_json::json!({"type":"webauthn.create","challenge":B64.encode(&ch.bytes),"origin":"http://localhost:5173","crossOrigin":false})).unwrap();
    serde_json::json!({"id":B64.encode([41]),"clientDataJSON":B64.encode(client),"attestationObject":B64.encode(att),"transports":[]}).to_string()
}
#[test]
fn restore_admission_requires_real_candidate_possession_and_mints_no_authority() {
    let env = fixture();
    let r = request(2);
    let ch = restore_admission::begin(&env, r.clone()).unwrap();
    let key = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
    use ed25519_dalek::Signer;
    let mut no_uv: serde_json::Value = serde_json::from_str(&registration(&ch, &key)).unwrap();
    let mut att = B64
        .decode(no_uv["attestationObject"].as_str().unwrap())
        .unwrap();
    let rp = Sha256::digest(b"localhost");
    let pos = att.windows(32).position(|w| w == rp.as_slice()).unwrap();
    att[pos + 32] = 0x41;
    no_uv["attestationObject"] = B64.encode(att).into();
    assert!(restore_admission::register(&env, r.job.clone(), no_uv.to_string()).is_err());
    let ch = restore_admission::register(&env, r.job.clone(), registration(&ch, &key)).unwrap();
    let mut no_uv: serde_json::Value =
        serde_json::from_str(&passkey_assertion(&env, &key, &ch)).unwrap();
    let client = B64
        .decode(no_uv["clientDataJSON"].as_str().unwrap())
        .unwrap();
    let mut auth = B64
        .decode(no_uv["authenticatorData"].as_str().unwrap())
        .unwrap();
    auth[32] = 1;
    no_uv["signature"] = B64
        .encode(
            key.sign(&[auth.clone(), Sha256::digest(&client).to_vec()].concat())
                .to_bytes(),
        )
        .into();
    no_uv["authenticatorData"] = B64.encode(auth).into();
    assert!(restore_admission::possess(&env, r.job.clone(), no_uv.to_string()).is_err());
    assert_eq!(
        restore_admission::status(&env).unwrap().unwrap().phase,
        RestoreAdmissionPhase::Possession
    );
    assert!(
        restore_admission::possess(
            &env,
            r.job.clone(),
            passkey_assertion(&env, &ed25519_dalek::SigningKey::from_bytes(&[72; 32]), &ch)
        )
        .is_err()
    );
    let j = restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch))
        .unwrap();
    assert_eq!(j.phase, RestoreAdmissionPhase::Admitted);
    env.transaction(|db| {
        assert_eq!(credentials(db)?.len(), 0);
        assert_eq!(authorization::authorities(db)?.credentials.len(), 1);
        assert!(store::header(db, &[2; 16]).is_err());
        assert!(store::incident::owner_change_allowed(db).is_err());
        Ok(())
    })
    .unwrap();
    assert!(restore_admission::begin(&env, request(3)).is_err());
}
#[test]
fn restore_admission_current_live_proof_rejects_archive_key_and_reused_instance() {
    use ed25519_dalek::Signer;
    let env = fixture();
    let r = request(1);
    let current = ed25519_dalek::SigningKey::from_bytes(&[88; 32]);
    env.transaction(|db| {
        let mut h = store::header(db, &[1; 16])?;
        h.recovery_verifier = current.verifying_key().to_bytes().to_vec();
        store::put_header(db, &h)
    })
    .unwrap();
    let ch = restore_admission::begin(&env, r.clone()).unwrap();
    let key = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
    let ch = restore_admission::register(&env, r.job.clone(), registration(&ch, &key)).unwrap();
    let j = restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch))
        .unwrap();
    assert_eq!(j.phase, RestoreAdmissionPhase::CurrentProof);
    let wrong = ed25519_dalek::SigningKey::from_bytes(&[89; 32])
        .sign(&j.recovery_message)
        .to_bytes()
        .to_vec();
    assert!(restore_admission::prove_current(&env, r.job.clone(), wrong).is_err());
    let sig = current.sign(&j.recovery_message).to_bytes().to_vec();
    assert_eq!(
        restore_admission::prove_current(&env, r.job.clone(), sig.clone())
            .unwrap()
            .phase,
        RestoreAdmissionPhase::Admitted
    );
    env.transaction(|db| {
        let mut h = store::header(db, &[1; 16])?;
        h.generation.as_mut().unwrap().nonce = vec![77; 32];
        store::put_header(db, &h)
    })
    .unwrap();
    assert!(restore_admission::prove_current(&env, r.job.clone(), sig).is_err());
}

#[test]
fn restore_namespace_seed_is_private_fenced_and_never_bootstraps_global() {
    let env = TestEnvironment::new();
    env.upgrade_random.set(true);
    assert!(
        futures::executor::block_on(restore_admission::initialize_namespace(&env, vec![90; 16]))
            .is_err()
    );
    env.transaction(|db| {
        cleanup::reclaim_empty(db, env.now())?;
        assert!(store::transition::pending(db)?);
        assert!(cleanup::namespace(db)?.seed.is_none());
        Ok(())
    })
    .unwrap();
    let namespace =
        futures::executor::block_on(restore_admission::initialize_namespace(&env, vec![90; 16]))
            .unwrap();
    assert_eq!(namespace.len(), 32);
    assert_ne!(namespace, vec![9; 32]);
    env.transaction(|db| {
        assert!(store::list(db)?.is_empty());
        assert!(credentials(db)?.is_empty());
        assert!(authorization::authorities(db)?.credentials.is_empty());
        Ok(())
    })
    .unwrap();
    let mut r = request(2);
    r.target.namespace = namespace.clone();
    restore_admission::begin(&env, r).unwrap();
    assert!(
        futures::executor::block_on(generation::bootstrap(
            &env,
            Bootstrap {
                reserve: Reserve {
                    vault: vec![3; 16],
                    operation: vec![4; 16]
                },
                public_key: vec![5; 32]
            }
        ))
        .is_err()
    );
    env.transaction(|db| {
        cleanup::reclaim_empty(db, env.now())?;
        assert_eq!(cleanup::namespace(db)?.identity, namespace);
        assert!(store::transition::pending(db)?);
        Ok(())
    })
    .unwrap();
}

#[test]
fn restore_transition_decoder_rejects_unknown_and_malformed_admission() {
    let env = fixture();
    restore_admission::begin(&env, request(2)).unwrap();
    env.transaction(|db|{
        let mut state=store::transition::load_state(db)?;
        state.restore.as_mut().unwrap().phase=RestoreAdmissionPhase::Admitted;
        assert!(store::transition::decode(&serde_json::to_string(&state).unwrap()).is_err());
        for raw in ["{}", "[]", "{\"version\":1}", "{\"version\":99}", "{\"version\":1,\"incident\":null,\"restore\":null,\"namespace_flight\":null,\"unknown\":1}"] {assert!(store::transition::decode(raw).is_err());}
        Ok(())
    }).unwrap();
}

#[test]
fn restore_nested_admission_preserves_legacy_parent_and_pins_without_partial_cutover() {
    let (env, key, pre, _) = super::incident_tests::fixture(3);
    signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap();
    env.transaction(|db| {
        let parent = store::incident::status(db)?.unwrap();
        // Actual pre-Task10 storage shape must survive migration without rewriting audit.
        store::save(db, "transition", &parent)?;
        assert!(store::transition::pending(db)?);
        for complete in [true, false] {
            let mut old = parent.clone();
            old.complete = complete;
            let s = store::transition::decode(&serde_json::to_string(&old).unwrap())?;
            assert_eq!(s.incident.unwrap().complete, complete);
        }
        let mut h = store::header(db, &[1; 16])?;
        h.recovery_verifier = ed25519_dalek::SigningKey::from_bytes(&[88; 32])
            .verifying_key()
            .to_bytes()
            .to_vec();
        store::put_header(db, &h)?;
        Ok(())
    })
    .unwrap();
    env.time.set(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    let ch = restore_admission::begin(&env, request(1)).unwrap();
    assert!(ch.registration);
    let candidate = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
    let ch =
        restore_admission::register(&env, request(1).job, registration(&ch, &candidate)).unwrap();
    let proof = restore_admission::possess(
        &env,
        request(1).job,
        passkey_assertion(&env, &candidate, &ch),
    )
    .unwrap();
    use ed25519_dalek::Signer;
    let signature = ed25519_dalek::SigningKey::from_bytes(&[88; 32])
        .sign(&proof.recovery_message)
        .to_bytes()
        .to_vec();
    assert_eq!(
        restore_admission::prove_current(&env, request(1).job, signature)
            .unwrap()
            .phase,
        RestoreAdmissionPhase::Admitted
    );
    env.transaction(|db| {
        let state = store::transition::load_state(db)?;
        let parent = state.incident.clone().unwrap();
        assert_eq!(parent.targets.len(), 3);
        assert_eq!(
            state.restore.as_ref().unwrap().parent_job,
            Some(parent.job.clone())
        );
        for v in 1..=3 {
            assert!(store::incident::pinned(db, &[v; 16])?);
            assert_eq!(
                store::header(db, &[v; 16])?.state,
                VaultState::IncidentRequired
            );
        }
        assert!(store::transition::any_pending(db)?);
        assert_eq!(store::content::gc(db, env.now() + DAY * 2)?, 0);
        let before = store::content::usage(db)?;
        store::transition::save_state(db, &state)?;
        assert_eq!(store::content::usage(db)?, before);
        let mut oversized = state.clone();
        oversized.incident.as_mut().unwrap().semantic_config = vec![255; 20000];
        assert_eq!(
            store::transition::save_state(db, &oversized),
            Err(Error::QuotaExceeded)
        );
        let mut done = state;
        done.incident.as_mut().unwrap().complete = true;
        store::transition::save_state(db, &done)?;
        assert!(store::transition::pending(db)?);
        assert!(store::incident::owner_change_allowed(db).is_err());
        Ok(())
    })
    .unwrap();
}
#[test]
fn restore_admission_counts_all_ten_physical_credentials_and_preserves_rows() {
    let env = fixture();
    env.transaction(|db|{for n in 0u8..10 {db.execute("INSERT INTO credentials VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,'{}')",params![vec![n]]).unwrap();}Ok(())}).unwrap();
    assert!(matches!(
        restore_admission::begin(&env, request(2)),
        Err(Error::QuotaExceeded)
    ));
    env.transaction(|db| {
        assert!(store::transition::load_state(db)?.restore.is_none());
        let n: i64 = db
            .query_row("SELECT count(*) FROM credentials", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(n, 10);
        Ok(())
    })
    .unwrap();
}
#[test]
fn restore_admission_upgrade_requires_new_candidate_and_current_proofs_and_denies_grants() {
    let env = fixture();
    let r = request(2);
    let key = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
    let ch = restore_admission::begin(&env, r.clone()).unwrap();
    let ch = restore_admission::register(&env, r.job.clone(), registration(&ch, &key)).unwrap();
    env.transaction(|db| {
        db.execute(
            "INSERT INTO global_settings VALUES('generation','2')",
            params![],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    assert!(
        restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch))
            .is_err()
    );
    let fresh = restore_admission::resume(&env, r.job.clone()).unwrap();
    assert_ne!(ch.bytes, fresh.bytes);
    assert!(
        restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &ch))
            .is_err()
    );
    restore_admission::possess(&env, r.job.clone(), passkey_assertion(&env, &key, &fresh)).unwrap();
    env.transaction(|db| {
        for purpose in [
            GrantPurpose::Normal,
            GrantPurpose::Create,
            GrantPurpose::Credentials,
            GrantPurpose::Restore { job: r.job.clone() },
        ] {
            assert!(
                ceremonies::validate_request(
                    db,
                    &env,
                    &GrantRequest {
                        operation: vec![1; 16],
                        public_key: key.verifying_key().to_bytes().to_vec(),
                        credential: vec![41],
                        purpose,
                        generations: vec![]
                    }
                )
                .is_err()
            );
        }
        Ok(())
    })
    .unwrap();
}

#[test]
fn restore_pending_blocks_old_cleanup_from_erasing_admitted_identity() {
    let (env, key, g) = signed_fixture(GrantPurpose::Cleanup { job: vec![81; 16] });
    env.transaction(|db| {
        grants::prepay(db)?;
        let mut n = cleanup::namespace(db)?;
        n.grant = Some(grants::load(db, &g.id)?);
        cleanup::save(db, &n)
    })
    .unwrap();
    restore_admission::begin(&env, request(2)).unwrap();
    let result = signed_call(
        &env,
        &key,
        &g,
        0,
        MutationOperation::Cleanup {
            job: vec![81; 16],
            cursor: 0,
            action: CleanupAction::Purge,
        },
    );
    assert!(matches!(result, Err(Error::Busy)));
    env.transaction(|db| {
        assert_eq!(store::header(db, &[1; 16])?.state, VaultState::Active);
        Ok(())
    })
    .unwrap();
}

#[test]
fn restore_admission_rejects_other_pending_bootstrap_or_creation_before_reserving_candidate() {
    let env = fixture();
    env.transaction(|db| {
        store::reserve(
            db,
            env.owner(),
            Reserve {
                vault: vec![3; 16],
                operation: vec![4; 16],
            },
            env.now(),
        )
        .map(|_| ())
    })
    .unwrap();
    assert!(matches!(
        restore_admission::begin(&env, request(2)),
        Err(Error::Busy)
    ));
    assert!(restore_admission::status(&env).unwrap().is_none());
}

#[test]
fn restore_candidate_uses_tenth_slot_without_an_eleventh_registration_or_namespace_growth() {
    let env = fixture();
    let key = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
    let cose = [
        vec![0xa4, 1, 1, 3, 0x27, 0x20, 6, 0x21, 0x58, 0x20],
        key.verifying_key().to_bytes().to_vec(),
    ]
    .concat();
    env.transaction(|db| {
        for id in 1..=9u8 {
            insert_credential(
                db,
                &passkey_auth::PasskeyCredential {
                    id: passkey_auth::CredentialId(vec![id]),
                    public_key_cose: passkey_auth::CosePublicKey(cose.clone()),
                    counter: 0,
                    transports: vec![],
                    aaguid: [0; 16],
                },
            )?;
        }
        Ok(())
    })
    .unwrap();
    let before = env.transaction(store::content::usage).unwrap();
    let ch = restore_admission::begin(&env, request(2)).unwrap();
    let ch = restore_admission::register(&env, request(2).job, registration(&ch, &key)).unwrap();
    restore_admission::possess(&env, request(2).job, passkey_assertion(&env, &key, &ch)).unwrap();
    env.transaction(|db| {
        assert_eq!(credentials(db)?.len(), 9);
        assert!(
            store::transition::load_state(db)?
                .restore
                .unwrap()
                .candidate
                .is_some()
        );
        assert_eq!(store::content::usage(db)?, before);
        assert!(store::incident::owner_change_allowed(db).is_err());
        Ok(())
    })
    .unwrap();
    assert!(restore_admission::begin(&env, request(3)).is_err());
}

#[test]
fn restore_admission_wall_clock_expiry_rejects_old_proofs_and_fresh_resume_succeeds() {
    use ed25519_dalek::Signer;
    let env = fixture();
    let r = request(1);
    let candidate = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
    let recovery = ed25519_dalek::SigningKey::from_bytes(&[88; 32]);
    env.transaction(|db| {
        let mut h = store::header(db, &[1; 16])?;
        h.recovery_verifier = recovery.verifying_key().to_bytes().to_vec();
        store::put_header(db, &h)
    })
    .unwrap();
    let ch = restore_admission::begin(&env, r.clone()).unwrap();
    let ch =
        restore_admission::register(&env, r.job.clone(), registration(&ch, &candidate)).unwrap();
    let possession = passkey_assertion(&env, &candidate, &ch);
    let j = restore_admission::possess(&env, r.job.clone(), possession.clone()).unwrap();
    let old = recovery.sign(&j.recovery_message).to_bytes().to_vec();
    env.time.set(ch.expires);
    assert!(matches!(
        restore_admission::possess(&env, r.job.clone(), possession),
        Err(Error::Expired)
    ));
    assert!(matches!(
        restore_admission::prove_current(&env, r.job.clone(), old.clone()),
        Err(Error::Expired)
    ));
    let fresh = restore_admission::resume(&env, r.job.clone()).unwrap();
    assert_ne!(fresh.bytes, ch.bytes);
    let j = restore_admission::possess(
        &env,
        r.job.clone(),
        passkey_assertion(&env, &candidate, &fresh),
    )
    .unwrap();
    assert!(restore_admission::prove_current(&env, r.job.clone(), old).is_err());
    let sig = recovery.sign(&j.recovery_message).to_bytes().to_vec();
    assert_eq!(
        restore_admission::prove_current(&env, r.job, sig)
            .unwrap()
            .phase,
        RestoreAdmissionPhase::Admitted
    );
}

#[test]
fn restore_fresh_same_vault_purge_never_reopens_old_parent_audit() {
    let (env, key, pre, _) = super::incident_tests::fixture(3);
    signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap();
    env.transaction(|db| {
        let mut parent = store::incident::status(db)?.unwrap();
        parent.targets[0].phase = PreparationPhase::Purged;
        incident::save(db, &mut parent)?;
        let mut fresh = parent.targets[0].source.clone();
        fresh.generation.as_mut().unwrap().nonce = vec![99; 32];
        fresh.state = VaultState::Active;
        store::put_header(db, &fresh)?;
        let before = serde_json::to_string(&parent).unwrap();
        incident::purge(db, &[fresh.generation.unwrap()], false)?;
        assert_eq!(
            serde_json::to_string(&store::incident::status(db)?.unwrap()).unwrap(),
            before
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn restore_pipeline_status_alone_does_not_issue_a_capability() {
    let env = fixture();
    restore_admission::begin(&env, request(2)).unwrap();
    let key = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
    let r = GrantRequest {
        operation: vec![11; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        generations: vec![],
        purpose: GrantPurpose::RestorePrepare {
            job: request(2).job,
            target: request(2).target,
        },
    };
    assert!(restore_grants::begin(&env, r).is_err());
}

fn admit_pipeline(env: &TestEnvironment, v: u8) -> ed25519_dalek::SigningKey {
    use ed25519_dalek::Signer;
    let candidate = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
    // signed_fixture uses an authority-only fake registration with ID 41. Give that
    // fixture authority a separate ID before testing actual candidate promotion.
    env.transaction(|db| {
        let mut a = authorization::authorities(db)?;
        for c in &mut a.credentials {
            if c.id == vec![41] {
                c.id = vec![40];
            }
        }
        store::save(db, "authorities", &a)
    })
    .unwrap();
    let current = ed25519_dalek::SigningKey::from_bytes(&[88; 32]);
    env.transaction(|db| {
        if let Ok(mut h) = store::header(db, &[v; 16]) {
            h.recovery_verifier = current.verifying_key().to_bytes().to_vec();
            store::put_header(db, &h)?;
        }
        Ok(())
    })
    .unwrap();
    let ch = restore_admission::begin(env, request(v)).unwrap();
    let ch =
        restore_admission::register(env, request(v).job, registration(&ch, &candidate)).unwrap();
    let j =
        restore_admission::possess(env, request(v).job, passkey_assertion(env, &candidate, &ch))
            .unwrap();
    if j.current_live.is_some() {
        restore_admission::prove_current(
            env,
            request(v).job,
            current.sign(&j.recovery_message).to_bytes().to_vec(),
        )
        .unwrap();
    }
    candidate
}
fn pipeline_grant(
    env: &TestEnvironment,
    key: &ed25519_dalek::SigningKey,
    purpose: GrantPurpose,
) -> (ed25519_dalek::SigningKey, GrantInfo) {
    let signing = ed25519_dalek::SigningKey::from_bytes(&[81; 32]);
    let free = matches!(purpose, GrantPurpose::RestoreCleanup { .. });
    let r = GrantRequest {
        operation: vec![111; 16],
        public_key: signing.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        generations: vec![],
        purpose,
    };
    let ch = restore_grants::begin(env, r.clone()).unwrap();
    let grant =
        restore_grants::finish(env, r.operation, passkey_assertion(env, key, &ch), free).unwrap();
    (signing, grant)
}
fn allocated_pipeline(
    env: &TestEnvironment,
    v: u8,
    key: &ed25519_dalek::SigningKey,
) -> (ed25519_dalek::SigningKey, GrantInfo, Generation) {
    let (signing, grant) = pipeline_grant(
        env,
        key,
        GrantPurpose::RestorePrepare {
            job: request(v).job,
            target: request(v).target,
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
            job: request(v).job,
            generation: target.clone(),
        },
    );
    (signing, grant, target)
}
fn empty_preflight(_env: &TestEnvironment, target: &Generation) -> RestorePreflight {
    RestorePreflight {
        archive_digest: request(target.vault[0]).archive_digest,
        archive_length: 1000,
        source_commitment: request(target.vault[0]).source_commitment,
        target_commitment: store::restore::target_seed(target).unwrap(),
        sequence: 0,
        records: 0,
        objects: 0,
        chunks: 0,
        revision_bytes: 0,
        peak_pending_bytes: 0,
        current_plain_bytes: 0,
        plain_bytes: 0,
        source_saved: true,
        source_fully_verified: true,
    }
}
fn stage_pipeline(
    env: &TestEnvironment,
    v: u8,
    signing: &ed25519_dalek::SigningKey,
    grant: &GrantInfo,
    target: &Generation,
) {
    let e = Envelope {
        version: 2,
        nonce: vec![3; 12],
        ciphertext: vec![4; 48],
    };
    signed_call(
        env,
        signing,
        grant,
        0,
        MutationOperation::RestoreStage {
            normal: e.clone(),
            recovery: e,
            recovery_verifier: ed25519_dalek::SigningKey::from_bytes(&[99; 32])
                .verifying_key()
                .to_bytes()
                .to_vec(),
        },
    )
    .unwrap();
    let p = restore_admission::status(env)
        .unwrap()
        .unwrap()
        .pipeline
        .unwrap();
    signed_call(
        env,
        signing,
        grant,
        1,
        MutationOperation::RestoreConfirmKit {
            envelope_digest: p.envelope_digest,
        },
    )
    .unwrap();
    signed_call(
        env,
        signing,
        grant,
        2,
        MutationOperation::RestorePreflight(empty_preflight(env, target)),
    )
    .unwrap();
    assert_eq!(v, target.vault[0]);
}
#[test]
fn restore_pipeline_empty_absent_requires_kit_and_backup_then_promotes_only_fresh_scope() {
    let env = fixture();
    let key = admit_pipeline(&env, 2);
    let (signing, g, target) = allocated_pipeline(&env, 2, &key);
    assert!(signed_call(&env, &signing, &g, 0, MutationOperation::RestoreBeginImport).is_err());
    stage_pipeline(&env, 2, &signing, &g, &target);
    signed_call(&env, &signing, &g, 3, MutationOperation::RestoreBeginImport).unwrap();
    assert!(signed_call(&env, &signing, &g, 4, MutationOperation::RestoreActivate).is_err());
    let d = restore_pipeline::descriptor(&env, request(2).job, target.clone()).unwrap();
    signed_call(
        &env,
        &signing,
        &g,
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
    signed_call(&env, &signing, &g, 5, MutationOperation::RestoreActivate).unwrap();
    env.transaction(|db| {
        let h = store::header(db, &target.vault)?;
        assert_eq!(h.state, VaultState::Active);
        assert_eq!(h.generation, Some(target.clone()));
        assert_eq!(h.backup_sequence, Some(0));
        let a = authorization::authority(db, &[41])?;
        assert_eq!(
            a.scope,
            CredentialScope::Instances(vec![Instance {
                vault: target.vault.clone(),
                nonce: target.nonce.clone()
            }])
        );
        assert!(!store::transition::pending(db)?);
        Ok(())
    })
    .unwrap();
    assert!(restore_admission::resume(&env, request(2).job).is_err());
    assert!(
        signed_call(
            &env,
            &signing,
            &g,
            6,
            MutationOperation::RestoreCancel { cursor: 0 }
        )
        .is_err()
    );
}

#[test]
fn restore_pipeline_nested_discard_and_activation_preserve_other_frozen_sources() {
    let (env, key, pre, _) = super::incident_tests::fixture(3);
    signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap();
    env.time.set(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    let key = admit_pipeline(&env, 1);
    let parent = env
        .transaction(|db| Ok(store::incident::status(db)?.unwrap()))
        .unwrap();
    let (signing, g, target) = allocated_pipeline(&env, 1, &key);
    stage_pipeline(&env, 1, &signing, &g, &target);
    let current = restore_admission::status(&env)
        .unwrap()
        .unwrap()
        .current_live
        .unwrap();
    let (clean_sign, clean) = pipeline_grant(
        &env,
        &key,
        GrantPurpose::RestoreCleanup {
            job: request(1).job,
            target: request(1).target,
        },
    );
    env.funded.set(false);
    env.cleanup_settled.set(false);
    signed_call(
        &env,
        &clean_sign,
        &clean,
        0,
        MutationOperation::RestoreDiscard {
            current: current.clone(),
            cursor: 0,
        },
    )
    .unwrap();
    env.transaction(|db| {
        assert_eq!(store::header(db, &[1; 16])?.state, VaultState::Purging);
        assert!(store::transition::pending(db)?);
        Ok(())
    })
    .unwrap();
    assert!(
        signed_call(
            &env,
            &clean_sign,
            &clean,
            1,
            MutationOperation::RestoreDerive(IncidentDerive {
                job: request(1).job,
                attempt: request(1).target.attempt,
                role: IncidentRole::Target,
                generation: target.clone(),
                transport: vec![1; 48]
            })
        )
        .is_err()
    );
    env.cleanup_settled.set(true);
    signed_call(
        &env,
        &clean_sign,
        &clean,
        1,
        MutationOperation::RestoreDiscard {
            current: current.clone(),
            cursor: 1,
        },
    )
    .unwrap();
    let after = env
        .transaction(|db| Ok(store::incident::status(db)?.unwrap()))
        .unwrap();
    assert_eq!(after.targets[0].phase, PreparationPhase::Purged);
    assert_eq!(after.targets[0].source.generation, Some(current));
    assert_eq!(
        after.targets[0]
            .restore_child
            .as_ref()
            .map(|c| c.job.clone()),
        Some(request(1).job)
    );
    assert_eq!(
        serde_json::to_string(&after.targets[1..]).unwrap(),
        serde_json::to_string(&parent.targets[1..]).unwrap()
    );
    assert_eq!(after.compromised, parent.compromised);
    env.funded.set(true);
    signed_call(&env, &signing, &g, 3, MutationOperation::RestoreBeginImport).unwrap();
    let d = restore_pipeline::descriptor(&env, request(1).job, target.clone()).unwrap();
    signed_call(
        &env,
        &signing,
        &g,
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
    signed_call(&env, &signing, &g, 5, MutationOperation::RestoreActivate).unwrap();
    env.transaction(|db| {
        assert_eq!(store::header(db, &[1; 16])?.state, VaultState::Active);
        assert!(!store::incident::pinned(db, &[1; 16])?);
        for v in 2..=3 {
            assert!(store::incident::pinned(db, &[v; 16])?);
            assert_eq!(
                store::header(db, &[v; 16])?.state,
                VaultState::IncidentRequired
            );
        }
        assert!(store::incident::owner_change_allowed(db).is_err());
        let parent = incident::load(db, &env)?;
        assert_eq!(parent.targets[0].phase, PreparationPhase::Purged);
        assert_eq!(incident::sources(&parent)?.len(), 2);
        Ok(())
    })
    .unwrap();
    assert!(restore_admission::resume(&env, request(1).job).is_err());
}
#[test]
fn restore_pipeline_preflight_rejects_capacity_and_unsaved_source_before_discard() {
    let env = fixture();
    let key = admit_pipeline(&env, 1);
    let (signing, g, target) = allocated_pipeline(&env, 1, &key);
    stage_pipeline(&env, 1, &signing, &g, &target);
    let mut f = empty_preflight(&env, &target);
    f.source_saved = false;
    assert!(
        signed_call(
            &env,
            &signing,
            &g,
            3,
            MutationOperation::RestorePreflight(f)
        )
        .is_err()
    );
    env.transaction(|db|{let used=store::content::global_usage(db)?;db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,0,X'','[]',1,?3)",params![vec![3u8;16],vec![4u8;16],(TOTAL_MAX-used-300) as i64]).map_err(|_|Error::Storage)?;Ok(())}).unwrap();
    let current = restore_admission::status(&env)
        .unwrap()
        .unwrap()
        .current_live
        .unwrap();
    assert!(matches!(
        signed_call(
            &env,
            &signing,
            &g,
            3,
            MutationOperation::RestoreDiscard { current, cursor: 0 }
        ),
        Err(Error::QuotaExceeded)
    ));
    env.transaction(|db| {
        assert_eq!(store::header(db, &[1; 16])?.state, VaultState::Active);
        Ok(())
    })
    .unwrap();
}
#[test]
fn restore_pipeline_cancel_during_random_waits_for_own_settlement_and_blocks_late_nonce() {
    let env = fixture();
    let candidate = admit_pipeline(&env, 2);
    let (signing, prep) = pipeline_grant(
        &env,
        &candidate,
        GrantPurpose::RestorePrepare {
            job: request(2).job,
            target: request(2).target,
        },
    );
    let (clean_sign, clean) = pipeline_grant(
        &env,
        &candidate,
        GrantPurpose::RestoreCleanup {
            job: request(2).job,
            target: request(2).target,
        },
    );
    let hook_sign = clean_sign.clone();
    let hook_grant = clean.clone();
    *env.random_hook.borrow_mut() = Some(Box::new(move |env| {
        env.funded.set(false);
        signed_call(
            env,
            &hook_sign,
            &hook_grant,
            0,
            MutationOperation::RestoreCancel { cursor: 0 },
        )
        .unwrap();
        let j = restore_admission::status(env).unwrap().unwrap();
        assert!(j.cancel_requested);
        assert!(!j.cancel_complete);
        env.transaction(|db| {
            assert!(store::transition::pending(db)?);
            cleanup::reclaim_empty(db, env.now())?;
            assert!(store::transition::load_state(db)?.restore.is_some());
            Ok(())
        })
        .unwrap();
    }));
    signed_call(&env, &signing, &prep, 0, MutationOperation::RestoreAllocate).unwrap();
    let j = restore_admission::status(&env).unwrap().unwrap();
    assert!(j.pipeline.is_none());
    assert!(!j.cancel_complete);
    signed_call(
        &env,
        &clean_sign,
        &clean,
        1,
        MutationOperation::RestoreCancel { cursor: 0 },
    )
    .unwrap();
    assert!(
        restore_admission::status(&env)
            .unwrap()
            .unwrap()
            .cancel_complete
    );
    assert_eq!(env.derive_calls.get(), 0);
    env.cleanup_settled.set(false);
    signed_call(
        &env,
        &clean_sign,
        &clean,
        2,
        MutationOperation::RestoreCancel { cursor: 0 },
    )
    .unwrap();
    assert!(
        restore_admission::status(&env)
            .unwrap()
            .unwrap()
            .cancel_complete
    );
    env.funded.set(true);
    assert!(matches!(
        restore_admission::begin(&env, request(2)),
        Err(Error::Conflict)
    ));
}

#[test]
fn restore_pipeline_cost_vectors_import_all_records_and_reject_bad_chunks() {
    let env = fixture();
    let raw: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/vault-backup/test/fixtures/restore-cost-vectors.json"
    ))
    .unwrap();
    let mut records = vec![];
    let mut charge = 0;
    let mut peak = 0;
    for x in raw.as_array().unwrap() {
        let mut r = x["record"].clone();
        for k in ["revision", "plain_size", "sequence"] {
            r[k] = serde_json::json!(r[k].as_str().unwrap().parse::<u64>().unwrap());
        }
        let r: Revision = serde_json::from_value(r).unwrap();
        let expected = x["charge"].as_str().unwrap().parse::<u64>().unwrap();
        let pending = x["pending"].as_str().unwrap().parse::<u64>().unwrap();
        assert_eq!(serde_json::to_vec(&r).unwrap().len() as u64, pending);
        charge += expected;
        peak = peak.max(pending);
        records.push(r);
    }
    let key = admit_pipeline(&env, 2);
    env.transaction(|db| {
        let mut j = restore_admission::load(db, &request(2).job)?;
        j.request.records = 2;
        restore_admission::save(db, j)
    })
    .unwrap();
    // The synthetic admitted fixture is updated before the signed grant binds the request.
    let (signing, g, target) = allocated_pipeline(&env, 2, &key);
    let e = Envelope {
        version: 2,
        nonce: vec![3; 12],
        ciphertext: vec![4; 48],
    };
    signed_call(
        &env,
        &signing,
        &g,
        0,
        MutationOperation::RestoreStage {
            normal: e.clone(),
            recovery: e,
            recovery_verifier: ed25519_dalek::SigningKey::from_bytes(&[99; 32])
                .verifying_key()
                .to_bytes()
                .to_vec(),
        },
    )
    .unwrap();
    let digest = restore_admission::status(&env)
        .unwrap()
        .unwrap()
        .pipeline
        .unwrap()
        .envelope_digest;
    signed_call(
        &env,
        &signing,
        &g,
        1,
        MutationOperation::RestoreConfirmKit {
            envelope_digest: digest,
        },
    )
    .unwrap();
    let mut f = empty_preflight(&env, &target);
    f.records = 2;
    f.objects = 2;
    f.chunks = 1;
    f.revision_bytes = charge;
    f.peak_pending_bytes = peak;
    f.sequence = records[1].sequence;
    for r in &records {
        f.target_commitment =
            Sha256::digest([f.target_commitment, store::restore::leaf(r)].concat()).to_vec();
    }
    signed_call(
        &env,
        &signing,
        &g,
        2,
        MutationOperation::RestorePreflight(f.clone()),
    )
    .unwrap();
    signed_call(&env, &signing, &g, 3, MutationOperation::RestoreBeginImport).unwrap();
    let mut bad = records[0].clone();
    bad.sequence = f.sequence + 1;
    assert!(signed_call(&env, &signing, &g, 4, MutationOperation::RestoreRecord(bad)).is_err());
    let mut n = 4;
    for r in &records {
        signed_call(
            &env,
            &signing,
            &g,
            n,
            MutationOperation::RestoreRecord(r.clone()),
        )
        .unwrap();
        n += 1;
        if !r.deleted {
            assert!(
                signed_call(
                    &env,
                    &signing,
                    &g,
                    n,
                    MutationOperation::RestoreChunk {
                        index: 0,
                        data: vec![6; 16]
                    }
                )
                .is_err()
            );
            assert!(
                signed_call(
                    &env,
                    &signing,
                    &g,
                    n,
                    MutationOperation::RestoreConfirmBackup(IncidentBackupAck {
                        descriptor_digest: vec![1; 32],
                        commitment: f.target_commitment.clone(),
                        archive_hash: vec![1; 32],
                        archive_length: 1000,
                        recovery_verifier: vec![1; 32],
                        sequence: f.sequence
                    })
                )
                .is_err()
            );
            signed_call(
                &env,
                &signing,
                &g,
                n,
                MutationOperation::RestoreChunk {
                    index: 0,
                    data: vec![5; 16],
                },
            )
            .unwrap();
            n += 1;
        }
        signed_call(
            &env,
            &signing,
            &g,
            n,
            MutationOperation::RestoreCommitRecord {
                sequence: r.sequence,
            },
        )
        .unwrap();
        n += 1;
    }
    let progress = restore_pipeline::progress(&env, request(2).job, target.clone()).unwrap();
    assert_eq!(progress.count, 2);
    assert_eq!(progress.root, f.target_commitment);
    let d = restore_pipeline::descriptor(&env, request(2).job, target.clone()).unwrap();
    assert_eq!(d.export.sequence, 9007199254740993);
    let page = restore_pipeline::index(&env, request(2).job, target.clone(), 0).unwrap();
    assert_eq!(page.entries.len(), 2);
    assert_eq!(
        store::restore::leaf(&page.entries[1]),
        store::restore::leaf(&records[1])
    );
    env.transaction(|db| {
        let actual: i64 = db
            .query_row("SELECT sum(charge) FROM revisions", params![], |r| {
                kinic_sqlite_compat::row_get(r, 0)
            })
            .unwrap();
        assert_eq!(actual as u64, charge);
        Ok(())
    })
    .unwrap();
}

#[test]
fn restore_pipeline_consumer_revalidates_expiry_and_reissued_proof_invalidates_old_grant() {
    use ed25519_dalek::Signer;
    let env = fixture();
    let candidate = admit_pipeline(&env, 1);
    let (signing, old, target) = allocated_pipeline(&env, 1, &candidate);
    let j = restore_admission::status(&env).unwrap().unwrap();
    env.time.set(j.challenge.expires);
    assert!(matches!(
        signed_call(
            &env,
            &signing,
            &old,
            0,
            MutationOperation::RestoreBeginImport
        ),
        Err(Error::Expired)
    ));
    let ch = restore_admission::resume(&env, j.request.job.clone()).unwrap();
    let j = restore_admission::possess(
        &env,
        j.request.job.clone(),
        passkey_assertion(&env, &candidate, &ch),
    )
    .unwrap();
    let current = ed25519_dalek::SigningKey::from_bytes(&[88; 32]);
    restore_admission::prove_current(
        &env,
        j.request.job.clone(),
        current.sign(&j.recovery_message).to_bytes().to_vec(),
    )
    .unwrap();
    assert!(matches!(
        signed_call(
            &env,
            &signing,
            &old,
            0,
            MutationOperation::RestoreBeginImport
        ),
        Err(Error::Unauthorized)
    ));
    let (signing, g) = pipeline_grant(
        &env,
        &candidate,
        GrantPurpose::RestoreTarget {
            job: j.request.job,
            generation: target.clone(),
        },
    );
    stage_pipeline(&env, 1, &signing, &g, &target);
}
#[test]
fn restore_pipeline_target_derive_rejects_source_role_and_settles_after_upgrade_callback() {
    let env = fixture();
    let candidate = admit_pipeline(&env, 2);
    let (signing, g, target) = allocated_pipeline(&env, 2, &candidate);
    let mut r = IncidentDerive {
        job: request(2).job,
        attempt: request(2).target.attempt,
        role: IncidentRole::Source,
        generation: target,
        transport: ic_bls12_381::G1Affine::generator().to_compressed().to_vec(),
    };
    assert!(
        signed_call(
            &env,
            &signing,
            &g,
            0,
            MutationOperation::RestoreDerive(r.clone())
        )
        .is_err()
    );
    assert_eq!(env.derive_calls.get(), 0);
    r.role = IncidentRole::Target;
    *env.derive_hook.borrow_mut() = Some(Box::new(|env| {
        env.transaction(|db| {
            db.execute(
                "INSERT INTO global_settings VALUES('generation','2')",
                params![],
            )
            .unwrap();
            let mut c = control(db)?;
            c.derive.as_mut().unwrap().token += 1;
            store::save(db, "control", &c)
        })
        .unwrap();
    }));
    signed_call(&env, &signing, &g, 0, MutationOperation::RestoreDerive(r)).unwrap();
    assert_eq!(env.derive_calls.get(), 1);
    assert_eq!(env.settled.get(), Some(30_000_000_000));
    env.transaction(|db| {
        assert!(control(db)?.derive.is_some());
        Ok(())
    })
    .unwrap();
    assert!(
        signed_call(
            &env,
            &signing,
            &g,
            1,
            MutationOperation::KeyResult {
                handle: vec![1; 32]
            }
        )
        .is_err()
    );
}

#[test]
fn restore_pipeline_underclaimed_cost_rolls_back_record_without_growing_reservation() {
    let env = fixture();
    let candidate = admit_pipeline(&env, 2);
    env.transaction(|db| {
        let mut j = restore_admission::load(db, &request(2).job)?;
        j.request.records = 1;
        restore_admission::save(db, j)
    })
    .unwrap();
    let (signing, g, target) = allocated_pipeline(&env, 2, &candidate);
    let e = Envelope {
        version: 2,
        nonce: vec![3; 12],
        ciphertext: vec![4; 48],
    };
    signed_call(
        &env,
        &signing,
        &g,
        0,
        MutationOperation::RestoreStage {
            normal: e.clone(),
            recovery: e,
            recovery_verifier: ed25519_dalek::SigningKey::from_bytes(&[99; 32])
                .verifying_key()
                .to_bytes()
                .to_vec(),
        },
    )
    .unwrap();
    let digest = restore_admission::status(&env)
        .unwrap()
        .unwrap()
        .pipeline
        .unwrap()
        .envelope_digest;
    signed_call(
        &env,
        &signing,
        &g,
        1,
        MutationOperation::RestoreConfirmKit {
            envelope_digest: digest,
        },
    )
    .unwrap();
    let r = Revision {
        vault: target.vault.clone(),
        object: vec![4; 16],
        revision: 1,
        sequence: 1,
        plain_size: 0,
        manifest: vec![],
        chunk_hashes: vec![],
        deleted: true,
    };
    let mut f = empty_preflight(&env, &target);
    f.records = 1;
    f.objects = 1;
    f.revision_bytes = 4096;
    f.peak_pending_bytes = 400;
    f.sequence = 1;
    f.target_commitment =
        Sha256::digest([f.target_commitment, store::restore::leaf(&r)].concat()).to_vec();
    signed_call(
        &env,
        &signing,
        &g,
        2,
        MutationOperation::RestorePreflight(f),
    )
    .unwrap();
    signed_call(&env, &signing, &g, 3, MutationOperation::RestoreBeginImport).unwrap();
    let before = env.transaction(store::content::usage).unwrap();
    assert!(matches!(
        signed_call(&env, &signing, &g, 4, MutationOperation::RestoreRecord(r)),
        Err(Error::QuotaExceeded)
    ));
    assert_eq!(env.transaction(store::content::usage).unwrap(), before);
    assert_eq!(
        restore_pipeline::progress(&env, request(2).job, target.clone())
            .unwrap()
            .count,
        0
    );
    assert!(restore_pipeline::descriptor(&env, request(2).job, target).is_err());
}

fn renew_pipeline(env: &TestEnvironment, candidate: &ed25519_dalek::SigningKey, v: u8) {
    use ed25519_dalek::Signer;
    let ch = restore_admission::resume(env, request(v).job).unwrap();
    let j = restore_admission::possess(env, request(v).job, passkey_assertion(env, candidate, &ch))
        .unwrap();
    if j.current_live.is_some() {
        let current = ed25519_dalek::SigningKey::from_bytes(&[88; 32]);
        restore_admission::prove_current(
            env,
            request(v).job,
            current.sign(&j.recovery_message).to_bytes().to_vec(),
        )
        .unwrap();
    }
}
fn prepare_pipeline(
    env: &TestEnvironment,
    candidate: &ed25519_dalek::SigningKey,
    v: u8,
) -> (ed25519_dalek::SigningKey, GrantInfo) {
    pipeline_grant(
        env,
        candidate,
        GrantPurpose::RestorePrepare {
            job: request(v).job,
            target: request(v).target,
        },
    )
}
#[test]
fn restore_allocation_expired_retry_retains_exact_pending_token_until_cancel_settlement() {
    let env = fixture();
    let candidate = admit_pipeline(&env, 2);
    let (signing, prep) = prepare_pipeline(&env, &candidate, 2);
    let hook_candidate = candidate.clone();
    env.defer_challenge_execution.set(true);
    *env.random_hook.borrow_mut() = Some(Box::new(move |env| {
        let old = restore_admission::status(env).unwrap().unwrap();
        let token = old.allocation_token.unwrap();
        env.time.set(old.challenge.expires + 1);
        renew_pipeline(env, &hook_candidate, 2);
        let (signing, prep) = prepare_pipeline(env, &hook_candidate, 2);
        let before = env
            .transaction(|db| Ok((control(db)?.serial, control(db)?.challenges)))
            .unwrap();
        let reserves = env.challenge_reserves.get();
        let calls = env.random_calls.get();
        signed_call(env, &signing, &prep, 0, MutationOperation::RestoreAllocate).unwrap();
        env.transaction(|db| {
            let g = grants::load(db, &prep.id)?;
            assert!(matches!(g.work.unwrap().result, Some(Err(Error::Busy))));
            assert_eq!((control(db)?.serial, control(db)?.challenges), before);
            assert_eq!(
                restore_admission::load(db, &request(2).job)?.allocation_token,
                Some(token)
            );
            Ok(())
        })
        .unwrap();
        assert_eq!(env.challenge_reserves.get(), reserves);
        assert_eq!(env.random_calls.get(), calls);
        // An unrelated newer reservation and another owner's same token cannot be released.
        env.challenge_rows
            .borrow_mut()
            .insert((env.owner(), token + 1000), (true, 9, 0));
        env.challenge_rows
            .borrow_mut()
            .insert((Principal::anonymous(), token), (true, 8, 0));
        let (signing, clean) = pipeline_grant(
            env,
            &hook_candidate,
            GrantPurpose::RestoreCleanup {
                job: request(2).job,
                target: request(2).target,
            },
        );
        env.funded.set(false);
        signed_call(
            env,
            &signing,
            &clean,
            0,
            MutationOperation::RestoreCancel { cursor: 0 },
        )
        .unwrap();
        env.transaction(|db| {
            assert!(!restore_admission::load(db, &request(2).job)?.cancel_complete);
            assert!(store::transition::pending(db)?);
            // Empty, credential-free namespace would otherwise qualify for reclamation.
            db.execute(
                "DELETE FROM vaults WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",
                params![],
            )
            .map_err(|_| Error::Storage)?;
            assert!(credentials(db)?.is_empty());
            cleanup::reclaim_empty(db, env.now())?;
            assert!(store::transition::load_state(db)?.restore.is_some());
            Ok(())
        })
        .unwrap();
    }));
    signed_call(&env, &signing, &prep, 0, MutationOperation::RestoreAllocate).unwrap();
    let j = restore_admission::status(&env).unwrap().unwrap();
    let token = j.allocation_token.unwrap();
    assert!(j.pipeline.is_none()); // Late T1 never publishes a nonce.
    assert_eq!(
        env.challenge_rows.borrow()[&(env.owner(), token)],
        (false, 1, 0)
    );
    renew_pipeline(&env, &candidate, 2);
    let (signing, clean) = pipeline_grant(
        &env,
        &candidate,
        GrantPurpose::RestoreCleanup {
            job: request(2).job,
            target: request(2).target,
        },
    );
    signed_call(
        &env,
        &signing,
        &clean,
        0,
        MutationOperation::RestoreCancel { cursor: 0 },
    )
    .unwrap();
    assert!(
        !restore_admission::status(&env)
            .unwrap()
            .unwrap()
            .cancel_complete
    );
    env.challenge_rows
        .borrow_mut()
        .get_mut(&(env.owner(), token))
        .unwrap()
        .2 = 1;
    signed_call(
        &env,
        &signing,
        &clean,
        1,
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
        assert!(!store::transition::pending(db)?);
        cleanup::reclaim_empty(db, env.now())?;
        assert!(store::transition::load_state(db)?.restore.is_none());
        Ok(())
    })
    .unwrap();
    assert_eq!(
        env.challenge_rows.borrow()[&(env.owner(), token + 1000)],
        (true, 9, 0)
    );
    assert_eq!(
        env.challenge_rows.borrow()[&(Principal::anonymous(), token)],
        (true, 8, 0)
    );
}

#[test]
fn restore_allocation_retry_after_exact_settlement_or_failed_reservation_succeeds() {
    for failed_reservation in [false, true] {
        let env = fixture();
        let candidate = admit_pipeline(&env, 1);
        let (signing, prep) = prepare_pipeline(&env, &candidate, 1);
        env.fail_challenge_reserve.set(failed_reservation);
        if !failed_reservation {
            env.defer_challenge_execution.set(true);
            *env.random_hook.borrow_mut() = Some(Box::new(|env| {
                env.time.set(
                    restore_admission::status(env)
                        .unwrap()
                        .unwrap()
                        .challenge
                        .expires
                        + 1,
                );
            }));
        }
        signed_call(&env, &signing, &prep, 0, MutationOperation::RestoreAllocate).unwrap();
        let j = restore_admission::status(&env).unwrap().unwrap();
        let token = j.allocation_token.unwrap();
        assert!(j.pipeline.is_none());
        if failed_reservation {
            assert_eq!(env.random_calls.get(), 0);
            assert!(
                !env.challenge_rows
                    .borrow()
                    .contains_key(&(env.owner(), token))
            );
        }
        env.time.set(j.challenge.expires + 1);
        renew_pipeline(&env, &candidate, 1);
        let (signing, prep) = prepare_pipeline(&env, &candidate, 1);
        if !failed_reservation {
            signed_call(&env, &signing, &prep, 0, MutationOperation::RestoreAllocate).unwrap();
            env.transaction(|db| {
                assert!(matches!(
                    grants::load(db, &prep.id)?.work.unwrap().result,
                    Some(Err(Error::Busy))
                ));
                assert_eq!(
                    restore_admission::load(db, &request(1).job)?.allocation_token,
                    Some(token)
                );
                Ok(())
            })
            .unwrap();
            env.challenge_rows
                .borrow_mut()
                .get_mut(&(env.owner(), token))
                .unwrap()
                .2 = 1;
        }
        env.challenge_rows
            .borrow_mut()
            .insert((env.owner(), token + 1000), (true, 9, 0));
        env.defer_challenge_execution.set(false);
        let (signing, prep) = prepare_pipeline(&env, &candidate, 1);
        signed_call(&env, &signing, &prep, 0, MutationOperation::RestoreAllocate).unwrap();
        let j = restore_admission::status(&env).unwrap().unwrap();
        assert!(j.pipeline.is_some());
        assert_ne!(j.allocation_token, Some(token));
        assert_eq!(
            env.challenge_rows.borrow()[&(env.owner(), token + 1000)],
            (true, 9, 0)
        );
        assert_eq!(
            env.random_calls.get(),
            if failed_reservation { 1 } else { 2 }
        );
    }
}

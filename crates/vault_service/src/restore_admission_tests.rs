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

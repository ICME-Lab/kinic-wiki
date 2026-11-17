use super::*;

// Decode the public shape so the initial RED exercises an absent action at runtime.
fn inline(e: &Env, size: usize) -> Action {
    let h = e.transaction(|db| store::active(db, &vault_id(1))).unwrap();
    let bytes = vec![7u8; size + 16];
    serde_json::from_value(serde_json::json!({"SaveInline": {
        "request": {"vault": vault_id(1), "object": vec![3u8;16],
            "operation": vec![4u8;16], "expected_revision": 0, "plain_size": size,
            "manifest": vec![1u8;64], "chunk_hashes": [Sha256::digest(&bytes).to_vec()]},
        "bytes": bytes,
        "context_hash": Sha256::digest(key_input(e.canister(), e.owner(), &h).unwrap()).to_vec()
    }}))
    .expect("SaveInline wire action must be supported")
}
fn snapshot(e: &Env) -> Vec<(String, i64)> {
    let db = e.db.borrow();
    [
        "vaults",
        "operations",
        "uploads",
        "chunks",
        "revisions",
        "revision_chunks",
        "objects",
        "upload_outcomes",
    ]
    .into_iter()
    .map(|t| {
        (
            t.into(),
            db.query_row(&format!("SELECT count(*) FROM {t}"), params![], |r| {
                sql::row_get(r, 0)
            })
            .unwrap(),
        )
    })
    .collect()
}
#[test]
fn inline_commits_empty_and_boundary_and_exact_replay() {
    for size in [0, NOTE_MAX as usize] {
        let e = Env::new();
        e.create();
        let action = inline(&e, size);
        let result = e.change(5, action.clone()).unwrap();
        let MutationResult::Revision(rev) = result else {
            panic!("revision receipt")
        };
        assert_eq!(rev.plain_size, size as u64);
        assert_eq!(rev.sequence, 1);
        assert_eq!(
            e.transaction(|db| store::content::chunk(db, &vault_id(1), &[3; 16], 1, 0))
                .unwrap(),
            vec![7u8; size + 16]
        );
        let before = snapshot(&e);
        e.funded.set(false);
        assert!(
            matches!(e.change(5, action.clone()).unwrap(), MutationResult::Revision(r) if r.revision == 1)
        );
        assert_eq!(snapshot(&e), before);
        e.funded.set(true);
        assert!(matches!(e.change(6, action), Err(Error::Conflict)));
        assert_eq!(snapshot(&e), before);
    }
}
#[test]
fn inline_rejects_invalid_context_payload_revision_and_rolls_back() {
    for field in [
        "context",
        "hash",
        "length",
        "size",
        "manifest",
        "revision",
        "chunks",
        "owner",
        "inactive",
        "funding",
        "commit_failure",
        "receipt_failure",
    ] {
        let e = Env::new();
        e.create();
        let mut a = inline(&e, 1);
        if let Action::SaveInline(ref mut r) = a {
            match field {
                "context" => r.context_hash[0] ^= 1,
                "hash" => r.bytes[0] ^= 1,
                "length" => {
                    r.bytes.pop();
                }
                "size" => r.request.plain_size = NOTE_MAX + 1,
                "manifest" => r.request.manifest = vec![1; 65537],
                "revision" => r.request.expected_revision = 1,
                "chunks" => r.request.chunk_hashes.push(vec![0; 32]),
                _ => (),
            }
        }
        match field {
            "owner" => e.owner.set(Principal::from_slice(&[8])),
            "inactive" => {e.transaction(|db| {let mut h = store::header(db,&vault_id(1))?; h.state=VaultState::Deleting;store::put_header(db,&h)}).unwrap();},
            "funding" => e.funded.set(false),
            "commit_failure" => e.db.borrow().execute_batch("CREATE TRIGGER fail_inline BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap(),
            "receipt_failure" => e.db.borrow().execute_batch("CREATE TRIGGER fail_inline_receipt BEFORE UPDATE OF result ON operations WHEN NEW.result IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap(),
            _ => (),
        }
        let before = snapshot(&e);
        assert!(e.change(5, a).is_err(), "{field}");
        assert_eq!(snapshot(&e), before, "{field}");
        assert_eq!(
            e.db.borrow()
                .query_row(
                    "SELECT json_extract(header,'$.sequence') FROM vaults",
                    params![],
                    |r| sql::row_get::<i64>(r, 0)
                )
                .unwrap(),
            0
        );
    }
}
#[test]
fn inline_conflicting_replay_cannot_change_payload_or_target() {
    let e = Env::new();
    e.create();
    let action = inline(&e, 1);
    e.change(5, action.clone()).unwrap();
    let before = snapshot(&e);
    for field in ["bytes", "manifest", "target", "context", "operation"] {
        let mut changed = action.clone();
        if let Action::SaveInline(ref mut r) = changed {
            match field {
                "bytes" => r.bytes[0] ^= 1,
                "manifest" => r.request.manifest[0] ^= 1,
                "target" => r.request.object[0] ^= 1,
                "context" => r.context_hash[0] ^= 1,
                "operation" => r.request.operation[0] ^= 1,
                _ => unreachable!(),
            }
        }
        assert!(
            matches!(e.change(5, changed), Err(Error::Conflict)),
            "{field}"
        );
        assert_eq!(snapshot(&e), before);
    }
}
#[test]
fn inline_cannot_bypass_full_capacity_or_adopt_existing_upload() {
    for remaining in [0, ops::CHARGE + 1] {
        let e = Env::new();
        e.create();
        let action = inline(&e, 1);
        e.transaction(|db| {
            let fill=TOTAL_MAX-store::content::global_usage(db)?-remaining;
            db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vault_id(1),vec![99u8;16],vec![0u8;64],fill as i64]).unwrap(); Ok(())
        }).unwrap();
        let before = snapshot(&e);
        assert!(matches!(e.change(5, action), Err(Error::QuotaExceeded)));
        assert_eq!(snapshot(&e), before);
    }
    let e = Env::new();
    e.create();
    e.begin();
    let before = snapshot(&e);
    assert!(matches!(e.change(6, inline(&e, 1)), Err(Error::Conflict)));
    assert_eq!(snapshot(&e), before);
}
#[test]
fn inline_checks_all_immutable_context_inputs_and_authentication() {
    for field in ["canister", "owner", "vault", "nonce", "key_name"] {
        let e = Env::new();
        let mut h = e.create();
        let mut canister = e.canister();
        let mut owner = e.owner();
        match field {
            "canister" => canister = Principal::from_slice(&[7]),
            "owner" => owner = Principal::from_slice(&[7]),
            "vault" => h.id[0] ^= 1,
            "nonce" => h.nonce[0] ^= 1,
            "key_name" => h.key_name = "other-key".into(),
            _ => unreachable!(),
        }
        let mut action = inline(&e, 1);
        if let Action::SaveInline(ref mut r) = action {
            r.context_hash = Sha256::digest(key_input(canister, owner, &h).unwrap()).to_vec();
        }
        let before = snapshot(&e);
        assert!(
            matches!(e.change(5, action), Err(Error::InvalidInput)),
            "{field}"
        );
        assert_eq!(snapshot(&e), before);
    }
    let e = Env::new();
    e.create();
    let action = inline(&e, 1);
    let before = snapshot(&e);
    e.owner.set(Principal::anonymous());
    assert!(matches!(e.change(5, action), Err(Error::Unauthorized)));
    assert_eq!(snapshot(&e), before);
}
#[test]
fn inline_optimistic_updates_and_old_replay_preserve_committed_revision() {
    let e = Env::new();
    e.create();
    let first = inline(&e, 1);
    e.change(5, first.clone()).unwrap();
    let mut second = inline(&e, 1);
    if let Action::SaveInline(ref mut r) = second {
        r.request.operation = vec![6; 16];
        r.request.expected_revision = 1;
    }
    assert!(
        matches!(e.change(7,second.clone()).unwrap(),MutationResult::Revision(r) if r.revision==2 && r.sequence==2)
    );
    let before = snapshot(&e);
    assert!(
        matches!(e.change(5,first).unwrap(),MutationResult::Revision(r) if r.revision==1 && r.sequence==1)
    );
    assert_eq!(snapshot(&e), before);
    if let Action::SaveInline(ref mut r) = second {
        r.request.operation = vec![8; 16];
    }
    assert!(matches!(e.change(9, second), Err(Error::Conflict)));
    assert_eq!(snapshot(&e), before);
}
#[test]
fn inline_respects_shared_receipt_row_capacity() {
    let e = Env::new();
    e.create();
    let action = inline(&e, 1);
    e.db.borrow().execute_batch("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999) INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,admission) SELECT X'50',CAST(printf('%016d',x) AS BLOB),zeroblob(32),X'00',86400,x,0,0 FROM n;").unwrap();
    let before = snapshot(&e);
    assert!(matches!(e.change(5, action), Err(Error::QuotaExceeded)));
    assert_eq!(snapshot(&e), before);
}
#[test]
fn frozen_pre_inline_mutation_receipts_replay_after_upgrade() {
    // Bytes generated from actual 82f03ce7 Rust types with candid 0.10.26, not a legacy type in
    // this test or the digest implementation. They include the old variant table.
    for (wire, digest, result) in [
        (
            include_str!("fixtures/mutation-v1-collect.hex"),
            "8be5626aa910463cf609f0413aefd25846f1ebd731a01bc20b3642845c6ab316",
            MutationResult::Collected(42),
        ),
        (
            include_str!("fixtures/mutation-v1-commit.hex"),
            "da26f07e214704bc4f3c05e7cda3f2950456026055f8af09691b54507042dd64",
            MutationResult::Revision(Revision {
                vault: vec![1; 16],
                object: vec![3; 16],
                revision: 1,
                plain_size: 1,
                manifest: vec![1; 64],
                chunk_hashes: vec![vec![2; 32]],
                deleted: false,
                sequence: 1,
            }),
        ),
        (
            include_str!("fixtures/mutation-v1-cancel.hex"),
            "9ec4a7c83d4cc85cba9d18cdd8135a2f78b610197b128aaf2993a8244cb521e6",
            MutationResult::Progress(true),
        ),
    ] {
        let e = Env::new();
        let wire = hex::decode(wire.trim()).unwrap();
        assert_eq!(
            hex::encode(Sha256::digest([b"mutation/v1".as_slice(), &wire].concat())),
            digest
        );
        let mut request: Mutation = candid::decode_one(&wire).unwrap();
        let expected = candid::encode_one(&result).unwrap();
        e.transaction(|db| {
            db.execute("INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,admission) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,?3,?4,77,0,0)",params![request.operation,hex::decode(digest).unwrap(),expected,(e.now()+DAY) as i64]).unwrap();Ok(())
        }).unwrap();
        e.funded.set(false);
        let before = snapshot(&e);
        let replayed = mutate(&e, request.clone()).expect("legacy receipt must replay");
        assert_eq!(candid::encode_one(replayed).unwrap(), expected);
        assert_eq!(snapshot(&e), before);
        match &mut request.action {
            Action::CommitRevision { upload } => upload[0] ^= 1,
            Action::CancelUpload { job, .. } => job[0] ^= 1,
            _ => continue,
        }
        assert!(matches!(mutate(&e, request), Err(Error::Conflict)));
        assert_eq!(snapshot(&e), before);
    }
}
#[test]
fn ambiguous_inline_replay_can_conflict_after_outer_receipt_gc() {
    for collect_outcome in [false, true] {
        let e = Env::new();
        e.create();
        let request = inline(&e, 1);
        e.change(5, request.clone()).unwrap();
        e.now.set(e.now() + DAY + 1);
        e.transaction(|db| {
            ops::collect(db, e.now())?;
            if collect_outcome {
                store::content::collect_expired_upload_outcomes(db, e.now())?;
            }
            Ok(())
        })
        .unwrap();
        let before = snapshot(&e);
        assert!(matches!(e.change(5, request.clone()), Err(Error::Conflict)));
        assert!(matches!(e.change(5, request), Err(Error::Conflict)));
        assert_eq!(snapshot(&e), before);
        assert_eq!(
            e.transaction(|db| store::content::manifest(db, &vault_id(1), &[3; 16], 1))
                .unwrap()
                .revision,
            1
        );
    }
}

#[test]
fn inline_digest_has_a_frozen_action_specific_domain() {
    #[derive(candid::CandidType, serde::Deserialize)]
    struct InlineV1 {
        operation: Id,
        request: SaveInline,
    }
    let wire = hex::decode(include_str!("fixtures/save-inline-v1.hex").trim()).unwrap();
    let fixture: InlineV1 = candid::decode_one(&wire).unwrap();
    let expected = "fbd36cfb6432e5a91f06e8c4f84ca73157da022edce3b56b77238625a715ce15";
    assert_eq!(
        hex::encode(Sha256::digest(
            [b"save-inline/v1".as_slice(), &wire].concat()
        )),
        expected
    );
    let request = Mutation {
        operation: fixture.operation,
        action: Action::SaveInline(fixture.request),
    };
    assert_eq!(
        hex::encode(ops::mutation_digest(&request).unwrap()),
        expected
    );
    assert_ne!(
        ops::mutation_digest(&request).unwrap(),
        ops::digest(b"mutation/v1", &request).unwrap()
    );
}

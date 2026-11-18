use super::*;

fn request(action: Action) -> Mutation {
    Mutation {
        operation: b"0123456789abcdef".to_vec(),
        action,
    }
}
fn put() -> Mutation {
    request(Action::PutChunk {
        upload: b"fedcba9876543210".to_vec(),
        index: 0,
        bytes: vec![7; 17],
    })
}
fn delete() -> Mutation {
    request(Action::DeleteVault {
        vault: b"fedcba9876543210".to_vec(),
    })
}
// Golden hashes from the independently encoded, released nine-variant Action
// and the interim ten-variant Action. Do not regenerate with the current enum.
const V1_PUT: &str = "62fb44c0c62b42d5768d0844cb84f9e055ce925a0938a856926a4ec2bff68107";
const V1_DELETE: &str = "2b816d6ee933a5f35eaf5379496bd42f9e5eec5347b2454279697006971dfc00";
const V2_PUT: &str = "3f23b9c2ee095e8eab4e10effc0796dee46c26b671e18ddcdb5f63f1f8b25790";
const V2_DELETE: &str = "e639c642c0bdd3c147deccd8a3335584817da0a6187af64490ea6602e8704f6d";
const V2_RENAME: &str = "5a2ade4a4ef51364b67b12a6c5eab6458efc6f51e02b5d4c50e021c9376d2d5c";

fn receipt(e: &Env, request: &Mutation, hash: &str, result: &MutationResult) {
    e.transaction(|db| {
        let digest = hex::decode(hash).unwrap();
        let token = ops::begin(db, &request.operation, &digest, e.now())?;
        ops::complete(db, &request.operation, token, result, e.now())
    })
    .unwrap();
}

#[test]
fn replays_pre_rename_receipts_without_repeating_work_or_requiring_credit() {
    for (r, hash, result) in [
        (put(), V1_PUT, MutationResult::Done),
        (delete(), V1_DELETE, MutationResult::Progress(true)),
    ] {
        let e = Env::new();
        receipt(&e, &r, hash, &result);
        e.funded.set(false);
        assert_eq!(
            candid::encode_one(mutate(&e, r).unwrap()).unwrap(),
            candid::encode_one(result).unwrap()
        );
    }
}

#[test]
fn replays_interim_receipts_including_rename() {
    let rename = request(Action::RenameVault {
        vault: b"fedcba9876543210".to_vec(),
        name: "Work".into(),
        expected_sequence: 7,
    });
    for (r, hash, result) in [
        (put(), V2_PUT, MutationResult::Done),
        (delete(), V2_DELETE, MutationResult::Progress(true)),
        (rename, V2_RENAME, MutationResult::Done),
    ] {
        let e = Env::new();
        receipt(&e, &r, hash, &result);
        e.funded.set(false);
        assert_eq!(
            candid::encode_one(mutate(&e, r).unwrap()).unwrap(),
            candid::encode_one(result).unwrap()
        );
    }
}

#[test]
fn legacy_receipts_keep_payload_owner_and_expiry_checks() {
    for hash in [V1_PUT, V2_PUT] {
        let e = Env::new();
        receipt(&e, &put(), hash, &MutationResult::Done);
        let altered = request(Action::PutChunk {
            upload: b"fedcba9876543210".to_vec(),
            index: 0,
            bytes: vec![8; 17],
        });
        assert!(matches!(mutate(&e, altered), Err(Error::Conflict)));
        e.owner.set(Principal::from_slice(&[2]));
        assert!(matches!(mutate(&e, put()), Err(Error::NotFound)));
        e.owner.set(Principal::anonymous());
        assert!(matches!(mutate(&e, put()), Err(Error::Unauthorized)));
        e.owner.set(Principal::from_slice(&[1]));
        e.now.set(100 + DAY + 1);
        assert!(matches!(mutate(&e, put()), Err(Error::Expired)));
    }
}

#[test]
fn resumes_legacy_pending_admission_after_an_upgrade() {
    for hash in [V1_PUT, V2_PUT] {
        let e = Env::new();
        e.create();
        let upload = BeginRevision {
            vault: vault_id(1),
            object: vec![9; 16],
            operation: b"fedcba9876543210".to_vec(),
            expected_revision: 0,
            plain_size: 1,
            manifest: vec![1; 64],
            chunk_hashes: vec![Sha256::digest(vec![7; 17]).to_vec()],
        };
        e.change(50, Action::BeginRevision(upload)).unwrap();
        let r = put();
        e.transaction(|db| {
        ops::begin(db, &r.operation, &hex::decode(hash).unwrap(), e.now())?;
        db.execute("UPDATE operations SET runtime=-1 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1", params![r.operation]).unwrap();
        Ok(())
    }).unwrap();
        assert!(matches!(mutate(&e, r.clone()), Ok(MutationResult::Done)));
        assert!(matches!(mutate(&e, r), Ok(MutationResult::Done)));
    }
}

#[test]
fn completed_commit_is_replayed_after_its_upload_has_been_removed() {
    let e = Env::new();
    e.create();
    let upload = BeginRevision {
        vault: vault_id(1),
        object: vec![9; 16],
        operation: b"fedcba9876543210".to_vec(),
        expected_revision: 0,
        plain_size: 1,
        manifest: vec![1; 64],
        chunk_hashes: vec![Sha256::digest(vec![7; 17]).to_vec()],
    };
    e.change(50, Action::BeginRevision(upload.clone())).unwrap();
    e.change(51, put().action).unwrap();
    let r = request(Action::CommitRevision {
        upload: upload.operation,
    });
    let expected = candid::encode_one(mutate(&e, r.clone()).unwrap()).unwrap();
    e.funded.set(false);
    // Pre-rename and interim CommitRevision hashes for this exact request.
    for hash in [
        "f1490a5a772096a87e5615d4f8c1f377a1c21339bd5b18eaf8e9c2111301c3f9",
        "648a4c3b334ef17de85e693fbc7cdafc586fb2cc6467559379197c83f58f0972",
    ] {
        e.transaction(|db| {
            db.execute("UPDATE operations SET digest=?2 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1", params![r.operation, hex::decode(hash).unwrap()]).unwrap();
            Ok(())
        }).unwrap();
        assert_eq!(
            candid::encode_one(mutate(&e, r.clone()).unwrap()).unwrap(),
            expected
        );
    }
    assert_eq!(
        e.transaction(|db| store::header(db, &vault_id(1)))
            .unwrap()
            .sequence,
        1
    );
}

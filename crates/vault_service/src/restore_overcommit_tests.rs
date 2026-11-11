//! Prepaid replacements remain bounded and local to the selected owner.
use super::*;

#[test]
fn overcommitted_prepaid_slots_keep_size_owner_and_allocation_guards() {
    let env = fixture();
    let candidate = admit_pipeline(&env, 2);
    let (_, info, _) = allocated_pipeline(&env, 2, &candidate);
    let (mut grant, credential) = env
        .transaction(|db| {
            let grant = grants::load(db, &info.id)?;
            let admission = restore_admission::load(db, &request(2).job)?;
            let credential: passkey_auth::PasskeyCredential =
                serde_json::from_str(admission.candidate.as_ref().unwrap()).unwrap();
            let filler = TOTAL_MAX + 524288 - store::content::global_usage(db)?;
            db.execute(
                "INSERT INTO revisions VALUES(?1,?2,?3,1,1,NULL,0,X'','[]',1,?4)",
                params![
                    Principal::self_authenticating([219; 32]).as_slice(),
                    vec![218u8; 16],
                    vec![217u8; 16],
                    filler as i64
                ],
            )
            .unwrap();
            Ok((grant, credential))
        })
        .unwrap();
    grant.info.id = vec![201; 32];
    let used = env.transaction(store::content::global_usage).unwrap();
    let mut oversized = grant.clone();
    oversized.last_digest = vec![0; 65536];
    assert_eq!(
        env.transaction(|db| grants::save(db, &oversized)),
        Err(Error::QuotaExceeded)
    );
    let mut large_credential = credential.clone();
    large_credential.id.0 = vec![0; 65536];
    assert_eq!(
        env.transaction(|db| insert_credential(db, &large_credential)),
        Err(Error::QuotaExceeded)
    );
    env.transaction(|db| {
        // The other owner has no charged slots and cannot borrow this owner's.
        store::OwnerContext::authenticated(Principal::self_authenticating([222; 32]))?.run(
            db,
            |db| {
                assert_eq!(grants::save(db, &grant), Err(Error::QuotaExceeded));
                assert_eq!(
                    insert_credential(db, &credential),
                    Err(Error::QuotaExceeded)
                );
                Ok(())
            },
        )
    })
    .unwrap();
    env.transaction(|db| {
        assert_eq!(store::content::global_usage(db)?, used);
        grants::save(db, &grant)?;
        insert_credential(db, &credential)?;
        assert_eq!(store::content::global_usage(db)?, used);
        assert_eq!(insert_credential(db, &credential), Err(Error::Conflict));
        let physical = credentials(db)?.len();
        for n in physical..10 {
            let mut c = credential.clone();
            c.id.0 = vec![n as u8 + 100];
            insert_credential(db, &c)?;
        }
        let mut extra = credential.clone();
        extra.id.0 = vec![255];
        assert_eq!(insert_credential(db, &extra), Err(Error::QuotaExceeded));
        assert_eq!(credentials(db)?.len(), 10);
        assert_eq!(store::content::global_usage(db)?, used);
        Ok(())
    })
    .unwrap();
}

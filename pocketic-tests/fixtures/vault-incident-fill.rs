// Used only by an isolated test build. Production has no seeding method or upgrade argument.
fn post_upgrade() {
    initialize();
    state::transaction(|db| {
        let owner=candid::Principal::self_authenticating([88;32]);
        vault_store::OwnerContext::authenticated(owner)?.run(db,|db|{
            db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,0,?3,'[]',1,0)",kinic_sqlite_compat::params![vec![88u8;16],vec![89u8;16],Vec::<u8>::new()]).unwrap();
            let remaining=vault_types::TOTAL_MAX-vault_store::content::global_usage(db)?;
            db.execute("UPDATE revisions SET charge=?1 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",kinic_sqlite_compat::params![remaining as i64]).unwrap();
            assert_eq!(vault_store::content::global_usage(db)?,vault_types::TOTAL_MAX);
            Ok(())
        })
    }).unwrap();
}

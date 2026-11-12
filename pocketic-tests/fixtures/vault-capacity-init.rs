// Test-only initial v6 account population. Every row respects production guards.
fn init(seed_accounts: u16) {
    initialize();
    assert!(seed_accounts <= 1024);
    state::transaction(|db| {
        for n in 0..u32::from(seed_accounts) {
            let owner = candid::Principal::self_authenticating(n.to_be_bytes());
            db.execute("INSERT INTO accounts VALUES(?1,1,0,0)", kinic_sqlite_compat::params![owner.to_text()]).unwrap();
        }
        Ok(())
    }).unwrap();
}

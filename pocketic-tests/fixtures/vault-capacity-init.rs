// Injected only into an isolated archive of the immutable Task5 source.
// No seeding entrypoint exists in the production Wasm or its Candid contract.
fn init(seed_accounts: u16, overcommit: bool) {
    initialize();
    assert!(seed_accounts <= 5000);
    state::transaction(|db| {
        for n in 0..u32::from(seed_accounts) {
            let owner = candid::Principal::self_authenticating(n.to_be_bytes());
            db.execute("INSERT INTO accounts VALUES(?1,1,0,0)", kinic_sqlite_compat::params![owner.to_text()]).unwrap();
        }
        Ok(())
    }).unwrap();
    if overcommit {
        state::State.vault_set_config(Some(vault_types::VaultConfig {
            origin: "https://vault.kinic.xyz".into(), rp_id: "vault.kinic.xyz".into(),
            key_name: "key_1".into(), minimum_cycles: 100_000_000_000,
        })).unwrap();
        state::transaction(|db| {
            let owner = candid::Principal::self_authenticating([90;32]);
            vault_store::OwnerContext::authenticated(owner)?.run(db,|db| {
                use sha2::{Digest,Sha256};
                use vault_types::*;
                let now=ic_cdk::api::time()/1_000_000_000;
                let mut header=vault_store::reserve(db,owner,Reserve { vault:vec![1;16], operation:vec![2;16] },now)?;
                header.state=VaultState::Active;
                vault_store::put_header(db,&header)?;
                db.execute("UPDATE vaults SET expires=0",kinic_sqlite_compat::params![]).unwrap();
                let cipher=vec![7;17];
                vault_store::content::begin(db,BeginRevision {
                    vault:vec![1;16],object:vec![3;16],operation:vec![4;16],expected_revision:0,
                    plain_size:1,manifest:vec![99],chunk_hashes:vec![Sha256::digest(&cipher).to_vec()],
                },now)?;
                vault_store::content::put(db,&[4;16],0,&cipher,now)?;
                vault_store::content::commit(db,&[4;16],now)?;
                for n in [5u8,6] {
                    vault_store::content::begin_export(db,&[1;16],&[n;16],now)?;
                    vault_store::content::finish_export(db,&[n;16],true,now)?;
                }
                // Synthetic logical charge models an old database within 200MiB,
                // above the new 184MiB content allowance; no 188MiB blob is needed.
                db.execute("UPDATE revisions SET charge=?1",kinic_sqlite_compat::params![188i64*1024*1024]).unwrap();
                Ok(())
            })
        }).unwrap();
    }
}

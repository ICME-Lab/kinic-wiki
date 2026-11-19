This source fixture freezes the Vault backend at PR #177 commit
`3dfb57915eba0acc462c7439a7023e8e4dde90d2` to test downgrade rejection independently
of squash-merge history. Its original `LICENSE` is included.

`vault-schema9-pr177-source.tar.gz` is a gzip archive of `git archive --format=tar`
for that commit with these paths: `LICENSE`, `Cargo.toml`, `Cargo.lock`,
`rust-toolchain.toml`, and `crates/{vault_canister,vault_service,vault_store,vault_types,kinic_sqlite_compat}`.
Gzip has a zero modification timestamp. SHA256:
`182ba86820d373a8a94f8e4977ed42e2709195741489a21d2be033f3daf130a9`.

`build-vault-schema9-baseline.mjs` checks the archive hash before extraction,
restricts workspace membership to those crates, and removes the unused ic-agent
workspace patch. It compiles the original canister code without assets or test
exports, offline using the frozen lockfile. No current schema code is substituted.
The source archive, original/effective lockfiles, and resulting Wasm hashes are
recorded in `target/vault-schema9-baseline/source.json`.

The integration test upgrades that real schema-9 Wasm to the current canister,
creates Prepared and Accepted receipts through real Wiki cycles transfers, and
requires a subsequent downgrade to the predecessor to fail. Both receipts and the
balance must survive; the prepared transfer must still settle exactly once.
All execution is local PocketIC, with no production deployment or live funds.

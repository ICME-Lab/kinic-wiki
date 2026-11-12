Imported from the user-approved `kinic-vault` working tree based on commit
`a998092256b031308161351fca51cdc8fac7446d`; exact upstream file digests are in
`docs/vault/source-snapshot.json`. `src/auth.rs` and the state machines in
`src/lib.rs` originate from `crates/vault-canister`. SQLite storage and wire types
are imported into the adjacent `vault_store` and `vault_types` crates. The shared
Wiki `kinic_sqlite_compat` is reused. Upstream AES-GCM vector and real Ed25519
WebAuthn fixture generation are retained for verification.

The embedded service receives authenticated ownership, storage transactions,
time, balance, billing and management calls through `runtime::Environment`.
Each synchronous storage transaction establishes and clears `OwnerContext`.
Every owner table uses a composite owner primary key, and SQL visibly scopes
individual relations and write predicates. Scope is never accepted in a request,
never recovered from a previous transaction, and never retained across `await`.
Global quotas and key-service journals explicitly use unscoped aggregate queries.

The `vendor/passkey-auth` code retains its upstream licenses and NOTICE. No
standalone Vault MemoryManager, login, development origin restriction or owner
init argument is embedded in the Wiki canister.

The original working-tree patch is retained in immutable Git history rather than
in the current source tree. `source-snapshot.json` records its archive commit,
path and SHA-256. Retrieve it with `git show <archive.commit>:<archive.path>`;
verify that SHA-256 before applying it to the upstream base. The original
93-file reconstruction evidence and per-file digests remain unchanged.

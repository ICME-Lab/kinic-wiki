# ic-agent compatibility patch

This directory contains the published `ic-agent` 0.49.2 source from
<https://crates.io/crates/ic-agent/0.49.2>, under the included Apache-2.0 license.

- Upstream repository: <https://github.com/dfinity/agent-rs>
- Upstream revision: `5053d3585eb829eb8e75ad1099ad8a4a19721099`, subdirectory `ic-agent`
- Published archive SHA-256: `1f9086b59107b6d6485a915762a2a3986ef208e80bb40eff22d099bbcd71deea`
- The upstream normalized `Cargo.toml`, `README.md`, and complete `src/` are retained.
  Registry cache metadata and the upstream workspace lockfile are omitted.

## Reason and local changes

`ic-agent` 0.49.3 still requires RustCrypto 0.13, which pulls in
`crypto-bigint` 0.5.5, affected by
<https://rustsec.org/advisories/RUSTSEC-2026-0387.html>.
The root workspace applies this source through `[patch.crates-io]` so both CLI
dependencies use the same agent and the same updated cryptographic types.

Local changes are confined to:

- `Cargo.toml`: use `elliptic-curve` 0.14.3, `ecdsa` 0.17, `k256`/`p256` 0.14,
  `pkcs8` 0.11 and `sec1` 0.8; include the local license. The root lockfile
  resolves `crypto-bigint` 0.7.9. Earlier 0.7.6–0.7.8 releases are yanked.
  Remove unused `serde_repr`. Mark `ic_principal` as a dependency-check exception:
  its `rangemap` feature supplies `StepLite` for candid's re-exported principal,
  so it is required even without a direct import (removal fails compilation).
- `src/identity/basic.rs` and `src/identity/mod.rs`: use the borrowed PKCS#8
  structure and explicit octet-string bytes introduced by the new ASN.1 API.
- `src/identity/secp256k1.rs` and `src/identity/prime256v1.rs`: adapt the PKCS#8
  type and malformed-key error constructor.
- `src/identity/delegated.rs`: use the renamed SEC1 public-key conversion API.

Cryptographic arithmetic, hashing, nonce generation, and signature formats are
implemented by the upstream RustCrypto releases; no arithmetic is backported.

## Validation and removal

`crates/vfs_client/tests/identity_compat.rs` covers SEC1 (with/without parameters),
PKCS#8, fixed public keys/principals, 64-byte ECDSA signatures and tampering,
checked EC delegation chains, wrong curves/malformed keys, and the RFC 8032
Ed25519 test vector. The CLI's existing Internet Identity session tests also run.

Build/release the CLI from the repository root with `--locked`, where this patch
and the lockfile apply. This local dependency override is not a published
replacement for upstream `ic-agent`.

Remove this directory and the root patch when an upstream agent release supports
the fixed RustCrypto family. Repeat the identity compatibility tests and verify
that no affected `crypto-bigint` version reappears in the resolved dependency tree.

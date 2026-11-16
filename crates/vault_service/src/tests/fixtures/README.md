# Frozen mutation identity fixtures

`mutation-v1-{collect,commit,cancel}.hex` are the exact Rust Candid wire bytes
produced using `crates/vault_types/src/lib.rs` from Git commit `82f03ce7` and
`candid = 0.10.26`. Their operation is sixteen bytes of5; commit upload is
sixteen bytes of4; cancellation vault/upload/job are respectively1/4/6.
Only the unused `pub mod capacity` line was omitted when compiling the old
source in a standalone fixture generator. The test does not regenerate these
bytes from the frozen legacy type used by the implementation.

SHA256(`mutation/v1` || bytes):

- Collect (212 bytes): `8be5626aa910463cf609f0413aefd25846f1ebd731a01bc20b3642845c6ab316`
- CommitRevision (229 bytes): `da26f07e214704bc4f3c05e7cda3f2950456026055f8af09691b54507042dd64`
- CancelUpload (263 bytes): `9ec4a7c83d4cc85cba9d18cdd8135a2f78b610197b128aaf2993a8244cb521e6`

JavaScript IDL encoders can order equivalent Candid type tables differently.
For example, the semantically identical old Collect JS encoding hashes to
`aecea5c506542f1ef1554ec2c6c6b09aa23c1881dc99532186c31d98503748a5`.
Persisted server receipts use Rust Candid, so compatibility tests use its bytes.

`save-inline-v1.hex` is a standalone action-specific Candid record
`{ operation: blob; request: SaveInline }`, with no Action enum in its type table.
It was encoded independently of the production digest helper. Values are:
outer operation5, vault1, object3, inner operation4 (16 repeated bytes each),
expected_revision0, plain_size1, manifest64 bytes of1, one hash32 bytes of2,
ciphertext17 bytes of7, context_hash32 bytes of8.
SHA256(`save-inline/v1` || bytes) is
`fbd36cfb6432e5a91f06e8c4f84ca73157da022edce3b56b77238625a715ce15` (323 bytes).
